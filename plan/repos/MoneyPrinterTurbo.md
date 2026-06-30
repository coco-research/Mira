# MoneyPrinterTurbo — headless faceless-volume engine (deep-dive)

- **Repo:** `github.com/harry0703/MoneyPrinterTurbo` · **fork:** `github.com/rkz91/MoneyPrinterTurbo` · **local:** `repos/MoneyPrinterTurbo`
- **License:** MIT (no copyleft, ~89k★)
- **Verdict:** **KEEP — headless volume (bake-off vs OpenMontage)**
- **Canonical analysis:** chat [MoneyPrinterTurbo analysis](cdabc08c-da34-4cc4-b848-5199f2fbefd3)

## What it actually is
A batteries-included, **fully-automated faceless-short generator**: topic → script (LLM) → TTS → stock/visuals → captions → assembled `.mp4`. Ships a **web UI + an API + a CLI** and Docker images (CPU + GPU).

## On disk (verified)
- `app/` (core), `webui/` + `webui.sh`/`webui.bat` (Streamlit UI), `cli.py`, `main.py` (API), `config.example.toml`.
- `Dockerfile` + `Dockerfile.gpu`, `docker-compose.yml` / `.gpu.yml` / `.release.yml`.
- `resource/`, `test/`, `pyproject.toml`, `uv.lock`.

## Role in Mira
The **headless engine** n8n fires for **auto-publish faceless volume** where you're *not* reviewing each video. A channel's **trust level** routes here ("Auto-publish when trusted"). Its `openai_base_url` points at **LM Studio** (`localhost:1234/v1`) or **NIM** so it uses our free LLMs; TTS via edge-tts (free).

## Why keep it (for now)
- MIT, proven at huge scale, dead-simple API for n8n.
- Lower ceiling than OpenMontage (template-y, fewer lanes, weaker anti-sameness) → it's the **volume** engine, not the quality engine.

## Bake-off (DEV_PLAN Phase 5)
Run the same faceless brief through both; compare quality/cost/effort; **default outcome: keep OpenMontage as primary, retire MPT** unless its hands-off simplicity proves worth maintaining for pure volume.

## Integration tasks
- Wire n8n: topic queue → MPT API → captions → QA gate → schedule.
- Point its LLM/TTS at our free providers via `config.toml`.

## Caveats
Templated output risks YouTube's "inauthentic content" rule at volume → must vary structure + add original framing (OpenMontage's `variation_checker` is stronger here).
