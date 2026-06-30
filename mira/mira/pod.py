"""Pod coordination adapter for Project Mira — Phase 8.

Dual-mode design
----------------
- **Mock mode** (default): persists coordination state to a local JSON file
  so the full pod API is exercisable offline without any cloud account.
- **Live mode**: delegates to Supabase PostgREST via stdlib ``urllib``; active
  iff both ``SUPABASE_URL`` and ``SUPABASE_AGENT_KEY`` are present in the
  environment (``is_live()`` returns True).

Security invariant (SECURITY.md §2)
------------------------------------
Only coordination metadata and capacity counters are ever stored.  No API
keys, secrets, or media paths are written — the column whitelist in
``publish_capacity`` and the ``_assert_no_secrets`` guard on every mock write
enforce this at the adapter boundary.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Default mock-state path relative to cwd (overridable via PodAdapter).
DEFAULT_MOCK_PATH = Path("state/pod_mock.json")

# Exact field names (lower-cased) that must NEVER appear in persisted data.
_FORBIDDEN_FIELD_NAMES: frozenset[str] = frozenset({
    "api_key", "apikey", "secret", "token", "password",
    "credential", "private_key", "supabase_url", "supabase_agent_key",
    "mira_local_token",
})

# Column whitelist for quota_ledger — strips any accidental extra fields
# before the write, providing defence-in-depth against leaking secrets.
_LEDGER_COLUMNS: frozenset[str] = frozenset({
    "pod_id", "user_id", "provider", "window",
    "used", "limit", "window_start", "healthy", "last_429_at",
})

# Empty mock state template.
_EMPTY_STATE: dict = {
    "pods": [],
    "pod_members": [],
    "channels": [],
    "topics": [],
    "jobs": [],
    "quota_ledger": [],
    "analytics": [],
    "previews": [],
}


# ── Module-level helpers ──────────────────────────────────────────────────────

def is_live() -> bool:
    """Return True iff both SUPABASE_URL and SUPABASE_AGENT_KEY are set.

    Reads directly from ``os.environ`` so monkeypatch / real environment
    changes take effect immediately without a keys-cache refresh.
    """
    return bool(
        os.environ.get("SUPABASE_URL")
        and os.environ.get("SUPABASE_AGENT_KEY")
    )


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _assert_no_secrets(obj: object, _path: str = "root") -> None:
    """Recursively assert that no forbidden field name appears in *obj*.

    Raises ``ValueError`` on the first violation.  Called before every mock
    write as a last-line-of-defence invariant check.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in _FORBIDDEN_FIELD_NAMES:
                raise ValueError(
                    f"Security violation: forbidden field {k!r} found at {_path}"
                )
            _assert_no_secrets(v, f"{_path}.{k}")
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            _assert_no_secrets(item, f"{_path}[{i}]")


# ── Adapter class ─────────────────────────────────────────────────────────────

