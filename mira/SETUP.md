# Mira — Your Setup Guide (do this in order)

This is the **only** doc you need to go from zero → posting. It's tiered so you get a
**fully working $0 generator first**, then add quality, then posting, then cloud/pod.

**Golden rule:** every key is optional. A blank key just means that provider stays off and
Mira uses a free/offline fallback. So do as much or as little as you want — nothing here
hard-blocks the app.

How to apply keys: `cp .env.example .env`, paste values, save. Mira reads `.env` on the next
run. **Never commit `.env`** (it's gitignored).

**How you operate Mira (the operating model):** you run **one** command — `mira up` — once
(this is the backend; later it's launched by the app for you). It starts the dashboard API
**and supervises your local engines** (auto-starts anything installed). From then on you do
**everything in the dashboard** — generate, review, schedule, and start/stop engines from the
**Engines** screen. **No terminal needed for day-to-day use.**

Legend: 🆓 free · 💳 costs money/credits · 🧍 one-time human action no key can replace.

---

## ▶ CURRENT FOCUS — Quality Lab (build great videos first, publish later)
We are **not** touching YouTube/Instagram, Supabase, Vercel, or cloud GPU yet. Goal: generate
videos locally, judge the quality, then decide how to push them out. **Tiers 2–5 below are parked.**

**The only keys that matter right now** (all 🆓), paste into `.env`:

| Key | Why it matters for quality | Get it |
|---|---|---|
| `GEMINI_API_KEY` | sharper scripts + (later) images/Veo on your quota | aistudio.google.com → Get API key |
| `OPENROUTER_API_KEY` | script-model variety / overflow | openrouter.ai → Keys |
| `NIM_API_KEY` | MiniMax-M3 / Nemotron — strong free scripts | build.nvidia.com → API key |
| `PEXELS_API_KEY` | **real B-roll footage** (biggest visual upgrade) | pexels.com/api |
| `PIXABAY_API_KEY` | **music bed** + extra stock | pixabay.com/api/docs |

Optional extra script speed (🆓): `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`.

**Already working with ZERO keys (truly key-free, no internet for visuals):**
- Real **scripts** — LM Studio (local model) is the first provider; no key.
- Real **voiceover** — edge-tts neural voices (needs internet, no key).
- Real **designed visuals** — two local engines, no key, no GPU:
  - **Remotion** (A): OpenMontage React motion-graphics components.
  - **HyperFrames** (B): HTML + GSAP kinetic type → headless Chrome.
- Full assemble (VO + captions + mux) → a watchable `.mp4`.

**Pick your visual style — compare A vs B:**
```bash
mira bench --topic "three free AI tools every student should know"
```
Then open the dashboard → **Review → Engine A/B** tab to watch both side-by-side and pick one.
Set the winner as default: `MIRA_VISUAL_ENGINE=remotion` (or `hyperframes`), or pass
`mira generate --visual remotion`. (Remotion/HyperFrames render locally → ~1–3 min each; first
run downloads a headless Chromium once.)

**What each key unlocks the moment you paste it:** Gemini/NIM/OpenRouter → faster/varied scripts;
Pexels → real photoreal B-roll (vs designed graphics); Pixabay → background music. But none are
required — the key-free path already produces a real short at **$0**.

---

## ✅ Already done for you (verified on this machine)
- Python 3.14 + the `mira` package — **377 tests green** across the whole backend.
- `ffmpeg`/`ffprobe` present → the offline generate pipeline produces real `.mp4`s with **no keys at all**.
- All 9 source repos cloned under `repos/`.
- **Engine supervisor wired in:** the backend detects/auto-starts local engines on boot; you
  control them from the dashboard **Engines → Local engines** card (no terminal).
- **LM Studio detected and running** with models loaded (gemma-4-12b, qwen3.6-35b, qwen3-coder,
  gpt-oss-20b, nemotron-3-nano, …) → real AI scripts already work.

So you can generate a faceless short **right now** with zero setup. The steps below make it
*better* (real voices, real stock, local visuals) and let you *publish*.

---

## TIER 0 — Local engines (🆓) → best quality at $0, controlled from the dashboard
These run on your Mac, no API cost, fully private. **The backend manages them — you do not start them in a terminal.**

- [x] **LM Studio** (local script LLM, the default) — ✅ already running here. It's a GUI app, so
      you launch the app once and keep its **local server** on (port `1234`); Mira auto-detects it.
      It shows as **running** on the Engines screen.
- [ ] **ComfyUI** (local images + LTX video) — **optional**. Install it once
      ([github.com/comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI)) into a
      standard location (e.g. `~/ComfyUI`) **or** set `COMFYUI_DIR=/path/to/ComfyUI` in `.env`.
      After that the backend **auto-starts it on boot** and you can Start/Stop it from the
      dashboard. *Until then the pipeline still works* — Veo-on-quota + stock cover b-roll.
- [ ] Nothing else to put in `.env` for these — Mira auto-detects the ports.

> Verify in the **dashboard**: open **Engines** → the *Local engines* card shows live status
> (running / stopped / not installed) with Start/Stop buttons. No CLI check needed.

---

## TIER 1 — Free API keys (🆓, all $0) → quality + overflow
Grab as many as you like; more = the swarm never hits a rate limit. **All free tiers.**

| What | Where to get it | `.env` variable | Unlocks |
|---|---|---|---|
| **Google AI Studio (Gemini)** | aistudio.google.com → "Get API key" | `GEMINI_API_KEY` | free LLM + images |
| **NVIDIA NIM** | build.nvidia.com → profile → API key (phone verify) | `NIM_API_KEY` | MiniMax-M3, Nemotron, image NIMs |
| **OpenRouter** | openrouter.ai → Keys | `OPENROUTER_API_KEY` | free model routing |
| **Mistral La Plateforme** | console.mistral.ai → API Keys (phone verify) | `MISTRAL_API_KEY` | ~1B free tokens/mo (biggest pool) |
| **Groq** | console.groq.com → API Keys | `GROQ_API_KEY` | very fast Llama/gpt-oss |
| **Cerebras** | cloud.cerebras.ai → API Keys | `CEREBRAS_API_KEY` | fastest gpt-oss-120b |
| **Cloudflare Workers AI** | dash.cloudflare.com → AI → use Account ID + an API token | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | free Llama/Qwen/GLM |
| **GitHub Models** | github.com/marketplace/models → a `github_pat_…` token | `GITHUB_MODELS_TOKEN` | frontier (gpt-5/o3/DeepSeek) |
| **HuggingFace** | huggingface.co → Settings → Access Tokens | `HUGGINGFACE_TOKEN` | hosted open models |
| **Pexels** | pexels.com/api | `PEXELS_API_KEY` | free stock video/photos |
| **Pixabay** | pixabay.com/api/docs | `PIXABAY_API_KEY` | free stock + music |
| **Freesound** | freesound.org/apiv2/apply | `FREESOUND_TOKEN` | free SFX |

> Minimum to feel "real": **Gemini + OpenRouter + Pexels**. Everything else is extra headroom.
> EN voice uses **edge-tts** which needs **no key** (just internet).

---

## TIER 2 — Publishing (🧍 one-time OAuth, 🆓) → actually post
A key alone can't post to *your* account — Google/Meta require a one-time consent. I'll have
the publisher adapters + a `mira auth youtube` helper ready; you do the consent once.

- [ ] **YouTube Data API** 🧍
  1. console.cloud.google.com → create/select a project.
  2. Enable **YouTube Data API v3**.
  3. APIs & Services → **OAuth consent screen** → External → add yourself as a test user.
  4. **Credentials → Create OAuth client ID → Desktop app** → download the JSON.
  5. Put the file path in `.env` → `YOUTUBE_CLIENT_SECRET_JSON=/abs/path/client_secret.json`.
  6. Run `mira auth youtube` once → approve in browser (stores a refresh token locally).
- [ ] **Instagram (Meta Graph)** 🧍 — needs an IG **Business/Creator** account linked to a
      Facebook Page + a Meta app. Generate a long-lived token → `IG_ACCESS_TOKEN`.
      *(Or skip and use Blotato later: `BLOTATO_API_KEY`, 💳.)*

> Until you do this, Mira still generates + reviews; it just **schedules to "ready to post"**
> instead of pushing live.

---

## TIER 3 — Optional metered providers (💳, small) → nice-to-haves
Only if you want them; the cost meter caps spend and warns first.

| What | `.env` | Cost | Why |
|---|---|---|---|
| **Sarvam** (Hindi voice) | `SARVAM_API_KEY` | small/char | best Hindi dubs (your 5% HI) |
| **ElevenLabs** (premium voice) | `ELEVENLABS_API_KEY` | metered | optional EN upgrade |
| **Suno** (licensed music) | `SUNO_API_KEY` | ~$0.10/track | optional original music |
| **MuAPI** (Kling motion-transfer) | `MUAPI_KEY` | ~$0.05–0.10/s | the "dance/motion" lane |

---

## TIER 4 — Cloud GPU burst (💳, real billing) → heavy/long renders
Only needed for self-hosted SkyReels-14B / Wan or big batches when the Mac is saturated.

- [ ] **Vultr** (preferred — ~$250 free credit covers GPU): vultr.com → API key → `VULTR_API_KEY`.
- [ ] **AWS** (fallback): IAM user with EC2 perms → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
- Mira **auto-tears down** instances when idle and enforces the burst budget cap. 🧍 you still
  own the bill — keep the cap on.

---

## TIER 5 — Pod / multi-user (🧍 + 🆓) → share with friends
Only when you want friends running it as a team.

- [ ] **Supabase** 🧍: supabase.com → New project → run `db/supabase_schema.sql` then
      `db/rls_policies.sql` in the SQL editor → copy `SUPABASE_URL` + the agent key →
      `.env` (`SUPABASE_URL`, `SUPABASE_AGENT_KEY`). Stores **coordination metadata only — never keys/media**.
- [ ] **Vercel** 🧍 (later, Phase 9): deploy the Next.js UI (free tier) for the shared dashboard.
- [ ] Set `MIRA_LOCAL_TOKEN` to any random string (auth for your local agent's 127.0.0.1 API).

---

## The shortest path (if you want a recommendation)
1. **Run `mira up` once** → backend starts, supervises engines, dashboard goes live. *(LM Studio already detected.)*
2. **Tier 1:** get **Gemini + OpenRouter + Pexels** keys → paste into `.env`. *(10 min, $0)*
3. Generate + review a few videos **from the dashboard**. *(you just click)*
4. **Tier 2:** do the **YouTube OAuth** once → start posting. *(20 min, $0)*
5. Add Tier 3/4/5 only when you actually need Hindi / heavy GPU / friends.

> ComfyUI is **optional** — only install it if you want local AI b-roll. The moment it's
> installed (or `COMFYUI_DIR` is set), the backend auto-starts it and the dashboard controls it.

When you've done Tier 0+1, tell me and I'll run a real end-to-end generate against your live
providers and walk you through the first publish.
