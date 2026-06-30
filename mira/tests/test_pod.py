"""Tests for mira.pod — Phase 8 pod-coordination adapter.

All tests run against the mock (offline) mode using tmp_path so there is
no Supabase dependency.  The is_live() tests use monkeypatch to exercise
both branches without modifying the real environment.

Security invariant tests assert that the persisted JSON mock never contains
any secret / key field — including accidental fields a caller might pass.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from mira import pod as pod_module
from mira.pod import PodAdapter

# ── Security invariant helpers ────────────────────────────────────────────────

# Exact forbidden field names (lower-cased); mirrors _FORBIDDEN_FIELD_NAMES in pod.py.
_FORBIDDEN_FIELDS: frozenset[str] = frozenset({
    "api_key", "apikey", "secret", "token", "password",
    "credential", "private_key", "supabase_url", "supabase_agent_key",
    "mira_local_token",
})


def _check_no_secrets(obj: object, _path: str = "root") -> None:
    """Recursively assert that no forbidden field name appears in *obj*."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            assert k.lower() not in _FORBIDDEN_FIELDS, (
                f"Forbidden field {k!r} found in mock JSON at {_path}"
            )
            _check_no_secrets(v, f"{_path}.{k}")
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            _check_no_secrets(item, f"{_path}[{i}]")


def _assert_mock_no_secrets(mock_path: Path) -> None:
    if not mock_path.exists():
        return
    data = json.loads(mock_path.read_text(encoding="utf-8"))
    _check_no_secrets(data)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_path(tmp_path: Path) -> Path:
    return tmp_path / "pod_mock.json"


@pytest.fixture
def adapter(mock_path: Path) -> PodAdapter:
    return PodAdapter(mock_path=mock_path)


# ── join() ────────────────────────────────────────────────────────────────────

class TestJoin:
    def test_join_returns_record_with_correct_fields(self, adapter: PodAdapter) -> None:
        result = adapter.join("pod_alpha", "usr_alice", "editor")
        assert result["pod_id"] == "pod_alpha"
        assert result["user_id"] == "usr_alice"
        assert result["role"] == "editor"
        assert "joined_at" in result

    def test_join_adds_member_to_mock(self, adapter: PodAdapter, mock_path: Path) -> None:
        adapter.join("pod_alpha", "usr_alice", "admin")
        state = json.loads(mock_path.read_text())
        members = state["pod_members"]
        assert len(members) == 1
        assert members[0]["user_id"] == "usr_alice"
        assert members[0]["role"] == "admin"

    def test_join_multiple_members(self, adapter: PodAdapter) -> None:
        adapter.join("pod_alpha", "usr_alice", "admin")
        adapter.join("pod_alpha", "usr_bob", "editor")
        state = adapter._load()
        users = {m["user_id"] for m in state["pod_members"]}
        assert users == {"usr_alice", "usr_bob"}

    def test_join_upserts_role_no_duplicate(self, adapter: PodAdapter) -> None:
        adapter.join("pod_alpha", "usr_alice", "viewer")
        adapter.join("pod_alpha", "usr_alice", "admin")  # promote; must not duplicate
        members = adapter._load()["pod_members"]
        alice_rows = [m for m in members if m["user_id"] == "usr_alice"]
        assert len(alice_rows) == 1, "Upsert must not create a duplicate row"
        assert alice_rows[0]["role"] == "admin"

    def test_join_different_pods_independent(self, adapter: PodAdapter) -> None:
        adapter.join("pod_alpha", "usr_alice", "editor")
        adapter.join("pod_beta", "usr_alice", "viewer")
        members = adapter._load()["pod_members"]
        assert len(members) == 2


# ── pair_agent() ──────────────────────────────────────────────────────────────

