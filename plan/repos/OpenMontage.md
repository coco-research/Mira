# OpenMontage — primary engine (deep-dive)

- **Repo:** `github.com/calesthio/OpenMontage` · **fork:** `github.com/rkz91/OpenMontage` · **local:** `repos/OpenMontage`
- **License:** AGPL-3.0 (copyleft — see caveats)
- **Verdict:** **KEEP — primary engine**
- **Canonical line-by-line analysis:** chat [OpenMontage analysis](f78fc4e8-6dfd-47db-bf02-dd57b04c1cfa)

## What it actually is
An **agentic, Cursor-driven video production platform** — not a "cuts & captions" helper. It's designed to be driven by AI coding agents (ships `AGENTS.md`, `CLAUDE.md`, `CURSOR.md`, `CODEX.md`, `COPILOT.md` driver guides + a `PROMPT_GALLERY.md`). Python core + a Remotion composer (Node) + a HyperFrames bridge. This is why it's our **brain-driven engine**: you (via Cursor/Claude) or `mira` drive it.

## On disk (verified)
- **`pipeline_defs/`** — 13 declarative pipelines: `animated-explainer`, `animation`, `avatar-spokesperson`, `character-animation`, `cinematic`, `clip-factory`, `documentary-montage`, `hybrid`, `localization-dub`, `podcast-repurpose`, `screen-demo`, `talking-head`, `framework-smoke`.
- **`tools/`** — provider selectors that back the dashboard Engines matrix: `tools/audio/tts_selector.py`, `tools/graphics/image_selector.py`, `tools/video/video_selector.py`; **`tools/cost_tracker.py`** (estimate→reconcile, `cost_log.json`); **`tools/tool_registry.py`** (`provider_menu()` / `support_envelope()` capability probe).
- **`lib/`** — `checkpoint.py` (**approval gates**), `media_profiles.py` (9:16 + `youtube_landscape` 16:9), `verify_scene_pacing.py`, **`slideshow_risk.py` + `variation_checker.py`** (anti "inauthentic content" — direct YouTube-policy insurance), **`source_media_review.py`** (review/enhance *your* footage — the "enhance my clips" ask), `playbook_generator.py` (style playbooks), **`hyperframes_style_bridge.py`** (HyperFrames integration), `pipeline_loader.py`, `scoring.py`, `shot_prompt_builder.py`, `clip_embedder.py`, `corpus.py`, `delivery_promise.py`.
- **`schemas/`** — `artifacts`, `checkpoints`, `pipelines`, `styles`, `tools`.
- **`tests/`** — `contracts/test_phase0..3_contracts.py` + `qa/test_08_end_to_end.py` — **already phased contract + e2e tests** (reuse as the `DEV_PLAN.md` contract-test base).
- **`remotion-composer/`** — the **no-GPU** Remotion render path.

## Role in Mira
The **primary, in-the-loop engine**. The dashboard is a thin surface over it:
- Engines matrix ← `tool_registry.provider_menu()` / `support_envelope()`
- Cost meter ← `cost_tracker` / `cost_log.json`
- Approval gate ← `checkpoint.py` policies (`guided` / `manual_all` / `auto_noncreative`)

Lanes it powers: **faceless** (`animated-explainer`/`animation`/`cinematic`), **cinematic story** (`cinematic` + the ported StoryGen chain), **personal** (`talking-head`/`clip-factory` + `avatar-spokesperson`), **Hindi** (`localization-dub`), **repurpose** (`clip-factory`, `podcast-repurpose`), **long-form** (`documentary-montage`, `animated-explainer`).

## Why it wins the bake-off (favored)
- **No-GPU Remotion path** → $0.15–$1.33/video in its own examples.
- **Built-in anti-inauthentic checks** (`variation_checker`, `slideshow_risk`) directly mitigate YouTube's 2025 "inauthentic content" enforcement.
- **Enhancement** (`source_media_review`) satisfies the "enhance my photos/clips" requirement natively.
- **Cost tracking + checkpoints already exist** → minimal dashboard re-implementation.

## Integration tasks
- Build the `mira` command layer around `tool_registry` / selectors / `cost_tracker` / `checkpoint`.
- **Port the StoryGen interpolation-chain** into `cinematic` (see [StoryGen-Atelier.md](StoryGen-Atelier.md)).
- Register **NIM / OpenRouter / uncensored-local** as providers in the selectors.
- Reuse `tests/contracts/*` + `tests/qa/*` as the DEV_PLAN contract/e2e base.

## License (AGPL-3.0)
Fine to **use** to make videos. Copyleft triggers only if you **distribute the modified software** or **run it as a network service for others**. Pod mode (each member runs their *own* agent) is fine. If we ever host a *modified* editor as a service for others, we must share source.

## Caveats
Agentic → needs an LLM driver (Cursor/you/NIM); a learning curve; AGPL. `tools/` is the real provider layer (the near-empty `lib/providers/` is not where routing lives).
