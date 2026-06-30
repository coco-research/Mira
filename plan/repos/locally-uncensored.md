# locally-uncensored — capability in, app optional (deep-dive)

- **Repo:** `github.com/PurpleDoubleD/locally-uncensored` · **fork:** `github.com/rkz91/locally-uncensored` · **local:** `repos/locally-uncensored`
- **License:** see repo `LICENSE`
- **Verdict:** **OPTIONAL cockpit — but integrate the CAPABILITY**
- **Canonical analysis:** chat [locally-uncensored reassessment](48a78ed4-a6be-4a41-8c58-132bc550d0ff)

## What it actually is
A cross-platform **Tauri** desktop app (`src-tauri/`, Vite `src/`, `setup.sh`/`setup.bat`/`setup.ps1`, `codex-api/`) that wraps **local uncensored models** behind a friendly UI + a curated model list + no-refusal prompt presets.

## On disk (verified)
- `src-tauri/` (Tauri shell), `src/` + `index.html` (Vite UI), `codex-api/`, `setup.*` (mac/win/linux), `update.bat`, `logos/`, `docs/`.

## The corrected reasoning
"Uncensored = ToS/monetization risk" was **wrong**. Uncensored just means the local model **won't refuse**; it doesn't make you produce policy-violating content. The real value is **no refusals on legitimately edgy-but-legal creative** (horror, satire, mature themes that cloud models reject).

## Role in Mira
- **Capability — IN:** an **uncensored local script LLM** (abliterated GGUF in LM Studio) + an **uncensored ComfyUI checkpoint** become **selectable providers** in the Engines matrix for the edgy-but-legal lane. Borrow the repo's **curated model list + no-refusal prompts**.
- **App — OPTIONAL:** the Tauri app itself is **redundant** (it's a UI wrapper over LM Studio/Ollama, which we already drive via `mira`). Keep it only as an optional local cockpit/sandbox.

## Integration tasks
- Add `script.uncensored-local` + `image.uncensored-local` provider entries pointing at LM Studio / ComfyUI.
- Lift the curated abliterated-model list + prompt presets into our provider config.

## Caveats
**Content policy + AI disclosure stay at the publish gate** regardless of model — "won't refuse" is not "anything goes". Personal/hobby use now; re-check at monetization.
