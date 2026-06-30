# Repo deep-dives — index

Per-repo analysis for the 9 forked repos. Each file: identity · what's on disk (verified) · role in Mira · why · integration tasks · license · caveats. The exhaustive line-by-line code analyses live in the linked chat transcripts; these files are the committed, fork-readable summary.

All repos cloned to `repos/<name>/`, forked to `github.com/rkz91/*` (`origin` = fork, `upstream` = original).

| Repo | Verdict | Role | Deep-dive |
|---|---|---|---|
| OpenMontage | **KEEP — primary engine** | 13 agentic pipelines, provider selectors, cost tracker, checkpoints | [OpenMontage.md](OpenMontage.md) |
| MoneyPrinterTurbo | **KEEP — headless volume** | fully-automated faceless shorts (web UI + API + CLI) | [MoneyPrinterTurbo.md](MoneyPrinterTurbo.md) |
| HyperFrames | **KEEP — OpenMontage runtime** | kinetic typography / motion graphics / SVG char compositing | [HyperFrames.md](HyperFrames.md) |
| StoryGen-Atelier | **KEEP — cinematic/story lane** | Veo interpolation-chain (storyboard → A→B clips → stitch) | [StoryGen-Atelier.md](StoryGen-Atelier.md) |
| Open-Generative-AI | **KEEP — premium lane UI** | motion transfer (Kling) + lip-sync + AI clipping | [Open-Generative-AI.md](Open-Generative-AI.md) |
| SkyReels-V2 | **KEEP — cloud-burst fallback** | self-hosted open video model (14B quality / 1.3B fast) | [SkyReels-V2.md](SkyReels-V2.md) |
| AVTR-1 | **MAYBE — personal brand only** | talking-head from a photo (renderer non-commercial) | [AVTR-1.md](AVTR-1.md) |
| locally-uncensored | **OPTIONAL cockpit + capability** | uncensored local provider (capability in; app out) | [locally-uncensored.md](locally-uncensored.md) |
| Free-ai-video-generator | **SKIP** | README-only, no pipeline code | [Free-ai-video-generator.md](Free-ai-video-generator.md) |

See [`../PLAN.md` §1](../PLAN.md) for the scored table and the repo→role diagram.
