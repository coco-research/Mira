# Third-Party Components

Mira is licensed under **AGPL-3.0** (see [`LICENSE`](LICENSE)). Copyright © 2026 Coco Inc.

Mira bundles and/or references the following third-party projects. Each retains its
own license; the license file for every bundled engine is preserved inside its
directory under `repos/`.

## Bundled engines (in `repos/`)

| Engine | License | Upstream |
|--------|---------|----------|
| OpenMontage | AGPL-3.0 | https://github.com/coco-research/OpenMontage |
| locally-uncensored | AGPL-3.0 | (upstream) |
| MoneyPrinterTurbo | MIT | https://github.com/harry0703/MoneyPrinterTurbo |
| Open-Generative-AI | MIT | (upstream) |
| Free-ai-video-generator | MIT | (upstream) |
| Wan2.2 | Apache-2.0 | https://github.com/Wan-Video/Wan2.2 |
| hyperframes | Apache-2.0 | (upstream) |
| StoryGen-Atelier | Apache-2.0 | (upstream) |

These licenses are compatible with distributing Mira under AGPL-3.0 (MIT and
Apache-2.0 are one-way compatible *into* AGPLv3; the AGPL engines share Mira's
license). Their copyright and license notices are retained in-tree.

> **Note:** verify each upstream URL and the exact vendored commit before public
> release, and record the pinned commit here. Placeholders marked "(upstream)"
> must be filled in.

## Removed or not redistributed (lab-0062 legal review)

