#!/usr/bin/env python3
"""Assemble the Mira dashboard prototype from partials.

Sources:
  - dashboard/prototype.html  (template/shell; contains <!-- INJECT:x --> ... <!-- /INJECT:x --> markers)
  - dashboard/partials/<screen>.html  (one self-contained <section class="page" id="x"> per screen)

The script replaces the content BETWEEN each marker pair with the matching partial,
leaving the markers in place so it stays idempotent / re-runnable as new screens land.
The landing screen (today) gets the `active` class so it shows on load.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "prototype.html"
PARTIALS = ROOT / "partials"
LANDING = "today"

# Screens that have a real partial built. Others stay as in-shell placeholders.
SCREENS = [
    "today", "ideate", "queue", "studio", "assets",
    "review", "library", "analytics", "channels",
    "engines", "connections", "collaborators",
    "onboarding",
]


def main() -> int:
    html = TEMPLATE.read_text(encoding="utf-8")
    missing = []
    for screen in SCREENS:
        partial_path = PARTIALS / f"{screen}.html"
        if not partial_path.exists():
            missing.append(screen)
            continue
        partial = partial_path.read_text(encoding="utf-8").strip()
        # Landing screen must be visible on load.
        if screen == LANDING:
            partial = partial.replace(
                f'<section class="page" id="{screen}">',
                f'<section class="page active" id="{screen}">',
                1,
            )
        start = f"<!-- INJECT:{screen} -->"
        end = f"<!-- /INJECT:{screen} -->"
        pattern = re.compile(
            re.escape(start) + r".*?" + re.escape(end),
            re.DOTALL,
        )
        replacement = f"{start}\n{partial}\n{end}"
        if not pattern.search(html):
            print(f"  ! marker for '{screen}' not found in template", file=sys.stderr)
            continue
        html = pattern.sub(lambda _m: replacement, html, count=1)
        print(f"  + injected {screen} ({len(partial.splitlines())} lines)")

    TEMPLATE.write_text(html, encoding="utf-8")
    if missing:
        print(f"  (placeholders kept for: {', '.join(missing)})")
    print(f"Done -> {TEMPLATE}  ({len(html.splitlines())} lines total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
