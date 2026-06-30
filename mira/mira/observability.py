"""Structured run logger — observability for Mira pipeline executions.

Writes JSONL to STATE_DIR/runs.jsonl (path overridable at construction).
Any field whose key contains 'key', 'token', 'secret', or 'password'
(case-insensitive) is redacted to "***" before writing so credentials never
land on disk.
"""
from __future__ import annotations

import contextlib
import json
import os
import threading
import time
from collections.abc import Generator
from pathlib import Path

from .config import STATE_DIR

# Keys whose *names* indicate a secret value (case-insensitive substring match).
_SECRET_PATTERNS = ("key", "token", "secret", "password")


def _is_secret_field(name: str) -> bool:
    lower = name.lower()
    return any(pat in lower for pat in _SECRET_PATTERNS)


def _redact(fields: dict) -> dict:
    return {k: ("***" if _is_secret_field(k) else v) for k, v in fields.items()}


class RunLog:
    """Thread-safe structured JSONL run logger.

    Parameters
    ----------
    path:
        Path to the JSONL file.  Defaults to ``STATE_DIR/runs.jsonl``.
        Parent directory is created on first write.
    """

    def __init__(self, path: Path | str | None = None) -> None:
        if path is None:
            path = STATE_DIR / "runs.jsonl"
        self._path = Path(path)
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def log(self, event: str, **fields) -> None:
        """Append one JSONL record with ``{ts, event, ...fields}``."""
        record = {
            "ts": _utc_iso(),
            "event": event,
            **_redact(fields),
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False)
        with self._lock:
            with self._path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def tail(self, n: int = 20) -> list[dict]:
        """Return the last *n* log records (oldest-first within the slice)."""
        if not self._path.exists():
            return []
        lines = self._path.read_text(encoding="utf-8").splitlines()
        tail_lines = lines[-n:] if n > 0 else []
        records = []
        for raw in tail_lines:
            raw = raw.strip()
            if raw:
                try:
                    records.append(json.loads(raw))
                except json.JSONDecodeError:
                    pass
        return records

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    @contextlib.contextmanager
    def timed(self, event: str, **fields) -> Generator[None, None, None]:
        """Context manager that logs *event* with ``duration_ms`` on exit."""
        t0 = time.monotonic()
        try:
            yield
        finally:
            elapsed_ms = (time.monotonic() - t0) * 1_000
            self.log(event, duration_ms=round(elapsed_ms, 3), **fields)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc_iso() -> str:
    """Return current UTC time as an ISO-8601 string (no external deps)."""
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")
