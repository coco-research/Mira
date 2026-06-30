# Mira prototype — build contract (read before authoring a screen)

You are authoring ONE screen of a single-file HTML prototype. Output a self-contained partial that the orchestrator injects into `dashboard/prototype.html`. **Do not** write a full HTML document — only the screen section (+ optional scoped CSS/JS blocks as described). Fake data only; no backend.

## Hard rules
1. The screen root MUST be exactly: `<section class="page" id="<SCREEN_ID>"> ... </section>` (no `active` class).
2. **Reuse the shared classes below.** Only add new CSS for genuinely screen-specific components, and put it in a single block at the very top of your partial: `<style data-screen="<SCREEN_ID>"> ... </style>`. **Prefix every new class** with your screen id (e.g. `.today-tile`, `.eng-row`, `.rev-tab`) to avoid collisions.
3. Any screen-specific JS goes in one block at the very bottom: `<script data-screen="<SCREEN_ID>"> ... </script>`. Wrap in an IIFE; do not redeclare globals. You may call the global `go('<id>')` router to deep-link to other screens.
4. Use the **fixtures** below verbatim (names, ids, numbers) so screens agree with each other.
5. Anthropic design language: paper/clay palette, serif headings (Newsreader), Inter body, soft radius, subtle shadow, generous whitespace. No neon, no gradients (except the subtle existing `.lib-thumb`). Calm, editorial.
6. Accessibility: buttons are `<button>`, inputs have labels, sufficient contrast.

## Shared CSS variables (already defined in shell)
`--paper #faf9f5` `--panel #f0eee6` `--panel-2 #f6f4ee` `--border #e5e2d9` `--border-strong #d8d4c7` `--ink #141413` `--ink-2 #6b6b66` `--clay #cc785c` `--clay-hover #b85c3e` `--green #6a8f5f` `--amber #c79a3e` `--red #c0573f` `--serif` `--sans` `--radius 12px` `--shadow`

## Shared classes you can use (already in shell)
- Layout: `.content` (page padding), `.card`, `.grid` + `.grid.cols-2` + `.grid.cols-3`, `.note` (dashed info box)
- Type: `h1`, `.lede` (sub-headline), `h2`
- Buttons: `.btn`, `.btn.ghost`, `.btn.sm`
- Inputs: `.field` + `.field input`, `.switch` (label>input+`.slider`)
- Badges/labels: `.tag` (+ `.tag.en` blue, `.tag.hi` tan), `.pill` (+ `.pill.posted` green, `.pill.draft` grey, `.pill.review` amber)
- Status: `.status-dot` (+ `.ok` green, `.local` grey)
- NEW shared helpers (in shell base CSS, use freely):
  - `.stat-grid` (responsive tile row) + `.stat` (tile) with `.stat .k` (big serif number) + `.stat .l` (label) + optional `.stat.alert`
  - `.badge` small pill + variants `.badge.local` `.badge.free` `.badge.metered` `.badge.quota`
  - `.tabs` + `.tab` (+ `.tab.active`) for tabbed screens
  - `.matrix` table-like: `.mrow` (row, flex), `.mrow .mstage` (left label col, 170px), `.mrow .mopts` (options flex-wrap), `.opt` (selectable chip) + `.opt.sel`
  - `.timeline` + `.tl-item` (dot + time + label) for schedules
  - `.row` (flex align-center gap), `.muted` (ink-2 small), `.right` (margin-left:auto)

## Global fixtures — USE THESE EXACTLY

### Markets / language
US + Canada + India. ~95% English / 5% Hindi (Hindi = occasional dub of a top performer, NOT a primary channel). All channels below are English. Where relevant, show a subtle "HI dub" affordance, never a Hindi channel.

### Channels (the fleet)
| id | name | lang | format | type | aspect | length | cadence | trust | niche |
|---|---|---|---|---|---|---|---|---|---|
| chn_aitools | Mira AI Tools | EN | Faceless | Short | 9:16 | 30–60s (cap 75) | 1/day | Review all | free AI tools & tips |
| chn_deepdives | Mira Deep Dives | EN | Faceless | Long | 16:9 | 3–5 min | 2/week | Review all | AI explainers / honest tests |
| chn_quickwins | Mira Quick Wins | EN | Faceless | Short | 9:16 | 30–45s | 1/day | Auto-publish (trusted) | 1-tip productivity shorts |

Channel emojis: AI Tools 🛠️, Deep Dives 🔬, Quick Wins ⚡.

