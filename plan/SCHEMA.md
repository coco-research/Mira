# Project Mira — Data Schemas & Pricing Snapshot

Concrete shapes for the `mira` command layer's JSON in/out, the on-disk config/state files, and the Supabase coordination tables. These are the **golden fixtures** the DEV_PLAN contract tests assert against.

> Companion to [`DASHBOARD_SPEC.md`](DASHBOARD_SPEC.md) (data model entities), [`DEV_PLAN.md`](DEV_PLAN.md) (contract layer), [`SECURITY.md`](SECURITY.md) (what's allowed in the cloud).
>
> Conventions: snake_case keys; ISO-8601 UTC timestamps; money in USD floats; durations in seconds; ids are `kind_<short>` (e.g. `vid_a1b2`).

---

## 1. Core entities (local-first)

### Channel
```json
{
  "id": "chn_aitools",
  "name": "Mira AI Tools",
  "language": "en",
  "video_type": "short",            // short | long
  "aspect": "9:16",                  // 9:16 | 16:9
  "faceless": true,
  "lane": "faceless",                // faceless | cinematic | personal | motion | dub
  "trust": "review_all",             // review_all | auto_publish
  "length_band": { "min_s": 30, "max_s": 60, "hard_cap_s": 75 },
  "brand_kit_id": "bk_aitools",
  "owner_user_id": "usr_rijul",
  "platforms": ["youtube", "instagram"],
  "default_music_id": "mus_lofi_soft",
  "created_at": "2026-06-18T00:00:00Z"
}
```

### BrandKit
```json
{
  "id": "bk_aitools",
  "palette": { "paper": "#faf9f5", "ink": "#141413", "accent": "#cc785c" },
  "caption": { "font": "Inter", "weight": "600", "position": "bottom_third", "highlight": "#cc785c" },
  "title_card_font": "Newsreader",
  "intro_asset": "assets/intro_aitools.mp4",
  "outro_asset": "assets/outro_aitools.mp4",
  "watermark": { "text": "Mira", "position": "br", "opacity": 0.6 },
  "voice": { "provider": "edge-tts", "voice": "en-US-AndrewNeural", "rate": 1.0 },
  "music_duck_db": -18
}
```

### Topic / Idea (queue item)
```json
{
  "id": "top_5free",
  "channel_id": "chn_aitools",
  "title": "5 free AI tools that feel illegal to know",
  "source": "manual",               // manual | trend | analytics | ref_url
  "status": "queued",                // idea | queued
  "lane_override": null,
  "length_override_s": null,
  "scheduled_for": "2026-06-22T14:00:00Z",
  "created_at": "2026-06-18T00:00:00Z"
}
```

### Video (job + artifact)
```json
{
  "id": "vid_a1b2",
  "topic_id": "top_5free",
  "channel_id": "chn_aitools",
  "engine": "openmontage",           // openmontage | moneyprinterturbo
  "pipeline": "animated-explainer",
  "state": "draft",                  // idea|queued|generating|draft|in_review|approved|scheduled|posted|failed
  "duration_s": 47.2,
  "aspect": "9:16",
  "artifacts": {
    "video": "media/vid_a1b2/final.mp4",
    "captions": "media/vid_a1b2/captions.srt",
    "thumbnails": ["media/vid_a1b2/thumb_1.png", "media/vid_a1b2/thumb_2.png"],
    "metadata": "media/vid_a1b2/package.json"
  },
  "checkpoints": [
    { "stage": "script", "status": "approved" },
    { "stage": "voice", "status": "approved" },
    { "stage": "assemble", "status": "pending" }
  ],
  "cost": { "estimate": 0.42, "actual": 0.38, "currency": "USD" },
  "ai_disclosure": true,
  "qa": { "passed": true, "duration_in_band": true, "variation_ok": true },
  "created_at": "2026-06-18T00:00:00Z"
}
```

### Package (thumbnail + metadata)
```json
{
  "video_id": "vid_a1b2",
  "variants": [
    { "thumbnail": "thumb_1.png", "title": "5 FREE AI tools (feels illegal)", "selected": true },
    { "thumbnail": "thumb_2.png", "title": "These AI tools should cost money", "selected": false }
  ],
  "description": "...",
  "tags": ["ai tools", "free ai", "productivity"],
  "hashtags": ["#ai", "#aitools", "#tech"],
  "language": "en"
}
```

## 2. State & config files (on disk, gitignored where noted)

### `cost_log.json` (per-video actuals — gitignored) — extends OpenMontage `cost_tracker`
```json
[
  { "video_id": "vid_a1b2", "stage": "script", "provider": "lmstudio", "units": 1, "cost": 0.0, "ts": "..." },
  { "video_id": "vid_a1b2", "stage": "voice", "provider": "edge-tts", "units": 1, "cost": 0.0, "ts": "..." },
  { "video_id": "vid_a1b2", "stage": "clip", "provider": "veo", "units": 2, "cost": 0.0, "note": "vertex_quota", "ts": "..." }
]
```

### `cost_model.json` (learned unit-cost EMA — the estimator's memory)
```json
{
  "updated_at": "2026-06-18T00:00:00Z",
  "alpha": 0.3,
  "units": {
    "veo_clip_s": { "ema_cost": 0.0, "ema_eta_s": 14, "n": 22, "source": "vertex_quota" },
    "kling_motion_s": { "ema_cost": 0.09, "ema_eta_s": 40, "n": 5 },
    "comfy_ltx_clip": { "ema_cost": 0.0, "ema_eta_s": 95, "n": 18, "source": "local_gpu_time" },
    "skyreels_14b_burst_min": { "ema_cost": 0.42, "ema_eta_s": 60, "n": 3, "source": "vultr" },
    "suno_track": { "ema_cost": 0.10, "ema_eta_s": 30, "n": 2 }
  }
}
```

### `config.toml` / `.env` (local only — never synced)
- `.env`: `GEMINI_API_KEY`, `NIM_API_KEY`, `OPENROUTER_API_KEY`, `YOUTUBE_*`, `IG_*`, `VULTR_API_KEY`, `AWS_*`, `MIRA_LOCAL_TOKEN`, `SUPABASE_AGENT_KEY`.
- `config.toml`: provider base URLs (LM Studio `http://localhost:1234/v1`, ComfyUI, NIM), budget caps, burst toggle, tier override.

### `support_envelope()` output (capability probe)
```json
{
  "machine": { "os": "darwin", "ram_gb": 64, "vram_gb": 0, "gpu": "apple_m4_max", "tier": "heavy" },
  "engines": { "openmontage": true, "moneyprinterturbo": true, "comfyui": true },
  "providers": {
    "llm": ["lmstudio", "nim", "openrouter", "mistral", "groq", "cerebras", "cloudflare", "github-models", "huggingface", "gemini", "uncensored-local"],
    "tts": ["edge-tts", "google-tts", "sarvam"],
    "image": ["sdxl-local", "imagen", "nim-flux", "uncensored-local"],
    "video": ["veo-quota", "comfy-ltx", "seedance", "skyreels-burst"],
    "music": ["pixabay", "freesound", "music_gen", "suno"]
  }
}
```

## 3. Supabase coordination tables (pod mode — metadata only, RLS-protected)
| Table | Key columns | Notes |
|---|---|---|
| `pods` | id, name, owner_user_id | tenant |
| `pod_members` | pod_id, user_id, role | role: admin/editor/viewer |
| `channels` | id, pod_id, owner_user_id, config_json | **no keys** |
| `topics` | id, channel_id, title, status, scheduled_for | queue |
| `jobs` | id, video_id, channel_id, assigned_user_id, state | **single-assignment** unique constraint |
| `quota_ledger` | pod_id, user_id, provider, window (rpm/rpd/tpm/tpd), used, limit, window_start, healthy | swarm fairness + 429 backoff |
| `analytics` | video_id, views, retention, ts | pulled by owner agent |
| `previews` | video_id, signed_url, expires_at | short-lived, optional |

All tables: RLS scoped to `pod_id`; `jobs` additionally restricted to `assigned_user_id` + pod admin. No `.env`/media/raw video columns ever.

### `quota_ledger` row shape (swarm capacity — never keys)
The router reads this to pick the member with free headroom and to back off providers that 429'd. Stores *capacity counters only* — no secrets.
```json
{
  "pod_id": "pod_x1",
  "user_id": "usr_rijul",
  "provider": "groq",
  "window": "rpd",
  "used": 312,
  "limit": 14400,
  "window_start": "2026-06-19T00:00:00Z",
  "healthy": true,
  "last_429_at": null
}
```
**Provider ids** (LLM pool, curated from [`cheahjs/free-llm-api-resources`](https://github.com/cheahjs/free-llm-api-resources), accessed 2026-06-19):
`lmstudio` (local) · `nim` · `openrouter` · `mistral` · `groq` · `cerebras` · `cloudflare` · `github-models` · `huggingface` · `gemini` · `uncensored-local`. Window codes: `rpm`/`rpd` (requests per min/day), `tpm`/`tpd` (tokens per min/day). The router rotates least-used-first within healthy providers, honoring each provider's tightest window.

---

## 4. Pricing snapshot (as of Jun 2026 — verify before relying on; this is a planning reference, not a contract)

| Service | Unit | Our cost | Notes |
|---|---|---|---|
| LM Studio (local) | 1k tok | **$0** | Mac compute only |
| NVIDIA NIM (dev tier) | request | **$0** | rate-limited; MiniMax-M3 non-commercial |
| OpenRouter (free models) | request | **$0** | free model variants; paid optional |
| Gemini Pro (your plan) | request | **$0** | within subscription |
| Veo 3.1 (Vertex free/quota) | clip | **$0** | within your quota; hero clips only |
| edge-tts | char | **$0** | free |
| Google Cloud TTS | char | free tier then ~$4–16/1M | long-form narration |
| Sarvam AI (Hindi) | char | metered (small) | best Hindi voice |
| ComfyUI / LTX (local) | clip | **$0** | Mac GPU time |
| Seedance 2.0 Mini | clip | low (~cents) | cheap draft/insert tier |
| Kling Motion Control (MuAPI) | second | ~$0.05–0.10/s | metered premium lane |
| SkyReels-V2 on Vultr | GPU-min | **$0 until ~$250 credit** then ~$1–2/hr A100-class | burst; auto-teardown |
| SkyReels-V2 on AWS spot | GPU-hr | ~$1–4/hr (uses your credits) | fallback after Vultr |
| Suno | track | ~$0.10 | optional licensed music |
| Pixabay / Freesound music | track | **$0** | royalty-free default |
| Stock (Pexels/Pixabay/Coverr) | clip | **$0** | free B-roll |
| Vercel | hosting | **$0** | free tier |
| Supabase | DB | **$0** | free tier (coordination only) |

**Per-video target:** $0 on the default free stack; up to ~$0.30–$1.30 if a metered tier (Kling motion / Suno / burst) is used. **Marginal cost per extra channel: ~$0.**
