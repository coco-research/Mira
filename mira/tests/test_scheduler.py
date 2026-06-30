"""Tests for mira/scheduler.py — Phase 5 scheduling engine."""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

_MIRA_ROOT = Path(__file__).parent.parent
if str(_MIRA_ROOT) not in sys.path:
    sys.path.insert(0, str(_MIRA_ROOT))

from mira.scheduler import dispatch_plan, due, next_slot


# ── Fixtures ──────────────────────────────────────────────────────────────────

NOW = "2026-06-20T12:00:00Z"   # reference "now" for all tests

_AUTO_CHANNEL = {
    "id": "chn_quickwins",
    "trust": "auto_publish",
    "platforms": ["youtube"],
}

_REVIEW_CHANNEL = {
    "id": "chn_aitools",
    "trust": "review_all",
    "platforms": ["youtube", "instagram"],
}

_CHANNELS = [_AUTO_CHANNEL, _REVIEW_CHANNEL]


def _video(vid_id, channel_id, state="scheduled", scheduled_for=None):
    return {
        "id": vid_id,
        "channel_id": channel_id,
        "state": state,
        "scheduled_for": scheduled_for or "2026-06-20T10:00:00Z",  # before NOW
    }


# ── due() ─────────────────────────────────────────────────────────────────────

class TestDue(unittest.TestCase):

    def test_past_item_is_due(self):
        """Item scheduled before now is included."""
        items = [_video("v1", "chn_quickwins", scheduled_for="2026-06-20T08:00:00Z")]
        result = due(items, NOW)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "v1")

    def test_future_item_excluded(self):
        """Item scheduled in the future is not due."""
        items = [_video("v2", "chn_quickwins", scheduled_for="2026-06-21T10:00:00Z")]
        result = due(items, NOW)
        self.assertEqual(result, [])

    def test_posted_item_excluded(self):
        """Item with state='posted' is excluded even if scheduled in the past."""
        items = [_video("v3", "chn_quickwins", state="posted",
                        scheduled_for="2026-06-19T08:00:00Z")]
        result = due(items, NOW)
        self.assertEqual(result, [])

    def test_no_scheduled_for_excluded(self):
        """Item without scheduled_for is excluded."""
        items = [{"id": "v4", "channel_id": "chn_quickwins", "state": "approved"}]
        result = due(items, NOW)
        self.assertEqual(result, [])

    def test_mixed_list(self):
        """Only past non-posted items are returned from a mixed list."""
        items = [
            _video("va", "chn_quickwins", scheduled_for="2026-06-20T08:00:00Z"),  # due
            _video("vb", "chn_quickwins", scheduled_for="2026-06-21T10:00:00Z"),  # future
            _video("vc", "chn_quickwins", state="posted",
                   scheduled_for="2026-06-19T08:00:00Z"),                         # posted
        ]
        result = due(items, NOW)
        self.assertEqual([r["id"] for r in result], ["va"])

    def test_exactly_on_now_is_due(self):
        """Item scheduled exactly at now (<=) is included."""
        items = [_video("ve", "chn_quickwins", scheduled_for=NOW)]
        result = due(items, NOW)
        self.assertEqual(len(result), 1)

    def test_uses_status_field_for_topics(self):
        """Topic dicts use 'status' instead of 'state'; 'posted' still excluded."""
        items = [
            {"id": "t1", "channel_id": "chn_quickwins",
             "status": "posted", "scheduled_for": "2026-06-20T08:00:00Z"},
        ]
        result = due(items, NOW)
        self.assertEqual(result, [])


# ── next_slot() ───────────────────────────────────────────────────────────────

