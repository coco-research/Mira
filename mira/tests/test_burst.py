"""Tests for mira.burst — cloud-burst launch/teardown logic."""
from __future__ import annotations

import os

import pytest

import mira.keys as _keys
from mira.burst import launch, pick_target, should_burst, teardown, within_budget


# ── should_burst ──────────────────────────────────────────────────────────────

class TestShouldBurst:
    def _local_machine(self, saturated=False, tier="heavy"):
        return {"tier": tier, "ram_gb": 64, "saturated": saturated}

    def test_no_burst_for_local_job_that_fits(self):
        job = {"stage": "caption", "est_vram_gb": 0, "est_ram_gb": 2, "cuda_only": False}
        burst, reason = should_burst(job, self._local_machine(saturated=False))
        assert burst is False
        assert isinstance(reason, str) and len(reason) > 0

    def test_no_burst_cuda_false_not_saturated(self):
        job = {"stage": "llm", "est_vram_gb": 4, "est_ram_gb": 8, "cuda_only": False}
        burst, _ = should_burst(job, self._local_machine(saturated=False))
        assert burst is False

    def test_burst_when_cuda_only(self):
        job = {"stage": "skyreels", "est_vram_gb": 24, "est_ram_gb": 16, "cuda_only": True}
        burst, reason = should_burst(job, self._local_machine(saturated=False))
        assert burst is True
        assert "cuda" in reason.lower() or "CUDA" in reason

    def test_burst_when_machine_saturated(self):
        job = {"stage": "video_gen", "est_vram_gb": 4, "est_ram_gb": 8, "cuda_only": False}
        burst, reason = should_burst(job, self._local_machine(saturated=True))
        assert burst is True
        assert isinstance(reason, str)

    def test_returns_tuple_of_two(self):
        job = {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4, "cuda_only": False}
        result = should_burst(job, self._local_machine())
        assert len(result) == 2

    def test_first_element_is_bool(self):
        job = {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4, "cuda_only": False}
        burst, _ = should_burst(job, self._local_machine())
        assert isinstance(burst, bool)


# ── pick_target ───────────────────────────────────────────────────────────────

class TestPickTarget:
    def test_none_when_no_keys(self, monkeypatch):
        monkeypatch.delenv("VULTR_API_KEY", raising=False)
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
        _keys.load(refresh=True)
        assert pick_target() == "none"

    def test_vultr_preferred_when_key_set(self, monkeypatch):
        monkeypatch.setenv("VULTR_API_KEY", "vultrtestkey123")
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
        _keys.load(refresh=True)
        assert pick_target() == "vultr"

    def test_aws_when_vultr_absent_and_aws_present(self, monkeypatch):
        monkeypatch.delenv("VULTR_API_KEY", raising=False)
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        _keys.load(refresh=True)
        assert pick_target() == "aws"

    def test_vultr_takes_priority_over_aws(self, monkeypatch):
        monkeypatch.setenv("VULTR_API_KEY", "vultrtestkey456")
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        _keys.load(refresh=True)
        assert pick_target() == "vultr"

    def test_return_value_is_valid(self, monkeypatch):
        monkeypatch.delenv("VULTR_API_KEY", raising=False)
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
        _keys.load(refresh=True)
        assert pick_target() in {"vultr", "aws", "none"}


# ── launch (dry_run) ──────────────────────────────────────────────────────────

class TestLaunchDryRun:
    def test_no_network_call_dry_run(self):
        """dry_run=True must never touch the network.

        We verify this indirectly: the function must return within a very
        short time (< 1 s in practice) and not raise any network-related
        error.  A real HTTP call to a cold provider endpoint would time out
        or raise, so absence of error + instant return proves no I/O.
        """
        import time
        start = time.monotonic()
        result = launch("vultr", dry_run=True)
        elapsed = time.monotonic() - start
        assert elapsed < 1.0, f"launch() took {elapsed:.2f}s — suspicious network I/O?"
        assert result["action"] == "launched_dry_run"

    def test_returns_instance_id(self):
        result = launch("vultr", dry_run=True)
        assert result["instance_id"] is not None
        assert isinstance(result["instance_id"], str)

    def test_target_preserved(self):
        result = launch("aws", dry_run=True)
        assert result["target"] == "aws"

    def test_none_target_returns_skipped(self):
        result = launch("none", dry_run=True)
        assert result["action"] == "skipped"
        assert result["instance_id"] is None

    def test_has_cost_note(self):
        result = launch("vultr", dry_run=True)
        assert "would_cost_note" in result
        assert isinstance(result["would_cost_note"], str)

    def test_dry_run_flag_preserved(self):
        result = launch("vultr", dry_run=True)
        assert result["dry_run"] is True


# ── teardown (dry_run) ────────────────────────────────────────────────────────

class TestTeardownDryRun:
    def test_no_network_call_dry_run(self):
        import time
        handle = launch("vultr", dry_run=True)
        start = time.monotonic()
        result = teardown(handle, dry_run=True)
        elapsed = time.monotonic() - start
        assert elapsed < 1.0
        assert result["action"] == "torn_down_dry_run"

    def test_round_trip_preserves_instance_id(self):
        """teardown() should carry the same instance_id launch() returned."""
        handle = launch("aws", dry_run=True)
        result = teardown(handle, dry_run=True)
        assert result["instance_id"] == handle["instance_id"]

    def test_round_trip_preserves_target(self):
        handle = launch("vultr", dry_run=True)
        result = teardown(handle, dry_run=True)
        assert result["target"] == "vultr"

    def test_none_handle_skips_gracefully(self):
        handle = launch("none", dry_run=True)
        result = teardown(handle, dry_run=True)
        assert result["action"] == "skipped"

    def test_teardown_has_cost_note(self):
        handle = launch("vultr", dry_run=True)
        result = teardown(handle, dry_run=True)
        assert "would_cost_note" in result

    def test_dry_run_flag_on_teardown(self):
        handle = launch("aws", dry_run=True)
        result = teardown(handle, dry_run=True)
        assert result["dry_run"] is True


# ── within_budget ─────────────────────────────────────────────────────────────

class TestWithinBudget:
    def test_zero_spend_and_zero_cost(self):
        assert within_budget(0.0, 0.0, cap=20.0) is True

    def test_under_cap(self):
        assert within_budget(5.0, 3.0, cap=20.0) is True

    def test_exactly_at_cap(self):
        assert within_budget(10.0, 10.0, cap=20.0) is True

    def test_one_cent_over_cap(self):
        assert within_budget(10.01, 10.0, cap=20.0) is False

    def test_far_over_cap(self):
        assert within_budget(50.0, 5.0, cap=20.0) is False

    def test_cap_zero_blocks_any_spend(self):
        assert within_budget(0.0, 0.01, cap=0.0) is False

    def test_returns_bool(self):
        result = within_budget(1.0, 1.0, cap=10.0)
        assert isinstance(result, bool)
