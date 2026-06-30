"""Designed-visual provider — key-free, GPU-free "graphics" videos.

Two interchangeable engines render the *same* scene list two ways so the look
can be A/B compared before any API key is involved:

  * ``render_remotion``   — OpenMontage's Remotion ``Explainer`` composition
                            (React → ``npx remotion render``).
  * ``render_hyperframes`` — a generated HTML+GSAP project
                            (``npx hyperframes render`` → headless Chrome → ffmpeg).

Both shell out to the cloned repos / npm CLIs as **subprocesses** — no Node code
is imported into mira's Python core — and produce a *video-only* MP4 at the
requested size. The pipeline muxes the edge-tts voiceover + SRT captions on top.

If the toolchain or repo is missing, the function raises ``EngineUnavailable``
so the caller can degrade to the always-available color-card path. No pip deps.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Sequence

from mira import config


class EngineUnavailable(RuntimeError):
    """Raised when a designed engine can't run (missing repo / Node / npx)."""


# ── shared helpers ──────────────────────────────────────────────────────────────

def _subprocess_env() -> dict[str, str]:
    """Process env with Homebrew bin on PATH so npx subprocesses find ffmpeg."""
    env = dict(os.environ)
    brew = config.HOMEBREW_BIN
    path = env.get("PATH", "")
    if brew not in path.split(os.pathsep):
        env["PATH"] = f"{brew}{os.pathsep}{path}" if path else brew
    return env


def _which(*names: str) -> str | None:
    env_path = _subprocess_env().get("PATH")
    for name in names:
        found = shutil.which(name, path=env_path)
        if found:
            return found
    return None


def _scene_list(scenes: Sequence[dict]) -> list[dict]:
    """Normalise scenes to ``[{"text": str, "seconds": float}]`` with sane minimums."""
    out: list[dict] = []
    for s in scenes:
        text = str(s.get("text", "")).strip()
        if not text:
            continue
        try:
            secs = max(0.6, float(s.get("seconds", 2.0)))
        except (TypeError, ValueError):
            secs = 2.0
        out.append({"text": text, "seconds": secs})
    if not out:
        raise EngineUnavailable("no usable scene text to render")
    return out


# ── Route A: Remotion (OpenMontage Explainer) ────────────────────────────────────

def _scenes_to_cuts(scenes: list[dict]) -> list[dict]:
    """Map normalised scenes onto Explainer ``cuts`` (hero_title + text_cards)."""
    cuts: list[dict] = []
    t = 0.0
    for i, s in enumerate(scenes):
        dur = s["seconds"]
        cut: dict[str, Any] = {
            "id": f"scene-{i:02d}",
            "source": "",
            "in_seconds": round(t, 3),
            "out_seconds": round(t + dur, 3),
            "type": "hero_title" if i == 0 else "text_card",
            "text": s["text"],
        }
        cuts.append(cut)
        t += dur
    return cuts


def render_remotion(
    scenes: Sequence[dict],
    size: tuple[int, int],
    out_path: str,
    *,
    theme: str = "flat-motion-graphics",
    timeout: int = 900,
) -> str:
    """Render *scenes* through OpenMontage's Remotion ``Explainer`` to *out_path*.

    Produces a video-only MP4 at ``size`` (width, height). Raises
    ``EngineUnavailable`` if the composer isn't installed or Node/npx are absent.
    """
    composer = config.REMOTION_COMPOSER_DIR
    if not composer.exists():
        raise EngineUnavailable(f"remotion-composer not found at {composer}")
    if not (composer / "node_modules").exists():
        raise EngineUnavailable(
            "remotion-composer dependencies missing — run `make setup` in repos/OpenMontage"
        )
    npx = _which("npx", "npx.cmd")
    if not npx:
        raise EngineUnavailable("npx not found on PATH (install Node.js)")

    w, h = size
    out_abs = Path(out_path).resolve()
    out_abs.parent.mkdir(parents=True, exist_ok=True)

    props = {
        "theme": theme,
        "width": int(w),
        "height": int(h),
        "cuts": _scenes_to_cuts(_scene_list(scenes)),
    }
    props_path = out_abs.with_suffix(".props.json")
    props_path.write_text(json.dumps(props, indent=2), encoding="utf-8")

    cmd = [
        npx, "remotion", "render",
        "src/index.tsx", "Explainer", str(out_abs),
        "--props", str(props_path),
        "--codec", "h264",
    ]
    try:
        subprocess.run(
            cmd, cwd=str(composer), env=_subprocess_env(),
            check=True, capture_output=True, timeout=timeout, text=True,
        )
    except subprocess.CalledProcessError as exc:
        tail = (exc.stderr or exc.stdout or "")[-800:]
        raise EngineUnavailable(f"remotion render failed: {tail}") from exc
    if not out_abs.exists():
        raise EngineUnavailable("remotion render produced no output file")
    return str(out_abs)


# ── Route B: HyperFrames (generated HTML + GSAP) ──────────────────────────────────

