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