class TestPairAgent:
    def test_returns_mira_format(self, adapter: PodAdapter) -> None:
        code = adapter.pair_agent("usr_alice")
        assert re.match(r"^MIRA-[0-9A-F]{8}$", code), (
            f"Expected MIRA-XXXXXXXX format, got {code!r}"
        )

    def test_stable_same_user(self, adapter: PodAdapter) -> None:
        assert adapter.pair_agent("usr_alice") == adapter.pair_agent("usr_alice")

    def test_stable_across_adapter_instances(
        self, mock_path: Path
    ) -> None:
        a1 = PodAdapter(mock_path=mock_path)
        a2 = PodAdapter(mock_path=mock_path)
        assert a1.pair_agent("usr_alice") == a2.pair_agent("usr_alice")

    def test_different_users_produce_different_codes(self, adapter: PodAdapter) -> None:
        assert adapter.pair_agent("usr_alice") != adapter.pair_agent("usr_bob")

    def test_code_contains_no_secret_field_names(self, adapter: PodAdapter) -> None:
        code = adapter.pair_agent("usr_alice")
        for forbidden in ("key", "secret", "token", "password"):
            assert forbidden.lower() not in code.lower(), (
                f"Pairing code {code!r} contains forbidden substring {forbidden!r}"
            )


# ── publish_capacity() + capacity_view() ─────────────────────────────────────

class TestCapacityRoundTrip:
    def _groq_row(self) -> dict:
        return {
            "pod_id": "pod_alpha",
            "user_id": "usr_alice",
            "provider": "groq",
            "window": "rpd",
            "used": 312,
            "limit": 14400,
            "window_start": "2026-06-19T00:00:00Z",
            "healthy": True,
            "last_429_at": None,
        }

    def test_single_row_round_trips(self, adapter: PodAdapter) -> None:
        adapter.publish_capacity("usr_alice", [self._groq_row()])
        view = adapter.capacity_view("pod_alpha")
        assert len(view) == 1
        row = view[0]
        assert row["provider"] == "groq"
        assert row["used"] == 312
        assert row["limit"] == 14400
        assert row["healthy"] is True
        assert row["window"] == "rpd"

    def test_multiple_providers_all_returned(self, adapter: PodAdapter) -> None:
        adapter.publish_capacity("usr_alice", [
            {"pod_id": "pod_alpha", "provider": "groq", "window": "rpd",
             "used": 100, "limit": 14400},
            {"pod_id": "pod_alpha", "provider": "gemini", "window": "rpd",
             "used": 50, "limit": 0},
        ])
        view = adapter.capacity_view("pod_alpha")
        assert {r["provider"] for r in view} == {"groq", "gemini"}

    def test_upsert_updates_counter(self, adapter: PodAdapter) -> None:
        row = {"pod_id": "pod_alpha", "provider": "groq", "window": "rpd", "used": 100}
        adapter.publish_capacity("usr_alice", [row])
        adapter.publish_capacity("usr_alice", [{**row, "used": 200}])
        view = adapter.capacity_view("pod_alpha")
        groq_rows = [r for r in view if r["provider"] == "groq"]
        assert len(groq_rows) == 1, "Upsert must not duplicate the row"
        assert groq_rows[0]["used"] == 200

    def test_capacity_view_scoped_to_pod(self, adapter: PodAdapter) -> None:
        adapter.publish_capacity("usr_alice", [
            {"pod_id": "pod_alpha", "provider": "groq", "window": "rpd", "used": 10}
        ])
        adapter.publish_capacity("usr_bob", [
            {"pod_id": "pod_beta", "provider": "groq", "window": "rpd", "used": 99}
        ])
        view_alpha = adapter.capacity_view("pod_alpha")
        assert all(r.get("pod_id") == "pod_alpha" for r in view_alpha)
        assert len(view_alpha) == 1

    def test_multiple_windows_same_provider(self, adapter: PodAdapter) -> None:
        adapter.publish_capacity("usr_alice", [
            {"pod_id": "pod_alpha", "provider": "groq", "window": "rpm", "used": 10},
            {"pod_id": "pod_alpha", "provider": "groq", "window": "rpd", "used": 312},
        ])
        view = adapter.capacity_view("pod_alpha")
        assert len(view) == 2
        windows = {r["window"] for r in view}
        assert windows == {"rpm", "rpd"}


# ── claim_job() ───────────────────────────────────────────────────────────────

