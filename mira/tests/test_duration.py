"""Tests for mira.duration — length-control math and ffprobe gate."""
import shutil
import subprocess

import pytest

from mira.duration import (
    duration_for_words,
    in_band,
    probe_duration,
    verify_clip,
    words_for_duration,
)


def test_round_trip_45s():
    """words_for_duration → duration_for_words should recover the original target."""
    assert duration_for_words(words_for_duration(45)) == pytest.approx(45, abs=1.0)


def test_words_for_60s_at_150wpm():
    assert words_for_duration(60, 150) == 150


class TestInBand:
    BAND = {"min_s": 30, "max_s": 60, "hard_cap_s": 75}

    def test_in_range(self):
        assert in_band(45.0, self.BAND) is True

    def test_above_hard_cap(self):
        assert in_band(80.0, self.BAND) is False

    def test_below_min(self):
        assert in_band(20.0, self.BAND) is False

    def test_at_min_boundary(self):
        assert in_band(30.0, self.BAND) is True

    def test_at_hard_cap_boundary(self):
        assert in_band(75.0, self.BAND) is True

    def test_above_max_but_below_hard_cap(self):
        # max_s is informational; hard_cap_s is the real ceiling
        assert in_band(70.0, self.BAND) is True


def test_ffprobe_clip(tmp_path):
    """Generate a ~2s black clip with ffmpeg and verify probe + in_band."""
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("ffmpeg not available")

    out = tmp_path / "out.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-f", "lavfi",
            "-i", "color=c=black:s=128x128:d=2",
            "-y",
            str(out),
        ],
        check=True,
        capture_output=True,
    )

    duration = probe_duration(str(out))
    assert duration is not None
    assert duration == pytest.approx(2.0, abs=0.4)

    band = {"min_s": 1, "max_s": 3, "hard_cap_s": 3}
    result = verify_clip(str(out), band)
    assert result["ok"] is True
    assert result["in_band"] is True
    assert result["duration_s"] == pytest.approx(2.0, abs=0.4)


def test_probe_missing_file():
    """probe_duration returns None for a non-existent path (ffprobe error)."""
    result = probe_duration("/nonexistent/path/clip.mp4")
    assert result is None


def test_verify_clip_missing_file():
    """verify_clip.ok is False when the file cannot be probed."""
    band = {"min_s": 1, "max_s": 3, "hard_cap_s": 3}
    result = verify_clip("/nonexistent/path/clip.mp4", band)
    assert result["ok"] is False
    assert result["duration_s"] is None
    assert result["in_band"] is None
