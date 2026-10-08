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
  [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills), which has no licence file, so
  OpenMontage's AGPL-3.0 licence cannot cover them. Mira ships only a link-only stub `SKILL.md` for each.

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
