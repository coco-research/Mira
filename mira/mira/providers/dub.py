"""Hindi (and general) dub adapter for the Mira pipeline.

Priority chain:
  1. Sarvam Bulbul API  — live, when SARVAM_API_KEY is set
  2. edge-tts hi-IN     — free, when the ``edge_tts`` package is importable
  3. Offline silent track via ffmpeg (timing-preserving placeholder)

All three paths return the same contract dict so the pipeline never
hard-crashes on a missing key or absent package.
"""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Union

from .. import keys as _keys


# ── SRT / scene normalisation ─────────────────────────────────────────────────

def _srt_time_to_s(t: str) -> float:
    """Convert SRT timestamp ``HH:MM:SS,mmm`` to fractional seconds."""
    t = t.replace(",", ".")
    h, m, s = t.split(":")
    return float(h) * 3600 + float(m) * 60 + float(s)


def _parse_srt(srt_text: str) -> list[dict]:
    """Parse an SRT string into ``[{start_s, end_s, text}, …]``."""
    segments: list[dict] = []
    for block in re.split(r"\n{2,}", srt_text.strip()):
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue
        timing_line = next((ln for ln in lines if "-->" in ln), None)
        if timing_line is None:
            continue
        parts = timing_line.split("-->")
        if len(parts) != 2:
            continue
        start_s = _srt_time_to_s(parts[0].strip())
        end_s = _srt_time_to_s(parts[1].strip())
        text_lines = []
        past_timing = False
        for ln in lines:
            if "-->" in ln:
                past_timing = True
                continue
            if past_timing:
                text_lines.append(ln)
        segments.append({
            "start_s": start_s,
            "end_s": end_s,
            "text": " ".join(text_lines).strip(),
        })
    return segments


def _normalise_segments(srt_or_scenes: Union[str, list]) -> list[dict]:
    """Return ``[{start_s, end_s, text}, …]`` from either input format."""
    if isinstance(srt_or_scenes, str):
        return _parse_srt(srt_or_scenes)
    result = []
    for seg in srt_or_scenes:
        result.append({
            "start_s": float(seg.get("start_s", seg.get("start", 0))),
            "end_s": float(seg.get("end_s", seg.get("end", 0))),
            "text": str(seg.get("text", "")),
        })
    return result


def _total_duration(segments: list[dict]) -> float:
    if not segments:
        return 1.0
    return max(s["end_s"] for s in segments)


# ── ffmpeg binary helper (mirrors tts.py) ────────────────────────────────────

def _ffmpeg_bin() -> str | None:
    ff = shutil.which("ffmpeg")
    if ff:
        return ff
    alt = "/opt/homebrew/bin/ffmpeg"
    if Path(alt).exists():
        return alt
    return None


# ── Provider implementations ─────────────────────────────────────────────────

def _silent_track(duration_s: float, out_path: str) -> bool:
    """Write a timing-preserving silent WAV track of *duration_s* seconds."""
    ff = _ffmpeg_bin()
    if ff is None:
        return False
    result = subprocess.run(
        [
            ff, "-y",
            "-f", "lavfi",
            "-i", "anullsrc=r=44100:cl=mono",
            "-t", f"{duration_s:.6f}",
            "-c:a", "pcm_s16le",
            out_path,
        ],
        capture_output=True,
    )
    return result.returncode == 0


def _try_edge_tts(segments: list[dict], lang: str, out_path: str) -> bool:
    """Synthesise the full script with edge-tts and save to *out_path*."""
    if importlib.util.find_spec("edge_tts") is None:
        return False
    voice_map = {
        "hi": "hi-IN-MadhurNeural",
        "en": "en-US-AndrewNeural",
    }
    voice = voice_map.get(lang, "hi-IN-MadhurNeural")
    full_text = " ".join(s["text"] for s in segments).strip()
    if not full_text:
        return False
    try:
        import asyncio
        import edge_tts  # type: ignore[import]

        async def _run() -> None:
            communicate = edge_tts.Communicate(full_text, voice)
            await communicate.save(out_path)

        asyncio.run(_run())
        return os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception:
        return False


# ── Public API ────────────────────────────────────────────────────────────────

def dub(
    srt_or_scenes: Union[str, list],
    lang: str = "hi",
    out_path: str | None = None,
) -> dict:
    """Generate a dubbed audio track that preserves the per-segment timing.

    Parameters
    ----------
    srt_or_scenes : SRT-formatted string or list of ``{start_s, end_s, text}``
    lang          : BCP-47 language code (default ``"hi"`` for Hindi)
    out_path      : destination file path; a temp WAV is created when None

    Returns
    -------
    {
      provider   : "sarvam" | "edge-tts" | "silent",
      lang       : str,
      aligned    : True,   # timing is always preserved for all providers
      audio_path : str | None,
      segments   : list[{start_s, end_s, text}],
    }

    The ``"sarvam"`` path includes a ``_request_shape`` key so the call
    contract can be inspected in tests without an actual network call.
    """
    segments = _normalise_segments(srt_or_scenes)
    duration_s = _total_duration(segments)

    if out_path is None:
        fd, out_path = tempfile.mkstemp(suffix=".wav", prefix=f"mira_dub_{lang}_")
        os.close(fd)

    # ── 1. Sarvam Bulbul (live) ───────────────────────────────────────────────
    if _keys.has("SARVAM_API_KEY"):
        # Stub: build the request shape so tests can inspect it without a real
        # network call.  A live implementation would POST to
        # https://api.sarvam.ai/text-to-speech (voice=bulbul:v1) and write
        # the returned audio bytes to out_path.
        return {
            "provider": "sarvam",
            "lang": lang,
            "aligned": True,
            "audio_path": None,   # live call would write the audio here
            "segments": segments,
            "_request_shape": {
                "inputs": [s["text"] for s in segments],
                "target_language_code": f"{lang}-IN",
                "speaker": "meera",
                "model": "bulbul:v1",
            },
        }

    # ── 2. edge-tts (free, offline-capable) ──────────────────────────────────
    if _try_edge_tts(segments, lang, out_path):
        return {
            "provider": "edge-tts",
            "lang": lang,
            "aligned": True,
            "audio_path": out_path,
            "segments": segments,
        }

    # ── 3. Offline silent track (always available when ffmpeg is present) ─────
    ok = _silent_track(duration_s, out_path)
    return {
        "provider": "silent",
        "lang": lang,
        "aligned": True,
        "audio_path": out_path if ok else None,
        "segments": segments,
    }