class TestNextSlot(unittest.TestCase):

    def test_returns_later_iso(self):
        """next_slot always returns a time strictly after the input."""
        slot = next_slot(_AUTO_CHANNEL, NOW, cadence_per_day=1)
        from mira.scheduler import _parse_iso
        self.assertGreater(_parse_iso(slot), _parse_iso(NOW))

    def test_cadence_2_half_day_apart(self):
        """cadence_per_day=2 → ~12 h interval."""
        from mira.scheduler import _parse_iso
        slot = next_slot(_AUTO_CHANNEL, NOW, cadence_per_day=2)
        diff = (_parse_iso(slot) - _parse_iso(NOW)).total_seconds()
        # Should be at least half a day (≥ 12 h), rounding up to next hour.
        self.assertGreaterEqual(diff, 12 * 3600)

    def test_returns_iso_string(self):
        """Return value is an ISO-8601 string ending in 'Z'."""
        slot = next_slot(_AUTO_CHANNEL, NOW)
        self.assertIsInstance(slot, str)
        self.assertTrue(slot.endswith("Z"), f"Expected Z suffix, got {slot!r}")

    def test_cadence_1_default(self):
        """Default cadence (1/day) yields a slot roughly 24 h later."""
        from mira.scheduler import _parse_iso
        slot = next_slot(_AUTO_CHANNEL, NOW)
        diff_hours = (_parse_iso(slot) - _parse_iso(NOW)).total_seconds() / 3600
        self.assertGreaterEqual(diff_hours, 24)

    def test_zero_cadence_treated_as_one(self):
        """cadence_per_day=0 is clamped to 1 — no division-by-zero."""
        slot = next_slot(_AUTO_CHANNEL, NOW, cadence_per_day=0)
        self.assertIsInstance(slot, str)


# ── dispatch_plan() ───────────────────────────────────────────────────────────

class TestDispatchPlan(unittest.TestCase):

    def test_auto_publish_channel_gets_publish(self):
        """Video on auto_publish channel → action 'publish'."""
        videos = [_video("v_auto", "chn_quickwins")]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["action"], "publish")
        self.assertEqual(plan[0]["video_id"], "v_auto")

    def test_review_all_channel_gets_hold(self):
        """Video on review_all channel → action 'hold'."""
        videos = [_video("v_rev", "chn_aitools")]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["action"], "hold")
        self.assertIn("review", plan[0]["reason"].lower())

    def test_posted_video_excluded(self):
        """Posted videos are not in the plan."""
        videos = [_video("v_posted", "chn_quickwins", state="posted")]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        self.assertEqual(plan, [])

    def test_future_video_excluded(self):
        """Future videos are not in the plan."""
        videos = [_video("v_future", "chn_quickwins",
                         scheduled_for="2026-06-25T10:00:00Z")]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        self.assertEqual(plan, [])

    def test_mixed_channels(self):
        """Mixed auto_publish + review_all videos in same plan batch."""
        videos = [
            _video("v_a", "chn_quickwins"),  # auto_publish
            _video("v_r", "chn_aitools"),    # review_all
        ]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        actions = {p["video_id"]: p["action"] for p in plan}
        self.assertEqual(actions["v_a"], "publish")
        self.assertEqual(actions["v_r"], "hold")

    def test_unknown_channel_defaults_to_hold(self):
        """Video with unknown channel_id → safe default 'hold'."""
        videos = [_video("v_unknown", "chn_nonexistent")]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["action"], "hold")

    def test_empty_inputs_return_empty_plan(self):
        self.assertEqual(dispatch_plan([], _CHANNELS, NOW), [])

    def test_empty_channels_unknown_defaults_to_hold(self):
        """Empty channels list → all due videos get action='hold' (safe default)."""
        videos = [_video("vx", "chn_quickwins")]
        plan = dispatch_plan(videos, [], NOW)
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["action"], "hold")

    def test_plan_dict_contains_required_keys(self):
        """Each plan item has the expected keys."""
        expected = {"video_id", "channel_id", "platform", "action",
                    "scheduled_for", "reason"}
        videos = [_video("v_keys", "chn_quickwins")]
        plan = dispatch_plan(videos, _CHANNELS, NOW)
        self.assertEqual(len(plan), 1)
        self.assertTrue(expected.issubset(plan[0].keys()),
                        f"Missing keys: {expected - plan[0].keys()}")


if __name__ == "__main__":
    unittest.main()
