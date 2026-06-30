"""Tests for the local engine supervisor + its API routes (no real spawning)."""
import os

import pytest

from mira import engines, api


def test_status_shape_all_engines(monkeypatch):
    # Avoid real network / model probing for a deterministic shape check.
    monkeypatch.setattr(engines, "port_open", lambda *a, **k: False)
    st = engines.status()
    assert set(st) == {"lmstudio", "comfyui"}
    for key in ("label", "kind", "port", "optional", "running", "installed", "managed", "url"):
        assert key in st["lmstudio"] and key in st["comfyui"]
    # ComfyUI is backend-managed (spawnable); LM Studio is detected-only.
    assert st["comfyui"]["managed"] is True
    assert st["lmstudio"]["managed"] is False
    assert st["comfyui"]["optional"] is True


def test_start_unknown_engine():
    res = engines.start("nope")
    assert res["ok"] is False and res["reason"] == "unknown_engine"


def test_lmstudio_cannot_be_spawned(monkeypatch):
    monkeypatch.setattr(engines, "port_open", lambda *a, **k: False)
    res = engines.start("lmstudio")
    assert res["ok"] is False and res["reason"] == "external"


def test_start_comfyui_not_installed(monkeypatch):
    monkeypatch.setattr(engines, "port_open", lambda *a, **k: False)
    monkeypatch.setattr(engines, "comfyui_install_dir", lambda: None)
    res = engines.start("comfyui")
    assert res["ok"] is False
    assert res["reason"] == "not_installed"
    assert "install_url" in res


def test_comfyui_install_dir_via_env(tmp_path, monkeypatch):
    # Empty dir → not a valid install (no main.py).
    monkeypatch.setenv("COMFYUI_DIR", str(tmp_path))
    assert engines.comfyui_install_dir() is None
    # With main.py → recognised.
    (tmp_path / "main.py").write_text("# comfyui entrypoint\n")
    assert engines.comfyui_install_dir() == tmp_path


def test_ensure_all_no_spawn_when_missing(monkeypatch):
    monkeypatch.setattr(engines, "port_open", lambda *a, **k: False)
    monkeypatch.setattr(engines, "_installed", lambda name: False)
    res = engines.ensure_all()
    assert "comfyui" in res
    assert res["comfyui"].get("skipped") is True   # nothing spawned


def test_stop_comfyui_when_not_managed(monkeypatch):
    monkeypatch.setattr(engines, "_read_state", lambda: {})
    res = engines.stop("comfyui")
    assert res["ok"] is False and res["reason"] == "not_managed"


def test_api_engines_status_route(monkeypatch):
    monkeypatch.setattr(engines, "port_open", lambda *a, **k: False)
    code, body = api.dispatch("/engines/status")
    assert code == 200 and "comfyui" in body


def test_api_post_unknown_engine():
    code, body = api.dispatch_post("/engine/start", {"name": ["bogus"]})
    assert code == 400


def test_api_post_start_lmstudio_is_external(monkeypatch):
    monkeypatch.setattr(engines, "port_open", lambda *a, **k: False)
    code, body = api.dispatch_post("/engine/start", {"name": ["lmstudio"]})
    assert code == 200 and body["reason"] == "external"
