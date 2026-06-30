"""Publishing provider — plans or executes a post to YouTube / Instagram.

Stdlib-only; no network calls unless LIVE mode is explicitly requested.

Design principles (from POLICY.md):
- AI disclosure is always True (costs nothing, covers compliance).
- Per-platform distinct cuts — each call targets one platform.
- review_all channel + non-approved video → action "hold" (never skips the gate).
- Live path fires only when: creds exist AND dry_run=False.
"""
from __future__ import annotations

from mira import keys

# Mapping: platform → required credential key(s)
_PLATFORM_CREDS: dict[str, list[str]] = {
    "youtube":   ["YOUTUBE_CLIENT_SECRET_JSON"],
    "instagram": ["IG_ACCESS_TOKEN"],
}


def can_publish(platform: str) -> tuple[bool, str]:
    """Return (True, "") if platform creds are present, else (False, reason).

    The reason is a human-readable string explaining what is missing and what
    OAuth step is needed.
    """
    cred_keys = _PLATFORM_CREDS.get(platform.lower())
    if cred_keys is None:
        return False, f"Unknown platform {platform!r}; no credential mapping defined."

    missing = [k for k in cred_keys if not keys.has(k)]
    if not missing:
        return True, ""

    hints: dict[str, str] = {
        "YOUTUBE_CLIENT_SECRET_JSON": (
            "YouTube OAuth not configured — download client_secret.json from "
            "Google Cloud Console, run the one-time browser OAuth flow, and set "
            "YOUTUBE_CLIENT_SECRET_JSON=/path/to/client_secret.json in .env."
        ),
        "IG_ACCESS_TOKEN": (
            "Instagram access token not set — generate a long-lived User access "
            "token via Meta for Developers (Graph API), then set "
            "IG_ACCESS_TOKEN=<token> in .env."
        ),
    }
    reason = "; ".join(hints.get(k, f"Missing credential: {k}") for k in missing)
    return False, reason


def publish(
    video: dict,
    channel: dict,
    *,
    dry_run: bool = True,
    platform: str | None = None,
) -> dict:
    """Plan or execute a publish action for one video on one platform.

    Parameters
    ----------
    video:    Video dict (must include at least ``id`` and ``state``).
    channel:  Channel dict (must include ``trust`` and ``platforms``).
    dry_run:  Default True — never makes a network call.  Set False only in
              production code that has verified creds are present.
    platform: Target platform.  If None, uses the first entry in
              ``channel["platforms"]``.

    Returns
    -------
    dict with keys:
        platform, action ("publish" | "hold" | "dry_run"), title,
        video_id, channel_id, would_post_at, disclosure, reason
    """
    from datetime import datetime, timezone

    target_platform = (platform or (channel.get("platforms") or ["youtube"])[0]).lower()
    video_id = video.get("id", "unknown")
    channel_id = channel.get("id", "unknown")
    title = video.get("title") or video.get("id", "Untitled")
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    disclosure = True  # always on — POLICY.md §4 rule 9

    # Gate 1: review_all channels require explicit approval before publish.
    trust = channel.get("trust", "review_all")
    state = video.get("state", "draft")
    if trust == "review_all" and state != "approved":
        return {
            "platform": target_platform,
            "action": "hold",
            "title": title,
            "video_id": video_id,
            "channel_id": channel_id,
            "would_post_at": None,
            "disclosure": disclosure,
            "reason": (
                f"Channel trust={trust!r}: video must be in state 'approved' "
                f"before publish (current state={state!r})."
            ),
        }

    # Gate 2: credential check.
    live_ok, cred_reason = can_publish(target_platform)

    if dry_run or not live_ok:
        action = "dry_run"
        reason = (
            "dry_run=True — no network call made."
            if dry_run
            else f"Credentials missing: {cred_reason}"
        )
        if not live_ok and not dry_run:
            reason = f"Cannot go live: {cred_reason}"
        return {
            "platform": target_platform,
            "action": action,
            "title": title,
            "video_id": video_id,
            "channel_id": channel_id,
            "would_post_at": now_iso,
            "disclosure": disclosure,
            "reason": reason,
        }

    # LIVE path — only reached when dry_run=False AND creds exist.
    # Real upload logic is intentionally left as a stub so the module
    # stays stdlib-only; a future Phase integrates the YouTube Data API
    # and Instagram Graph API here.
    return {
        "platform": target_platform,
        "action": "publish",
        "title": title,
        "video_id": video_id,
        "channel_id": channel_id,
        "would_post_at": now_iso,
        "disclosure": disclosure,
        "reason": "Live publish initiated (stub — wire up API client in Phase 6).",
    }
