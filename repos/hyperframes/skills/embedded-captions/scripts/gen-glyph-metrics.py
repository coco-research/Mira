#!/usr/bin/env python3
"""
Generate per-glyph advance widths and ink bounds (in em) from a bundled font,
for setpieces that bake layout at compile time (coverword).

    python3 scripts/gen-glyph-metrics.py \\
        modes/standard/fonts/files/anton-latin-400-normal.woff2 Anton \\
        --output assets/fonts/anton-glyph-metrics.json

The JSON is written as UTF-8 to a temp file next to the target and moved into
place with an atomic rename, so a failed run exits non-zero and leaves the
existing file untouched. Without --output it is printed to stdout (UTF-8).
Needs fontTools (+ brotli for .woff2). Run it again if the font file changes,
then format the JSON with the repo formatter (`npx oxfmt <file>`).

Modified by Coco, 2026-10-08 (lab-0062). See repos/hyperframes/MODIFICATIONS.md.
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile

CHARS = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    ".,!?'\u2019\":;-\u2013\u2014()&%+#@*/"
)


def build(path, family):
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.ttLib import TTFont

    with open(path, "rb") as f:
        blob = f.read()
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
    if not widths:
        raise ValueError(f"{path}: no glyphs for the metric character set")
    hhea = font["hhea"]
    rel = os.path.relpath(os.path.abspath(path), os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    return {
        "_meta": {
            "family": family,
            "source": rel.replace(os.sep, "/"),
            "sha256": hashlib.sha256(blob).hexdigest(),
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


def write_atomic(target, text):
    target = os.path.abspath(target)
    directory = os.path.dirname(target)
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(target) + ".", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        if os.path.exists(target):
            os.chmod(tmp, os.stat(target).st_mode & 0o777)
        else:
            os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("font", help="font file (.ttf/.otf/.woff/.woff2)")
    ap.add_argument("family", help="family name recorded in _meta")
    ap.add_argument("-o", "--output", help="JSON file to write (atomically); default: stdout")
    args = ap.parse_args(argv)
    try:
        text = json.dumps(build(args.font, args.family), indent=2, ensure_ascii=False) + "\n"
        if args.output:
            write_atomic(args.output, text)
        else:
            sys.stdout.buffer.write(text.encode("utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"gen-glyph-metrics: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
