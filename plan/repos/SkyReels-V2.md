# SkyReels-V2 — cloud-burst self-hosted video model (deep-dive)

- **Repo:** `github.com/SkyworkAI/SkyReels-V2` · **fork:** `github.com/rkz91/SkyReels-V2` · **local:** `repos/SkyReels-V2`
- **License:** Skywork Community License (check terms before monetizing)
- **Verdict:** **KEEP — cloud-burst fallback only**
- **Canonical analysis:** chat [SkyReels reassessment](e2b3b6d1-skyreels-reassess)

## What it actually is
An open **diffusion-forcing video model** with inference scripts: `generate_video.py`, `generate_video_df.py` (diffusion forcing / longer clips), the `skyreels_v2_infer/` package, and `skycaptioner_v1/`. Comes in **1.3B** (fast/light) and **14B** (quality) variants. **CUDA-only, heavy VRAM** → does not run well on the Mac.

## On disk (verified)
- `generate_video.py`, `generate_video_df.py`, `skyreels_v2_infer/`, `skycaptioner_v1/`, `requirements.txt`, `assets/`.

## Role in Mira
The **specific open model we run when we cloud-burst** (Mac saturated, or we want self-hosted coherent clips at volume without per-clip API fees). It is **not** an everyday-local engine.
- Burst order: **Vultr free-credit GPU first → AWS spot fallback**.
- 1.3B for fast drafts, 14B for quality.

## Why keep it
- A real escape hatch for volume/coherent clips without paying per-second video APIs.
- Open weights → no per-clip metering once the GPU is up.

## Integration tasks
- Containerize for the burst launcher; wire **auto-teardown** (destroy instance when idle) + live credit meter.
- Default to **local ComfyUI/LTX** first; only burst SkyReels on saturation/CUDA-only need.

## Caveats
CUDA + big VRAM (esp. 14B); Skywork Community License → re-check for monetization; burst = real spend after free credits → guard with budget cap + teardown.
