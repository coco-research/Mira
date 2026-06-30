"""Offline tests for the Pexels stock route + Pillow caption burn-in.

All network paths are guarded by ``MIRA_STOCK=offline`` so the suite never calls
Pexels even though a real key now lives in ``.env``.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

ffprobe_required = pytest.mark.skipif(
    shutil.which("ffprobe") is None and not Path("/opt/homebrew/bin/ffprobe").exists(),
    reason="ffprobe not available",
)


class TestKeywords:
    def test_strips_stopwords_and_dedupes(self) -> None:
        from mira.providers.stock import _keywords
        q = _keywords("You need to know the three free AI tools every student should know")
        assert "the" not in q.split() and "you" not in q.split()
        assert "free" in q or "tools" in q or "student" in q
        # order-preserving, deduped, capped
        assert len(q.split()) <= 5
        assert len(q.split()) == len(set(q.split()))

    def test_empty_text_yields_fallback_query(self) -> None:
        from mira.providers.stock import _keywords
        assert _keywords("   ").strip() != ""


class TestOrientationAndFilePick:
    def test_orientation(self) -> None:
        from mira.providers.stock import _orientation
        assert _orientation((1080, 1920)) == "portrait"
        assert _orientation((1920, 1080)) == "landscape"
        assert _orientation((512, 512)) == "square"

    def test_best_file_prefers_covering_then_smallest(self) -> None:
        from mira.providers.stock import _best_file
        files = [
            {"link": "tiny", "width": 240, "height": 426},
            {"link": "ok", "width": 720, "height": 1280},
            {"link": "huge", "width": 2160, "height": 3840},
        ]
        # target height 1920*0.6 = 1152 → smallest file whose height >= 1152 is "ok"
        assert _best_file(files, (1080, 1920)) == "ok"

    def test_best_file_falls_back_to_largest_when_none_cover(self) -> None:
        from mira.providers.stock import _best_file
        files = [
            {"link": "tiny", "width": 240, "height": 426},
            {"link": "small", "width": 360, "height": 640},
        ]
        assert _best_file(files, (1080, 1920)) == "small"

    def test_best_file_raises_when_empty(self) -> None:
        from mira.providers.stock import _best_file
        with pytest.raises(ValueError):
            _best_file([], (1080, 1920))


class TestOfflineGuard:
    def test_offline_forced_env(self, monkeypatch) -> None:
        from mira.providers import stock
        monkeypatch.setenv("MIRA_STOCK", "offline")
        assert stock._offline_forced() is True
        monkeypatch.setenv("MIRA_STOCK", "")
        assert stock._offline_forced() is False

    @ffprobe_required
    def test_scene_clip_offline_ignores_key(self, tmp_path: Path, monkeypatch) -> None:
        """With MIRA_STOCK=offline, scene_clip never touches the network."""
        monkeypatch.setenv("MIRA_STOCK", "offline")
        monkeypatch.setenv("PEXELS_API_KEY", "should-not-be-used")
        from mira.providers.stock import scene_clip
        out = str(tmp_path / "c.mp4")
        scene_clip("ocean waves", 1.0, (128, 228), out, burn_text="hello", variant=2)
        assert Path(out).exists() and Path(out).stat().st_size > 0


class TestCaptionPng:
    def test_caption_png_created_with_alpha(self, tmp_path: Path) -> None:
        from mira.providers.burn import caption_png
        from PIL import Image
        out = str(tmp_path / "cap.png")
        caption_png("Three free AI tools every student should know about today", (540, 960), out)
        img = Image.open(out)
        assert img.size == (540, 960)
        assert img.mode == "RGBA"
        # Some pixels are opaque (the band/text drew something).
        alpha = img.getchannel("A").getextrema()
        assert alpha[1] > 0

    def test_empty_text_is_fully_transparent(self, tmp_path: Path) -> None:
        from mira.providers.burn import caption_png
        from PIL import Image
        out = str(tmp_path / "blank.png")
        caption_png("   ", (320, 568), out)
        img = Image.open(out)
        assert img.getchannel("A").getextrema() == (0, 0)


class TestCliVisualChoice:
    def test_visual_accepts_stock(self) -> None:
        from mira.cli import _build_parser
        args = _build_parser().parse_args(["generate", "--topic", "x", "--visual", "stock"])
        assert args.visual == "stock"
