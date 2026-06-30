"""Phase-0 HTTP API for the mira command layer.

Stdlib-only: http.server + json. No pip installs.

``dispatch(path)`` is the pure function used by tests (no socket needed).
``make_handler()`` wraps it in a BaseHTTPRequestHandler subclass.
``serve(port)`` starts a ThreadingHTTPServer for live use.
"""
from __future__ import annotations

import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from mira import fixtures


# ── Pure dispatch (testable without a socket) ────────────────────────────────
# Routes return DEEP COPIES so a caller mutating the result can never corrupt
# the module-level fixtures (verification WARN fix). Live modules are imported
# lazily inside the route lambda so a missing sibling never breaks core routes.

def _engines() -> Any:
    from mira import registry
    return registry.provider_menu()


def _keys() -> Any:
    from mira import keys
    return keys.configured()


def _engine_status() -> Any:
    from mira import engines
    return engines.status()


def _bench() -> Any:
    """Return the latest A/B bench manifest, or {} when no bench has been run."""
    from mira import config
    manifest = config.STATE_DIR / "bench" / "latest.json"
    if not manifest.exists():
        return {}
    try:
        return json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _bench_video_path(engine: str) -> Path | None:
    """Resolve the on-disk MP4 for *engine* from the latest manifest, safely.

    Only paths recorded in the manifest AND living under the bench dir are
    served — never an arbitrary filesystem path from the query string.
    """
    from mira import config
    manifest = config.STATE_DIR / "bench" / "latest.json"
    if not manifest.exists():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        return None
    base = (config.STATE_DIR / "bench").resolve()
    for entry in data.get("engines", []):
        if entry.get("engine") == engine and entry.get("video"):
            vp = Path(entry["video"]).resolve()
            try:
                vp.relative_to(base)
            except ValueError:
                return None
            return vp if vp.exists() else None
    return None


_ROUTES: dict[str, Any] = {
    "/status": lambda: fixtures.TODAY,
    "/channels": lambda: fixtures.CHANNELS,
    "/library": lambda: fixtures.VIDEOS,
    "/videos": lambda: fixtures.VIDEOS,        # alias used by the n8n flow
    "/ideas": lambda: fixtures.IDEAS,
    "/cost": lambda: fixtures.COST_METER,
    "/support": lambda: fixtures.SUPPORT_ENVELOPE,
    "/engines": _engines,                      # live provider_menu() registry
    "/engines/status": _engine_status,         # live local-engine lifecycle state
    "/keys": _keys,                            # which keys are configured (no values)
    "/bench": _bench,                          # latest A/B engine-comparison manifest
}


def dispatch(path: str) -> tuple[int, object]:
    """Return (status_code, json-able object) for a GET *path*.

    Core routes use fixtures directly; never requires probe/cost/router. The
    body is deep-copied so mutation by a caller can't corrupt the fixtures.
    """
    handler = _ROUTES.get(path)
    if handler is None:
        return 404, {"error": "not found", "path": path}
    return 200, copy.deepcopy(handler())


# POST actions the dashboard can trigger (engine lifecycle). Kept tiny + explicit.
def dispatch_post(path: str, params: dict[str, list[str]]) -> tuple[int, object]:
    """Return (status_code, json-able object) for a POST *path* with query params."""
    name = (params.get("name") or [""])[0]
    if path == "/engine/start":
        from mira import engines
        if name not in engines.ENGINES:
            return 400, {"error": "unknown engine", "name": name}
        return 200, engines.start(name)
    if path == "/engine/stop":
        from mira import engines
        if name not in engines.ENGINES:
            return 400, {"error": "unknown engine", "name": name}
        return 200, engines.stop(name)
    return 404, {"error": "not found", "path": path}


# ── HTTP handler ─────────────────────────────────────────────────────────────

def make_handler() -> type[BaseHTTPRequestHandler]:
    """Return a BaseHTTPRequestHandler subclass for the dashboard API."""

    class _MiraHandler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: object) -> None:
            payload = json.dumps(body, indent=2, default=str).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            # The dashboard is opened from file:// or a different origin.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_OPTIONS(self) -> None:  # CORS preflight for POST
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def _send_video(self, file_path: Path) -> None:
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Accept-Ranges", "none")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            # Stream a bench MP4 so the dashboard's Engine A/B players can load it.
            if parsed.path == "/bench/video":
                engine = (parse_qs(parsed.query).get("engine") or [""])[0]
                vp = _bench_video_path(engine)
                if vp is None:
                    self._send(404, {"error": "no bench video", "engine": engine})
                    return
                self._send_video(vp)
                return
            status, body = dispatch(parsed.path)
            self._send(status, body)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            status, body = dispatch_post(parsed.path, params)
            self._send(status, body)

        def log_message(self, fmt: str, *args: object) -> None:  # quieter logs
            pass

    return _MiraHandler


# ── Live server ───────────────────────────────────────────────────────────────

def serve(port: int = 8770, *, supervise: bool = True) -> None:
    """Start a ThreadingHTTPServer on 127.0.0.1:port (blocks).

    On boot the backend auto-starts any installed local engines (ComfyUI, etc.)
    so the user never has to touch a terminal — engines are part of the backend.
    """
    if supervise:
        try:
            from mira import engines
            results = engines.ensure_all()
            for name, res in results.items():
                state = "running" if res.get("running") else res.get("reason", "—")
                print(f"  engine {name}: {state}")
        except Exception as exc:  # never let supervision block the API
            print(f"  engine supervision skipped: {exc}")
    handler_cls = make_handler()
    with ThreadingHTTPServer(("127.0.0.1", port), handler_cls) as httpd:
        print(f"mira API listening on http://127.0.0.1:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    serve()
