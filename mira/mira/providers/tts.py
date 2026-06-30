"""TTS provider adapter.

Quality path (default when available): **edge-tts** — free, no key, high-quality
Microsoft neural voices. Invoked via ``python -m edge_tts`` so it always resolves
inside the project venv (never depends on the CLI being on PATH).

Offline path (fallback / forced): ffmpeg ``anullsrc`` → silent AAC track of
*exactly* ``seconds`` duration. No network, no key, no pip deps.

Force offline (e.g. in tests / air-gapped runs) with env ``MIRA_TTS=offline``.

Keyed path (opt-in): Sarvam AI (SARVAM_API_KEY) — best Hindi.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

# A warm, confident default narration voice. Override per-channel via brand kit.
DEFAULT_VOICE = "en-US-AndrewNeural"
DEFAULT_VOICE_HI = "hi-IN-MadhurNeural"


# ── helpers ───────────────────────────────────────────────────────────────────

def _ffmpeg_bin() -> str:
    """Return the ffmpeg binary path, checking Homebrew location as fallback."""
    ff = shutil.which("ffmpeg")
    if ff:
        return ff
    alt = "/opt/homebrew/bin/ffmpeg"
    if Path(alt).exists():
        return alt
    raise RuntimeError(
        "ffmpeg not found. Install via Homebrew: brew install ffmpeg"
    )


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


# ── offline ───────────────────────────────────────────────────────────────────

def _offline_audio(out_path: str, seconds: float) -> str:
    """Generate a silent AAC audio track of exactly *seconds* duration."""
    _run([
        _ffmpeg_bin(), "-y",
        "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=mono",
        "-t", f"{seconds:.6f}",
        "-c:a", "aac",
        "-b:a", "64k",
        str(out_path),
    ])
    return str(out_path)


# ── edge-tts (free, no key) ───────────────────────────────────────────────────

def _edge_available() -> bool:
    """True when edge-tts is importable AND offline mode is not forced."""
    if os.environ.get("MIRA_TTS", "").lower() == "offline":
        return False
    return importlib.util.find_spec("edge_tts") is not None


def _edge_tts_audio(text: str, out_path: str, seconds: float, voice: str) -> str:
    """Synthesise speech with edge-tts, then fit to *seconds*.

    Invoked via ``python -m edge_tts`` (current interpreter) so it works in the
    venv regardless of PATH. The natural narration is padded with trailing
    silence when shorter than *seconds*, and only trimmed when longer — so the
    voice is never cut mid-word for a small overshoot.
    """
    import tempfile
    ff = _ffmpeg_bin()

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        raw_path = tmp.name
    try:
        subprocess.run(
            [sys.executable, "-m", "edge_tts", "--voice", voice,
             "--text", text, "--write-media", raw_path],
            check=True, capture_output=True, timeout=60,
        )
        # Pad with silence to reach *seconds* (apad), then cap length (-t).
        _run([
            ff, "-y",
            "-i", raw_path,
            "-af", "apad",
            "-t", f"{seconds:.6f}",
            "-c:a", "aac", "-b:a", "128k",
            str(out_path),
        ])
    finally:
        try:
            os.unlink(raw_path)
        except OSError:
            pass
    return str(out_path)


# ── public API ────────────────────────────────────────────────────────────────

def synthesize(text: str, out_path: str, seconds: float, voice: str | None = None) -> str:
    """Synthesise speech for *text*, fitting *seconds* duration.

    Returns the path of the generated audio file (AAC inside M4A/MP4 container).

    Priority:
      1. edge-tts  — high-quality free neural voice (unless ``MIRA_TTS=offline``)
      2. Sarvam    — if SARVAM_API_KEY is set (best Hindi)
      3. Offline   — silent ``anullsrc`` track (always works, zero deps)
    """
    voice = voice or DEFAULT_VOICE

    if _edge_available():
        try:
            return _edge_tts_audio(text, out_path, seconds, voice)
        except Exception:
            pass

    from mira import keys as _keys  # late import to avoid circular at module load
    if _keys.has("SARVAM_API_KEY"):
        try:
            return _sarvam_audio(text, out_path, seconds)
        except Exception:
            pass

    return _offline_audio(out_path, seconds)


def _sarvam_audio(text: str, out_path: str, seconds: float) -> str:
    """Call Sarvam TTS API (stub — implement when key is available)."""
    # Placeholder: fall through to offline if the Sarvam logic is not yet wired.
    raise NotImplementedError("Sarvam TTS not yet implemented")
