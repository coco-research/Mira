"""Length-control math and ffprobe gate for Mira clips.

Converts between word counts and durations, validates clips against a
LengthBand, and optionally measures actual render duration via ffprobe.
Stdlib-only — no pip installs.
"""
from __future__ import annotations

import json
import shutil
import subprocess


def words_for_duration(target_s: float, wpm: float = 150.0) -> int:
    """Return how many words to write to fill ``target_s`` seconds of speech."""
    return round(target_s / 60 * wpm)


def duration_for_words(words: int, wpm: float = 150.0) -> float:
    """Return expected TTS duration in seconds for ``words`` at ``wpm``."""
    return words / wpm * 60


def in_band(duration_s: float, band: dict) -> bool:
    """True iff ``duration_s`` is within [min_s, hard_cap_s] (inclusive).

    Uses ``hard_cap_s`` as the ceiling (not ``max_s``) so clips are only
    rejected when they exceed the absolute hard cap.
    """
    return band["min_s"] <= duration_s <= band["hard_cap_s"]


def probe_duration(path: str) -> float | None:
    """Return the duration of a media file in seconds via ffprobe.

    Returns ``None`` if ffprobe is not installed, the file cannot be read,
    or the JSON output cannot be parsed.
    """
    if not shutil.which("ffprobe"):
        return None
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except Exception:
        return None


def verify_clip(path: str, band: dict) -> dict:
    """Probe ``path`` and check its duration against ``band``.

    Returns a dict with:
      - ``duration_s``: measured duration (float) or None if probe failed
      - ``in_band``: bool or None when duration is unknown
      - ``ok``: False if duration could not be measured, otherwise in_band
    """
    duration_s = probe_duration(path)
    if duration_s is None:
        return {"duration_s": None, "in_band": None, "ok": False}
    fits = in_band(duration_s, band)
    return {"duration_s": duration_s, "in_band": fits, "ok": fits}
