"""Captions provider — builds a SubRip (.srt) file from script scenes.

No ASR needed: the word-level timecodes come straight from the script that the
LLM (or offline template) generated, so the SRT is always aligned with the
intended narration.

No network, no key, no pip deps.
"""
from __future__ import annotations

from pathlib import Path


def _seconds_to_srt_ts(total_s: float) -> str:
    """Convert a floating-point second offset to SRT timestamp format.

    SRT uses ``HH:MM:SS,mmm`` (comma as decimal separator).
    """
    total_ms = round(total_s * 1000)
    ms = total_ms % 1000
    total_s_int = total_ms // 1000
    secs = total_s_int % 60
    total_m = total_s_int // 60
    mins = total_m % 60
    hours = total_m // 60
    return f"{hours:02d}:{mins:02d}:{secs:02d},{ms:03d}"


def build_srt(
    scenes: list[dict],
    out_path: str,
) -> str:
    """Write a valid SRT file for *scenes* and return *out_path*.

    Parameters
    ----------
    scenes:
        List of ``{"text": str, "seconds": float}`` dicts — the ``scenes``
        list from ``llm.write_script()``.
    out_path:
        Destination path for the ``.srt`` file.

    Returns the path of the written SRT file.
    """
    lines: list[str] = []
    cursor = 0.0

    for idx, scene in enumerate(scenes, start=1):
        text = scene["text"].strip()
        duration = float(scene["seconds"])
        if duration <= 0:
            duration = 1.0

        start_ts = _seconds_to_srt_ts(cursor)
        end_ts = _seconds_to_srt_ts(cursor + duration)

        lines.append(str(idx))
        lines.append(f"{start_ts} --> {end_ts}")
        lines.append(text)
        lines.append("")  # blank line between cues

        cursor += duration

    content = "\n".join(lines)
    Path(out_path).write_text(content, encoding="utf-8")
    return str(out_path)


# ── SRT parser (for tests and QA) ─────────────────────────────────────────────

def parse_srt(path: str) -> list[dict]:
    """Parse an SRT file and return a list of cue dicts.

    Each dict has keys: ``index`` (int), ``start`` (float s), ``end`` (float s),
    ``text`` (str).
    """
    text = Path(path).read_text(encoding="utf-8")
    cues: list[dict] = []

    blocks = [b.strip() for b in text.split("\n\n") if b.strip()]
    for block in blocks:
        lines = block.splitlines()
        if len(lines) < 2:
            continue
        try:
            index = int(lines[0].strip())
        except ValueError:
            continue
        if " --> " not in lines[1]:
            continue
        start_str, end_str = lines[1].split(" --> ", 1)
        cues.append({
            "index": index,
            "start": _srt_ts_to_seconds(start_str.strip()),
            "end": _srt_ts_to_seconds(end_str.strip()),
            "text": "\n".join(lines[2:]).strip(),
        })

    return cues


def _srt_ts_to_seconds(ts: str) -> float:
    """Parse ``HH:MM:SS,mmm`` → float seconds."""
    ts = ts.replace(",", ".")
    parts = ts.split(":")
    h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
    return h * 3600 + m * 60 + s
