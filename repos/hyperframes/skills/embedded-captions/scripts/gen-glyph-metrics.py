#!/usr/bin/env python3
"""
Generate per-glyph advance widths and ink bounds (in em) from a bundled font,
for setpieces that bake layout at compile time (coverword).

    python3 scripts/gen-glyph-metrics.py \
        modes/standard/fonts/files/anton-latin-400-normal.woff2 Anton \
        > assets/fonts/anton-glyph-metrics.json

Needs fontTools (+ brotli for .woff2). Run it again if the font file changes,
then format the JSON with the repo formatter (`npx oxfmt <file>`).
"""
import hashlib
import json
import os
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

CHARS = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    ".,!?'\u2019\":;-\u2013\u2014()&%+#@*/"
)


def main(path, family):
    font = TTFont(path)
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]
    widths, bounds = {}, {}
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if not name:
            continue
        widths[ch] = round(hmtx[name][0] / upm, 4)
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        if pen.bounds:
            bounds[ch] = [round(v / upm, 4) for v in pen.bounds]
    hhea = font["hhea"]
    rel = os.path.relpath(path, os.path.join(os.path.dirname(__file__), ".."))
    out = {
        "_meta": {
            "family": family,
            "source": rel.replace(os.sep, "/"),
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
            "licence": "SIL OFL 1.1 (licence text beside the font file)",
            "generator": "scripts/gen-glyph-metrics.py (fontTools)",
            "units": "em; bounds are [xMin, yMin, xMax, yMax], y up from the baseline",
        },
        "unitsPerEm": upm,
        "ascent": round(hhea.ascent / upm, 4),
        "descent": round(hhea.descent / upm, 4),
        "widths": widths,
        "bounds": bounds,
    }
    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
