"""Tests for mira.router — quota-aware swarm router.

Run with:
    .venv/bin/python -m pytest tests/test_router.py -q
"""
from __future__ import annotations

import pytest

from mira.router import (
    POLICY_CHAIN,
    TIER,
    choose_provider,
    is_available,
    mark_429,
    record_use,
    reset_window,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _row(provider: str, used: int = 0, limit: int = 0, healthy: bool = True) -> dict:
    return {
        "pod_id": "pod-1",
        "user_id": "u1",
        "provider": provider,
        "window": "rpd",
        "used": used,
        "limit": limit,
        "healthy": healthy,
        "window_start": None,
        "last_429_at": None,
    }


# ── is_available ──────────────────────────────────────────────────────────────

class TestIsAvailable:
    def test_healthy_unlimited(self):
        assert is_available(_row("nim", used=999, limit=0)) is True

    def test_healthy_within_limit(self):
        assert is_available(_row("nim", used=5, limit=10)) is True

    def test_healthy_at_limit(self):
        assert is_available(_row("nim", used=10, limit=10)) is False

    def test_unhealthy(self):
        assert is_available(_row("nim", used=0, limit=100, healthy=False)) is False

    def test_negative_limit_means_unlimited(self):
        assert is_available(_row("nim", used=50, limit=-1)) is True


# ── record_use ────────────────────────────────────────────────────────────────

class TestRecordUse:
    def test_creates_row_if_missing(self):
        ledger: list[dict] = []
        record_use(ledger, "u1", "nim")
        assert len(ledger) == 1
        assert ledger[0]["used"] == 1
        assert ledger[0]["healthy"] is True

    def test_increments_existing_row(self):
        ledger = [_row("nim", used=5)]
        record_use(ledger, "u1", "nim", n=3)
        assert ledger[0]["used"] == 8

    def test_reflected_in_choose_provider(self):
        """record_use side-effect is seen by the next choose_provider call."""
        ledger = [_row("nim", used=0), _row("groq", used=0)]
        # Record 50 uses for nim, none for groq
        for _ in range(50):
            record_use(ledger, "u1", "nim")
        chosen = choose_provider(["nim", "groq"], ledger)
        assert chosen == "groq"  # groq has lower used count


# ── mark_429 ─────────────────────────────────────────────────────────────────

class TestMark429:
    def test_sets_unhealthy(self):
        ledger = [_row("nim")]
        mark_429(ledger, "u1", "nim")
        assert ledger[0]["healthy"] is False
        assert ledger[0]["last_429_at"] is not None

    def test_creates_row_if_missing(self):
        ledger: list[dict] = []
        mark_429(ledger, "u1", "nim")
        assert len(ledger) == 1
        assert ledger[0]["healthy"] is False


# ── reset_window ──────────────────────────────────────────────────────────────

class TestResetWindow:
    def test_resets_all(self):
        ledger = [_row("nim", used=100, healthy=False), _row("groq", used=50)]
        reset_window(ledger)
        for row in ledger:
            assert row["used"] == 0
            assert row["healthy"] is True

    def test_resets_specific_provider(self):
        ledger = [_row("nim", used=100), _row("groq", used=50)]
        reset_window(ledger, provider="nim")
        assert ledger[0]["used"] == 0
        assert ledger[1]["used"] == 50  # unchanged


# ── choose_provider ───────────────────────────────────────────────────────────

class TestLeastUsed:
    def test_picks_lower_used_within_same_stage(self):
        """Two own_free_cloud providers — pick the one with lower used."""
        ledger = [_row("nim", used=100), _row("groq", used=5)]
        chosen = choose_provider(["nim", "groq"], ledger)
        assert chosen == "groq"

    def test_picks_lower_when_first_is_high(self):
        ledger = [_row("mistral", used=200), _row("cerebras", used=1)]
        chosen = choose_provider(["mistral", "cerebras"], ledger)
        assert chosen == "cerebras"


class TestBackoff429:
    def test_429_provider_is_skipped(self):
        """mark_429 on a provider makes it invisible to the router."""
        ledger = [_row("groq", used=1), _row("nim", used=999)]
        mark_429(ledger, "u1", "groq")
        chosen = choose_provider(["groq", "nim"], ledger)
        # groq is unhealthy, nim must be chosen even though used is high
        assert chosen == "nim"

    def test_429_with_only_one_candidate_returns_none(self):
        ledger = [_row("groq")]
        mark_429(ledger, "u1", "groq")
        assert choose_provider(["groq"], ledger) is None


class TestOverLimit:
    def test_over_limit_provider_skipped(self):
        ledger = [_row("nim", used=100, limit=100), _row("mistral", used=10, limit=200)]
        chosen = choose_provider(["nim", "mistral"], ledger)
        assert chosen == "mistral"

    def test_all_over_limit_returns_none(self):
        ledger = [_row("nim", used=50, limit=50), _row("groq", used=200, limit=200)]
        assert choose_provider(["nim", "groq"], ledger) is None


class TestChainOrder:
    def test_free_local_beats_metered(self):
        """A free_local candidate is always preferred over a metered one."""
        ledger = [_row("lmstudio", used=0), _row("kling", used=0)]
        chosen = choose_provider(["lmstudio", "kling"], ledger)
        assert chosen == "lmstudio"

    def test_free_local_beats_own_free_cloud(self):
        ledger = [_row("nim", used=0), _row("comfyui", used=0)]
        chosen = choose_provider(["nim", "comfyui"], ledger)
        assert chosen == "comfyui"

    def test_own_free_cloud_beats_burst(self):
        ledger = [_row("nim", used=0), _row("aws", used=0)]
        chosen = choose_provider(["nim", "aws"], ledger)
        assert chosen == "nim"

    def test_chain_skips_exhausted_stage(self):
        """If the free_local candidate is over-limit, falls through to own_free_cloud."""
        ledger = [_row("lmstudio", used=100, limit=100), _row("nim", used=0)]
        chosen = choose_provider(["lmstudio", "nim"], ledger)
        assert chosen == "nim"


class TestPinnedLocal:
    def test_returns_local_when_available(self):
        """pinned_local picks a local id even when a cloud provider has more headroom."""
        ledger = [_row("lmstudio", used=5), _row("nim", used=0)]
        chosen = choose_provider(
            ["lmstudio", "nim"], ledger, pinned_local=True
        )
        assert chosen == "lmstudio"

    def test_returns_none_when_no_local_candidate(self):
        """pinned_local returns None if no local provider is in stage_candidates."""
        ledger = [_row("nim", used=0)]
        chosen = choose_provider(["nim"], ledger, pinned_local=True)
        assert chosen is None

    def test_pinned_local_skips_unhealthy_local(self):
        """Even in pinned_local mode, an unhealthy local provider is skipped."""
        ledger = [_row("lmstudio", healthy=False), _row("comfyui", used=0)]
        chosen = choose_provider(
            ["lmstudio", "comfyui"], ledger, pinned_local=True
        )
        assert chosen == "comfyui"

    def test_pinned_local_returns_none_if_all_unhealthy(self):
        ledger = [_row("lmstudio", healthy=False)]
        chosen = choose_provider(["lmstudio"], ledger, pinned_local=True)
        assert chosen is None


class TestEdgeCases:
    def test_empty_candidates_returns_none(self):
        assert choose_provider([], []) is None

    def test_no_ledger_rows_treats_providers_as_fresh(self):
        """Providers absent from ledger are treated as used=0, healthy=True."""
        chosen = choose_provider(["lmstudio", "nim"], [])
        # lmstudio is free_local → earlier in policy chain
        assert chosen == "lmstudio"

    def test_single_available_candidate(self):
        ledger = [_row("groq", used=10)]
        assert choose_provider(["groq"], ledger) == "groq"

    def test_policy_chain_is_correct_order(self):
        assert POLICY_CHAIN == [
            "free_local", "own_free_cloud", "pod_swarm", "metered", "burst"
        ]

    def test_tier_classifications(self):
        assert TIER["lmstudio"] == "free_local"
        assert TIER["comfyui"] == "free_local"
        assert TIER["nim"] == "own_free_cloud"
        assert TIER["groq"] == "own_free_cloud"
        assert TIER["sarvam"] == "metered"
        assert TIER["kling"] == "metered"
        assert TIER["vultr"] == "burst"
        assert TIER["aws"] == "burst"
