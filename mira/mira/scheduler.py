"""Pure scheduling engine — no side effects, no network, no persistence.

All functions operate on plain dicts and ISO-8601 strings (UTC, 'Z' suffix or
'+00:00' offset).  The only external import is stdlib ``datetime``.

Design (DASHBOARD_SPEC.md + POLICY.md):
- auto_publish  channels: due videos → action "publish" (headless lane).
- review_all    channels: due videos → action "hold" (always needs human gate).
- ``dispatch_plan`` never calls publish() directly; it returns a plan list for
  the caller (n8n / CLI / API) to act on.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


# ── Internal helpers ─────────────────────────────────────────────────────────

def _parse_iso(iso: str) -> datetime:
    """Parse an ISO-8601 UTC string ('Z' or '+00:00') to a timezone-aware datetime."""
    iso = iso.strip()
    if iso.endswith("Z"):
        iso = iso[:-1] + "+00:00"
    return datetime.fromisoformat(iso)


def _fmt_iso(dt: datetime) -> str:
    """Format a timezone-aware datetime back to the 'Z'-suffix style used in mira."""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Public API ───────────────────────────────────────────────────────────────

def due(items: list[dict[str, Any]], now_iso: str) -> list[dict[str, Any]]:
    """Return items whose ``scheduled_for`` <= *now_iso* and that are not posted.

    Parameters
    ----------
    items:    List of topic or video dicts that carry a ``scheduled_for`` key.
    now_iso:  Current time as an ISO-8601 UTC string.

    An item is **excluded** when:
    - ``scheduled_for`` is None / missing.
    - ``scheduled_for`` is in the future (> now).
    - ``state`` is ``"posted"`` or ``status`` is ``"posted"`` (already done).
    """
    now = _parse_iso(now_iso)
    result = []
    for item in items:
        sf = item.get("scheduled_for")
        if not sf:
            continue
        state = item.get("state") or item.get("status") or ""
        if state == "posted":
            continue
        try:
            scheduled = _parse_iso(sf)
        except (ValueError, TypeError):
            continue
        if scheduled <= now:
            result.append(item)
    return result


def next_slot(channel: dict[str, Any], after_iso: str, cadence_per_day: int = 1) -> str:
    """Compute the next available publish slot for *channel* after *after_iso*.

    The slot is computed by adding ``(24 / cadence_per_day)`` hours to
    *after_iso*, rounded up to the nearest hour, ensuring it is strictly
    later than *after_iso*.

    Parameters
    ----------
    channel:         Channel dict (used for future platform-specific constraints).
    after_iso:       ISO-8601 UTC reference time.
    cadence_per_day: How many videos per day the channel targets (≥ 1).

    Returns
    -------
    ISO-8601 UTC string representing the next slot.
    """
    cadence = max(1, cadence_per_day)
    interval_hours = 24.0 / cadence
    base = _parse_iso(after_iso)
    candidate = base + timedelta(hours=interval_hours)

    # Round up to the nearest full hour so slots look clean.
    if candidate.minute != 0 or candidate.second != 0:
        candidate = candidate.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)

    # Guarantee strictly later than the input.
    if candidate <= base:
        candidate = base + timedelta(hours=1)

    return _fmt_iso(candidate)


def dispatch_plan(
    videos: list[dict[str, Any]],
    channels: list[dict[str, Any]],
    now_iso: str,
) -> list[dict[str, Any]]:
    """Build a publish plan for all due videos — no side effects.

    For each video whose ``scheduled_for`` is due and state is not "posted":
    - Look up its channel by ``channel_id``.
    - If channel.trust == "auto_publish" → action "publish".
    - If channel.trust == "review_all"   → action "hold".
    - Unknown channel                    → action "hold" (safe default).

    Returns
    -------
    List of plan dicts, each containing:
        video_id, channel_id, platform, action, scheduled_for, reason
    """
    channel_map: dict[str, dict] = {c["id"]: c for c in (channels or [])}
    due_videos = due(videos, now_iso)
    plan = []
    for video in due_videos:
        channel_id = video.get("channel_id", "")
        channel = channel_map.get(channel_id, {})
        trust = channel.get("trust", "review_all")
        platforms = channel.get("platforms") or ["youtube"]
        platform = platforms[0]

        if trust == "auto_publish":
            action = "publish"
            reason = "Channel trust=auto_publish; routed to headless publish."
        else:
            action = "hold"
            reason = (
                f"Channel trust={trust!r}; video held for human review "
                f"before publishing."
            )

        plan.append({
            "video_id": video.get("id"),
            "channel_id": channel_id,
            "platform": platform,
            "action": action,
            "scheduled_for": video.get("scheduled_for"),
            "reason": reason,
        })
    return plan
