"""Local engine supervisor — lifecycle for on-device engines (LM Studio, ComfyUI).

Operating model: the user controls everything from the dashboard, never a terminal.
The backend owns engine lifecycle:

* ``status()``      — live state of every local engine (running / installed / managed).
* ``start(name)``   — spawn a spawnable engine (ComfyUI) if installed and not running.
* ``stop(name)``    — terminate an engine we previously spawned.
* ``ensure_all()``  — called on backend boot: auto-starts every installed, auto-start
                      engine that isn't already running. Missing engines no-op cleanly.

Engine kinds
------------
* ``managed_external`` — a GUI app we DETECT but don't spawn (LM Studio). The user
  launches it once; we never shell out to start it.
* ``spawnable``        — a server we can launch as a detached subprocess (ComfyUI).

Everything is stdlib-only and degrades gracefully: a not-installed engine is a
first-class state, not an error.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from mira import config
from mira.probe import port_open

# ── Engine registry ───────────────────────────────────────────────────────────
ENGINES: dict[str, dict] = {
    "lmstudio": {
        "label": "LM Studio",
        "port": 1234,
        "kind": "managed_external",   # GUI app — detected, never spawned
        "optional": False,            # primary local LLM
        "autostart": False,
        "install_url": "https://lmstudio.ai",
        "note": "Local script LLM. Launch the LM Studio app once and enable its server.",
    },
    "comfyui": {
        "label": "ComfyUI",
        "port": 8188,
        "kind": "spawnable",          # backend can launch it
        "optional": True,             # pipeline works without it (Veo/stock cover b-roll)
        "autostart": True,            # auto-start on backend boot when installed
        "install_url": "https://github.com/comfyanonymous/ComfyUI",
        "note": "Optional local AI b-roll. Auto-starts when installed at a known path.",
    },
}

# Where ComfyUI might live; first dir containing main.py wins.
_COMFY_CANDIDATES = [
    "~/ComfyUI", "~/comfyui",
    "~/Documents/ComfyUI", "~/Documents/ComfyUI/ComfyUI",
    "~/Applications/ComfyUI", "~/Desktop/ComfyUI",
]


# ── State (pids of engines we spawned) ─────────────────────────────────────────

def _state_path() -> Path:
    return config.ensure_state_dir() / "engines.json"


def _read_state() -> dict:
    p = _state_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


def _write_state(state: dict) -> None:
    _state_path().write_text(json.dumps(state, indent=2))


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# ── Install detection ───────────────────────────────────────────────────────────

def comfyui_install_dir() -> Path | None:
    """Return the ComfyUI install directory, or None if not found.

    Priority: env ``COMFYUI_DIR`` → config.toml ``comfyui_dir`` → common locations.
    A directory only counts when it contains ``main.py``.
    """
    env = os.environ.get("COMFYUI_DIR")
    if env:
        d = Path(env).expanduser()
        return d if (d / "main.py").exists() else None

    cfg = config.load_config()
    cfg_dir = cfg.get("comfyui_dir")
    if cfg_dir:
        d = Path(cfg_dir).expanduser()
        if (d / "main.py").exists():
            return d

    for cand in _COMFY_CANDIDATES:
        d = Path(cand).expanduser()
        if (d / "main.py").exists():
            return d
    return None


def _python_for(install_dir: Path) -> str:
    """Prefer the engine's own venv interpreter; fall back to the current one."""
    for rel in (".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe"):
        p = install_dir / rel
        if p.exists():
            return str(p)
    return sys.executable


def _installed(name: str) -> bool:
    if name == "comfyui":
        return comfyui_install_dir() is not None
    if name == "lmstudio":
        # GUI app: treat reachable port OR presence of the .app as "installed".
        return port_open("127.0.0.1", ENGINES[name]["port"]) or _lmstudio_app_present()
    return False


def _lmstudio_app_present() -> bool:
    for cand in ("/Applications/LM Studio.app", "~/Applications/LM Studio.app"):
        if Path(cand).expanduser().exists():
            return True
    return False


# ── Status ─────────────────────────────────────────────────────────────────────

def _lmstudio_models() -> list[str]:
    """Best-effort list of loaded LM Studio model ids (empty on any failure)."""
    url = config.DEFAULT_BASE_URLS["lmstudio"].rstrip("/") + "/models"
    try:
        with urllib.request.urlopen(url, timeout=0.8) as r:
            data = json.loads(r.read().decode())
        return [m.get("id", "") for m in data.get("data", []) if m.get("id")]
    except Exception:
        return []


def status(name: str | None = None) -> dict:
    """Return live status for one engine (if *name*) or all engines.

    Each entry: {label, kind, port, optional, running, installed, managed, pid,
                 url, note, install_url, [models]}.
    """
    if name is not None:
        return _status_one(name)
    return {n: _status_one(n) for n in ENGINES}


