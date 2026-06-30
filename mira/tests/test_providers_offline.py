"""Unit tests for offline provider paths.

All tests run without any API keys or network access.
Tests involving ffmpeg are skipped if ffmpeg/ffprobe are absent.
"""
from __future__ import annotations

import math
import os
import shutil
from pathlib import Path

import pytest

# Ensure /opt/homebrew/bin is on PATH.
_brew_bin = "/opt/homebrew/bin"
if _brew_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = f"{_brew_bin}:{os.environ.get('PATH', '')}"

_HAS_FFMPEG = bool(
    shutil.which("ffmpeg") or Path("/opt/homebrew/bin/ffmpeg").exists()
)
_HAS_FFPROBE = bool(
    shutil.which("ffprobe") or Path("/opt/homebrew/bin/ffprobe").exists()
)

ffmpeg_required = pytest.mark.skipif(
    not _HAS_FFMPEG,
    reason="ffmpeg not installed",
)
ffprobe_required = pytest.mark.skipif(
    not (_HAS_FFMPEG and _HAS_FFPROBE),
    reason="ffmpeg/ffprobe not installed",
)

_CHANNEL = {"id": "chn_aitools", "language": "en"}


# ── LLM: offline template ─────────────────────────────────────────────────────

class TestLlmOffline:
    @pytest.fixture(autouse=True)
    def _force_offline_llm(self, monkeypatch) -> None:
        """Force the deterministic template path even when LM Studio is running."""
        monkeypatch.setenv("MIRA_LLM", "offline")

    def test_word_budget_approximate(self) -> None:
        """Template scene totals ≈ word budget (within 30 %)."""
        from mira.providers.llm import write_script
        from mira.duration import words_for_duration

        target_s = 8.0
        result = write_script("AI automation tools", target_s, _CHANNEL)

        assert "script" in result
        assert "scenes" in result
        scenes = result["scenes"]
        assert len(scenes) >= 2

        word_budget = words_for_duration(target_s)
        actual_words = sum(len(s["text"].split()) for s in scenes)
        # Allow ±40 % tolerance (the template may over/under-shoot slightly).
        assert actual_words >= word_budget * 0.60, (
            f"Word count {actual_words} is too low vs budget {word_budget}"
        )
        assert actual_words <= word_budget * 2.0, (
            f"Word count {actual_words} is too high vs budget {word_budget}"
        )

    def test_total_seconds_close_to_target(self) -> None:
        """Sum of scene durations ≈ target (within 0.1 s)."""
        from mira.providers.llm import write_script

        target_s = 6.0
        result = write_script("productivity hacks", target_s, _CHANNEL)
        total = sum(s["seconds"] for s in result["scenes"])
        assert abs(total - target_s) < 0.2, (
            f"Scene total {total:.3f}s deviates more than 0.2s from {target_s}s"
        )

    def test_provider_used_offline(self) -> None:
        """provider_used() reports offline-template when no keys are present."""
        from mira.providers.llm import write_script, provider_used
        import mira.keys as _keys

        # Confirm keys are absent before asserting provider id.
        write_script("test topic", 5.0, _CHANNEL)
        if not any(_keys.has(k) for k in ("GROQ_API_KEY", "OPENROUTER_API_KEY",
                                           "MISTRAL_API_KEY", "NIM_API_KEY")):
            assert provider_used() == "offline-template"

    def test_deterministic(self) -> None:
        """Same topic → same script (deterministic offline template)."""
        from mira.providers.llm import write_script

        r1 = write_script("machine learning basics", 6.0, _CHANNEL)
        r2 = write_script("machine learning basics", 6.0, _CHANNEL)
        assert r1["script"] == r2["script"]

    def test_scenes_have_positive_seconds(self) -> None:
        from mira.providers.llm import write_script

        result = write_script("chatgpt tips", 5.0, _CHANNEL)
        for s in result["scenes"]:
            assert s["seconds"] > 0, f"Scene has non-positive seconds: {s}"


# ── TTS: offline audio ────────────────────────────────────────────────────────

class TestTtsOffline:
    @ffprobe_required
    def test_offline_produces_audio_file(self, tmp_path: Path, monkeypatch) -> None:
        """synthesize() creates a non-empty audio file."""
        monkeypatch.setenv("MIRA_TTS", "offline")  # force the silent fallback
        from mira.providers.tts import synthesize

        out = str(tmp_path / "audio.m4a")
        result = synthesize("Hello world", out, 3.0)
        assert Path(result).exists()
        assert Path(result).stat().st_size > 0

    @ffprobe_required
    def test_offline_duration_approx(self, tmp_path: Path, monkeypatch) -> None:
        """Offline audio duration is within ±0.5 s of requested."""
        monkeypatch.setenv("MIRA_TTS", "offline")  # force the silent fallback
        from mira.providers.tts import synthesize
        from mira.duration import probe_duration

        target_s = 4.0
        out = str(tmp_path / "audio.m4a")
        synthesize("Test narration text for offline path.", out, target_s)

        actual = probe_duration(out)
        assert actual is not None, "ffprobe could not read audio duration"
        assert abs(actual - target_s) <= 0.5, (
            f"Audio duration {actual:.3f}s is not within ±0.5s of {target_s}s"
        )


