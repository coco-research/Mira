"""Analytics pull-back adapter.

Goes live via YouTube Data API v3 / Instagram Graph API only when the
relevant key is present AND ``dry_run=False``.  Otherwise returns a
deterministic, fixture-shaped sample so tests never touch the network.
"""
from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

from .. import keys as _keys

if TYPE_CHECKING:
    pass

# Planning RPMs (USD per 1,000 views) by geography.
_RPM: dict[str, float] = {
    "US": 4.2,
    "CA": 3.8,
    "IN": 0.65,
    "other": 1.0,
}

# YPP full-monetisation thresholds (2026, POLICY.md §1).
_YPP = {
    "subs": 1_000,
    "watch_hours": 4_000,
    "shorts_views": 10_000_000,
}


# ---------------------------------------------------------------------------
# Deterministic fixture generator
# ---------------------------------------------------------------------------

def _fixture_stats(channel_id: str) -> dict:
    """Stable pseudo-random stats seeded from channel_id."""
    seed = int(hashlib.sha256(channel_id.encode()).hexdigest(), 16)

    def _scale(offset: int, lo: float, hi: float) -> float:
        unit = ((seed >> offset) & 0xFFFF) / 0xFFFF
        return round(lo + unit * (hi - lo), 2)

    return {
        "views_28d": int(_scale(0, 500, 50_000)),
        "retention_pct": round(_scale(16, 20.0, 65.0), 1),
        "subs": int(_scale(32, 50, 3_000)),
        "watch_hours": round(_scale(48, 10.0, 8_000.0), 1),
        "shorts_views_90d": int(_scale(64, 1_000, 15_000_000)),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def pull(channel_id: str, *, dry_run: bool = True) -> dict:
    """Return analytics stats for *channel_id*.

    Live network path:
    - YouTube: requires ``YOUTUBE_API_KEY`` (simple data API key — not OAuth).
      Fetches statistics from the ``channels`` endpoint.
    - Instagram: requires ``IG_ACCESS_TOKEN``.
      Fetches from the ``/{ig_user_id}/insights`` endpoint.

    When either key is absent or ``dry_run=True``, returns a deterministic
    fixture (same channel_id → same numbers, every time, no network).

    Returns a dict with keys:
    ``views_28d``, ``retention_pct``, ``subs``, ``watch_hours``,
    ``shorts_views_90d``.
    """
    if not dry_run and _keys.has("YOUTUBE_API_KEY"):
        return _pull_youtube(channel_id)

    if not dry_run and _keys.has("IG_ACCESS_TOKEN"):
        return _pull_instagram(channel_id)

    return _fixture_stats(channel_id)


def _pull_youtube(channel_id: str) -> dict:  # pragma: no cover — requires live key
    """Live YouTube Data API v3 pull.

    NOTE: Full per-video retention requires YouTube Analytics API (OAuth).
    This path uses only the simple Data API key for channel-level stats.
    Run ``mira auth youtube`` once to store an OAuth refresh token for the
    Analytics API so retention_pct and watch_hours come from real data.
    """
    import urllib.request
    import json as _json

    api_key = _keys.get("YOUTUBE_API_KEY")
    url = (
        "https://www.googleapis.com/youtube/v3/channels"
        f"?part=statistics&id={channel_id}&key={api_key}"
    )
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = _json.loads(resp.read())

    items = data.get("items", [])
    if not items:
        return _fixture_stats(channel_id)

    stats = items[0].get("statistics", {})
    return {
        "views_28d": int(stats.get("viewCount", 0)),
        "retention_pct": None,      # requires Analytics OAuth — see note above
        "subs": int(stats.get("subscriberCount", 0)),
        "watch_hours": None,        # requires Analytics OAuth
        "shorts_views_90d": None,   # requires Analytics OAuth
    }


def _pull_instagram(channel_id: str) -> dict:  # pragma: no cover — requires live key
    """Live Instagram Graph API pull."""
    import urllib.request
    import urllib.parse
    import json as _json

    token = _keys.get("IG_ACCESS_TOKEN")
    params = urllib.parse.urlencode({
        "metric": "impressions,reach,follower_count",
        "period": "day",
        "access_token": token,
    })
    url = f"https://graph.instagram.com/{channel_id}/insights?{params}"
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = _json.loads(resp.read())

    raw = {item["name"]: item.get("values", [{}])[-1].get("value", 0)
           for item in data.get("data", [])}
    return {
        "views_28d": int(raw.get("impressions", 0)),
        "retention_pct": None,
        "subs": int(raw.get("follower_count", 0)),
        "watch_hours": None,
        "shorts_views_90d": None,
    }


# ---------------------------------------------------------------------------
# YPP progress
# ---------------------------------------------------------------------------

def ypp_progress(stats: dict) -> dict:
    """Return progress toward YPP full-monetisation thresholds.

    Each fraction is clamped to [0, 1].
    ``eligible`` is True when *all three* thresholds are met (the Shorts-views
    path is an OR alternative to watch_hours, so eligible flips when
    subs >= 1 000 AND (watch_hours >= 4 000 OR shorts_views >= 10 000 000)).
    """
    def _frac(actual, threshold) -> float:
        if actual is None:
            return 0.0
        return min(1.0, float(actual) / threshold)

    subs_frac = _frac(stats.get("subs"), _YPP["subs"])
    hours_frac = _frac(stats.get("watch_hours"), _YPP["watch_hours"])
    shorts_frac = _frac(stats.get("shorts_views_90d"), _YPP["shorts_views"])

    subs_ok = subs_frac >= 1.0
    hours_ok = hours_frac >= 1.0
    shorts_ok = shorts_frac >= 1.0

    return {
        "subs_1000": subs_frac,
        "watch_hours_4000": hours_frac,
        "shorts_views_10m": shorts_frac,
        "eligible": subs_ok and (hours_ok or shorts_ok),
    }


# ---------------------------------------------------------------------------
# RPM estimate
# ---------------------------------------------------------------------------

def rpm_estimate(geo_split: dict) -> float:
    """Return a blended RPM (USD / 1 000 views) for the given geography split.

    *geo_split* maps geo codes to fractional shares that sum to 1.0, e.g.::

        {"US": 0.6, "CA": 0.1, "IN": 0.2, "other": 0.1}

    Unknown codes fall back to the "other" rate.
    """
    total_share = sum(geo_split.values())
    if total_share <= 0:
        return _RPM["other"]

    blended = 0.0
    for geo, share in geo_split.items():
        rate = _RPM.get(geo, _RPM["other"])
        blended += rate * (share / total_share)

    return round(blended, 4)
