"""Tests for mira.clipfactory — hub-and-spoke short-clip factory.

All tests that touch ffmpeg/ffprobe are skipped when those binaries are absent.
Source clips are generated at runtime from ffmpeg lavfi (no fixture files needed).
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from mira.clipfactory import make_shorts
from mira.duration import probe_duration

# ── PATH / binary detection ───────────────────────────────────────────────────

_brew_bin = "/opt/homebrew/bin"
if _brew_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{_brew_bin}:{os.environ.get('PATH', '')}"

_HAS_FFMPEG = bool(
    shutil.which("ffmpeg") or Path("/opt/homebrew/bin/ffmpeg").exists()
)
_HAS_FFPROBE = bool(
    shutil.which("ffprobe") or Path("/opt/homebrew/bin/ffprobe").exists()
)
_HAS_BOTH = _HAS_FFMPEG and _HAS_FFPROBE

fftools_required = pytest.mark.skipif(
    not _HAS_BOTH,
    reason="ffmpeg and ffprobe are required for clip-factory tests",
)


# ── helper: create a small test source ───────────────────────────────────────

def _make_source(path: str, duration_s: float = 12.0) -> None:
    """Generate a tiny 320×180 16:9 test video via ffmpeg lavfi (video only)."""
    ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
    subprocess.run(
        [
            ff, "-y",
            "-f", "lavfi",
            "-i", f"testsrc=size=320x180:rate=25",
            "-t", str(duration_s),
            "-pix_fmt", "yuv420p",
            path,
        ],
        capture_output=True,
        check=True,
    )


def _video_stream(path: str) -> dict:
    """Return the first video stream dict from ffprobe -show_streams."""
    fp = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"
    result = subprocess.run(
        [fp, "-v", "quiet", "-print_format", "json", "-show_streams", path],
        capture_output=True, text=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    return next((s for s in streams if s.get("codec_type") == "video"), {})


# ── clip count and duration ───────────────────────────────────────────────────

class TestMakeShortsCount:
    @fftools_required
    def test_produces_at_least_3_clips_from_12s(self, tmp_path: Path) -> None:
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4)
        assert len(clips) >= 3, f"Expected >= 3 clips, got {len(clips)}"

    @fftools_required
    def test_exact_count_override(self, tmp_path: Path) -> None:
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), count=2, clip_s=4)
        assert len(clips) == 2

    @fftools_required
    def test_clips_are_real_files(self, tmp_path: Path) -> None:
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4)
        for clip in clips:
            assert Path(clip["path"]).exists(), f"Missing file: {clip['path']}"
            assert Path(clip["path"]).stat().st_size > 0


class TestMakeShortsMetadata:
    @fftools_required
    def test_metadata_keys_present(self, tmp_path: Path) -> None:
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4)
        for clip in clips:
            assert "path" in clip
            assert "start_s" in clip
            assert "duration_s" in clip

    @fftools_required
    def test_start_s_values_are_sequential(self, tmp_path: Path) -> None:
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4)
        for i, clip in enumerate(clips):
            assert abs(clip["start_s"] - i * 4.0) < 0.01, (
                f"Clip {i} start_s={clip['start_s']:.3f}, expected ~{i * 4.0}"
            )

    @fftools_required
    def test_duration_s_approx_clip_s(self, tmp_path: Path) -> None:
        """Each clip's metadata duration_s ≈ clip_s (within 0.01 s)."""
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4)
        for clip in clips:
            assert abs(clip["duration_s"] - 4.0) < 0.01, (
                f"duration_s={clip['duration_s']:.3f} deviates from 4.0"
            )


# ── actual file durations (ffprobe) ──────────────────────────────────────────

class TestMakeShortsRealDuration:
    @fftools_required
    def test_probed_duration_approx_clip_s(self, tmp_path: Path) -> None:
        """ffprobe-measured duration must be within ±0.6 s of clip_s."""
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4)
        for clip in clips:
            d = probe_duration(clip["path"])
            assert d is not None, f"ffprobe failed on {clip['path']}"
            assert abs(d - 4.0) < 0.6, (
                f"Probed duration {d:.3f}s not within ±0.6s of 4.0s"
            )


# ── aspect ratio ─────────────────────────────────────────────────────────────

class TestMakeShortsAspect:
    @fftools_required
    def test_output_is_portrait_9_16(self, tmp_path: Path) -> None:
        """Clips must have width/height ≈ 9/16 (± 0.1)."""
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4, aspect="9:16")
        assert clips, "No clips produced"
        for clip in clips:
            vs = _video_stream(clip["path"])
            assert vs, f"No video stream in {clip['path']}"
            w, h = int(vs["width"]), int(vs["height"])
            ratio = w / h
            assert abs(ratio - 9 / 16) < 0.1, (
                f"Expected 9:16 ratio, got {w}×{h} (ratio={ratio:.4f})"
            )

    @fftools_required
    def test_portrait_width_less_than_height(self, tmp_path: Path) -> None:
        """Width must be less than height for portrait (9:16) clips."""
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=12.0)
        clips = make_shorts(source, str(tmp_path / "out"), clip_s=4, aspect="9:16")
        for clip in clips:
            vs = _video_stream(clip["path"])
            w, h = int(vs["width"]), int(vs["height"])
            assert w < h, f"Expected portrait (w < h) but got {w}×{h}"


# ── output directory creation ─────────────────────────────────────────────────

class TestMakeShortsOutDir:
    @fftools_required
    def test_creates_missing_out_dir(self, tmp_path: Path) -> None:
        source = str(tmp_path / "src.mp4")
        _make_source(source, duration_s=8.0)
        new_dir = str(tmp_path / "new_subdir" / "clips")
        clips = make_shorts(source, new_dir, clip_s=4)
        assert Path(new_dir).is_dir()
        assert len(clips) >= 1
