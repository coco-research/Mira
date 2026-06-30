"""Mira Phase-1 generation pipeline — faceless-short offline path.

``generate()`` orchestrates every stage end-to-end:

  script → voice → scene clips → captions → compose → QA probe

All stages log to the cost ledger (cost = 0.0 on the free/offline path).
Returns a ``schemas.Video``-shaped dict with real duration from ffprobe.

No pip deps.  Requires ffmpeg / ffprobe (at /opt/homebrew/bin or on PATH).
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mira import config as _config
from mira import cost as _cost
from mira import duration as _dur
from mira.providers import llm as _llm
from mira.providers import tts as _tts
from mira.providers import stock as _stock
from mira.providers import captions as _captions
from mira.providers import compose as _compose


# ── helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _aspect_to_size(aspect: str) -> tuple[int, int]:
    """Return the canonical pixel size for the given aspect ratio."""
    return (1080, 1920) if aspect == "9:16" else (1920, 1080)


def _log_cost(
    video_id: str,
    stage: str,
    provider: str,
    cost_log_path: Any,
    units: float = 1.0,
    note: str | None = None,
) -> None:
    _cost.append_cost(
        {
            "video_id": video_id,
            "stage": stage,
            "provider": provider,
            "units": units,
            "cost": 0.0,
            "note": note,
            "ts": _now_iso(),
        },
        path=cost_log_path,
    )


# ── public API ────────────────────────────────────────────────────────────────

def generate(
    channel: dict,
    topic: dict,
    out_dir: str | Path,
    target_s: float | None = None,
    state_dir: str | Path | None = None,
    size: tuple[int, int] | None = None,
    visual_engine: str | None = None,
) -> dict[str, Any]:
    """Run the full generation pipeline for one faceless short.

    Parameters
    ----------
    channel:
        Channel configuration dict (matches ``schemas.Channel``).
    topic:
        Topic dict with at least a ``"title"`` key.
    out_dir:
        Directory where all artifacts are written.
    target_s:
        Target video duration in seconds.  If ``None``, the midpoint of the
        channel's ``length_band`` is used.
    state_dir:
        Optional directory for cost_log.json.  Defaults to ``config.STATE_DIR``.
    size:
        Override pixel dimensions ``(width, height)``.  Defaults to the
        canonical size for the channel's aspect ratio.  Pass a small value
        (e.g. ``(256, 456)``) in tests for speed.

    Returns
    -------
    dict
        ``schemas.Video``-shaped dict with keys: ``id``, ``topic_id``,
        ``channel_id``, ``state``, ``duration_s``, ``aspect``, ``artifacts``,
        ``checkpoints``, ``cost``, ``qa``, ``created_at``.
    """
    # ── setup ─────────────────────────────────────────────────────────────────
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    video_id = f"vid_{uuid.uuid4().hex[:8]}"
    topic_title: str = topic.get("title", "untitled")
    topic_id: str = topic.get("id", "top_unknown")
    channel_id: str = channel.get("id", "chn_unknown")
    aspect: str = channel.get("aspect", "9:16")
    length_band: dict = channel.get("length_band", {"min_s": 30, "max_s": 60, "hard_cap_s": 75})

    # Determine target duration.
    if target_s is None:
        override = topic.get("length_override_s")
        target_s = float(override) if override else (
            (float(length_band["min_s"]) + float(length_band["max_s"])) / 2
        )

    # Determine output size.
    if size is None:
        size = _aspect_to_size(aspect)

    # Cost-log path — separate per test run if state_dir is given.
    cost_log_path: Any = None
    if state_dir is not None:
        sd = Path(state_dir)
        sd.mkdir(parents=True, exist_ok=True)
        cost_log_path = sd / "cost_log.json"

    checkpoints: list[dict] = []

    # ── stage 1: script ───────────────────────────────────────────────────────
    script_result = _llm.write_script(topic_title, target_s, channel)
    provider_used = _llm.provider_used()
    _log_cost(video_id, "script", provider_used, cost_log_path)
    checkpoints.append({"stage": "script", "status": "done", "provider": provider_used})

    scenes: list[dict] = script_result["scenes"]

    # ── stage 2: voice / TTS ──────────────────────────────────────────────────
    script_text: str = script_result["script"]
    audio_path = str(out_dir / f"{video_id}_audio.m4a")
    _tts.synthesize(script_text, audio_path, target_s)
    _log_cost(video_id, "voice_en", "offline-anullsrc", cost_log_path)
    checkpoints.append({"stage": "voice_en", "status": "done"})

    # ── stage 3: visuals ──────────────────────────────────────────────────────
    # Engine selection: "cards" (per-scene solid colour, always available) or a
    # designed engine ("remotion" | "hyperframes") that renders the whole scene
    # list into one key-free graphics MP4. Designed engines degrade to cards if
    # their toolchain/repo is missing, so the pipeline never hard-fails.
    engine = (visual_engine or _config.VISUAL_ENGINE or "cards").lower()
    clip_paths: list[str] = []
    engine_used = "cards"

    if engine in ("remotion", "hyperframes"):
        from mira.providers import designed as _designed
        designed_path = str(out_dir / f"{video_id}_{engine}.mp4")
        try:
            _designed.render(engine, scenes, size, designed_path)
            clip_paths = [designed_path]
            engine_used = engine
            _log_cost(
                video_id, "clip", f"designed-{engine}", cost_log_path,
                units=float(sum(float(s["seconds"]) for s in scenes)),
                note=f"{engine} (designed visual)",
            )
        except _designed.EngineUnavailable as exc:
            checkpoints.append({"stage": "images", "status": "fallback",
                                "engine": engine, "reason": str(exc)[:200]})
            clip_paths = []  # fall through to the cards path below

    elif engine == "stock":
        # Real B-roll per scene (Pexels), with the scene text burned on top. The
        # topic title is the shared search query so every scene stays on-theme;
        # variant=i picks a different result so clips don't all repeat. Each
        # scene_clip degrades to a solid-colour card if the fetch fails, so the
        # pipeline never hard-fails on a flaky network.
        engine_used = "stock"
        for i, scene in enumerate(scenes):
            clip_path = str(out_dir / f"{video_id}_scene_{i:02d}.mp4")
            _stock.scene_clip(
                text=scene["text"],
                seconds=float(scene["seconds"]),
                size=size,
                out_path=clip_path,
                query=topic_title,
                burn_text=scene["text"],
                variant=i,
            )
            clip_paths.append(clip_path)
            _log_cost(
                video_id, "clip", "stock-pexels", cost_log_path,
                units=float(scene["seconds"]), note=f"scene {i}",
            )

    if not clip_paths:
        engine_used = "cards"
        for i, scene in enumerate(scenes):
            clip_path = str(out_dir / f"{video_id}_scene_{i:02d}.mp4")
            _stock.scene_clip(
                text=scene["text"],
                seconds=float(scene["seconds"]),
                size=size,
                out_path=clip_path,
            )
            clip_paths.append(clip_path)
            _log_cost(
                video_id, "clip",
                "offline-ffmpeg",
                cost_log_path,
                units=float(scene["seconds"]),
                note=f"scene {i}",
            )

    checkpoints.append({"stage": "images", "status": "done",
                        "n_clips": len(clip_paths), "engine": engine_used})

    # ── stage 4: captions (SRT) ───────────────────────────────────────────────
    srt_path = str(out_dir / f"{video_id}_captions.srt")
    _captions.build_srt(scenes, srt_path)
    _log_cost(video_id, "captions", "offline-srt", cost_log_path)
    checkpoints.append({"stage": "captions", "status": "done"})

    # ── stage 5: compose ──────────────────────────────────────────────────────
    final_path = str(out_dir / f"{video_id}_final.mp4")
    _compose.assemble(
        clips=clip_paths,
        audio=audio_path,
        srt=srt_path,
        out_path=final_path,
        size=size,
    )
    _log_cost(video_id, "production_engine", "offline-ffmpeg", cost_log_path)
    checkpoints.append({"stage": "compose", "status": "done"})

    # ── QA probe ──────────────────────────────────────────────────────────────
    actual_duration = _dur.probe_duration(final_path)
    duration_in_band = (
        _dur.in_band(actual_duration, length_band)
        if actual_duration is not None
        else None
    )

    qa: dict = {
        "passed": actual_duration is not None,
        "duration_in_band": duration_in_band,
        "target_s": target_s,
        "actual_s": actual_duration,
    }

    # ── assemble return dict ──────────────────────────────────────────────────
    return {
        "id": video_id,
        "topic_id": topic_id,
        "channel_id": channel_id,
        "engine": "openmontage",
        "visual_engine": engine_used,
        "pipeline": "faceless-short-offline",
        "state": "draft",
        "duration_s": actual_duration,
        "aspect": aspect,
        "artifacts": {
            "video": final_path,
            "audio": audio_path,
            "captions": srt_path,
            "scene_clips": clip_paths,
        },
        "checkpoints": checkpoints,
        "cost": {"estimate": 0.0, "actual": 0.0, "currency": "USD"},
        "ai_disclosure": True,
        "qa": qa,
        "created_at": _now_iso(),
    }


# ── A/B bench ───────────────────────────────────────────────────────────────────

def bench(
    channel: dict,
    topic: dict,
    out_dir: str | Path | None = None,
    target_s: float | None = None,
    size: tuple[int, int] | None = None,
    engines: tuple[str, ...] = ("remotion", "hyperframes"),
) -> dict[str, Any]:
    """Render the SAME topic through each designed engine for a fair A/B look-test.

    Script, voiceover, and captions are generated ONCE and shared across every
    engine so the only thing that differs is the visual style. Writes a
    ``latest.json`` manifest into the output dir (read by the dashboard's
    Engine A/B tab) and returns it. Engines that can't run are recorded with
    ``ok: False`` rather than aborting the whole bench.
    """
    out_dir = Path(out_dir) if out_dir else (_config.STATE_DIR / "bench")
    out_dir.mkdir(parents=True, exist_ok=True)

    topic_title: str = topic.get("title", "untitled")
    aspect: str = channel.get("aspect", "9:16")
    length_band: dict = channel.get("length_band", {"min_s": 30, "max_s": 60, "hard_cap_s": 75})
    if target_s is None:
        target_s = (float(length_band["min_s"]) + float(length_band["max_s"])) / 2
    if size is None:
        size = _aspect_to_size(aspect)

    # Shared script / VO / captions — generated once for a fair comparison.
    script_result = _llm.write_script(topic_title, target_s, channel)
    scenes: list[dict] = script_result["scenes"]
    script_provider = _llm.provider_used()

    audio_path = str(out_dir / "shared_audio.m4a")
    _tts.synthesize(script_result["script"], audio_path, target_s)

    srt_path = str(out_dir / "shared_captions.srt")
    _captions.build_srt(scenes, srt_path)

    from mira.providers import designed as _designed

    results: list[dict] = []
    for eng in engines:
        visual_path = str(out_dir / f"{eng}_visual.mp4")
        final_path = str(out_dir / f"{eng}_final.mp4")
        entry: dict[str, Any] = {"engine": eng, "video": final_path}
        try:
            _designed.render(eng, scenes, size, visual_path)
            _compose.assemble([visual_path], audio_path, srt_path, final_path, size)
            entry["ok"] = True
            entry["duration_s"] = _dur.probe_duration(final_path)
        except Exception as exc:  # EngineUnavailable or render/compose failure
            entry["ok"] = False
            entry["video"] = None
            entry["reason"] = str(exc)[:300]
        results.append(entry)

    manifest = {
        "topic": topic_title,
        "channel_id": channel.get("id", "chn_unknown"),
        "script": script_result["script"],
        "script_provider": script_provider,
        "scenes": len(scenes),
        "target_s": target_s,
        "size": list(size),
        "engines": results,
        "out_dir": str(out_dir),
        "created_at": _now_iso(),
    }
    (out_dir / "latest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
