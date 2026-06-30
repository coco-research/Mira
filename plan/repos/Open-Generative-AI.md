# Open-Generative-AI — premium motion-transfer lane (deep-dive)

- **Repo:** `github.com/Anil-matcha/Open-Generative-AI` · **fork:** `github.com/rkz91/Open-Generative-AI` · **local:** `repos/Open-Generative-AI`
- **License:** see repo `LICENSE`
- **Verdict:** **KEEP — premium lane (metered motion-transfer)**
- **Canonical analysis:** chat [Motion transfer + OGAI](48a78ed4-a6be-4a41-8c58-132bc550d0ff)

## What it actually is
A **Next.js + Electron** desktop/web generative-media app: text/image→video, **motion transfer / motion control** (drive a still or model with a reference motion — the "dance-clone" effect), lip-sync, and AI clipping. Ships `models_dump.json` + `project_knowledge.md` documenting its model wiring.

## On disk (verified)
- `app/`, `components/`, `src/`, `electron/`, `public/`, `models_dump.json`, `project_knowledge.md`, `Dockerfile`, `docker-compose.yml`, `next.config.mjs`, `tailwind.config.js`.

## Role in Mira
The **motion-transfer / motion-control feature** (Lane C, metered). It's the UI/orchestration reference for routing to **Kling Motion Control (V2V / 3 Turbo) via MuAPI**, with a local fallback (**Wan2.2-Animate** on cloud-burst) and Viggle as an alt. Surfaced in the dashboard's **Assets → animate** and a premium Studio lane.

## Why keep it
- Directly answers the "clone a video's motion onto a model/photo" ask.
- Good map of which hosted motion APIs to call (we borrow the routing, not necessarily the whole Electron app).

## Integration tasks
- Expose motion-transfer as a `mira` lane that calls Kling via MuAPI (metered → cost meter + warning).
- Local path: Wan2.2-Animate on Vultr/AWS burst when avoiding API spend.

## Caveats
Hosted motion APIs are **metered** (real $) → gate behind cost meter + budget cap; quality/cost trade-off vs local Wan.