### Cost meter
MTD **$11.40 / $50** cap (23%, green). Breakdown: Veo (quota) $0.00 · Kling/MuAPI $7.20 · Sarvam $1.10 · Suno $0.30 · Vultr credit used $2.80 of $250. Forecast: "at this pace you hit the cap in ~19 days."

### Today stat tiles
To review **3** · Scheduled today **2** · Spend **$11.40 / $50** · Ideas waiting **7** · Alerts **1** (1 failed render, alert).

### Sample videos (reuse ids/titles across screens)
| id | title | channel | state | dur | note |
|---|---|---|---|---|---|
| vid_a1b2 | 5 free AI tools that feel illegal to know | chn_aitools | InReview | 0:47 | cost $0.00 |
| vid_c3d4 | Turn one photo into a talking video (free) | chn_aitools | InReview | 0:52 | uses Kling motion, $0.18 |
| vid_e5f6 | Stop paying for ChatGPT — do this instead | chn_quickwins | InReview | 0:38 | auto-pub candidate |
| vid_g7h8 | This free local AI runs with no internet | chn_aitools | Scheduled | 0:41 | today 2:00pm |
| vid_i9j0 | I tested every free AI video tool — the winner | chn_deepdives | Draft | 4:12 | long-form, 9 scenes |
| vid_k1l2 | Upscale any blurry photo to 4K for free | chn_aitools | Posted | 0:44 | 12.3k views |
| vid_m3n4 | 7 AI sites every creator should bookmark | chn_quickwins | Posted | 0:36 | 31k views |

### Failure fixture
vid_p5q6 "Free AI voice that sounds 100% human" (chn_aitools) — Failed at **visuals** stage (ComfyUI OOM, auto-downgraded then retry available).

### Ideas waiting (7) — for peeks
"Nano-Banana image API — first look", "Veo 3.1 vs local LTX — honest test", "The $0 faceless stack, end to end", "5 prompts that 10x your output", "Local AI on a 16GB laptop?", "Best free TTS in 2026", "Motion-transfer explained simply". Source badges: From niche / YouTube trending / Google Trends / Reddit.

### Engines matrix (stage → options; mark default; badge)
- Script LLM: **LM Studio local** (default, Local) · NVIDIA NIM — MiniMax-M3/Nemotron-3 (Free) · OpenRouter (Free) · Mistral La Plateforme (Free) · Groq (Free) · Cerebras (Free) · Cloudflare Workers AI (Free) · GitHub Models (Free) · HuggingFace local (Local) · Gemini (Free) · Uncensored local — abliterated GGUF (Local)
- Voice EN: **edge-tts** (default, Free) · Kokoro local (Local) · ElevenLabs (Metered)
- Voice HI: **Sarvam** (default, Metered) · edge-tts hi-IN (Free)
- Images: **local SDXL-Flux** (default, Local) · Imagen (Quota) · Gemini (Free) · NIM FLUX/Qwen (Free) · Uncensored local checkpoint (Local)
- AI video: **Veo on quota** (default, Quota) · ComfyUI LTX Mac (Local) · Seedance 2.0 Mini (Metered) · cloud-burst Vultr→AWS SkyReels-14B/Wan (Metered)
- Motion transfer: **Kling 3 Turbo (Open-Generative-AI)** (default, Metered) · Wan2.2-Animate local (Local) · Viggle (Free)
- Music: **Pixabay/Freesound** (default, Free) · local music_gen (Local) · Suno (Metered)
- Thumbnail+metadata: **Imagen/Flux + script LLM** (default, mixed) 
- Captions: **faster-whisper local** (default, Local)
- Posting: **YouTube Data API** (default, Free) · Blotato (Metered) · IG Graph (Free)
- Production engine: **OpenMontage — in-the-loop** (default, Local) · MoneyPrinterTurbo — headless volume (Local)

Machine tier badge: **Heavy** (detected: Apple M4 Max · 64GB · Metal). Cloud-burst toggle: ON. Compute swarm (pod): OFF (solo mode).

### Compliance (Review screen must surface — from POLICY.md)
90-second checklist items: hook in first 2s (sound-off), payoff before 60% mark, captions synced + in safe zone, no watermark/letterbox, voice natural, **duration in band (ffprobe)**, **originality: passes variation/slideshow check (HARD GATE)**, **distinct cut per platform**, **audio royalty-free**. Plus a **thumbnail/title picker** (2–3 variants) and an **AI-disclosure toggle defaulting ON**.

## Screen IDs (router knows all of these)
today, ideate, queue, studio, assets, review, library, analytics, channels, engines, connections, collaborators
