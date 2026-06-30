"""Tests for mira.longform — plan_longform() and validate_longform()."""
from __future__ import annotations

import pytest

from mira.longform import plan_longform, validate_longform
from mira.duration import words_for_duration


# ── plan_longform ─────────────────────────────────────────────────────────────

class TestPlanLongform:
    _TOPIC = {"id": "top_test", "title": "The AI Revolution Explained"}

    def test_returns_required_keys(self) -> None:
        plan = plan_longform(self._TOPIC)
        for key in ("target_s", "word_budget", "scene_count", "chapters", "aspect"):
            assert key in plan, f"Missing key: {key!r}"

    def test_target_s_preserved(self) -> None:
        plan = plan_longform(self._TOPIC, target_s=300)
        assert plan["target_s"] == 300

    def test_aspect_is_16_9(self) -> None:
        plan = plan_longform(self._TOPIC)
        assert plan["aspect"] == "16:9"

    def test_word_budget_matches_duration_util(self) -> None:
        """word_budget must equal words_for_duration(target_s, wpm)."""
        target_s, wpm = 240, 150
        plan = plan_longform(self._TOPIC, target_s=target_s, wpm=wpm)
        expected = words_for_duration(target_s, wpm)
        assert plan["word_budget"] == expected

    def test_word_budget_approx_600_for_240s_at_150wpm(self) -> None:
        """150 wpm × 4 min = 600 words exactly."""
        plan = plan_longform(self._TOPIC, target_s=240, wpm=150)
        assert abs(plan["word_budget"] - 600) <= 2

    def test_scene_count_in_sane_range_240s(self) -> None:
        """scene_count must fall in [target_s//8, ceil(target_s/6)] for 240 s."""
        import math
        plan = plan_longform(self._TOPIC, target_s=240)
        sc = plan["scene_count"]
        assert 240 // 8 <= sc <= math.ceil(240 / 6), (
            f"scene_count {sc} outside expected band for 240s"
        )

    def test_at_least_3_chapters(self) -> None:
        plan = plan_longform(self._TOPIC, target_s=240)
        assert len(plan["chapters"]) >= 3

    def test_chapters_have_required_fields(self) -> None:
        plan = plan_longform(self._TOPIC, target_s=240)
        for ch in plan["chapters"]:
            assert "title" in ch, f"Chapter missing 'title': {ch}"
            assert "start_s" in ch, f"Chapter missing 'start_s': {ch}"

    def test_first_chapter_starts_at_zero(self) -> None:
        plan = plan_longform(self._TOPIC, target_s=240)
        assert plan["chapters"][0]["start_s"] == 0

    def test_chapter_starts_are_ascending(self) -> None:
        plan = plan_longform(self._TOPIC, target_s=300)
        starts = [ch["start_s"] for ch in plan["chapters"]]
        assert starts == sorted(starts), f"Chapter starts not sorted: {starts}"

    def test_different_durations_scale_scene_count(self) -> None:
        plan_short = plan_longform(self._TOPIC, target_s=120)
        plan_long = plan_longform(self._TOPIC, target_s=480)
        assert plan_short["scene_count"] < plan_long["scene_count"]


# ── validate_longform ─────────────────────────────────────────────────────────

class TestValidateLongform:
    _TOPIC = {"id": "top_v", "title": "Valid Documentary"}

    def test_good_plan_passes(self) -> None:
        plan = plan_longform(self._TOPIC, target_s=240)
        errors = validate_longform(plan)
        assert errors == [], f"Unexpected errors for a generated plan: {errors}"

    def test_one_chapter_flagged(self) -> None:
        bad = {
            "target_s": 240,
            "word_budget": 600,
            "scene_count": 34,
            "chapters": [{"title": "Only Chapter", "start_s": 0}],
            "aspect": "16:9",
        }
        errors = validate_longform(bad)
        assert any("chapter" in e.lower() for e in errors), (
            f"Expected a chapter-count error, got: {errors}"
        )

    def test_two_chapters_flagged(self) -> None:
        bad = {
            "target_s": 240,
            "word_budget": 600,
            "scene_count": 34,
            "chapters": [
                {"title": "Intro", "start_s": 0},
                {"title": "End", "start_s": 200},
            ],
            "aspect": "16:9",
        }
        errors = validate_longform(bad)
        assert any("chapter" in e.lower() for e in errors), (
            f"Expected a chapter-count error, got: {errors}"
        )

    def test_long_intro_flagged(self) -> None:
        """Second chapter starting at 30 s means a 30 s intro — too long."""
        bad = {
            "target_s": 240,
            "word_budget": 600,
            "scene_count": 34,
            "chapters": [
                {"title": "Intro", "start_s": 0},
                {"title": "Part 1", "start_s": 30},   # 30 s intro ≥ 15 s
                {"title": "Part 2", "start_s": 120},
                {"title": "Conclusion", "start_s": 200},
            ],
            "aspect": "16:9",
        }
        errors = validate_longform(bad)
        assert any("intro" in e.lower() for e in errors), (
            f"Expected an intro-duration error, got: {errors}"
        )

    def test_bad_scene_count_flagged(self) -> None:
        """A scene_count of 1 for a 240 s plan is wildly outside the band."""
        bad = {
            "target_s": 240,
            "word_budget": 600,
            "scene_count": 1,
            "chapters": [
                {"title": "Intro", "start_s": 0},
                {"title": "Part 1", "start_s": 10},
                {"title": "Conclusion", "start_s": 200},
            ],
            "aspect": "16:9",
        }
        errors = validate_longform(bad)
        assert any("scene_count" in e.lower() for e in errors), (
            f"Expected a scene_count error, got: {errors}"
        )

    def test_valid_300s_plan(self) -> None:
        plan = plan_longform({"id": "t", "title": "Tech Deep Dive"}, target_s=300)
        assert validate_longform(plan) == []

    def test_empty_chapters_flagged(self) -> None:
        bad = {
            "target_s": 240,
            "word_budget": 600,
            "scene_count": 34,
            "chapters": [],
            "aspect": "16:9",
        }
        errors = validate_longform(bad)
        assert errors  # at least one error expected
