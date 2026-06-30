"""Stock-footage / scene-clip provider adapter.

Live path (default when ``PEXELS_API_KEY`` is set): Pexels video API → downloads a
royalty-free B-roll clip matching the scene, cover-fits it to frame, and burns the
caption text on top (Pillow overlay, since this ffmpeg lacks libfreetype).

Offline path (no key / network failure / ``MIRA_STOCK=offline``): ffmpeg ``color``
lavfi source → solid-colour MP4 clip. Colour is deterministically derived from the
scene text so adjacent scenes differ. No network, no key.

Force offline (tests / air-gapped) with env ``MIRA_STOCK=offline``.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

# A browser-like UA — Pexels' CDN returns 403 (Cloudflare code 1010) to bare
# urllib requests, so every Pexels call must send this.
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Stopwords stripped when turning narration prose into a stock search query.
_STOPWORDS = frozenset((
    "the", "and", "for", "you", "your", "this", "that", "with", "about", "from",
    "are", "was", "were", "has", "have", "had", "will", "would", "can", "could",
    "should", "here", "there", "what", "when", "where", "which", "who", "how",
    "why", "its", "it's", "into", "out", "now", "let", "lets", "get", "got",
    "one", "two", "three", "first", "second", "third", "fourth", "fifth", "next",
    "almost", "every", "really", "just", "very", "they", "them", "their", "our",
    "know", "knows", "need", "needs", "want", "wants", "start", "using", "use",
    "real", "example", "key", "insight", "game", "changing", "shortcut", "hear",
))


def _offline_forced() -> bool:
    return os.environ.get("MIRA_STOCK", "").lower() == "offline"


def _keywords(text: str, limit: int = 5) -> str:
    """Reduce narration prose to a short, order-preserving stock-search query."""
    words = re.findall(r"[a-zA-Z]+", (text or "").lower())
    seen: set[str] = set()
    out: list[str] = []
    for w in words:
        if len(w) <= 2 or w in _STOPWORDS or w in seen:
            continue
        seen.add(w)
        out.append(w)
        if len(out) >= limit:
            break
    return " ".join(out) or "abstract technology background"


# ── helpers ───────────────────────────────────────────────────────────────────

def _ffmpeg_bin() -> str:
    ff = shutil.which("ffmpeg")
    if ff:
        return ff
    alt = "/opt/homebrew/bin/ffmpeg"
    if Path(alt).exists():
        return alt
    raise RuntimeError("ffmpeg not found. Install via: brew install ffmpeg")


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


# A small palette of dark/muted hex colours for the offline solid-colour clips.
_PALETTE = [
    "0x1a1a2e", "0x16213e", "0x0f3460", "0x533483",
    "0x2c3e50", "0x1c1c3a", "0x2d4a22", "0x3d1c1c",
]


def _pick_colour(text: str) -> str:
    h = int(hashlib.md5(text.encode()).hexdigest(), 16)
    return _PALETTE[h % len(_PALETTE)]


# ── offline ───────────────────────────────────────────────────────────────────

def _offline_clip(
    text: str,
    seconds: float,
    size: tuple[int, int],
    out_path: str,
) -> str:
    """Generate a solid-colour MP4 clip.

    ``drawtext`` is intentionally omitted: this ffmpeg build was compiled
    without ``--enable-libfreetype``, so the filter is unavailable.  Text
    is delivered through the SRT captions track instead.
    """
    w, h = size
    colour = _pick_colour(text)
    _run([
        _ffmpeg_bin(), "-y",
        "-f", "lavfi",
        "-i", f"color=c={colour}:s={w}x{h}:r=24:d={seconds:.6f}",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "stillimage",
        "-pix_fmt", "yuv420p",
        "-t", f"{seconds:.6f}",
        str(out_path),
    ])
    return str(out_path)


# ── Pexels (live, keyed) ──────────────────────────────────────────────────────

def _orientation(size: tuple[int, int]) -> str:
    w, h = size
    if h > w:
        return "portrait"
    if w > h:
        return "landscape"
    return "square"


def _best_file(files: list[dict], size: tuple[int, int]) -> str:
    """Pick a download URL: smallest file whose height covers the target, else largest."""
    w, h = size
    usable = [f for f in files if f.get("link") and f.get("width") and f.get("height")]
    if not usable:
        raise ValueError("no usable video files in Pexels result")
    by_area = sorted(usable, key=lambda f: f["width"] * f["height"])
    target_h = h * 0.6
    for f in by_area:
        if f["height"] >= target_h:
            return f["link"]
    return by_area[-1]["link"]


def _pexels_clip(
    text: str,
    seconds: float,
    size: tuple[int, int],
    out_path: str,
    api_key: str,
    *,
    query: str | None = None,
    burn_text: str | None = None,
    variant: int = 0,
) -> str:
    """Search Pexels for a B-roll clip, cover-fit to *size*, burn *burn_text* on top.

    *variant* picks the Nth result so different scenes of one topic get distinct
    footage instead of all repeating the first hit.
    """
    import tempfile

    w, h = size
    q = (query or _keywords(text)).strip()
    per_page = max(variant + 1, 12)
    url = (
        "https://api.pexels.com/videos/search?"
        + urllib.parse.urlencode({
            "query": q,
            "per_page": per_page,
            "orientation": _orientation(size),
            "size": "medium",
        })
    )
    req = urllib.request.Request(url, headers={"Authorization": api_key, "User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read())

    videos = data.get("videos", [])
    if not videos:
        raise ValueError(f"Pexels returned no results for query {q!r}")

    video = videos[variant % len(videos)]
    video_url = _best_file(video.get("video_files", []), size)

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        raw_path = tmp.name
    caption_png: str | None = None
    try:
        dl = urllib.request.Request(video_url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(dl, timeout=90) as resp:
            Path(raw_path).write_bytes(resp.read())

        # Cover-fit (scale up + centre-crop) so portrait footage fills the frame
        # with no letterbox bars, then optionally overlay a burned-in caption.
        cover = (
            f"scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1"
        )
        cmd = [_ffmpeg_bin(), "-y", "-i", raw_path]

        if burn_text is not None:
            try:
                from mira.providers import burn as _burn
                caption_png = out_path + ".caption.png"
                _burn.caption_png(burn_text, size, caption_png)
                cmd += ["-i", caption_png, "-filter_complex",
                        f"[0:v]{cover}[bg];[bg][1:v]overlay=0:0,format=yuv420p[v]",
                        "-map", "[v]"]
            except Exception:
                caption_png = None  # burn-in optional; footage + soft SRT still play
        if caption_png is None:
            cmd += ["-vf", f"{cover},format=yuv420p"]

        cmd += [
            "-t", f"{seconds:.6f}",
            "-r", "30",
            "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
            "-an", str(out_path),
        ]
        _run(cmd)
    finally:
        for p in (raw_path, caption_png):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    return str(out_path)


# ── public API ────────────────────────────────────────────────────────────────

def scene_clip(
    text: str,
    seconds: float,
    size: tuple[int, int],
    out_path: str,
    *,
    query: str | None = None,
    burn_text: str | None = None,
    variant: int = 0,
) -> str:
    """Generate a video clip for one scene.

    Parameters
    ----------
    text:
        Scene narration text (used as the Pexels search query when *query* is not
        given; drives colour selection for the offline path).
    seconds:
        Target clip duration in seconds.
    size:
        ``(width, height)`` in pixels.
    out_path:
        Destination path for the MP4 file.
    query:
        Explicit stock-search query (e.g. the topic title) overriding *text*.
    burn_text:
        Caption text to burn onto the footage. ``None`` = no overlay.
    variant:
        Index into the Pexels result set so sibling scenes get distinct footage.

    Returns the path of the generated clip. Falls back to a solid-colour clip when
    no key is set, ``MIRA_STOCK=offline``, or the live fetch fails.
    """
    if not _offline_forced():
        from mira import keys as _keys
        if _keys.has("PEXELS_API_KEY"):
            try:
                return _pexels_clip(
                    text, seconds, size, out_path, _keys.get("PEXELS_API_KEY"),
                    query=query, burn_text=burn_text, variant=variant,
                )
            except Exception:
                pass  # degrade to offline

    return _offline_clip(text, seconds, size, out_path)
