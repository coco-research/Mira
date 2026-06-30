"""Tests for mira.providers.dub — offline and provider-selection behaviour.

All tests run without network access.  API-key tests use monkeypatch to inject
a fake key so no real call is made (Sarvam path is a stub in dub.py).
"""
from __future__ import annotations

import os
import shutil

import pytest

import mira.keys as _keys_mod
from mira.providers.dub import dub

# ── fixtures ──────────────────────────────────────────────────────────────────

SAMPLE_SCENES = [
    {"start_s": 0.0,  "end_s": 3.5,  "text": "Welcome to this documentary."},
    {"start_s": 4.0,  "end_s": 8.0,  "text": "Today we explore artificial intelligence."},
    {"start_s": 8.5,  "end_s": 12.0, "text": "Let us begin our journey."},
]

SAMPLE_SRT = """\
1
00:00:00,000 --> 00:00:03,500
Welcome to this documentary.

2
00:00:04,000 --> 00:00:08,000
Today we explore artificial intelligence.

3
00:00:08,500 --> 00:00:12,000
Let us begin our journey.
"""

_HAS_FFMPEG = bool(
    shutil.which("ffmpeg") or os.path.exists("/opt/homebrew/bin/ffmpeg")
)


def _no_sarvam(monkeypatch) -> None:
    """Remove SARVAM_API_KEY from env and bust the keys cache."""
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    _keys_mod._cache = None


# ── offline / no-key path ─────────────────────────────────────────────────────

class TestDubOffline:
    def test_aligned_always_true(self, monkeypatch, tmp_path) -> None:
        """aligned must be True regardless of which provider is selected."""
        _no_sarvam(monkeypatch)
        out = str(tmp_path / "dub.wav")
        result = dub(SAMPLE_SCENES, lang="hi", out_path=out)
        assert result["aligned"] is True

    def test_lang_preserved(self, monkeypatch, tmp_path) -> None:
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "dub.wav"))
        assert result["lang"] == "hi"

    def test_provider_not_sarvam_without_key(self, monkeypatch, tmp_path) -> None:
        """Without SARVAM_API_KEY the provider must not be 'sarvam'."""
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "dub.wav"))
        assert result["provider"] != "sarvam", (
            f"Expected non-sarvam provider, got {result['provider']!r}"
        )

    def test_timing_count_matches_input_scenes(self, monkeypatch, tmp_path) -> None:
        """Returned segments must have the same count as the input scenes."""
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "dub.wav"))
        assert len(result["segments"]) == len(SAMPLE_SCENES)

    @pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg not installed")
    def test_offline_silent_produces_file(self, monkeypatch, tmp_path) -> None:
        """Silent-track provider must write a real file."""
        _no_sarvam(monkeypatch)
        # Patch _try_edge_tts to always return False so we reach the silent path.
        import mira.providers.dub as dub_mod
        monkeypatch.setattr(dub_mod, "_try_edge_tts", lambda *a, **kw: False)

        out = str(tmp_path / "silent.wav")
        result = dub(SAMPLE_SCENES, lang="hi", out_path=out)
        assert result["provider"] == "silent"
        assert result["audio_path"] is not None
        assert os.path.exists(result["audio_path"])
        assert os.path.getsize(result["audio_path"]) > 0

    @pytest.mark.skipif(not _HAS_FFMPEG, reason="ffmpeg not installed")
    def test_silent_path_returned_with_ffmpeg(self, monkeypatch, tmp_path) -> None:
        """When ffmpeg is present, audio_path must be set on the silent path."""
        _no_sarvam(monkeypatch)
        import mira.providers.dub as dub_mod
        monkeypatch.setattr(dub_mod, "_try_edge_tts", lambda *a, **kw: False)

        out = str(tmp_path / "s2.wav")
        result = dub(SAMPLE_SCENES, lang="hi", out_path=out)
        assert result["audio_path"] == out


# ── SRT string input ──────────────────────────────────────────────────────────

class TestDubSrtInput:
    def test_srt_segment_count(self, monkeypatch, tmp_path) -> None:
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SRT, lang="hi", out_path=str(tmp_path / "dub.wav"))
        assert len(result["segments"]) == 3

    def test_srt_first_segment_timing(self, monkeypatch, tmp_path) -> None:
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SRT, lang="hi", out_path=str(tmp_path / "dub.wav"))
        seg = result["segments"][0]
        assert abs(seg["start_s"] - 0.0) < 0.01
        assert abs(seg["end_s"] - 3.5) < 0.01

    def test_srt_text_preserved(self, monkeypatch, tmp_path) -> None:
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SRT, lang="hi", out_path=str(tmp_path / "dub.wav"))
        assert "Welcome" in result["segments"][0]["text"]

    def test_srt_aligned_true(self, monkeypatch, tmp_path) -> None:
        _no_sarvam(monkeypatch)
        result = dub(SAMPLE_SRT, lang="hi", out_path=str(tmp_path / "dub.wav"))
        assert result["aligned"] is True


# ── Sarvam stub (key injected) ────────────────────────────────────────────────

class TestDubSarvamStub:
    def test_provider_is_sarvam_with_key(self, monkeypatch, tmp_path) -> None:
        monkeypatch.setenv("SARVAM_API_KEY", "test-key-stub-12345")
        _keys_mod._cache = None

        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "s.wav"))
        assert result["provider"] == "sarvam"

    def test_sarvam_aligned_true(self, monkeypatch, tmp_path) -> None:
        monkeypatch.setenv("SARVAM_API_KEY", "test-key-stub-12345")
        _keys_mod._cache = None

        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "s.wav"))
        assert result["aligned"] is True

    def test_sarvam_request_shape_present(self, monkeypatch, tmp_path) -> None:
        monkeypatch.setenv("SARVAM_API_KEY", "test-key-stub-12345")
        _keys_mod._cache = None

        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "s.wav"))
        assert "_request_shape" in result
        shape = result["_request_shape"]
        assert shape["model"] == "bulbul:v1"
        assert len(shape["inputs"]) == len(SAMPLE_SCENES)
        assert shape["target_language_code"] == "hi-IN"

    def test_sarvam_segment_count(self, monkeypatch, tmp_path) -> None:
        monkeypatch.setenv("SARVAM_API_KEY", "test-key-stub-12345")
        _keys_mod._cache = None

        result = dub(SAMPLE_SCENES, lang="hi", out_path=str(tmp_path / "s.wav"))
        assert len(result["segments"]) == len(SAMPLE_SCENES)
