"""Tests for mira.tiers — RAM-tier degradation logic."""
from __future__ import annotations

import pytest

from mira.tiers import degrade_or_offload, headroom_ok, plan_modes


# ── plan_modes ────────────────────────────────────────────────────────────────

class TestPlanModesHeavy:
    def test_concurrency_above_one(self):
        plan = plan_modes("heavy", {"stage": "script", "est_vram_gb": 0, "est_ram_gb": 8})
        assert plan["concurrency"] > 1

    def test_no_unload(self):
        plan = plan_modes("heavy", {"stage": "script", "est_vram_gb": 0, "est_ram_gb": 8})
        assert plan["unload_between_stages"] is False

    def test_no_lowvram(self):
        plan = plan_modes("heavy", {"stage": "script", "est_vram_gb": 0, "est_ram_gb": 8})
        assert plan["lowvram"] is False

    def test_no_offload(self):
        plan = plan_modes("heavy", {"stage": "script", "est_vram_gb": 0, "est_ram_gb": 8})
        assert plan["offload"] is False

    def test_no_segmented(self):
        plan = plan_modes("heavy", {"stage": "render", "est_vram_gb": 8, "est_ram_gb": 16})
        assert plan["segmented"] is False

    def test_quant_set(self):
        plan = plan_modes("heavy", {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 8})
        assert plan["quant"] is not None


class TestPlanModesMid:
    def test_concurrency_one(self):
        plan = plan_modes("mid", {"stage": "script", "est_vram_gb": 2, "est_ram_gb": 8})
        assert plan["concurrency"] == 1

    def test_unload_between_stages(self):
        plan = plan_modes("mid", {"stage": "script", "est_vram_gb": 2, "est_ram_gb": 8})
        assert plan["unload_between_stages"] is True

    def test_tiled(self):
        plan = plan_modes("mid", {"stage": "image", "est_vram_gb": 4, "est_ram_gb": 8})
        assert plan["tiled"] is True

    def test_no_offload_mid(self):
        plan = plan_modes("mid", {"stage": "render", "est_vram_gb": 6, "est_ram_gb": 12})
        assert plan["offload"] is False


class TestPlanModesLight:
    def test_lowvram_enabled(self):
        plan = plan_modes("light", {"stage": "script", "est_vram_gb": 0, "est_ram_gb": 4})
        assert plan["lowvram"] is True

    def test_segmented_enabled(self):
        plan = plan_modes("light", {"stage": "render", "est_vram_gb": 0, "est_ram_gb": 4})
        assert plan["segmented"] is True

    def test_concurrency_one(self):
        plan = plan_modes("light", {"stage": "script", "est_vram_gb": 0, "est_ram_gb": 4})
        assert plan["concurrency"] == 1

    def test_offload_heavy_vram_stage(self):
        """A light-tier job with >4 GB estimated VRAM should offload."""
        plan = plan_modes("light", {"stage": "video_gen", "est_vram_gb": 8, "est_ram_gb": 4})
        assert plan["offload"] is True

    def test_no_offload_light_vram_stage(self):
        """A light-tier job with small VRAM estimate stays local."""
        plan = plan_modes("light", {"stage": "caption", "est_vram_gb": 1, "est_ram_gb": 2})
        assert plan["offload"] is False

    def test_quant_small(self):
        plan = plan_modes("light", {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4})
        assert plan["quant"] is not None

    def test_note_non_empty(self):
        plan = plan_modes("light", {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4})
        assert isinstance(plan["note"], str) and len(plan["note"]) > 0


class TestPlanModesReturnShape:
    EXPECTED_KEYS = {
        "concurrency", "unload_between_stages", "lowvram", "tiled",
        "quant", "segmented", "offload", "note",
    }

    @pytest.mark.parametrize("tier", ["heavy", "mid", "light"])
    def test_all_keys_present(self, tier):
        plan = plan_modes(tier, {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4})
        assert self.EXPECTED_KEYS.issubset(set(plan))

    def test_case_insensitive_tier(self):
        """Tier matching should be case-insensitive."""
        plan_lower = plan_modes("heavy", {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4})
        plan_upper = plan_modes("HEAVY", {"stage": "llm", "est_vram_gb": 0, "est_ram_gb": 4})
        assert plan_lower["concurrency"] == plan_upper["concurrency"]


# ── headroom_ok ───────────────────────────────────────────────────────────────

class TestHeadroomOk:
    def test_plenty_of_ram(self):
        assert headroom_ok(16.0, 8.0) is True

    def test_exact_guard_boundary_passes(self):
        # free=10, est=8, guard=2 → 10 >= 10 → True
        assert headroom_ok(10.0, 8.0, guard_gb=2.0) is True

    def test_one_byte_below_guard_fails(self):
        # free=9.9, est=8, guard=2 → 9.9 < 10 → False
        assert headroom_ok(9.9, 8.0, guard_gb=2.0) is False

    def test_zero_free_fails(self):
        assert headroom_ok(0.0, 8.0) is False

    def test_custom_guard(self):
        # free=6, est=4, guard=3 → 6 >= 7 → False
        assert headroom_ok(6.0, 4.0, guard_gb=3.0) is False

    def test_est_zero(self):
        # Any positive free_ram > guard is fine when est=0
        assert headroom_ok(3.0, 0.0, guard_gb=2.0) is True

    def test_returns_bool(self):
        result = headroom_ok(16.0, 8.0)
        assert isinstance(result, bool)


# ── degrade_or_offload ────────────────────────────────────────────────────────

class TestDegradeOrOffload:
    def test_run_when_headroom_ok_heavy(self):
        job = {"est_ram_gb": 8}
        assert degrade_or_offload("heavy", job, free_ram_gb=16.0) == "run"

    def test_run_when_headroom_ok_light(self):
        job = {"est_ram_gb": 2}
        assert degrade_or_offload("light", job, free_ram_gb=10.0) == "run"

    def test_downgrade_heavy_insufficient(self):
        job = {"est_ram_gb": 20}
        assert degrade_or_offload("heavy", job, free_ram_gb=10.0) == "downgrade"

    def test_downgrade_mid_insufficient(self):
        job = {"est_ram_gb": 14}
        assert degrade_or_offload("mid", job, free_ram_gb=10.0) == "downgrade"

    def test_offload_light_insufficient(self):
        """Light tier + not enough free RAM → offload (PLAN.md §6.2)."""
        job = {"est_ram_gb": 10}
        # free=8, est=10, guard=2 → 8 < 12 → fails headroom → light → offload
        assert degrade_or_offload("light", job, free_ram_gb=8.0) == "offload"

    def test_offload_light_zero_free(self):
        job = {"est_ram_gb": 4}
        assert degrade_or_offload("light", job, free_ram_gb=0.0) == "offload"

    def test_return_values_are_valid(self):
        valid = {"run", "downgrade", "offload"}
        for tier in ("heavy", "mid", "light"):
            for free in (0.0, 8.0, 64.0):
                result = degrade_or_offload(tier, {"est_ram_gb": 6}, free_ram_gb=free)
                assert result in valid, f"Invalid result {result!r} for tier={tier}, free={free}"
