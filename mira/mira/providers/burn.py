"""Caption burn-in helper — renders a transparent PNG of wrapped, legible caption
text that ffmpeg can ``overlay`` onto footage.

Why this exists: this machine's ffmpeg is built WITHOUT libfreetype/libass, so the
``drawtext`` and ``subtitles`` filters are unavailable. The ``overlay`` filter IS
available, so we draw the caption with Pillow (always installed) into an RGBA PNG
and composite it over the video. Used by the stock-footage visual route so real
b-roll still carries readable on-screen text (the designed engines draw their own).

Pure-local: no network, no key. If Pillow or a usable font is missing the caller
should treat a raised exception as "skip burn-in" (footage + soft SRT still play).
"""
from __future__ import annotations

from pathlib import Path

# macOS system fonts, in preference order (bold first for punchy captions).
_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/SFNS.ttf",
)


def _load_font(size: int):
    from PIL import ImageFont
    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap(draw, text: str, font, max_width: float, max_lines: int) -> list[str]:
    """Greedy word-wrap using real glyph metrics; truncates with an ellipsis."""
    words = text.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
            if len(lines) == max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    if len(lines) == max_lines and cur and lines[-1] != cur:
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > max_width:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines


def caption_png(text: str, size: tuple[int, int], out_png: str) -> str:
    """Render *text* into a transparent PNG of *size* with a lower-third band.

    Empty/whitespace text yields a fully transparent PNG (a no-op overlay), so the
    caller can always overlay unconditionally. Returns *out_png*.
    """
    from PIL import Image, ImageDraw

    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    text = (text or "").strip()
    if not text:
        img.save(out_png)
        return out_png

    draw = ImageDraw.Draw(img)
    font_size = max(18, int(w / 16))
    font = _load_font(font_size)

    max_width = w * 0.86
    lines = _wrap(draw, text, font, max_width, max_lines=4)

    line_h = int(font_size * 1.22)
    block_h = line_h * len(lines)
    # Anchor the block in the lower third (good for vertical shorts).
    block_top = int(h * 0.70)
    if block_top + block_h > h * 0.96:
        block_top = int(h * 0.96 - block_h)

    pad = int(font_size * 0.5)
    band_top = max(0, block_top - pad)
    band_bottom = min(h, block_top + block_h + pad)
    band = Image.new("RGBA", (w, band_bottom - band_top), (0, 0, 0, 0))
    ImageDraw.Draw(band).rectangle([0, 0, w, band_bottom - band_top], fill=(0, 0, 0, 140))
    img.alpha_composite(band, (0, band_top))

    stroke = max(2, font_size // 14)
    y = block_top
    for line in lines:
        lw = draw.textlength(line, font=font)
        x = (w - lw) / 2
        draw.text(
            (x, y), line, font=font, fill=(255, 255, 255, 255),
            stroke_width=stroke, stroke_fill=(0, 0, 0, 220),
        )
        y += line_h

    img.save(out_png)
    return out_png
