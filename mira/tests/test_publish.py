"""Tests for mira/providers/publish.py — Phase 5 publishing engine."""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# Ensure the mira package is importable when running from the project root.
_MIRA_ROOT = Path(__file__).parent.parent
if str(_MIRA_ROOT) not in sys.path:
    sys.path.insert(0, str(_MIRA_ROOT))

from mira.providers.publish import can_publish, publish


class TestCanPublish(unittest.TestCase):
    """can_publish(platform) -> (bool, reason)"""

    def test_youtube_false_when_no_creds(self):
        """No YOUTUBE_CLIENT_SECRET_JSON in env → (False, reason mentioning OAuth)."""
        # Patch keys.has to always return False for YouTube cred.
        with patch("mira.providers.publish.keys.has", return_value=False):
            ok, reason = can_publish("youtube")
        self.assertFalse(ok)
        self.assertIn("OAuth", reason,
                      "reason should mention the OAuth step required")

    def test_instagram_false_when_no_creds(self):
        """No IG_ACCESS_TOKEN → (False, reason mentioning access token)."""
        with patch("mira.providers.publish.keys.has", return_value=False):
            ok, reason = can_publish("instagram")
        self.assertFalse(ok)
        self.assertTrue(len(reason) > 0, "reason should be non-empty")

    def test_youtube_true_when_cred_present(self):
        """When YOUTUBE_CLIENT_SECRET_JSON is set → (True, '')."""
        with patch("mira.providers.publish.keys.has", return_value=True):
            ok, reason = can_publish("youtube")
        self.assertTrue(ok)
        self.assertEqual(reason, "")

    def test_unknown_platform(self):
        """Unknown platform name → (False, reason)."""
        ok, reason = can_publish("tiktok")
        self.assertFalse(ok)
        self.assertIn("Unknown platform", reason)


class TestPublishDryRun(unittest.TestCase):
    """publish() with dry_run=True (default) — no network, disclosure always True."""

    def _auto_channel(self, **overrides):
        base = {
            "id": "chn_quickwins",
            "trust": "auto_publish",
            "platforms": ["youtube"],
        }
        return {**base, **overrides}

    def _approved_video(self, **overrides):
        base = {"id": "vid_abc", "state": "approved", "title": "Test Video"}
        return {**base, **overrides}

    def test_dry_run_default_no_network(self):
        """Default dry_run=True returns action='dry_run' without any network call."""
        with patch("mira.providers.publish.keys.has", return_value=True):
            result = publish(self._approved_video(), self._auto_channel())
        self.assertEqual(result["action"], "dry_run")
        self.assertTrue(result["disclosure"],
                        "disclosure must be True (POLICY §4 rule 9)")

    def test_dry_run_explicit_false_no_creds(self):
        """dry_run=False but creds missing → action='dry_run' (not 'publish')."""
        with patch("mira.providers.publish.keys.has", return_value=False):
            result = publish(
                self._approved_video(),
                self._auto_channel(),
                dry_run=False,
            )
        # Without creds, even explicit dry_run=False must not attempt network.
        self.assertNotEqual(result["action"], "publish",
                            "Should not publish when credentials are absent")
        self.assertTrue(result["disclosure"])

    def test_disclosure_always_true(self):
        """disclosure is True regardless of dry_run or channel trust."""
        for trust in ("auto_publish", "review_all"):
            channel = self._auto_channel(trust=trust)
            video = self._approved_video()
            with patch("mira.providers.publish.keys.has", return_value=False):
                result = publish(video, channel, dry_run=True)
            self.assertTrue(result["disclosure"], f"disclosure False for trust={trust}")

    def test_result_contains_required_keys(self):
        """Result dict contains all expected keys."""
        expected_keys = {
            "platform", "action", "title", "video_id",
            "channel_id", "would_post_at", "disclosure", "reason",
        }
        with patch("mira.providers.publish.keys.has", return_value=False):
            result = publish(self._approved_video(), self._auto_channel())
        self.assertTrue(expected_keys.issubset(result.keys()),
                        f"Missing keys: {expected_keys - result.keys()}")


class TestPublishHoldGate(unittest.TestCase):
    """review_all channel + non-approved video → action 'hold'."""

    def _review_channel(self):
        return {
            "id": "chn_aitools",
            "trust": "review_all",
            "platforms": ["youtube"],
        }

    def test_review_all_non_approved_holds(self):
        """review_all channel with state='in_review' → action='hold'."""
        video = {"id": "vid_xyz", "state": "in_review", "title": "Pending"}
        result = publish(video, self._review_channel(), dry_run=True)
        self.assertEqual(result["action"], "hold")
        self.assertTrue(result["disclosure"])
        self.assertIn("review_all", result["reason"])

    def test_review_all_draft_holds(self):
        video = {"id": "vid_draft", "state": "draft"}
        result = publish(video, self._review_channel())
        self.assertEqual(result["action"], "hold")

    def test_review_all_approved_proceeds(self):
        """review_all + state='approved' → NOT 'hold' (passes the gate)."""
        video = {"id": "vid_ok", "state": "approved", "title": "Approved"}
        with patch("mira.providers.publish.keys.has", return_value=False):
            result = publish(video, self._review_channel(), dry_run=True)
        # Should be dry_run (no creds), not hold.
        self.assertNotEqual(result["action"], "hold",
                            "Approved video on review_all channel should not hold")


if __name__ == "__main__":
    unittest.main()
