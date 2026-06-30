# StoryGen-Atelier — cinematic / story lane (deep-dive)

- **Repo:** `github.com/0xsline/StoryGen-Atelier` · **fork:** `github.com/rkz91/StoryGen-Atelier` · **local:** `repos/StoryGen-Atelier`
- **License:** see repo `LICENSE` (treat as personal-use for now)
- **Verdict:** **KEEP — cinematic/story lane (port the chain into OpenMontage)**
- **Canonical analysis:** chat [StoryGen reassessment](e2b3b6d1-2a6e-4d6a-9b6f-storygenc).

## What it actually is
A full-stack app (`backend/` + `frontend/` + `start_servers.sh`) implementing an **interpolation-chain** for *coherent narrative* video: storyboard → generate keyframes (Gemini/Imagen) → **Veo keyframe A→B clips** → FFmpeg stitch, with **style presets**. The unique bit is character/scene **coherence across shots** — exactly what plain text-to-video lacks.

## On disk (verified)
- `backend/`, `frontend/`, `guide/`, `exampleImg/`, `start_servers.sh` / `stop_servers.sh`.

## Role in Mira
The **cinematic / hero-piece lane (Lane A2)**. We don't run the app; we **port its interpolation-chain logic into OpenMontage's `cinematic.yaml` pipeline** so it shares the same providers, cost meter, and checkpoints.

## Why keep it
- Solves narrative coherence cheaply by leaning on **Veo via your Vertex quota** (hero clips at ~$0 marginal).
- Distinct from everyday volume — reserved for standout pieces.

## Integration tasks
- Extract storyboard → frames → A→B Veo → stitch into OpenMontage `cinematic`.
- Gate behind the **Veo quota / cost meter** (quota-heavy; not for daily volume).
- Map style presets to per-channel brand kit.

## Caveats
Quota-heavy (Veo) → cap usage; verify license before any monetization.
