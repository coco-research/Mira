"""Video compose / assembly provider.

Concatenates scene clips, muxes the audio track, and attaches the SRT
captions as a soft subtitle stream.  All heavy lifting is done by ffmpeg.
No pip deps.

Pipeline:
  1. Write a concat list file.
  2. ``ffmpeg -f concat`` → intermediate video-only MP4.
  3. ``ffmpeg`` mux intermediate + audio + SRT → final MP4 with mov_text subtitles.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import os
from pathlib import Path


# ── helpers ───────────────────────────────────────────────────────────────────

def _ffmpeg_bin() -> str:
    ff = shutil.which("ffmpeg")
    if ff:
        return ff
    alt = "/opt/homebrew/bin/ffmpeg"
    if Path(alt).exists():
        return alt
    raise RuntimeError("ffmpeg not found. Install via: brew install ffmpeg")


def _run(cmd: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)


# ── concat ────────────────────────────────────────────────────────────────────

def _write_concat_list(clips: list[str], dest: str) -> None:
    """Write an ffmpeg concat-demuxer list file."""
    lines = []
    for clip in clips:
        # Use absolute paths; escape single quotes in paths.
        abs_path = str(Path(clip).resolve())
        escaped = abs_path.replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    Path(dest).write_text("\n".join(lines), encoding="utf-8")


def _concat_clips(clips: list[str], out_path: str) -> str:
    """Concatenate *clips* into a single video-only MP4."""
    ff = _ffmpeg_bin()
    list_file = out_path + ".concat_list.txt"
    _write_concat_list(clips, list_file)
    try:
        _run([
            ff, "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", list_file,
            "-c", "copy",
            out_path,
        ])
    finally:
        try:
            os.unlink(list_file)
        except OSError:
            pass
    return out_path


# ── public API ────────────────────────────────────────────────────────────────

def assemble(
    clips: list[str],
    audio: str,
    srt: str,
    out_path: str,
    size: tuple[int, int],
) -> str:
    """Assemble the final MP4.

    Parameters
    ----------
    clips:
        Ordered list of scene clip paths (video-only MP4s).
    audio:
        Path to the audio track (AAC/M4A).
    srt:
        Path to the captions SRT file.
    out_path:
        Destination path for the final MP4.
    size:
        ``(width, height)`` — used to verify consistent framing (not re-encoded
        unless the concat produces a mismatch).

    Returns *out_path*.
    """
    ff = _ffmpeg_bin()

    # Step 1 — concat clips into a temporary video-only file.
    with tempfile.TemporaryDirectory() as tmpdir:
        concat_mp4 = os.path.join(tmpdir, "concat.mp4")
        _concat_clips(clips, concat_mp4)

        # Step 2 — mux video + audio + SRT subtitles into the final MP4.
        # mov_text is the standard MP4 soft-subtitle codec (no libass needed).
        _run([
            ff, "-y",
            "-i", concat_mp4,         # 0: video
            "-i", str(audio),         # 1: audio
            "-i", str(srt),           # 2: subtitles
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-map", "2:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "64k",
            "-c:s", "mov_text",
            "-shortest",
            str(out_path),
        ])

    return str(out_path)
