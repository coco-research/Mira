"""Cost ledger and learning estimator (EMA) for the mira command layer.

Stdlib-only — no pip installs required.

All file-writing functions accept optional ``path``/``state_dir`` arguments
(defaulting to config paths) so tests can use tmp dirs without touching the
real state directory.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mira import config, fixtures

# ── helpers ─────────────────────────────────────────────────────────────────

def _resolve_log(path) -> Path:
    return Path(path) if path is not None else config.COST_LOG


def _resolve_model(path) -> Path:
    return Path(path) if path is not None else config.COST_MODEL


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Cost log (append-only ledger) ───────────────────────────────────────────

def append_cost(entry: dict[str, Any], path=None) -> None:
    """Append one cost-log entry to cost_log.json (creates [] if missing)."""
    log_path = _resolve_log(path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    existing = read_cost_log(path)

    record = dict(entry)
    if "ts" not in record or record["ts"] is None:
        record["ts"] = _now_iso()

    existing.append(record)
    log_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")


def read_cost_log(path=None) -> list[dict]:
    """Return the full cost log; empty list if the file does not exist."""
    log_path = _resolve_log(path)
    if not log_path.exists():
        return []
    return json.loads(log_path.read_text(encoding="utf-8"))


def total_spend(path=None) -> float:
    """Sum of all ``cost`` values in the log."""
    return sum(float(e.get("cost", 0.0)) for e in read_cost_log(path))


def spend_by_provider(path=None) -> dict[str, float]:
    """Aggregate ``cost`` keyed by ``provider``."""
    totals: dict[str, float] = {}
    for entry in read_cost_log(path):
        provider = entry.get("provider", "unknown")
        totals[provider] = totals.get(provider, 0.0) + float(entry.get("cost", 0.0))
    return totals


# ── Cost model (EMA estimator) ───────────────────────────────────────────────

def load_cost_model(path=None) -> dict:
    """Load cost_model.json, or seed from fixtures.COST_MODEL if absent."""
    model_path = _resolve_model(path)
    if not model_path.exists():
        return _deep_copy(fixtures.COST_MODEL)
    raw = json.loads(model_path.read_text(encoding="utf-8"))
    return raw


def _save_cost_model(model: dict, path=None) -> None:
    model_path = _resolve_model(path)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.write_text(json.dumps(model, indent=2), encoding="utf-8")


def _deep_copy(obj):
    """Shallow-safe deep copy via JSON round-trip (stdlib only)."""
    return json.loads(json.dumps(obj))


def update_unit(
    unit: str,
    cost: float,
    eta_s: float,
    path=None,
    alpha: float | None = None,
) -> dict:
    """EMA-update a unit's ema_cost and ema_eta_s; increment n; persist model.

    EMA formula: new = alpha*sample + (1-alpha)*old
    If n==0 the first sample is stored as-is (no smoothing needed).

    Returns the updated unit dict.
    """
    model = load_cost_model(path)
    a = alpha if alpha is not None else float(model.get("alpha", 0.3))

    units_map: dict = model.setdefault("units", {})
    if unit not in units_map:
        units_map[unit] = {"ema_cost": 0.0, "ema_eta_s": 0.0, "n": 0}

    row = units_map[unit]
    n = int(row.get("n", 0))
    old_cost = float(row.get("ema_cost", 0.0))
    old_eta = float(row.get("ema_eta_s", 0.0))

    if n == 0:
        new_cost = cost
        new_eta = eta_s
    else:
        new_cost = a * cost + (1 - a) * old_cost
        new_eta = a * eta_s + (1 - a) * old_eta

    row["ema_cost"] = new_cost
    row["ema_eta_s"] = new_eta
    row["n"] = n + 1
    model["updated_at"] = _now_iso()

    _save_cost_model(model, path)
    return dict(row)


def estimate(unit: str, units: float = 1, path=None) -> dict:
    """Return a cost/time estimate for ``units`` of the given unit type.

    Returns a dict with keys:
        cost        – ema_cost * units
        eta_s       – ema_eta_s * units
        n           – number of observations
        confidence  – "low" (n<3) | "med" (n<10) | "high" (n>=10)
    """
    model = load_cost_model(path)
    units_map: dict = model.get("units", {})

    if unit not in units_map:
        return {"cost": 0.0, "eta_s": 0.0, "n": 0, "confidence": "low"}

    row = units_map[unit]
    n = int(row.get("n", 0))
    ema_cost = float(row.get("ema_cost", 0.0))
    ema_eta = float(row.get("ema_eta_s", 0.0))

    if n < 3:
        confidence = "low"
    elif n < 10:
        confidence = "med"
    else:
        confidence = "high"

    return {
        "cost": ema_cost * units,
        "eta_s": ema_eta * units,
        "n": n,
        "confidence": confidence,
    }
