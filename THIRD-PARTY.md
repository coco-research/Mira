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
- **Commercial fonts embedded in eight regression goldens** (`repos/hyperframes/packages/producer/tests/{style-3-prod,style-7-prod,style-8-prod,style-15-prod,style-16-prod,style-18-prod,sub-comp-id-selector,sub-comp-t0}/output/compiled.html`): base64 `@font-face` copies of Helvetica Neue (Light, Italic, Bold Italic; Linotype), Helvetica LT Pro (Italic, Bold Italic; Linotype), Impact (Monotype) and Garamond (Italic, Bold Italic; Monotype). They were not captured from system fonts: every one was a licensed kit that Google Fonts serves for these commercial names (`fonts.gstatic.com/l/…`; name ID 13 says "This font has been licensed to Google Inc. … You may not redistribute"), fetched by the compiler's Google Fonts fallback when the goldens were generated. No licence allows redistributing them. The 50 `@font-face` blocks were removed; the fixtures and their sources stay, and the text falls back to the CSS stacks' generic families. Details per fixture in `repos/hyperframes/packages/producer/tests/FONT-LICENSES/README.md`.
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
| `repos/hyperframes/skills/graphic-overlays/assets/vendor/gsap.min.js` | GSAP 3.15.0 by GreenSock (Webflow, Inc.) | GSAP Standard License, granted by Webflow, Inc. (https://gsap.com/standard-license). Not open source (not OSI-approved). It allows free use, including commercial use, on websites, web apps and digital interfaces, but prohibits using GSAP in no-code visual animation-building tools that compete with Webflow's visual animation builder without written consent, and prohibits reverse engineering it to build such products or removing its notices. Webflow may terminate the licence only if its terms are not complied with. Webflow may revise the terms, but someone who does not accept a revision loses only versions released after it (and later updates to earlier versions); earlier versions stay under the terms they were licensed under. | Its notice: "Copyright 2026, GreenSock. All rights reserved. Subject to the terms at https://gsap.com/standard-license." Not covered by hyperframes' Apache-2.0 licence or by Mira's AGPL-3.0. |
| GSAP inlined into 43 regression goldens, `repos/hyperframes/packages/producer/tests/**/output/compiled.html` (19 × GSAP 3.14.2 from jsDelivr, 24 × GSAP 3.12.2 from cdnjs) | GSAP by GreenSock (Webflow, Inc.) | GSAP Standard License (Webflow, Inc.), as above; not open source | Each inlined copy keeps its own notice: 3.14.2 "@license Copyright 2025, GreenSock. All rights reserved. Subject to the terms at https://gsap.com/standard-license."; 3.12.2 "@license Copyright 2023, GreenSock. All rights reserved. Subject to the terms at https://greensock.com/standard-license or for Club GreenSock members, the agreement issued with that membership." Test data only; not covered by Apache-2.0 or AGPL-3.0. Another 10 goldens (and 60 fixture source pages) load GSAP at render time with a `<script src>` from cdnjs or jsDelivr, so no copy is stored for those. |
| Fonts embedded as base64 `@font-face` data in the regression goldens, `repos/hyperframes/packages/producer/tests/*/output/compiled.html` | 14 Google Fonts families (Archivo Black, Caveat, EB Garamond, Fraunces, Inter, JetBrains Mono, League Gothic, Montserrat, Nunito, Oswald, Outfit, Roboto, Space Grotesk, Space Mono) | SIL OFL 1.1 | One licences folder, `repos/hyperframes/packages/producer/tests/FONT-LICENSES/`: `OFL-<family>.txt` byte for byte from google/fonts `ofl/<family>/OFL.txt` @ 2eb0b48d5f760f62e286216f0859a8c540dbc1bd, and a README listing family, source and fixtures (and where an embedded file's own copyright line differs from the OFL.txt header). None of these 14 OFL texts has a Reserved Font Name |
| `repos/hyperframes/skills/embedded-captions/modes/standard/fonts/fonts.css` (43 base64 faces) | The font files in `modes/standard/fonts/files/`, byte for byte: 38 Fontsource latin-subset woff2 and 5 unmodified google/fonts TTF (see the caption-font table below) | SIL OFL 1.1 / Apache-2.0 | Licence text for every family in `files/` (`OFL-<family>.txt`, `Apache-2.0-<family>.txt`); the generated header of `fonts.css` says so |

## Caption fonts and Reserved Font Names (lab-0062)

Files in `repos/hyperframes/skills/embedded-captions/modes/standard/fonts/files/`. A subset is a Modified Version under the SIL OFL, and a Modified Version may not use a Reserved Font Name. So every family whose licence reserves a name ships as the unmodified upstream file, and `build-fonts-css.cjs` embeds that file as-is in `fonts.css`, checking its sha256 against the value below on every build. Families with no reserved name stay Fontsource latin subsets. The Reserved Font Name column is read from the licence text shipped beside the fonts and checked against google/fonts' `OFL.txt` at the same commit.

| Family | Licence | Reserved Font Name (shipped licence text) | Shipped as |
|---|---|---|---|
| Anton | OFL 1.1 | none | Latin subset from Fontsource (`anton-latin-400-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Audiowide | OFL 1.1 | "Audiowide" | Unmodified upstream file `Audiowide-Regular.ttf`: [google/fonts `ofl/audiowide/Audiowide-Regular.ttf` @ `2eb0b48d5f76`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/audiowide/Audiowide-Regular.ttf), sha256 `c7c0f2b0f6fad8c623e31772ce79f94a4edb9321ffce9fce978ea892d20ae730` |
| Baloo 2 | OFL 1.1 | none | Latin subset from Fontsource (`baloo-2-latin-400-normal.woff2`, `baloo-2-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Bangers | OFL 1.1 | none | Latin subset from Fontsource (`bangers-latin-400-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Bodoni Moda | OFL 1.1 | none | Latin subset from Fontsource (`bodoni-moda-latin-400-normal.woff2`, `bodoni-moda-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Caveat | OFL 1.1 | none | Latin subset from Fontsource (`caveat-latin-400-normal.woff2`, `caveat-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Chakra Petch | OFL 1.1 | none | Latin subset from Fontsource (`chakra-petch-latin-500-normal.woff2`, `chakra-petch-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Cinzel | OFL 1.1 | "Cinzel Decorative" | Latin subset from Fontsource (`cinzel-latin-400-normal.woff2`, `cinzel-latin-700-normal.woff2`); allowed to stay a subset because the reserved name is not the shipped family's. The shipped OFL text reserves "Cinzel Decorative", a separate family; google/fonts' Cinzel OFL.txt reserves none. |
| Cormorant Garamond | OFL 1.1 | none | Latin subset from Fontsource (`cormorant-garamond-latin-400-normal.woff2`, `cormorant-garamond-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Creepster | OFL 1.1 | "Creepster" | Unmodified upstream file `Creepster-Regular.ttf`: [google/fonts `ofl/creepster/Creepster-Regular.ttf` @ `2eb0b48d5f76`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/creepster/Creepster-Regular.ttf), sha256 `402aeb734586c74aecd3dbdc454589b1fb12e2e1c71f782fd019ae68066d9f44` |
| Fredoka | OFL 1.1 | none | Latin subset from Fontsource (`fredoka-latin-400-normal.woff2`, `fredoka-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Inter | OFL 1.1 | none | Latin subset from Fontsource (`inter-latin-400-normal.woff2`, `inter-latin-500-italic.woff2`, `inter-latin-500-normal.woff2`, `inter-latin-600-italic.woff2`, `inter-latin-600-normal.woff2`, `inter-latin-700-normal.woff2`, `inter-latin-800-normal.woff2`, `inter-latin-900-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Monoton | OFL 1.1 | "Monoton" | Unmodified upstream file `Monoton-Regular.ttf`: [google/fonts `ofl/monoton/Monoton-Regular.ttf` @ `2eb0b48d5f76`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/monoton/Monoton-Regular.ttf), sha256 `951c4cea65ffede784a7c9672feec5d329a7e1e12216c42d53ecf36c90d04dea` |
| Orbitron | OFL 1.1 | "Orbitron" | Unmodified upstream file `Orbitron[wght].ttf` (variable, wght 400–900): [google/fonts `ofl/orbitron/Orbitron[wght].ttf` @ `2eb0b48d5f76`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/orbitron/Orbitron%5Bwght%5D.ttf), sha256 `f42db2dd16e642258e35782916eceb1dcdbea06fb958d77ad71dc5963587e8fd` |
| Permanent Marker | Apache-2.0 | n/a (Apache-2.0 has no reserved names) | Latin subset from Fontsource (`permanent-marker-latin-400-normal.woff2`); allowed to stay a subset (Apache-2.0 permits modified versions). |
| Press Start 2P | OFL 1.1 | "Press Start 2P" | Unmodified upstream file `PressStart2P-Regular.ttf`: [google/fonts `ofl/pressstart2p/PressStart2P-Regular.ttf` @ `2eb0b48d5f76`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/pressstart2p/PressStart2P-Regular.ttf), sha256 `034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d` |
| Rajdhani | OFL 1.1 | none | Latin subset from Fontsource (`rajdhani-latin-500-normal.woff2`, `rajdhani-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Saira Stencil One | OFL 1.1 | none | Latin subset from Fontsource (`saira-stencil-one-latin-400-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Shippori Mincho | OFL 1.1 | none | Latin subset from Fontsource (`shippori-mincho-latin-400-normal.woff2`, `shippori-mincho-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Sora | OFL 1.1 | none | Latin subset from Fontsource (`sora-latin-400-normal.woff2`, `sora-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Space Grotesk | OFL 1.1 | none | Latin subset from Fontsource (`space-grotesk-latin-400-normal.woff2`, `space-grotesk-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| Special Elite | Apache-2.0 | n/a (Apache-2.0 has no reserved names) | Latin subset from Fontsource (`special-elite-latin-400-normal.woff2`); allowed to stay a subset (Apache-2.0 permits modified versions). |
| Teko | OFL 1.1 | none | Latin subset from Fontsource (`teko-latin-400-normal.woff2`, `teko-latin-700-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |
| VT323 | OFL 1.1 | none | Latin subset from Fontsource (`vt323-latin-400-normal.woff2`); allowed to stay a subset because its licence reserves no font name. |

## Producer bundled fonts and Reserved Font Names (lab-0062)

`repos/hyperframes/packages/producer/scripts/generate-font-data.ts` inlines Fontsource latin subsets of these families into the producer build (`src/services/fontData.generated.ts`). The compiler then embeds those subsets in compiled HTML. A subset is a Modified Version under the SIL OFL, so no family whose licence reserves its name is bundled any more. Requests for those families are aliased (`packages/core/src/fonts/aliases.ts`) to a bundled family with no Reserved Font Name, and the aliased name is no longer fetched from Google Fonts. Reserved names were checked in google/fonts `OFL.txt` @ `2eb0b48d5f760f62e286216f0859a8c540dbc1bd`. `packages/producer/scripts/check-golden-font-licences.mjs` checks the bundled faces, as well as the goldens, and the producer build runs it with `--bundled-only`.

| Family | Licence | Reserved Font Name (google/fonts `OFL.txt`) | Status |
|---|---|---|---|
| Inter | OFL 1.1 ([`ofl/inter/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/inter/OFL.txt)) | none | bundled |
| Montserrat | OFL 1.1 ([`ofl/montserrat/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/montserrat/OFL.txt)) | none | bundled |
| Outfit | OFL 1.1 ([`ofl/outfit/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/outfit/OFL.txt)) | none | bundled |
| Nunito | OFL 1.1 ([`ofl/nunito/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/nunito/OFL.txt)) | none | bundled |
| Oswald | OFL 1.1 ([`ofl/oswald/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/oswald/OFL.txt)) | none | bundled |
| League Gothic | OFL 1.1 ([`ofl/leaguegothic/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/leaguegothic/OFL.txt)) | none | bundled |
| Archivo Black | OFL 1.1 ([`ofl/archivoblack/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/archivoblack/OFL.txt)) | none | bundled |
| Space Mono | OFL 1.1 ([`ofl/spacemono/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/spacemono/OFL.txt)) | none | bundled |
| JetBrains Mono | OFL 1.1 ([`ofl/jetbrainsmono/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/jetbrainsmono/OFL.txt)) | none | bundled |
| EB Garamond | OFL 1.1 ([`ofl/ebgaramond/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/ebgaramond/OFL.txt)) | none | bundled |
| Noto Sans JP | OFL 1.1 ([`ofl/notosansjp/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/notosansjp/OFL.txt)) | 'Source' | bundled: the reserved name "Source" is not part of any of its names |
| Roboto | OFL 1.1 ([`ofl/roboto/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/roboto/OFL.txt)) | none | bundled |
| Open Sans | OFL 1.1 ([`ofl/opensans/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/opensans/OFL.txt)) | none | bundled |
| Poppins | OFL 1.1 ([`ofl/poppins/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/poppins/OFL.txt)) | none | bundled |
| IBM Plex Mono | OFL 1.1 ([`ofl/ibmplexmono/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/ibmplexmono/OFL.txt)) | "Plex" | not bundled; "IBM Plex Mono" renders with the bundled JetBrains Mono |
| Lato | OFL 1.1 ([`ofl/lato/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/lato/OFL.txt)) | "Lato" | not bundled; "Lato" renders with the bundled Inter |
| Playfair Display | OFL 1.1 ([`ofl/playfairdisplay/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/playfairdisplay/OFL.txt)) | "Playfair Display" | not bundled; "Playfair Display" renders with the bundled EB Garamond |
| Source Code Pro | OFL 1.1 ([`ofl/sourcecodepro/OFL.txt`](https://github.com/google/fonts/blob/2eb0b48d5f760f62e286216f0859a8c540dbc1bd/ofl/sourcecodepro/OFL.txt)) | 'Source' | not bundled; "Source Code Pro" renders with the bundled JetBrains Mono |

The `@fontsource/ibm-plex-mono`, `@fontsource/lato`, `@fontsource/playfair-display` and `@fontsource/source-code-pro` packages remain as unused dependencies in `packages/producer/package.json` and `bun.lock` (no lockfile change in this PR). They should be dropped the next time the lockfile changes, and before any image that bundles `node_modules` is published.

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
