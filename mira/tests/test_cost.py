"""Tests for mira.cost — cost ledger + EMA estimator.

All tests use pytest tmp_path so nothing is written to the real state dir.
"""
from __future__ import annotations

import pytest

from mira.cost import (
    append_cost,
    estimate,
    load_cost_model,
    read_cost_log,
    spend_by_provider,
    total_spend,
    update_unit,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _log(tmp_path):
    return tmp_path / "cost_log.json"


def _model(tmp_path):
    return tmp_path / "cost_model.json"


def _seed_log(tmp_path):
    entries = [
        {"video_id": "vid_001", "stage": "script",  "provider": "lmstudio", "units": 1, "cost": 0.00},
        {"video_id": "vid_001", "stage": "voice",   "provider": "edge-tts",  "units": 1, "cost": 0.10},
        {"video_id": "vid_002", "stage": "clip",    "provider": "edge-tts",  "units": 2, "cost": 0.20},
    ]
    for e in entries:
        append_cost(e, path=_log(tmp_path))
    return entries


# ── Cost log tests ────────────────────────────────────────────────────────────

class TestCostLog:
    def test_round_trip_empty(self, tmp_path):
        assert read_cost_log(path=_log(tmp_path)) == []

    def test_append_creates_file(self, tmp_path):
        p = _log(tmp_path)
        assert not p.exists()
        append_cost({"video_id": "x", "stage": "s", "provider": "p", "cost": 0.0}, path=p)
        assert p.exists()

    def test_total_spend(self, tmp_path):
        _seed_log(tmp_path)
        assert total_spend(path=_log(tmp_path)) == pytest.approx(0.30)

    def test_total_spend_empty(self, tmp_path):
        assert total_spend(path=_log(tmp_path)) == pytest.approx(0.0)

    def test_spend_by_provider_sums(self, tmp_path):
        _seed_log(tmp_path)
        by_p = spend_by_provider(path=_log(tmp_path))
        assert by_p["lmstudio"] == pytest.approx(0.00)
        assert by_p["edge-tts"] == pytest.approx(0.30)

    def test_append_preserves_order(self, tmp_path):
        for i in range(5):
            append_cost({"video_id": f"v{i}", "stage": "s", "provider": "p", "cost": float(i)}, path=_log(tmp_path))
        log = read_cost_log(path=_log(tmp_path))
        assert [e["video_id"] for e in log] == [f"v{i}" for i in range(5)]

    def test_ts_auto_filled(self, tmp_path):
        append_cost({"video_id": "v", "stage": "s", "provider": "p", "cost": 0.0}, path=_log(tmp_path))
        entry = read_cost_log(path=_log(tmp_path))[0]
        assert "ts" in entry and entry["ts"] is not None

    def test_explicit_ts_preserved(self, tmp_path):
        append_cost({"video_id": "v", "stage": "s", "provider": "p", "cost": 0.0, "ts": "2026-01-01T00:00:00Z"}, path=_log(tmp_path))
        entry = read_cost_log(path=_log(tmp_path))[0]
        assert entry["ts"] == "2026-01-01T00:00:00Z"


# ── EMA estimator tests ───────────────────────────────────────────────────────

class TestUpdateUnit:
    def test_first_update_stores_sample_directly(self, tmp_path):
        row = update_unit("test_unit", cost=1.0, eta_s=10.0, path=_model(tmp_path))
        assert row["ema_cost"] == pytest.approx(1.0)
        assert row["ema_eta_s"] == pytest.approx(10.0)
        assert row["n"] == 1

    def test_second_update_applies_ema(self, tmp_path):
        update_unit("test_unit", cost=1.0, eta_s=10.0, path=_model(tmp_path))
        row = update_unit("test_unit", cost=0.0, eta_s=0.0, path=_model(tmp_path))
        # alpha=0.3 (default from seed model): new = 0.3*0 + 0.7*1 = 0.7
        assert row["ema_cost"] == pytest.approx(0.7)
        assert row["ema_eta_s"] == pytest.approx(7.0)
        assert row["n"] == 2

    def test_ema_moves_toward_constant_sample(self, tmp_path):
        target = 5.0
        update_unit("converge", cost=0.0, eta_s=0.0, path=_model(tmp_path))
        for _ in range(30):
            update_unit("converge", cost=target, eta_s=target, path=_model(tmp_path))
        row = update_unit("converge", cost=target, eta_s=target, path=_model(tmp_path))
        assert row["ema_cost"] == pytest.approx(target, rel=0.01)
        assert row["n"] == 32

    def test_custom_alpha(self, tmp_path):
        update_unit("a", cost=10.0, eta_s=0.0, path=_model(tmp_path))
        row = update_unit("a", cost=0.0, eta_s=0.0, path=_model(tmp_path), alpha=0.5)
        assert row["ema_cost"] == pytest.approx(5.0)

    def test_increments_n(self, tmp_path):
        for i in range(1, 6):
            row = update_unit("inc", cost=1.0, eta_s=1.0, path=_model(tmp_path))
            assert row["n"] == i

    def test_persists_across_calls(self, tmp_path):
        update_unit("persist", cost=2.0, eta_s=5.0, path=_model(tmp_path))
        model = load_cost_model(path=_model(tmp_path))
        assert "persist" in model["units"]
        assert model["units"]["persist"]["n"] == 1


# ── Estimate tests ────────────────────────────────────────────────────────────

class TestEstimate:
    def test_unknown_unit(self, tmp_path):
        result = estimate("nonexistent_unit", path=_model(tmp_path))
        assert result["cost"] == pytest.approx(0.0)
        assert result["n"] == 0
        assert result["confidence"] == "low"

    def test_low_confidence_fresh_unit(self, tmp_path):
        for _ in range(2):
            update_unit("fresh", cost=1.0, eta_s=1.0, path=_model(tmp_path))
        result = estimate("fresh", path=_model(tmp_path))
        assert result["n"] == 2
        assert result["confidence"] == "low"

    def test_med_confidence(self, tmp_path):
        for _ in range(5):
            update_unit("med_unit", cost=1.0, eta_s=1.0, path=_model(tmp_path))
        result = estimate("med_unit", path=_model(tmp_path))
        assert result["confidence"] == "med"

    def test_high_confidence_after_10_updates(self, tmp_path):
        for _ in range(10):
            update_unit("veteran", cost=1.0, eta_s=2.0, path=_model(tmp_path))
        result = estimate("veteran", path=_model(tmp_path))
        assert result["confidence"] == "high"

    def test_cost_scales_with_units(self, tmp_path):
        for _ in range(10):
            update_unit("scalar", cost=1.0, eta_s=10.0, path=_model(tmp_path))
        r1 = estimate("scalar", units=1, path=_model(tmp_path))
        r3 = estimate("scalar", units=3, path=_model(tmp_path))
        assert r3["cost"] == pytest.approx(r1["cost"] * 3)
        assert r3["eta_s"] == pytest.approx(r1["eta_s"] * 3)

    def test_eta_s_scales_with_units(self, tmp_path):
        for _ in range(10):
            update_unit("eta_scalar", cost=0.5, eta_s=20.0, path=_model(tmp_path))
        r = estimate("eta_scalar", units=2, path=_model(tmp_path))
        r1 = estimate("eta_scalar", units=1, path=_model(tmp_path))
        assert r["eta_s"] == pytest.approx(r1["eta_s"] * 2)

    def test_seeded_unit_from_fixtures(self, tmp_path):
        """Units seeded from fixtures.COST_MODEL should be estimable without any update."""
        result = estimate("kling_motion_s", path=_model(tmp_path))
        assert result["n"] == 5
        assert result["confidence"] == "med"
        assert result["cost"] == pytest.approx(0.09)

    def test_high_confidence_boundary_exactly_10(self, tmp_path):
        for _ in range(10):
            update_unit("boundary10", cost=1.0, eta_s=1.0, path=_model(tmp_path))
        assert estimate("boundary10", path=_model(tmp_path))["confidence"] == "high"

    def test_low_confidence_boundary_exactly_2(self, tmp_path):
        for _ in range(2):
            update_unit("boundary2", cost=1.0, eta_s=1.0, path=_model(tmp_path))
        assert estimate("boundary2", path=_model(tmp_path))["confidence"] == "low"

    def test_med_confidence_boundary_exactly_3(self, tmp_path):
        for _ in range(3):
            update_unit("boundary3", cost=1.0, eta_s=1.0, path=_model(tmp_path))
        assert estimate("boundary3", path=_model(tmp_path))["confidence"] == "med"
