"""Integration test: full offline generate() pipeline.

Generates a ~6 s faceless short using the chn_aitools fixture channel.
Small size (256×456) keeps the suite fast (<20 s total).

Skips when ffmpeg/ffprobe are not installed.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

# Ensure /opt/homebrew/bin is on PATH so ffmpeg/ffprobe are findable.
_brew_bin = "/opt/homebrew/bin"
if _brew_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{_brew_bin}:{os.environ.get('PATH', '')}"

# ── skip guard ────────────────────────────────────────────────────────────────

def _ffmpeg_ok() -> bool:
    return bool(shutil.which("ffmpeg") or Path("/opt/homebrew/bin/ffmpeg").exists())


def _ffprobe_ok() -> bool:
    return bool(shutil.which("ffprobe") or Path("/opt/homebrew/bin/ffprobe").exists())


pytestmark = pytest.mark.skipif(
    not (_ffmpeg_ok() and _ffprobe_ok()),
    reason="ffmpeg/ffprobe not installed — skipping pipeline integration test",
)

# ── fixtures / helpers ────────────────────────────────────────────────────────

TARGET_S = 6.0
TOLERANCE_S = 1.5
SMALL_SIZE = (256, 456)

# A minimal test band that encompasses our ~6 s target.
TEST_BAND = {"min_s": 3, "max_s": 12, "hard_cap_s": 15}

_CHANNEL = {
    "id": "chn_aitools",
    "name": "Mira AI Tools",
    "language": "en",
    "video_type": "short",
    "aspect": "9:16",
    "faceless": True,
    "lane": "faceless",
    "trust": "review_all",
    "length_band": {"min_s": 30, "max_s": 60, "hard_cap_s": 75},
}

_TOPIC = {
    "id": "top_test01",
    "channel_id": "chn_aitools",
    "title": "5 free AI tools that feel illegal to know",
    "source": "manual",
}


# ── test ──────────────────────────────────────────────────────────────────────

def test_generate_produces_valid_mp4(tmp_path: Path, monkeypatch) -> None:
    """End-to-end pipeline: script → tts → clips → srt → compose → probe."""
    monkeypatch.setenv("MIRA_TTS", "offline")  # keep the suite network-free + fast
    monkeypatch.setenv("MIRA_LLM", "offline")  # don't hit a live LM Studio model
    monkeypatch.setenv("MIRA_STOCK", "offline")  # don't hit Pexels with a real key
    from mira.pipeline import generate
    from mira.duration import probe_duration, verify_clip
    from mira.cost import read_cost_log
    from mira.providers.captions import parse_srt

    state_dir = tmp_path / "state"
    result = generate(
        channel=_CHANNEL,
        topic=_TOPIC,
        out_dir=tmp_path / "out",
        target_s=TARGET_S,
        state_dir=state_dir,
        size=SMALL_SIZE,
    )

    # ── artifact presence ─────────────────────────────────────────────────────
    final_mp4 = Path(result["artifacts"]["video"])
    assert final_mp4.exists(), f"final.mp4 not found at {final_mp4}"
    assert final_mp4.stat().st_size > 0, "final.mp4 is empty"

    srt_path = Path(result["artifacts"]["captions"])
    assert srt_path.exists(), f"captions.srt not found at {srt_path}"

    # ── duration check ────────────────────────────────────────────────────────
    actual = probe_duration(str(final_mp4))
    assert actual is not None, "ffprobe could not read final.mp4 duration"
    assert abs(actual - TARGET_S) <= TOLERANCE_S, (
        f"Duration {actual:.2f}s is outside ±{TOLERANCE_S}s of target {TARGET_S}s"
    )

    # verify_clip against a small band that encompasses 6 s.
    vc = verify_clip(str(final_mp4), TEST_BAND)
    assert vc["ok"], (
        f"verify_clip failed: duration={vc['duration_s']}, in_band={vc['in_band']}"
    )

    # ── captions parse ────────────────────────────────────────────────────────
    cues = parse_srt(str(srt_path))
    assert len(cues) >= 1, "captions.srt has no cues"
    # Each cue must have a non-empty text field.
    for cue in cues:
        assert cue["text"], f"Empty cue at index {cue['index']}"

    # ── cost log has ≥ 3 entries ──────────────────────────────────────────────
    log = read_cost_log(path=state_dir / "cost_log.json")
    assert len(log) >= 3, f"Expected ≥3 cost entries, got {len(log)}: {log}"

    # All entries must reference the correct video_id.
    vid_id = result["id"]
    assert all(e["video_id"] == vid_id for e in log), (
        "Some cost entries have mismatched video_id"
    )

    # ── result shape ──────────────────────────────────────────────────────────
    assert result["state"] == "draft"
    assert result["aspect"] == "9:16"
    assert result["duration_s"] is not None
    assert "qa" in result
