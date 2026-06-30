"""Long-form pipeline params for Mira documentary / explainer videos.

Provides two public functions:
  plan_longform  — build a structured plan dict from a topic + target duration
  validate_longform — check a plan dict for spec violations

Stdlib-only, no pip deps.
"""
from __future__ import annotations

import math

from .duration import words_for_duration


# ── Plan builder ──────────────────────────────────────────────────────────────

def plan_longform(
    topic: dict,
    target_s: int = 240,
    wpm: float = 150,
) -> dict:
    """Build a long-form plan for *topic* targeting *target_s* seconds of video.

    Parameters
    ----------
    topic    : topic dict (must have at least ``title`` and ``id``)
    target_s : desired video duration in seconds (default 4 min)
    wpm      : narrator words-per-minute used to size the word budget

    Returns
    -------
    {
      target_s     : int,
      word_budget  : int,   # words to write  (duration.words_for_duration)
      scene_count  : int,   # ~1 scene every 6–8 s
      chapters     : list[{title: str, start_s: int}],
      aspect       : "16:9",
    }
    """
    word_budget = words_for_duration(target_s, wpm)

    # One scene roughly every 7 s (centre of the 6–8 s band).
    scene_count = round(target_s / 7)

    chapters = _build_chapters(topic, target_s)

    return {
        "target_s": target_s,
        "word_budget": word_budget,
        "scene_count": scene_count,
        "chapters": chapters,
        "aspect": "16:9",
    }


def _build_chapters(topic: dict, target_s: int) -> list[dict]:
    """Generate a chapter list with a short intro followed by body + conclusion.

    The intro is always < 15 s to satisfy the quality gate.  Body chapters
    divide the remaining runtime evenly.  Total chapters ≥ 3 for any
    target_s ≥ 60 s.
    """
    title = topic.get("title", "Documentary")

    # Short intro hook (~10 s) — keeps the quality-gate check happy.
    intro_s = min(10, target_s // 6)

    remaining = target_s - intro_s

    # Number of body segments: roughly one per minute, minimum 2 so that
    # we always produce ≥ 3 chapters total (intro + body × n + conclusion
    # where conclusion is the last body segment).
    n_body = max(2, round(target_s / 60))
    segment_s = remaining // n_body

    chapters: list[dict] = [{"title": "Introduction", "start_s": 0}]

    # Body chapters — derive titles from the topic title words when possible.
    words = title.split()
    for i in range(n_body - 1):
        label = words[i % len(words)].capitalize() if words else f"Part {i + 1}"
        start = intro_s + i * segment_s
        chapters.append({"title": f"Part {i + 1}: {label}", "start_s": start})

    # Conclusion is the final body segment.
    chapters.append({
        "title": "Conclusion",
        "start_s": intro_s + (n_body - 1) * segment_s,
    })

    return chapters


# ── Validator ─────────────────────────────────────────────────────────────────

def validate_longform(plan: dict) -> list[str]:
    """Return a list of spec violations for *plan*.

    Checks
    ------
    - intro duration < 15 s  (chapters[1].start_s − chapters[0].start_s)
    - at least 3 chapters
    - scene_count within the 6–8 s/scene band for target_s
    """
    errors: list[str] = []
    chapters = plan.get("chapters", [])
    target_s = plan.get("target_s", 0)
    scene_count = plan.get("scene_count", 0)

    # ── intro duration ────────────────────────────────────────────────────────
    if len(chapters) >= 2:
        intro_dur = chapters[1]["start_s"] - chapters[0]["start_s"]
        if intro_dur >= 15:
            errors.append(
                f"intro duration {intro_dur}s must be < 15s (hook is too long)"
            )
    elif len(chapters) == 1:
        # Only one chapter — can't compute intro; flag chapter count instead.
        pass

    # ── chapter count ─────────────────────────────────────────────────────────
    if len(chapters) < 3:
        errors.append(
            f"plan has {len(chapters)} chapter(s); long-form requires >= 3"
        )

    # ── scene_count vs duration band ─────────────────────────────────────────
    if target_s > 0:
        sc_min = target_s // 8          # tightest packing: 8 s/scene
        sc_max = math.ceil(target_s / 6)  # loosest packing: 6 s/scene
        if not (sc_min <= scene_count <= sc_max):
            errors.append(
                f"scene_count {scene_count} is outside the expected band "
                f"[{sc_min}, {sc_max}] for a {target_s}s video"
            )

    return errors
