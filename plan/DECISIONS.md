# Project Mira — Decisions Log (ADR)

Every meaningful decision + the rationale, so future-you and forks understand *why*, not just *what*. Newest at top. Status: ✅ Decided · 🔄 Revisit-at-monetization · ⏸️ Deferred.

> Open (undecided) items live in [`PLAN.md` "Open decisions"](PLAN.md). This log is the *decided* history.

---

### ADR-022 ✅ Expand the free Script-LLM pool from `cheahjs/free-llm-api-resources`
**Context:** Script-LLM overflow + the §6.3 compute swarm only listed NIM/OpenRouter/Gemini. The community list [`cheahjs/free-llm-api-resources`](https://github.com/cheahjs/free-llm-api-resources) (23k★, accessed 2026-06-19) surfaces several legitimate, OpenAI-compatible perpetual free tiers we weren't using.
**Decision:** Add **Mistral La Plateforme** (~1B tok/mo — largest free pool), **Groq** & **Cerebras** (fast, ~14.4k req/day), **Cloudflare Workers AI** (10k neurons/day), and **GitHub Models** (frontier, tight caps) as Script-LLM providers in the Engines matrix + Connections, and into the swarm provider pool + `quota_ledger` provider enum.
**Why:** Each pod member's own accounts multiply free headroom and beat single-account rate limits — directly strengthening the swarm. Kept as *overflow*, not primary; LM Studio local stays the private default. ToS: one genuine account per real member, switch to paid keys at monetization.
**Excludes:** reverse-engineered/illegitimate services (per the list's own policy).

### ADR-021 ✅ Materialize all planning docs as committed files
**Context:** Repo deep-dives existed only as chat links; no index/launch/security/schema docs.
**Decision:** Create `repos/*.md`, `LAUNCH.md`, `DECISIONS.md`, `SECURITY.md`, `SCHEMA.md`, `README.md`.
**Why:** Forks/collaborators land with no entry point; chat links aren't portable.

### ADR-020 ✅ Free-GPU sources tiered by automatability
**Decision:** **Vultr free credits → AWS spot** for *automated* burst. Colab/Kaggle/cgpu are **manual-only** experimental sandboxes, off the automated pipeline.
**Why:** Notebook/interactive providers violate ToS for headless automation and are unreliable; Vultr/AWS expose real APIs + teardown. (PLAN §6.3)

### ADR-019 ✅ Compute swarm pools *capacity*, not keys
**Decision:** Pod members' free accounts (NIM/OpenRouter/Gemini/Veo/Vultr) form a capacity swarm; jobs route to the member with headroom and **run on their machine with their key local**. Quota ledger in Supabase; rotation = least-used + 429-backoff.
**Why:** Beats single-account rate limits without ever sharing secrets; fairness + ToS-safe. (PLAN §6.3)

### ADR-018 ✅ RAM tiers (Heavy/Mid/Light) + graceful degradation
**Decision:** Probe RAM/VRAM/GPU at onboarding → tier sets Engine defaults. Sequential stages + model unload, lowvram/tiled, quant-to-fit, segmented long-form, concurrency=1 on Mid/Light; headroom guardrail downgrades/offloads before OOM.
**Why:** Collaborators have varied laptops; must not OOM. (PLAN §6.2)

### ADR-017 ✅ Two-plane distribution (local-first, cloud-coordinated)
**Decision:** **Execution plane** = local Mira Agent (OpenMontage + keys + rendering) on each member's Mac/Windows. **Coordination plane** = Vercel UI + Supabase (Auth, shared state, Realtime). **No secrets/media/rendering in the cloud.**
**Why:** Friends use their own keys/compute; privacy + cost stay local; cloud only coordinates. (PLAN §6.1, DASHBOARD_SPEC deployment)

### ADR-016 ✅ Cross-platform agent (Mac primary, Windows supported)
**Decision:** Package the agent for Mac + Windows (`mira setup` / tray app). Windows = CUDA ComfyUI+LM Studio, or no-GPU fallback to NIM/OpenRouter/Gemini+Veo.
**Why:** Some friends are on Windows.

### ADR-015 ✅ Thumbnail + metadata packaging is a first-class step
**Decision:** Generate 2–3 thumbnail + title/description/tags/hashtags variants (localized EN/HI), pick in Review; `mira package`.
**Why:** Biggest prior gap — #1 CTR lever for long-form, discovery for Shorts.

### ADR-014 ✅ Per-channel brand kit + Assets/My-media + Music lane + AI disclosure
**Decision:** Add brand kit (intro/outro, logo, caption style, palette, music bed), an Assets screen (enhance/animate your footage), a royalty-free music lane (auto-ducked), and an AI-disclosure toggle at publish.
**Why:** Consistency pillar, the "enhance my clips" ask, monetization-safe audio, policy compliance.

### ADR-013 ✅ Long-form via documentary/explainer pipeline + hub-and-spoke
**Decision:** Channel `video_type` (Short 9:16 / Long 16:9). Long-form = word-budgeted script → many cheap scenes → 16:9 1080p + chapters + free TTS; `clip-factory` repurposes one long-form into a week of Shorts.
**Why:** YouTube target is 3–5 min; one long-form should feed many shorts.

### ADR-012 ✅ Length control = word budget → fixed TTS rate → ffprobe check
**Decision:** Per-channel band + hard cap, enforced by script word budget, fixed speaking rate, and `verify_scene_pacing`/`ffprobe`; checked in the QA gate.
**Why:** Deterministic duration without guesswork.

### ADR-011 ✅ Learning cost+ETA estimator
**Decision:** `cost_model.json` keeps EMA of unit costs over OpenMontage's `cost_tracker`; Studio shows predicted cost+ETA with a tightening range; `mira estimate`.
**Why:** Cost is a core constraint; predict before spending.

### ADR-010 🔄 Uncensored = capability IN, app OUT
**Decision:** Add uncensored local LLM (abliterated GGUF) + ComfyUI checkpoint as selectable providers for edgy-but-legal creative; the locally-uncensored *app* stays optional (redundant UI wrapper). Content policy + disclosure remain at publish.
**Why:** Earlier "ToS risk" reasoning was wrong — no-refusal ≠ policy-violating. Re-check at monetization. (repos/locally-uncensored.md)

### ADR-009 ✅ StoryGen-Atelier → cinematic lane (ported)
**Decision:** Promote from MAYBE to KEEP; port its interpolation-chain into OpenMontage `cinematic`, gated behind Veo quota.
**Why:** Unique narrative coherence, cheap on existing Veo quota.

### ADR-008 ✅ SkyReels-V2 = cloud-burst fallback only
**Decision:** Keep as the open model we run on Vultr/AWS burst (1.3B fast / 14B quality), not an everyday-local engine.
**Why:** CUDA-heavy; real escape hatch for volume without per-clip API fees. 🔄 license at monetization.

### ADR-007 ✅ OpenMontage = primary engine; MoneyPrinterTurbo = headless volume (bake-off)
**Decision:** OpenMontage is the in-the-loop quality engine and dashboard backbone; MPT is the headless auto-publish volume engine. Phase 5 bake-off; default keep OpenMontage.
**Why:** OpenMontage has lanes, anti-inauthentic checks, cost tracking, checkpoints; MPT is simpler/template-y.

### ADR-006 ✅ Mac-first compute; cloud on demand
**Decision:** M4 Max handles scripts/voice/images/edit/captions/local clips. Cloud GPU is a deliberate **burst** (Vultr→AWS) for Mac saturation or CUDA-only models, with cost warning + auto-teardown.
**Why:** Keep it ~$0; avoid idle cloud billing.

### ADR-005 ✅ LM Studio (MLX) over Ollama for local LLM; NIM/OpenRouter/HF as overflow
**Decision:** Local LLM via LM Studio `localhost:1234/v1`; NIM (MiniMax-M3, Nemotron 3, Sarvam-M Hindi), OpenRouter, HF local as free overflow.
**Why:** User preference + existing LM Studio model library; NIM free dev tier.

### ADR-004 ✅ Three-layer operating model + `mira` command layer
**Decision:** Dashboard (Vercel/local) + n8n (schedule) + Engine (OpenMontage), all over a single `mira` FastAPI+CLI command layer. Drivable by Cursor/Claude/Antigravity.
**Why:** One testable seam (DEV_PLAN); UI and automation are just callers.

### ADR-003 ✅ HTML prototype first, refactor to Next.js+Tailwind later
**Decision:** Build a single-file Anthropic-styled HTML prototype (`dashboard/prototype.html`), refactor to Next.js+Tailwind at Phase 9.
**Why:** Fast iteration on UX before committing to a framework; extension cost is acceptable.

### ADR-002 ✅ Trust-based publishing + live cost meter
**Decision:** Always-on approval gate by default, with a per-channel "auto-publish when trusted" toggle; live cost meter for metered services.
**Why:** Quality control early, automation once trusted; cost visibility is core.

### ADR-001 ✅ Hobby-first, monetize-later framing
**Decision:** Treat as a personal/hobby project now; non-commercial licenses (AVTR renderer, PolyForm, AGPL personal use) are fine. Flag everything to re-check at monetization.
**Why:** "For now it's a fun project" — don't over-engineer for commercial compliance yet, but keep a 🔄 trail.