class PodAdapter:
    """Dual-mode pod coordination adapter.

    Parameters
    ----------
    mock_path:
        Path to the local JSON state file used in mock (offline) mode.
        Defaults to ``state/pod_mock.json`` relative to cwd.
    """

    def __init__(self, mock_path: Path | str | None = None) -> None:
        self._mock_path = Path(mock_path) if mock_path else DEFAULT_MOCK_PATH

    # ── Mock state I/O ────────────────────────────────────────────────────────

    def _load(self) -> dict:
        if self._mock_path.exists():
            return json.loads(self._mock_path.read_text(encoding="utf-8"))
        import copy
        return copy.deepcopy(_EMPTY_STATE)

    def _save(self, state: dict) -> None:
        # Security guard: reject any write that accidentally contains a secret.
        _assert_no_secrets(state)
        self._mock_path.parent.mkdir(parents=True, exist_ok=True)
        self._mock_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

    # ── Supabase PostgREST helpers (live mode only, stdlib urllib) ────────────

    def _base_url(self) -> str:
        return os.environ.get("SUPABASE_URL", "").rstrip("/")

    def _headers(self, extra: dict | None = None) -> dict:
        key = os.environ.get("SUPABASE_AGENT_KEY", "")
        h: dict = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _rest_post(self, table: str, record: dict, on_conflict: list[str]) -> dict:
        """Upsert a single row via PostgREST ON CONFLICT merge."""
        url = (
            f"{self._base_url()}/rest/v1/{table}"
            f"?on_conflict={','.join(on_conflict)}"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps(record).encode(),
            headers=self._headers({
                "Prefer": "resolution=merge-duplicates,return=representation",
            }),
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            return result[0] if isinstance(result, list) and result else result

    def _rest_get(self, table: str, filters: dict) -> list[dict]:
        """SELECT rows matching simple equality filters."""
        qs = "&".join(
            f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in filters.items()
        )
        req = urllib.request.Request(
            f"{self._base_url()}/rest/v1/{table}?{qs}",
            headers=self._headers({"Prefer": "return=representation"}),
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())

    def _rest_patch_qs(self, table: str, raw_qs: str, updates: dict) -> list[dict]:
        """PATCH rows matching a pre-built PostgREST query string.

        The raw_qs parameter allows IS NULL filters (e.g.
        ``"id=eq.X&assigned_user_id=is.null"``) that the simple equality
        helper cannot express.
        """
        req = urllib.request.Request(
            f"{self._base_url()}/rest/v1/{table}?{raw_qs}",
            data=json.dumps(updates).encode(),
            headers=self._headers({"Prefer": "return=representation"}),
            method="PATCH",
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())

    # ── Public API ────────────────────────────────────────────────────────────

    def join(self, pod_id: str, user_id: str, role: str = "editor") -> dict:
        """Add *user_id* to *pod_id* with *role*.  Upserts on (pod_id, user_id).

        Returns the membership record dict.
        """
        record: dict = {
            "pod_id": pod_id,
            "user_id": user_id,
            "role": role,
            "joined_at": _now_iso(),
        }
        if is_live():
            return self._rest_post("pod_members", record, ["pod_id", "user_id"])

        state = self._load()
        # Remove stale row if present, then append the new record (upsert).
        state["pod_members"] = [
            m for m in state["pod_members"]
            if not (m["pod_id"] == pod_id and m["user_id"] == user_id)
        ]
        state["pod_members"].append(record)
        self._save(state)
        return record

    def pair_agent(self, user_id: str) -> str:
        """Return a stable, opaque pairing code for *user_id*.

        Format: ``MIRA-<8 uppercase hex chars>`` derived from the SHA-256
        of user_id.  The code is deterministic (same user → same code) and
        contains no secrets — only a short hash of the user identifier.
        """
        digest = hashlib.sha256(user_id.encode()).hexdigest()[:8].upper()
        return f"MIRA-{digest}"

    def publish_capacity(self, user_id: str, ledger_rows: list[dict]) -> None:
        """Upsert quota_ledger capacity rows for *user_id*.

        Each row is stripped to the :data:`_LEDGER_COLUMNS` whitelist before
        writing, guaranteeing that no accidental secret field is ever
        persisted (even if the caller mistakenly includes one).
        """
        clean_rows: list[dict] = []
        for row in ledger_rows:
            # Whitelist-strip to allowed columns only.
            clean = {k: v for k, v in row.items() if k in _LEDGER_COLUMNS}
            clean["user_id"] = user_id
            clean_rows.append(clean)

        if is_live():
            for row in clean_rows:
                self._rest_post(
                    "quota_ledger",
                    row,
                    ["pod_id", "user_id", "provider", "window"],
                )
            return

        state = self._load()
        for row in clean_rows:
            key = (
                row.get("pod_id"),
                user_id,
                row.get("provider"),
                row.get("window"),
            )
            state["quota_ledger"] = [
                r for r in state["quota_ledger"]
                if (
                    r.get("pod_id"),
                    r.get("user_id"),
                    r.get("provider"),
                    r.get("window"),
                ) != key
            ]
            state["quota_ledger"].append(row)
        self._save(state)

    def capacity_view(self, pod_id: str) -> list[dict]:
        """Return all quota_ledger rows for *pod_id*."""
        if is_live():
            return self._rest_get("quota_ledger", {"pod_id": pod_id})

        state = self._load()
        return [r for r in state["quota_ledger"] if r.get("pod_id") == pod_id]

    def claim_job(self, job_id: str, user_id: str) -> bool:
        """Atomically attempt to claim *job_id* for *user_id*.

        Returns ``True`` on a successful first claim; ``False`` if the job is
        already assigned (single-assignment enforcement).

        In live mode the PostgREST ``PATCH WHERE assigned_user_id IS NULL``
        is atomic at the DB level — concurrent claims race and only one wins.
        In mock mode a load-check-save cycle provides the same guarantee for
        single-process testing scenarios.
        """
        if is_live():
            job_id_q = urllib.parse.quote(job_id)
            result = self._rest_patch_qs(
                "jobs",
                f"id=eq.{job_id_q}&assigned_user_id=is.null",
                {"assigned_user_id": user_id, "state": "assigned"},
            )
            return len(result) > 0

        state = self._load()
        for job in state["jobs"]:
            if job.get("id") == job_id:
                if job.get("assigned_user_id") is not None:
                    return False  # Already claimed — single-assignment respected
                job["assigned_user_id"] = user_id
                job["state"] = "assigned"
                job["claimed_at"] = _now_iso()
                self._save(state)
                return True

        # Job not yet in mock — insert as claimed.
        state["jobs"].append({
            "id": job_id,
            "assigned_user_id": user_id,
            "state": "assigned",
            "claimed_at": _now_iso(),
        })
        self._save(state)
        return True
