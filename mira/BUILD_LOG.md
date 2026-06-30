# Mira — Build Log (context saved after every task)

Append-only record so any agent/human can resume. Newest at top.

## Stock-footage visual route — real B-roll, key-free-ish (2026-06-21, 400 tests green)
- **Why:** the designed engines (Remotion/HyperFrames) only do text-on-gradient. First real *footage* upgrade. Verified Veo API is metered/no-free-tier (subscription's 1,000 Flow credits are manual-UI only, not API), so we lead with **Pexels stock** ($0, free key) and park Veo as an optional hero layer with a planned $5/mo cap.
- **`providers/stock.py`:** rewired the Pexels path — adds a browser **User-Agent** (bare urllib got Cloudflare 403/1010), turns narration into a **keyword query** (stopword strip), requests **orientation-matched** results, **cover-fits** (scale-up + centre-crop, no letterbox), picks a covering-but-small file, and uses `variant=i` so sibling scenes get **distinct** footage. New `MIRA_STOCK=offline` guard mirrors LLM/TTS.
- **`providers/burn.py` (new):** Pillow renders a transparent caption PNG (lower-third band + stroked text, word-wrapped to glyph metrics) that ffmpeg `overlay`s onto footage — needed because this ffmpeg lacks libfreetype (`drawtext`/`subtitles` unavailable). Empty text → fully transparent (safe no-op).
- **`pipeline.py`:** new `visual_engine="stock"` branch (per-scene footage + burned caption, topic title as shared query); `cli.py` `--visual stock`. Degrades to colour cards on any fetch failure → never hard-fails.
- **Evidence (live, `--visual stock`, topic "three free AI tools every student should know", 18s 1080×1920):** 6 distinct real clips (classroom, robot, study scenes), **h264 1080×1920 + aac + mov_text, 18.0s, 7.7 MB** (vs ~1.6 MB cards), burned captions legible, VO **−19.6 dB** real speech. edge-tts flaked silent mid-render (network) → fixed with a retried VO re-mux; the silent fallback is by design. Output: `state/stock_demo/stock_demo_voiced.mp4`.
- **Tests:** +11 in `tests/test_stock_burn.py` (keyword strip, orientation, file-pick cover/fallback, offline guard, caption PNG alpha/transparent, CLI `--visual stock`). Network guarded so the real `.env` key is never hit in tests.


## Conventions
- Core is **stdlib-only** (no pydantic/fastapi) to stay wheel-safe on Python 3.14. Only dev dep: `pytest`.
- Every module ships with `tests/test_<module>.py`. Nothing is "done" until its tests pass (DEV_PLAN gate).
- Run tests: `.venv/bin/python -m pytest` from the `mira/` project dir.

## Status snapshot — Phase 0 COMPLETE ✅ (117 tests green, 2026-06-20)
| Phase | Item | State | Tests |
|---|---|---|---|
| 0 | scaffold (pyproject, schemas, fixtures, config) | ✅ done | 4 |
| 0 | probe.py (support_envelope) | ✅ done | 23 |
| 0 | registry.py (provider_menu) | ✅ done | 13 |
| 0/1 | cost.py (cost_log + EMA estimator) | ✅ done | 24 |
| 0/1 | duration.py (word-budget→duration + ffprobe) | ✅ done | 11 |
| 0/8 | router.py (policy chain + quota ledger) | ✅ done | 31 |
| 0 | api.py + cli.py (stub commands) | ✅ done | 11 |
| | **TOTAL** | **`117 passed`** | |

Live CLI verified: `mira support` → tier=heavy, ram=64, engines {openmontage,moneyprinterturbo,comfyui}=true.

## Blocked (need creds/hardware — scaffold + tests only, cannot verify autonomously)
- Phase 1 real render (ComfyUI+models+LM Studio), Phase 3 live wiring, Phase 5 publish/n8n (YouTube OAuth),
  Phase 6 long-form/Hindi (Sarvam), Phase 7 GPU burst (Vultr/AWS), Phase 8 pod (Supabase/Vercel + 2nd machine),
  Phase 9 OAuth analytics + Next.js refactor.

---

## Deferred fixes — RESOLVED in final consolidation (2026-06-20)
From the Phase-0 verification audit. Earlier: 2 portability blockers in `test_probe.py` fixed.
Now closed in the consolidation pass:
- ✅ `router.choose_provider(..., user_id=None)` added; `_best_row` matches `(user_id, provider)` first (pod-swarm misroute fixed; backward-compatible).
- ✅ `config.ensure_state_dir()` now wired into the CLI `generate` path (no longer dead code).
- ✅ `api.dispatch` returns `copy.deepcopy(...)` — callers can't corrupt module fixtures.
- ◽ `fixtures.COST_MODEL` vs `config.COST_MODEL` name collision — left as-is (distinct modules, no runtime clash); revisit if it ever confuses. nit.
- ◽ `probe.tier_for(has_gpu=...)` unused param / `cost.load_cost_model` docstring — cosmetic nits, deferred.

## Log

### 2026-06-19 — Phase 0 foundation
- Created `mira/` project: `pyproject.toml` (stdlib core, `mira` console script), `.gitignore`, package `mira/__init__.py`.
- `schemas.py`: dataclasses for Channel/BrandKit/Topic/Video/Package/CostLogEntry/MachineInfo/SupportEnvelope/ProviderOption/StageMenu/QuotaLedgerRow + enums (STAGES, LLM_PROVIDERS incl. the 5 new free providers, QUOTA_WINDOWS).
- `fixtures.py`: golden data matching SCHEMA.md + dashboard `_CONTRACT.md` (3 channels, 7 videos + failure, ideas, cost meter, support_envelope, cost_model).
- `config.py`: paths/state dir, provider base URLs, local ports, config.toml loader.
- `tests/test_schemas_fixtures.py`: round-trip + free-provider-pool assertions.

### 2026-06-20 — Phase 0 modules (6 parallel agents, Sonnet 4.6) — ALL GREEN
- `probe.py` (23) live machine/port/repo probe; `registry.py` (13) provider_menu incl. 5 new free LLMs;
  `cost.py` (24) ledger + EMA estimator; `duration.py` (11) word-budget + real ffprobe (ffmpeg present);
  `router.py` (31) policy chain + quota-ledger 429 backoff; `api.py`+`cli.py` (11) stdlib http + argparse stubs.
- Full suite: **117 passed in 1.31s**. CLI/API run end-to-end on fixtures.
- **Phase 0 DoD met:** every command callable, returns typed JSON, contract tests green, engines/probe enumerated.

### 2026-06-20 — Waves 1 & 2 + FINAL CONSOLIDATION — ALL GREEN
- Wave 1: Phase 1 pipeline (real 8s .mp4), Phase 3 dashboard data layer (live+fallback), Phase 8 Supabase schema/RLS + `pod.py`.
- Wave 2: Phase 5 publisher+scheduler+n8n, Phase 6 long-form+Hindi dub+clip-factory, Phase 7 RAM tiers+cloud-burst, Phase 9 analytics+observability.
- **Consolidation pass:**
  - Wired the real command surface into `cli.py`: `generate`, `schedule`, `publish` (dry-run default), `analytics`, `make-shorts`, plus `engines`/`keys` fetches — alongside the existing read commands.
  - Hardened `api.py`: deep-copied route bodies; added `/engines`, `/keys`, `/videos` routes (lazy imports so a missing sibling never breaks core routes).
  - Applied all 3 deferred WARN fixes (router user_id, ensure_state_dir, fixture deep-copy). See resolved list above.
  - Added `tests/test_cli_actions.py` (6 tests) covering the new commands + deep-copy invariant.
- **Full suite: `362 passed in ~6s`.** Smoke: `mira generate --topic "5 free AI tools" --target 20` produced a real 20.0s MP4 fully offline (no keys).
- **Everything that can be verified without credentials/2nd machine is GREEN.** Remaining work is human-gated only (OAuth, Supabase/Vercel project creation, optional metered keys, GPU billing) — see `SETUP.md`.

### 2026-06-20 — Quality-first pivot + real voiceover
- User reprioritised: **build/judge video quality locally first**; publishing (YouTube/IG), Supabase/Vercel, and cloud GPU are **parked**. Only quality-relevant free keys matter now (Gemini, OpenRouter, NIM, Pexels, Pixabay).
- Honest gap audit of `generate()`: today's no-key output = template script + **silent** audio + **solid-colour cards** + invisible soft subs → a structural smoke test, not a quality artifact.
- **ffmpeg constraint found:** Homebrew ffmpeg 8.1 built WITHOUT libfreetype/libass/fontconfig → no `drawtext`/`subtitles` filter. Burned-in captions must come via a Pillow PNG-overlay path (planned), not libass — avoids changing the user's system ffmpeg.
- **Real voiceover shipped (no key):** installed `edge-tts` + `Pillow` in the venv. Rewrote `providers/tts.py` to invoke `python -m edge_tts` (venv-robust, not PATH-dependent), default voice `en-US-AndrewNeural`, `apad`+`-t` fit (pads silence, only trims on overshoot), and `MIRA_TTS=offline` force-switch. Pinned the offline TTS + pipeline tests to `MIRA_TTS=offline` so the suite stays network-free.
- Verified sample (`mira generate --target 25`): final 25.0s mp4, audio **mean_volume -19.7 dB / max -3.1 dB** (genuine speech; silent track ≈ -91 dB).
- **Full suite: `372 passed`.** Remaining quality upgrades queued: burned captions (Pillow), Pexels HD/portrait selection + Pixabay fallback, music bed (mix+duck), Gemini script provider.

### 2026-06-20 — Engine supervisor (backend-owned lifecycle, dashboard-controlled)
- User feedback: engine start (ComfyUI) must be **part of the backend**, controlled from the dashboard — never a terminal step. LM Studio confirmed running with models loaded.
- New `engines.py` supervisor: `status()` / `start()` / `stop()` / `ensure_all()` + `comfyui_install_dir()` autodetect (env `COMFYUI_DIR` → config.toml → common paths, must contain `main.py`).
  - Two engine kinds: `managed_external` (LM Studio — detected, not spawned) and `spawnable` (ComfyUI — launched as a detached process group, pid tracked in `state/engines.json`, port-polled to readiness, logs to `state/logs/comfyui.log`).
  - Not-installed is a first-class state, never an error. ComfyUI flagged `optional` (Veo/stock cover b-roll without it).
- `api.py`: added GET `/engines/status`, POST `/engine/start|stop` (query `?name=`), CORS headers + `do_OPTIONS` preflight (dashboard fetches cross-origin), and `serve(supervise=True)` calls `engines.ensure_all()` on boot.
- `cli.py`: added `up` (start backend + supervise), `engines-status`, `engine-start`, `engine-stop`.
- Dashboard `engines.html`: new **Local engines** card — live status dots (running/stopped/not-installed), Start/Stop/Install buttons wired to the API via new `api.postJSON`; static fallback + "backend offline" hint when API is down. Prototype rebuilt.
- `SETUP.md`: rewrote the operating model (run `mira up` once → control everything from the dashboard) and Tier 0 (LM Studio auto-detected ✅; ComfyUI optional + backend-supervised). Removed the manual-terminal framing.
- Tests: `test_engines.py` (10). **Full suite: `372 passed`.** Live smoke: booted `mira up`, `/engines/status` returned LM Studio running + 7 models and ComfyUI not-installed/managed; POST start ComfyUI returned a clean `not_installed` hint.

### 2026-06-20 — Key-free Visual Pivot (Remotion A vs HyperFrames B)
Goal: render the SAME topic two ways with **zero API keys** and compare in the dashboard, so we can pick a visual style before any key/billing is involved. Plan: `.cursor/plans/key-free_visual_pivot_58e7c8ed.plan.md`.
- **Phase 0 (de-risk) — both engines render here, no keys, no GPU:**
  - OpenMontage Remotion (`remotion-composer` npm install + `render_demo.py world-in-numbers`) → `world-in-numbers.mp4`, **h264 1920×1080 + aac, 23.1s**.
  - HyperFrames (`npx hyperframes init … --example kinetic-type` → render `--no-browser-gpu`) → **h264 1920×1080 + aac, 15.0s**. `hyperframes doctor` passed every check (ffmpeg/ffprobe found, chrome-headless cached). Learned: `render` resolves project root at the nearest `package.json`, so HyperFrames must run from a **standalone project dir** (not inside the monorepo).
- **Phase 1 (key-free scripts):** `providers/llm.py` now tries **LM Studio first** (`http://localhost:1234/v1`, auto-selects first loaded non-`*embed*` chat model, no key), then keyed overflow (Groq→OpenRouter→Mistral→NIM→**Gemini** added), then the offline template. Added `_coerce_script()` (tolerates string-scenes / missing seconds) and a `MIRA_LLM=offline` force-switch (suite stays deterministic + network-free). Live proof: gemma-4-12b-qat returned real JSON ("Stop struggling with homework! Use Perplexity…"). Caveat: it's a **reasoning model** — `max_tokens=1000` is the sweet spot (≈700 reasoning + room for JSON); bigger budgets let it ramble into empty content. ~108s/script on this Mac.
- **Phase 2 (adapters):** new `providers/designed.py` — `render_remotion()` (builds `{theme,width,height,cuts[]}` props → `npx remotion render … Explainer`) and `render_hyperframes()` (generates a standalone `index.html` of timed GSAP text-cards + `package.json`/`hyperframes.json` → `npx hyperframes render --no-browser-gpu`). Both shell out (no Node imported into Python), prepend `/opt/homebrew/bin` to PATH so subprocess ffmpeg is found, and raise `EngineUnavailable` to degrade. One backward-compatible edit to OpenMontage `Root.tsx` `calculateMetadata` to honor `props.width/height` (portrait shorts; demos unaffected). Verified: both produce **portrait 360×640 h264** (Remotion 8.0s incl. its 1s fade-pad, HyperFrames 7.0s).
- **Phase 3 (pipeline):** `pipeline.generate(visual_engine=…)` switch — `cards` (default, always-available solid-colour fallback) | `remotion` | `hyperframes`; designed engines render ONE full-composition clip then reuse the existing VO+SRT ffmpeg mux; on `EngineUnavailable` it falls back to cards. `--visual {cards,remotion,hyperframes}` on `mira generate`; `MIRA_VISUAL_ENGINE` env default; `config.VISUAL_ENGINE`. E2E verified: hyperframes → final **360×640 h264 + aac + mov_text**, 6.0s.
- **Phase 4 (A/B bench + Review):** `pipeline.bench()` renders the same topic through both engines with a **shared** script/VO/captions (only the visuals differ), writing `state/bench/latest.json`. `mira bench --topic … [--size WxH]`. API: GET `/bench` (manifest) + GET `/bench/video?engine=…` (streams the MP4, path-restricted to the bench dir). Dashboard Review screen gained an **Engine A/B** tab (two-up players, shared script, "pick A/B"). Live HTTP verified (200 video/mp4, bad engine → 404).
- **Tests:** `tests/test_designed_bench.py` (17) — scene→cuts, HTML escaping, EngineUnavailable paths, LM Studio unreachable→None, `_coerce_script`, `/bench` manifest + **path-traversal rejection**, CLI flag wiring. **Full suite: `377 passed` (~29s, no live-LLM leak).**
- **Key-free evidence (no `.env`, zero configured keys):** `mira bench --topic "three free AI tools every student should know" --target 18` → both finals **h264 1080×1920 + aac + mov_text captions, 18.0s**, real edge-tts narration **mean_volume −19.6 dB** (silent ≈ −91 dB). Remotion final 1.66 MB, HyperFrames final 2.19 MB. Note: edge-tts is network-flaky (it briefly fell back to a silent track mid-bench; a re-mux with a fresh VO fixed it — the silent fallback is by design, never a crash). LM Studio script also fell back to the template on this long run (reasoning model is slow/variable); the visual A/B — the actual deliverable — rendered cleanly both ways. Frames: `state/bench/_thumb_{remotion,hyperframes}.png`.
- **Net:** zero-key pipeline now spans script (LM Studio→template) → VO (edge-tts→silent) → **designed visuals (Remotion ⟷ HyperFrames)** → captions → mux, A/B-comparable in the dashboard. Photoreal stock/AI footage, publishing, Supabase/Vercel, cloud GPU remain parked (non-goals).