def _esc(text: str) -> str:
    """Minimal HTML-escape for text injected into the generated composition."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def hyperframes_html(scenes: list[dict], size: tuple[int, int]) -> str:
    """Build a single-file HyperFrames composition of timed kinetic text-cards."""
    w, h = size
    total = round(sum(s["seconds"] for s in scenes), 3)

    cards: list[str] = []
    tweens: list[str] = []
    t = 0.0
    for i, s in enumerate(scenes):
        dur = s["seconds"]
        start = round(t, 3)
        # Hold the card visible, with a short fade in and fade out inside its window.
        fade = min(0.4, dur / 3)
        out_at = round(start + dur - fade, 3)
        cards.append(
            f'<div class="card" id="card-{i}" data-start="{start}" '
            f'data-duration="{dur}"><div class="card-text">{_esc(s["text"])}</div></div>'
        )
        tweens.append(
            f'tl.fromTo("#card-{i}", {{opacity:0, y:40}}, '
            f'{{opacity:1, y:0, duration:{fade:.3f}, ease:"power2.out"}}, {start});'
        )
        tweens.append(
            f'tl.to("#card-{i}", {{opacity:0, y:-30, duration:{fade:.3f}, '
            f'ease:"power2.in"}}, {out_at});'
        )
        t += dur

    cards_html = "\n      ".join(cards)
    tweens_js = "\n    ".join(tweens)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=block" rel="stylesheet" />
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{ width: {w}px; height: {h}px; overflow: hidden;
    background: #0F172A; font-family: "Inter", system-ui, sans-serif; color: #F8FAFC; }}
  #root {{ position: absolute; inset: 0; }}
  .bg {{ position: absolute; inset: 0;
    background:
      radial-gradient(ellipse at 30% 25%, rgba(124,58,237,0.20) 0%, transparent 60%),
      radial-gradient(ellipse at 75% 70%, rgba(236,72,153,0.16) 0%, transparent 55%),
      linear-gradient(145deg, #0F172A 0%, #131c33 60%, #0F172A 100%); }}
  .card {{ position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; padding: 8% 9%; opacity: 0; }}
  .card-text {{ font-weight: 900; line-height: 1.12; text-align: center;
    font-size: {max(34, min(96, int(w / 12)))}px;
    letter-spacing: -0.02em;
    text-shadow: 0 6px 28px rgba(0,0,0,0.45); }}
  #card-0 .card-text {{ color: #22D3EE; }}
</style>
</head>
<body>
  <div id="root" data-composition-id="main" data-width="{w}" data-height="{h}"
       data-start="0" data-duration="{total}">
    <div class="bg"></div>
    <div class="stage clip" data-start="0" data-duration="{total}">
      {cards_html}
    </div>
  </div>
  <script>
    window.__timelines = window.__timelines || {{}};
    const tl = gsap.timeline({{ paused: true }});
    {tweens_js}
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
"""


def render_hyperframes(
    scenes: Sequence[dict],
    size: tuple[int, int],
    out_path: str,
    *,
    timeout: int = 900,
) -> str:
    """Render *scenes* through a generated HyperFrames project to *out_path*.

    Produces a video-only MP4 at ``size``. Raises ``EngineUnavailable`` if npx
    is missing or the render fails.
    """
    npx = _which("npx", "npx.cmd")
    if not npx:
        raise EngineUnavailable("npx not found on PATH (install Node.js)")

    norm = _scene_list(scenes)
    out_abs = Path(out_path).resolve()
    out_abs.parent.mkdir(parents=True, exist_ok=True)

    # A self-contained project dir so `hyperframes render` resolves its root here
    # (a package.json stops it from walking up into a parent monorepo).
    proj = out_abs.parent / f"{out_abs.stem}_hf"
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "index.html").write_text(hyperframes_html(norm, size), encoding="utf-8")
    (proj / "package.json").write_text(
        json.dumps({"name": "mira-hf", "private": True, "type": "module"}),
        encoding="utf-8",
    )
    # No `registry` key → no network fetch; we use only inline HTML/GSAP.
    (proj / "hyperframes.json").write_text(
        json.dumps({
            "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
            "paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"},
        }),
        encoding="utf-8",
    )

    cmd = [
        npx, "--yes", "hyperframes", "render",
        "--quality", "draft", "--no-browser-gpu",
        "--output", str(out_abs),
    ]
    try:
        subprocess.run(
            cmd, cwd=str(proj), env=_subprocess_env(),
            check=True, capture_output=True, timeout=timeout, text=True,
        )
    except subprocess.CalledProcessError as exc:
        tail = (exc.stderr or exc.stdout or "")[-800:]
        raise EngineUnavailable(f"hyperframes render failed: {tail}") from exc
    if not out_abs.exists():
        raise EngineUnavailable("hyperframes render produced no output file")
    return str(out_abs)


# ── dispatch helper ──────────────────────────────────────────────────────────────

def render(engine: str, scenes: Sequence[dict], size: tuple[int, int], out_path: str) -> str:
    """Render via the named engine (``remotion`` | ``hyperframes``)."""
    if engine == "remotion":
        return render_remotion(scenes, size, out_path)
    if engine == "hyperframes":
        return render_hyperframes(scenes, size, out_path)
    raise EngineUnavailable(f"unknown designed engine: {engine!r}")
