"""Offline tests for the key-free visual pivot.

Covers the designed-engine adapters, the LM Studio LLM helpers, the bench
manifest API routes, and CLI argument wiring — all without launching Node,
rendering video, or hitting a live model.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from mira import api, config
from mira.cli import _build_parser
from mira.providers import designed, llm


# ── designed.py: scene → engine inputs (no subprocess) ───────────────────────────

def test_scene_list_filters_empty_and_enforces_minimum():
    scenes = [{"text": "  ", "seconds": 5}, {"text": "Real line", "seconds": 0.1}]
    out = designed._scene_list(scenes)
    assert len(out) == 1
    assert out[0]["text"] == "Real line"
    assert out[0]["seconds"] >= 0.6  # clamped minimum


def test_scene_list_raises_when_no_text():
    with pytest.raises(designed.EngineUnavailable):
        designed._scene_list([{"text": "", "seconds": 3}])


def test_scenes_to_cuts_shape():
    cuts = designed._scenes_to_cuts(
        [{"text": "Hook", "seconds": 2.0}, {"text": "Body", "seconds": 3.0}]
    )
    assert cuts[0]["type"] == "hero_title"
    assert cuts[1]["type"] == "text_card"
    # Timeline is contiguous and increasing.
    assert cuts[0]["in_seconds"] == 0
    assert cuts[0]["out_seconds"] == 2.0
    assert cuts[1]["in_seconds"] == 2.0
    assert cuts[1]["out_seconds"] == 5.0


def test_hyperframes_html_is_well_formed():
    scenes = designed._scene_list([{"text": "A & B <tag>", "seconds": 2.0},
                                   {"text": "Second", "seconds": 2.0}])
    html = designed.hyperframes_html(scenes, (1080, 1920))
    assert 'data-composition-id="main"' in html
    assert 'data-width="1080"' in html and 'data-height="1920"' in html
    assert 'data-duration="4.0"' in html
    assert 'window.__timelines["main"]' in html
    # Text is HTML-escaped, not injected raw.
    assert "A &amp; B &lt;tag&gt;" in html
    assert "<tag>" not in html.split("<script")[0].split("card-text")[-1]


def test_render_unknown_engine_raises():
    with pytest.raises(designed.EngineUnavailable):
        designed.render("bogus", [{"text": "x", "seconds": 2}], (360, 640), "/tmp/x.mp4")


def test_render_remotion_missing_composer(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "REMOTION_COMPOSER_DIR", tmp_path / "nope")
    with pytest.raises(designed.EngineUnavailable):
        designed.render_remotion([{"text": "x", "seconds": 2}], (360, 640),
                                 str(tmp_path / "out.mp4"))


# ── llm.py: LM Studio + coercion (offline) ───────────────────────────────────────

def test_lmstudio_model_unreachable_returns_none():
    # A closed port → connection refused → None (never raises).
    assert llm.lmstudio_model("http://127.0.0.1:1/v1", timeout=0.3) is None


def test_offline_flag_forces_template(monkeypatch):
    monkeypatch.setenv("MIRA_LLM", "offline")
    result = llm.write_script("test topic", 6.0, {"language": "en"})
    assert llm.provider_used() == "offline-template"
    assert result["scenes"]


def test_coerce_script_fills_missing_seconds():
    raw = {"scenes": [{"text": "one"}, {"text": "two"}]}
    out = llm._coerce_script(raw, "topic", 6.0)
    assert len(out["scenes"]) == 2
    assert all(s["seconds"] > 0 for s in out["scenes"])
    assert out["script"]  # synthesised from scene text


def test_coerce_script_rejects_empty():
    with pytest.raises(ValueError):
        llm._coerce_script({"scenes": []}, "topic", 6.0)


def test_coerce_script_accepts_string_scenes():
    out = llm._coerce_script({"scenes": ["line a", "line b"]}, "topic", 6.0)
    assert [s["text"] for s in out["scenes"]] == ["line a", "line b"]


# ── api.py: bench manifest + safe video path ─────────────────────────────────────

def test_bench_route_empty_when_no_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    status, body = api.dispatch("/bench")
    assert status == 200
    assert body == {}


def test_bench_route_returns_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    bench_dir = tmp_path / "bench"
    bench_dir.mkdir()
    video = bench_dir / "remotion_final.mp4"
    video.write_bytes(b"\x00\x00fake")
    manifest = {"topic": "t", "engines": [{"engine": "remotion", "video": str(video), "ok": True}]}
    (bench_dir / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")

    status, body = api.dispatch("/bench")
    assert status == 200
    assert body["topic"] == "t"
    assert api._bench_video_path("remotion") == video.resolve()
    assert api._bench_video_path("hyperframes") is None  # not in manifest


def test_bench_video_path_rejects_traversal(monkeypatch, tmp_path):
    """A manifest pointing outside the bench dir must NOT be served."""
    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    bench_dir = tmp_path / "bench"
    bench_dir.mkdir()
    outside = tmp_path / "secret.mp4"
    outside.write_bytes(b"nope")
    manifest = {"engines": [{"engine": "remotion", "video": str(outside), "ok": True}]}
    (bench_dir / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert api._bench_video_path("remotion") is None


# ── cli.py: argument wiring (no execution) ───────────────────────────────────────

def test_cli_generate_accepts_visual_flag():
    ns = _build_parser().parse_args(["generate", "--topic", "x", "--visual", "hyperframes"])
    assert ns.visual == "hyperframes"


def test_cli_generate_visual_defaults_none():
    ns = _build_parser().parse_args(["generate", "--topic", "x"])
    assert ns.visual is None


def test_cli_bench_subcommand_parses():
    ns = _build_parser().parse_args(["bench", "--topic", "x", "--size", "1080x1920"])
    assert ns.command == "bench"
    assert ns.topic == "x"
    assert ns.size == "1080x1920"