class TestClaimJob:
    def test_first_claim_succeeds(self, adapter: PodAdapter) -> None:
        assert adapter.claim_job("job_001", "usr_alice") is True

    def test_second_claim_different_user_fails(self, adapter: PodAdapter) -> None:
        """Single-assignment: a second different user cannot claim an already-claimed job."""
        adapter.claim_job("job_001", "usr_alice")
        assert adapter.claim_job("job_001", "usr_bob") is False

    def test_second_claim_same_user_fails(self, adapter: PodAdapter) -> None:
        """Idempotency: even the original claimant gets False on re-claim."""
        adapter.claim_job("job_001", "usr_alice")
        assert adapter.claim_job("job_001", "usr_alice") is False

    def test_independent_jobs_can_both_be_claimed(self, adapter: PodAdapter) -> None:
        assert adapter.claim_job("job_001", "usr_alice") is True
        assert adapter.claim_job("job_002", "usr_bob") is True

    def test_claimed_job_has_correct_user(self, adapter: PodAdapter) -> None:
        adapter.claim_job("job_001", "usr_alice")
        jobs = adapter._load()["jobs"]
        job = next(j for j in jobs if j["id"] == "job_001")
        assert job["assigned_user_id"] == "usr_alice"
        assert job["state"] == "assigned"


# ── is_live() ─────────────────────────────────────────────────────────────────

class TestIsLive:
    def test_false_with_no_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SUPABASE_URL", raising=False)
        monkeypatch.delenv("SUPABASE_AGENT_KEY", raising=False)
        assert pod_module.is_live() is False

    def test_false_with_only_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
        monkeypatch.delenv("SUPABASE_AGENT_KEY", raising=False)
        assert pod_module.is_live() is False

    def test_false_with_only_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SUPABASE_URL", raising=False)
        monkeypatch.setenv("SUPABASE_AGENT_KEY", "sbp_test_key")
        assert pod_module.is_live() is False

    def test_true_when_both_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
        monkeypatch.setenv("SUPABASE_AGENT_KEY", "sbp_test_key")
        # keys.load refresh ensures the mira.keys cache also reflects the new vars
        # (relevant if other code reads through the cache layer).
        from mira import keys
        keys.load(refresh=True)
        assert pod_module.is_live() is True

    def test_false_after_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
        monkeypatch.setenv("SUPABASE_AGENT_KEY", "sbp_test_key")
        assert pod_module.is_live() is True
        monkeypatch.delenv("SUPABASE_URL")
        assert pod_module.is_live() is False


# ── No-secrets invariant ──────────────────────────────────────────────────────

class TestNoSecretsInvariant:
    def test_full_workflow_leaves_no_secrets(
        self, adapter: PodAdapter, mock_path: Path
    ) -> None:
        """After a realistic workflow, the mock JSON must contain no secret fields."""
        adapter.join("pod_alpha", "usr_alice", "editor")
        adapter.publish_capacity("usr_alice", [
            {
                "pod_id": "pod_alpha",
                "provider": "groq",
                "window": "rpd",
                "used": 10,
                "limit": 14400,
                "healthy": True,
            }
        ])
        adapter.claim_job("job_001", "usr_alice")
        _assert_mock_no_secrets(mock_path)

    def test_publish_strips_accidental_secret_field(
        self, adapter: PodAdapter, mock_path: Path
    ) -> None:
        """Even if a caller passes an api_key field, publish_capacity strips it."""
        adapter.publish_capacity("usr_alice", [
            {
                "pod_id": "pod_alpha",
                "provider": "groq",
                "window": "rpd",
                "used": 10,
                "api_key": "sk-this-must-never-be-stored",   # accidentally passed
            }
        ])
        _assert_mock_no_secrets(mock_path)
        # Confirm the row was still stored (the valid fields survived).
        view = adapter.capacity_view("pod_alpha")
        assert len(view) == 1
        assert "api_key" not in view[0]

    def test_join_record_contains_no_secret_fields(
        self, adapter: PodAdapter, mock_path: Path
    ) -> None:
        adapter.join("pod_alpha", "usr_alice", "admin")
        _assert_mock_no_secrets(mock_path)

    def test_mock_json_keys_at_top_level(
        self, adapter: PodAdapter, mock_path: Path
    ) -> None:
        """The mock JSON structure keys must only be known table names."""
        adapter.join("pod_alpha", "usr_alice", "editor")
        state = json.loads(mock_path.read_text())
        known_tables = {
            "pods", "pod_members", "channels", "topics",
            "jobs", "quota_ledger", "analytics", "previews",
        }
        assert set(state.keys()) <= known_tables