def _status_one(name: str) -> dict:
    spec = ENGINES[name]
    port = spec["port"]
    running = port_open("127.0.0.1", port)
    state = _read_state().get(name, {})
    pid = state.get("pid")
    out = {
        "label": spec["label"],
        "kind": spec["kind"],
        "port": port,
        "optional": spec["optional"],
        "running": running,
        "installed": _installed(name),
        "managed": spec["kind"] == "spawnable",   # backend can start/stop it
        "pid": pid if (pid and _pid_alive(pid)) else None,
        "url": f"http://127.0.0.1:{port}",
        "note": spec["note"],
        "install_url": spec["install_url"],
    }
    if name == "lmstudio" and running:
        out["models"] = _lmstudio_models()
    return out


# ── Lifecycle ────────────────────────────────────────────────────────────────────

def start(name: str, *, wait_s: float = 30.0) -> dict:
    """Start a spawnable engine. Returns a result dict (never raises for normal cases).

    Result keys: ok (bool), engine, running, reason?, hint?, pid?, log?.
    """
    if name not in ENGINES:
        return {"ok": False, "engine": name, "reason": "unknown_engine"}
    spec = ENGINES[name]

    if port_open("127.0.0.1", spec["port"]):
        return {"ok": True, "engine": name, "running": True, "reason": "already_running"}

    if spec["kind"] == "managed_external":
        return {
            "ok": False, "engine": name, "running": False, "reason": "external",
            "hint": f"Launch the {spec['label']} app, then enable its local server.",
            "install_url": spec["install_url"],
        }

    if name == "comfyui":
        return _start_comfyui(wait_s=wait_s)
    return {"ok": False, "engine": name, "reason": "not_spawnable"}


def _start_comfyui(*, wait_s: float) -> dict:
    install = comfyui_install_dir()
    if install is None:
        return {
            "ok": False, "engine": "comfyui", "running": False,
            "reason": "not_installed",
            "hint": "Install ComfyUI, or set COMFYUI_DIR / config.toml comfyui_dir to its folder. "
                    "It auto-starts from then on. (Optional — the pipeline runs without it.)",
            "install_url": ENGINES["comfyui"]["install_url"],
        }

    port = ENGINES["comfyui"]["port"]
    log_dir = config.ensure_state_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "comfyui.log"
    py = _python_for(install)

    log_fh = open(log_path, "ab")
    try:
        proc = subprocess.Popen(
            [py, "main.py", "--port", str(port)],
            cwd=str(install),
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,          # own process group → clean teardown
        )
    except Exception as exc:
        log_fh.close()
        return {"ok": False, "engine": "comfyui", "running": False,
                "reason": "spawn_failed", "hint": str(exc)}

    st = _read_state()
    st["comfyui"] = {"pid": proc.pid, "port": port, "started_at": time.time(),
                     "log": str(log_path), "dir": str(install)}
    _write_state(st)

    deadline = time.time() + wait_s
    while time.time() < deadline:
        if port_open("127.0.0.1", port):
            return {"ok": True, "engine": "comfyui", "running": True,
                    "pid": proc.pid, "log": str(log_path)}
        if proc.poll() is not None:           # died early
            return {"ok": False, "engine": "comfyui", "running": False,
                    "reason": "exited", "hint": f"see log: {log_path}"}
        time.sleep(0.5)
    return {"ok": False, "engine": "comfyui", "running": False,
            "reason": "timeout", "pid": proc.pid, "log": str(log_path),
            "hint": f"still starting after {wait_s:.0f}s; check {log_path}"}


def stop(name: str) -> dict:
    """Stop an engine we spawned. Managed-external engines can't be stopped here."""
    if name not in ENGINES:
        return {"ok": False, "engine": name, "reason": "unknown_engine"}
    if ENGINES[name]["kind"] == "managed_external":
        return {"ok": False, "engine": name, "reason": "external",
                "hint": f"Quit the {ENGINES[name]['label']} app to stop it."}

    st = _read_state()
    rec = st.get(name)
    if not rec or not rec.get("pid"):
        return {"ok": False, "engine": name, "reason": "not_managed",
                "hint": "Not started by Mira (no tracked pid)."}
    pid = rec["pid"]
    if not _pid_alive(pid):
        st.pop(name, None)
        _write_state(st)
        return {"ok": True, "engine": name, "running": False, "reason": "already_stopped"}

    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True)
        else:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
    except Exception as exc:
        return {"ok": False, "engine": name, "reason": "kill_failed", "hint": str(exc)}

    st.pop(name, None)
    _write_state(st)
    return {"ok": True, "engine": name, "running": False}


def ensure_all() -> dict:
    """Backend-boot hook: auto-start every installed, autostart, spawnable engine.

    Returns {engine: result}. Never raises — a missing/already-running engine is fine.
    """
    results: dict[str, dict] = {}
    for name, spec in ENGINES.items():
        if not spec.get("autostart"):
            continue
        if port_open("127.0.0.1", spec["port"]):
            results[name] = {"ok": True, "engine": name, "running": True,
                             "reason": "already_running"}
            continue
        if spec["kind"] == "spawnable" and _installed(name):
            results[name] = start(name)
        else:
            results[name] = {"ok": False, "engine": name, "running": False,
                             "reason": "not_installed", "skipped": True}
    return results
