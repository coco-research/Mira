"""Clip factory — hub-and-spoke repurpose: one long-form source → N vertical shorts.

This is the "Make Shorts from this" feature.  It uses ffprobe to measure the
source video duration and ffmpeg to cut and re-crop each segment to the target
aspect ratio.

Requirements: ffmpeg and ffprobe in PATH (or at the Homebrew location).
No pip dependencies.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


# ── Binary helpers ────────────────────────────────────────────────────────────

def _which(name: str) -> str | None:
    """Locate *name*, checking Homebrew as a fallback."""
    found = shutil.which(name)
    if found:
        return found
    alt = f"/opt/homebrew/bin/{name}"
    if Path(alt).exists():
        return alt
    return None


def _require(name: str) -> str:
    path = _which(name)
    if path is None:
        raise RuntimeError(
            f"{name} not found in PATH. Install via: brew install ffmpeg"
        )
    return path


# ── ffprobe ───────────────────────────────────────────────────────────────────

def _ffprobe_duration(path: str) -> float:
    """Return the duration of *path* in seconds via ffprobe."""
    ffprobe = _require("ffprobe")
    result = subprocess.run(
        [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", path],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed on {path!r}: {result.stderr.strip()}"
        )
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def _ffprobe_has_audio(path: str) -> bool:
    """Return True if *path* contains at least one audio stream."""
    ffprobe = _require("ffprobe")
    result = subprocess.run(
        [
            ffprobe, "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-select_streams", "a",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        return False
    data = json.loads(result.stdout)
    return bool(data.get("streams"))


# ── Video filter ──────────────────────────────────────────────────────────────

def _vf_for_aspect(aspect: str) -> str:
    """Build an ffmpeg ``-vf`` filter that re-crops to the target aspect ratio.

    For 9:16 (portrait / Shorts): centre-crops the source to a portrait window
    matching 9:16, rounded to an even pixel width — no upscale, so the output
    height equals the source height.

    For 16:9 (landscape): centre-crops to 16:9 when source is taller.
    """
    if aspect == "9:16":
        # crop_w = floor(ih * 9/16 / 2) * 2  (even pixel width, 9:16 ratio)
        return "crop=trunc(ih*9/16/2)*2:ih"
    if aspect == "16:9":
        # crop_h = floor(iw * 9/16 / 2) * 2  (even pixel height, 16:9 ratio)
        return "crop=iw:trunc(iw*9/16/2)*2"
    # Passthrough for any other aspect spec.
    return "null"


# ── Public API ────────────────────────────────────────────────────────────────

def make_shorts(
    source_mp4: str,
    out_dir: str,
    *,
    count: int | None = None,
    clip_s: float = 30,
    aspect: str = "9:16",
) -> list[dict]:
    """Cut *source_mp4* into N vertical short clips.

    Parameters
    ----------
    source_mp4 : path to the source video file
    out_dir    : output directory (created if it does not exist)
    count      : number of clips to produce; derived from source duration when None
    clip_s     : target duration of each clip in seconds (default 30)
    aspect     : output aspect ratio — ``"9:16"`` (default) or ``"16:9"``

    Returns
    -------
    list of ``{path: str, start_s: float, duration_s: float}``
    """
    ffmpeg = _require("ffmpeg")
    _require("ffprobe")  # validate availability early

    source_duration = _ffprobe_duration(source_mp4)
    n = count if count is not None else int(source_duration // clip_s)
    if n < 1:
        n = 1

    os.makedirs(out_dir, exist_ok=True)
    vf = _vf_for_aspect(aspect)
    stem = Path(source_mp4).stem
    has_audio = _ffprobe_has_audio(source_mp4)

    clips: list[dict] = []
    for i in range(n):
        start_s = i * clip_s
        actual_dur = min(clip_s, source_duration - start_s)
        if actual_dur <= 0:
            break

        out_path = os.path.join(out_dir, f"{stem}_clip{i:03d}.mp4")

        cmd = [
            ffmpeg, "-y",
            "-ss", str(start_s),
            "-i", source_mp4,
            "-t", str(actual_dur),
            "-vf", vf,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "28",
        ]

        if has_audio:
            cmd += ["-c:a", "aac", "-b:a", "64k"]
        else:
            cmd += ["-an"]

        cmd.append(out_path)

        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed for clip {i} of {source_mp4!r}:\n"
                + result.stderr.decode(errors="replace")[-600:]
            )

        clips.append({
            "path": out_path,
            "start_s": float(start_s),
            "duration_s": float(actual_dur),
        })

    return clips