- **MoneyPrinterTurbo subtitle fonts:** `MicrosoftYaHeiBold.ttc`, `MicrosoftYaHeiNormal.ttc`,
  `STHeitiLight.ttc`, `STHeitiMedium.ttc` and `UTM Kabel KT.ttf` were proprietary and are no longer in
  `repos/MoneyPrinterTurbo/resource/fonts/`. The default subtitle font is now Noto Sans CJK (SIL OFL 1.1),
  looked up on the host at runtime and never bundled; see `repos/MoneyPrinterTurbo/resource/fonts/README.md`.
  Charm (SIL OFL 1.1) stays bundled. Its licence text sits beside it at
  `repos/MoneyPrinterTurbo/resource/fonts/OFL-charm.txt`, copied byte for byte from
  [google/fonts `ofl/charm/OFL.txt` @ 053f0ca635d11d8c76b7d584f7e70974932fc674](https://github.com/google/fonts/blob/053f0ca635d11d8c76b7d584f7e70974932fc674/ofl/charm/OFL.txt)
  (Copyright 2018 The Charm Project Authors, https://github.com/cadsondemak/charm). The bundled
  `Charm-*.ttf` files are version 1.001 and embed the same copyright line.
- **`repos/OpenMontage/.agents/skills/vercel-composition-patterns/`, `vercel-react-best-practices/` and
  `web-design-guidelines/`:** Vercel's skills from
  [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills). Upstream declares MIT in its README
  (and in the `license:` frontmatter of the first two skills) but ships no LICENSE file or copyright notice, so
  the MIT terms cannot be complied with and OpenMontage's AGPL-3.0 licence cannot cover them. Mira ships only a
  link-only stub `SKILL.md` for each.
- **`repos/hyperframes/packages/producer/tests/heygen-promo-preview-assets/src/`:** `ABCSolarDisplay-Bold.woff2`
  (ABC Solar Display, Dinamo) and `TT_Norms_Pro_{Normal,Medium,Bold}.woff2` (TT Norms Pro, TypeType) are
  commercial fonts with no licence and were removed. The regression fixture's golden `output/compiled.html` no
  longer declares them, so its text falls back to the existing Arial / sans-serif stacks.
- **Commercial fonts embedded in eight regression goldens** (`repos/hyperframes/packages/producer/tests/{style-3-prod,style-7-prod,style-8-prod,style-15-prod,style-16-prod,style-18-prod,sub-comp-id-selector,sub-comp-t0}/output/compiled.html`): base64 `@font-face` copies of Helvetica Neue (Linotype), Helvetica (Monotype), Impact (Monotype) and Garamond (Monotype), captured from the host's system fonts when the goldens were generated, with no licence to redistribute. The 50 `@font-face` blocks were removed; the fixtures and their sources stay, and the text falls back to the CSS stacks' generic families. Details per fixture in `repos/hyperframes/packages/producer/tests/FONT-LICENSES/README.md`.
- **IBM Plex Mono in `repos/hyperframes/packages/producer/tests/style-11-prod/output/compiled.html`:** the golden embedded a trimmed latin subset (Regular and Bold, from Fontsource) that kept the name "IBM Plex Mono". Plex's OFL reserves the font name "Plex", and a trimmed subset is a Modified Version, which may not use it (legal ruling, lab-0062). Both `@font-face` blocks were removed. The fixture's CSS still names "IBM Plex Mono", which a browser fetches from Google Fonts or finds on the host at render time; Mira stores no Plex font data. No IBM Plex font file ships in Mira, so there is no upstream release checksum to record.
- **`repos/hyperframes/docs/custom.css`:** four `@font-face` rules loaded TT Norms Pro (TypeType, commercial) from HeyGen's asset CDN for the docs site. They were removed; body text and headings now use a system stack (`'Inter'` if installed locally, then `-apple-system`, `BlinkMacSystemFont`, `'Segoe UI'`, `Roboto`, `Arial`, `sans-serif`), and no webfont is loaded for it.
- **`repos/hyperframes/skills/embedded-captions/assets/brand/`:** a fan-made replica of a video-game logo
  typeface, its fan-kit terms ("not for commercial usage", which conflicts with redistribution under AGPL-3.0)
  and the glyph widths/bounds measured from that fan kit. All removed; the folder is now empty and
  gitignored. The theme compiler's `coverword` setpiece now sets the word in the bundled Anton face (see the
  table below).
- **`repos/hyperframes/skills/graphic-overlays/assets/fonts/Virgil.woff2`:** removed because its licence could
  not be confirmed. The upstream repository (excalidraw/virgil) says OFL, but the font's own name table says
  "Freeware for personal use". The skill now suggests Caveat or the system `cursive` font.

## Fonts and scripts bundled inside engines (lab-0062)

| Path | Component | Licence | Licence text / source |
|------|-----------|---------|-----------------------|
| `repos/hyperframes/skills/embedded-captions/assets/fonts/anton-glyph-metrics.json` | Advance widths and ink bounds for the `coverword` setpiece | SIL OFL 1.1 (data derived from the font) | Generated by `skills/embedded-captions/scripts/gen-glyph-metrics.py` (fontTools) from the bundled `modes/standard/fonts/files/anton-latin-400-normal.woff2` (Anton, licence text `OFL-anton.txt` beside it); the file's `_meta` records the source path and SHA-256. Regenerate from the skill folder with `python3 scripts/gen-glyph-metrics.py modes/standard/fonts/files/anton-latin-400-normal.woff2 Anton --output assets/fonts/anton-glyph-metrics.json` (UTF-8, temp file plus atomic rename; a failed run exits non-zero and leaves the file untouched) |
| `repos/hyperframes/skills/graphic-overlays/assets/fonts/Caveat-{400,700}-latin.woff2` | Caveat | SIL OFL 1.1 | `OFL-caveat.txt` beside it, byte for byte from [google/fonts `ofl/caveat/OFL.txt` @ 2eb0b48d5f760f62e286216f0859a8c540dbc1bd](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/caveat/OFL.txt) |
| `repos/hyperframes/skills/graphic-overlays/assets/fonts/Inter-{400,700}-latin.woff2` | Inter | SIL OFL 1.1 | `OFL-inter.txt` beside it, byte for byte from [google/fonts `ofl/inter/OFL.txt` @ 2eb0b48d5f760f62e286216f0859a8c540dbc1bd](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/inter/OFL.txt) |
| Inter as shipped: `repos/hyperframes/skills/graphic-overlays/assets/fonts/Inter-{400,700}-latin.woff2` and `repos/hyperframes/skills/embedded-captions/modes/standard/fonts/files/inter-latin-*.woff2` | Inter version 4.001 (git-66647c0bb) | SIL OFL 1.1 | Each file carries its own notice, "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)". The `OFL-inter.txt` beside them is the unchanged upstream google/fonts text, which says "Copyright 2020 The Inter Project Authors"; both name the same authors under the same licence. |
| `repos/hyperframes/skills/graphic-overlays/assets/fonts/LXGWWenKaiTC-400-latin.woff2` | LXGW WenKai TC | SIL OFL 1.1 | `OFL-lxgw-wenkai-tc.txt` beside it, byte for byte from [lxgw/LxgwWenkaiTC `OFL.txt` @ v1.330 (e161a32aeaf17666e0e14aca45ebcbf92ec4ba85)](https://github.com/lxgw/LxgwWenkaiTC/blob/e161a32aeaf17666e0e14aca45ebcbf92ec4ba85/OFL.txt) |
| `repos/hyperframes/skills/graphic-overlays/assets/vendor/gsap.min.js` | GSAP 3.15.0 by GreenSock (Webflow, Inc.) | GSAP Standard License, granted by Webflow, Inc. (https://gsap.com/standard-license). Not open source (not OSI-approved). It allows free use, including commercial use, on websites, web apps and digital interfaces, but prohibits using GSAP in no-code visual animation-building tools that compete with Webflow's visual animation builder without written consent, and prohibits reverse engineering it to build such products or removing its notices. Webflow may amend or terminate the licence. | Its notice: "Copyright 2026, GreenSock. All rights reserved. Subject to the terms at https://gsap.com/standard-license." Not covered by hyperframes' Apache-2.0 licence or by Mira's AGPL-3.0. |
| GSAP inlined into 20 regression goldens, `repos/hyperframes/packages/producer/tests/*/output/compiled.html` (19 × GSAP 3.14.2, 1 × 3.12.5, each from jsDelivr) | GSAP by GreenSock (Webflow, Inc.) | GSAP Standard License (Webflow, Inc.), as above; not open source | The inlined copy keeps its own notice ("@license Copyright 2025, GreenSock. All rights reserved. Subject to the terms at https://gsap.com/standard-license." or the 3.12.5 equivalent). Test data only; not covered by Apache-2.0 or AGPL-3.0. |
| Fonts embedded as base64 `@font-face` data in the regression goldens, `repos/hyperframes/packages/producer/tests/*/output/compiled.html` | 14 Google Fonts families (Archivo Black, Caveat, EB Garamond, Fraunces, Inter, JetBrains Mono, League Gothic, Montserrat, Nunito, Oswald, Outfit, Roboto, Space Grotesk, Space Mono) | SIL OFL 1.1 | One licences folder, `repos/hyperframes/packages/producer/tests/FONT-LICENSES/`: `OFL-<family>.txt` byte for byte from google/fonts `ofl/<family>/OFL.txt` @ 2eb0b48d5f760f62e286216f0859a8c540dbc1bd, and a README listing family, source and fixtures (and where an embedded file's own copyright line differs from the OFL.txt header). None of these 14 OFL texts has a Reserved Font Name |
| `repos/hyperframes/skills/embedded-captions/modes/standard/fonts/fonts.css` (44 base64 faces) | The woff2 files in `modes/standard/fonts/files/`, byte for byte | SIL OFL 1.1 / Apache-2.0 | Licence text for every family in `files/` (`OFL-<family>.txt`, `Apache-2.0-<family>.txt`); the generated header of `fonts.css` now says so |

## External engines (NOT bundled — fetch yourself)

These are **not** redistributed with Mira because their licenses are incompatible
with, or more restrictive than, Mira's AGPL-3.0. Install them yourself with
[`scripts/setup-engines.sh`](scripts/setup-engines.sh); you obtain them directly
from upstream under upstream's terms.

| Engine | License | Why external |
|--------|---------|--------------|
| n8n | Sustainable Use License (fair-code) | Not AGPL-compatible; restricts commercial/hosted redistribution |
| SkyReels-V2 | Skywork Community License (custom) | Custom model license; not AGPL |

## Dropped (not used, not shipped)

- **AVTR-1** (Goodsize model license) — its "derivatives must stay exclusively under
  the AVTR-1 agreement" clause conflicts with AGPL, and it requires a paid commercial
  license for entities with ≥ $10M revenue. Removed entirely.
- **ltx-video-mac** (MIT) — unused; removed.

## Credits within Mira's own code

CoCo Ads / launch-video flow derives from the open-source `brag` skill (credited in
the main CoCo repo).