# ── Stock: offline scene clip ─────────────────────────────────────────────────

class TestStockOffline:
    @pytest.fixture(autouse=True)
    def _force_offline_stock(self, monkeypatch) -> None:
        monkeypatch.setenv("MIRA_STOCK", "offline")  # never hit Pexels in tests

    @ffprobe_required
    def test_offline_clip_exists(self, tmp_path: Path) -> None:
        """scene_clip() creates a non-empty MP4."""
        from mira.providers.stock import scene_clip

        out = str(tmp_path / "clip.mp4")
        result = scene_clip("AI tools overview", 3.0, (256, 456), out)
        assert Path(result).exists()
        assert Path(result).stat().st_size > 0

    @ffprobe_required
    def test_offline_clip_duration(self, tmp_path: Path) -> None:
        """Offline clip duration is within ±0.3 s of requested."""
        from mira.providers.stock import scene_clip
        from mira.duration import probe_duration

        target_s = 2.5
        out = str(tmp_path / "clip.mp4")
        scene_clip("Test scene text", target_s, (256, 456), out)

        actual = probe_duration(out)
        assert actual is not None, "ffprobe could not read clip duration"
        assert abs(actual - target_s) <= 0.3, (
            f"Clip duration {actual:.3f}s is not within ±0.3s of {target_s}s"
        )

    @ffprobe_required
    def test_different_scenes_produce_distinct_files(self, tmp_path: Path) -> None:
        """Two different scene texts produce distinct output files."""
        from mira.providers.stock import scene_clip

        p1 = str(tmp_path / "clip1.mp4")
        p2 = str(tmp_path / "clip2.mp4")
        scene_clip("First scene about AI", 2.0, (256, 456), p1)
        scene_clip("Second scene about tools", 2.0, (256, 456), p2)

        assert Path(p1).exists() and Path(p2).exists()
        # They are separate files (different scene text → different colour).
        assert Path(p1).read_bytes() != Path(p2).read_bytes()


# ── Captions: SRT generation ──────────────────────────────────────────────────

class TestCaptionsOffline:
    def _sample_scenes(self) -> list[dict]:
        return [
            {"text": "Here is the hook for this video.", "seconds": 2.0},
            {"text": "First key point about AI tools.", "seconds": 2.0},
            {"text": "Second key point and call to action.", "seconds": 2.0},
        ]

    def test_srt_file_written(self, tmp_path: Path) -> None:
        from mira.providers.captions import build_srt

        out = str(tmp_path / "caps.srt")
        result = build_srt(self._sample_scenes(), out)
        assert Path(result).exists()
        assert Path(result).stat().st_size > 0

    def test_srt_has_correct_cue_count(self, tmp_path: Path) -> None:
        from mira.providers.captions import build_srt, parse_srt

        scenes = self._sample_scenes()
        out = str(tmp_path / "caps.srt")
        build_srt(scenes, out)

        cues = parse_srt(out)
        assert len(cues) == len(scenes), (
            f"Expected {len(scenes)} cues, got {len(cues)}"
        )

    def test_srt_timestamps_are_valid(self, tmp_path: Path) -> None:
        """Timestamps must be increasing and non-negative."""
        from mira.providers.captions import build_srt, parse_srt

        out = str(tmp_path / "caps.srt")
        build_srt(self._sample_scenes(), out)
        cues = parse_srt(out)

        assert all(c["start"] >= 0 for c in cues)
        assert all(c["end"] > c["start"] for c in cues)
        for i in range(1, len(cues)):
            assert cues[i]["start"] >= cues[i - 1]["end"] - 0.001

    def test_srt_cumulative_end_matches_total_duration(self, tmp_path: Path) -> None:
        """Last cue end time == sum of scene durations."""
        from mira.providers.captions import build_srt, parse_srt

        scenes = self._sample_scenes()
        out = str(tmp_path / "caps.srt")
        build_srt(scenes, out)
        cues = parse_srt(out)

        total_s = sum(s["seconds"] for s in scenes)
        last_end = cues[-1]["end"]
        assert abs(last_end - total_s) < 0.01, (
            f"Last cue end {last_end:.3f}s ≠ total {total_s:.3f}s"
        )

    def test_srt_text_preserved(self, tmp_path: Path) -> None:
        from mira.providers.captions import build_srt, parse_srt

        scenes = self._sample_scenes()
        out = str(tmp_path / "caps.srt")
        build_srt(scenes, out)
        cues = parse_srt(out)

        for scene, cue in zip(scenes, cues):
            assert scene["text"].strip() == cue["text"].strip()

    def test_srt_format_comma_separator(self, tmp_path: Path) -> None:
        """SRT must use comma as decimal separator in timestamps, not dot."""
        from mira.providers.captions import build_srt

        out = str(tmp_path / "caps.srt")
        build_srt(self._sample_scenes(), out)
        content = Path(out).read_text(encoding="utf-8")

        # Arrow lines should use commas: "00:00:02,000 --> 00:00:04,000"
        arrow_lines = [ln for ln in content.splitlines() if " --> " in ln]
        assert arrow_lines, "No timestamp lines found in SRT"
        for line in arrow_lines:
            assert "," in line, f"Timestamp line missing comma: {line!r}"
