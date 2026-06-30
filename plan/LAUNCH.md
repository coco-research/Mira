# Project Mira — Launch Playbook

The concrete "what do I actually post" layer. [`PLAN.md`](PLAN.md) is strategy; this is the starting channel roster, brand kits, and the first 30 topic seeds so day 1 isn't a blank page.

> Companion to [`PLAN.md`](PLAN.md) (strategy), [`DASHBOARD_SPEC.md`](DASHBOARD_SPEC.md) (UI), [`DEV_PLAN.md`](DEV_PLAN.md) (build).

---

## 1. Launch roster (start with 2, add 1 once the loop is hands-off)

| # | Channel | Lang | Format | Face? | Lane | Trust | Cadence |
|---|---|---|---|---|---|---|---|
| 1 | **Mira AI Tools** | EN | Short-form 9:16 | Faceless | faceless (explainer/animation) | Review-all → trusted | 1/day |
| 2 | **Aaj Kya Seekha** ("what I learned today") | HI | Short-form 9:16 | Faceless | faceless + `localization-dub` | Review-all | 1/day |
| 3 *(phase 2)* | **Mira Deep Dives** | EN | Long-form 16:9 (3–5 min) | Faceless | `documentary-montage` | Review-all | 2/week → hub for Shorts |

Rationale: faceless EN "AI tools/tips" = highest demand + lowest production risk; Hindi curiosity/learning = under-served + uses the `localization-dub` differentiator; long-form deep-dive added only once daily shorts are automated, then it **feeds** the shorts via `clip-factory` (hub-and-spoke).

Why not start with the with-face channel: filming yourself adds a manual step; bring it in after the automated loop is proven (PLAN Phase 2). AVTR-1 avatar stays parked.

---

## 2. Brand kits (concrete values — inherited by every render)

Shared design DNA = the Anthropic palette already in `dashboard/prototype.html` so the dashboard and the content feel like one product.

### Channel 1 — Mira AI Tools (EN)
- **Palette:** paper `#faf9f5`, ink `#141413`, clay accent `#cc785c`, green `#6a8f5f`.
- **Caption font:** Inter SemiBold, bottom-third, ink-on-paper card, clay keyword highlight.
- **Title-card font:** Newsreader (serif) for the hook line.
- **Intro:** 0.8s logo wordmark "Mira" on paper. **Outro:** 1.2s "Follow for daily AI tools" CTA card.
- **Watermark:** small clay "Mira" bottom-right, 60% opacity.
- **Default music:** soft lo-fi/ambient bed (Pixabay), auto-ducked −18dB under VO.
- **Voice:** edge-tts `en-US-AndrewNeural` (warm, confident), rate 1.0.

### Channel 2 — Aaj Kya Seekha (HI)
- **Palette:** same paper/ink base, accent swapped to **deep indigo `#4f5bd5`** for differentiation.
- **Caption font:** Inter (Devanagari fallback Noto Sans Devanagari), high-contrast.
- **Voice:** Sarvam AI Hindi (natural) or Google Cloud TTS `hi-IN`; rate 0.95.
- **Intro/outro:** Hindi CTA "Roz kuch naya seekho — follow karo".
- **Music:** same bed family, slightly warmer.

### Channel 3 — Mira Deep Dives (EN, long-form)
- Inherits Channel 1 kit + **chapter title-cards** every section, 16:9, lower-third source citations, slightly slower pacing.

---

## 3. First 30 topic seeds

Pre-loaded into the Topic queue so generation can start immediately. Each is a hook, not a script; `mira generate` expands to a word-budgeted script.

### Mira AI Tools (EN, shorts) — 12
1. 5 free AI tools that feel illegal to know
2. This free local AI runs on your laptop with no internet
3. Stop paying for ChatGPT — do this instead
4. Turn one photo into a talking video (free)
5. The fastest way to remove any object from a video
6. 3 AI prompts that 10x your output
7. Free AI voice that sounds 100% human
8. Make faceless YouTube videos in 5 minutes
9. The AI tool that writes your week of content
10. Upscale any blurry photo to 4K for free
11. Clone a dance/motion onto any photo (how it works)
12. 7 AI sites every creator should bookmark

### Aaj Kya Seekha (HI, shorts) — 12
13. AI se ghar baithe paise kaise kamaye (3 tareeke)
14. Ye free AI tool aapka time bacha dega
15. Bina internet ke chalने वाला AI — sach me?
16. Ek photo se video banao — bilkul free
17. ChatGPT ke 3 secret prompts
18. Faceless YouTube channel kaise shuru kare
19. AI se padhai 2x fast — ye trick
20. Free AI voice jo insaan jaisi lagti hai
21. Purani blurry photo ko HD banao
22. 5 AI apps jo har student ko chahiye
23. AI se resume 2 minute me banao
24. Roz ek nayi AI trick — #1

### Mira Deep Dives (EN, long-form 3–5 min) — 6
25. How AI video generation actually works (no hype)
26. I tested every free AI video tool — here's the winner
27. The real cost of "free" AI tools (and how to stay free)
28. Build a faceless content engine for $0 — full walkthrough
29. Local vs cloud AI: which should you actually use?
30. Motion transfer explained: from research to your phone

---

## 4. First-week run sheet

1. **Day 0:** onboarding wizard → detect LM Studio/ComfyUI → test keys (Gemini, NIM, YouTube, IG) → set budget cap → create Channels 1 & 2 with brand kits above.
2. **Day 0:** bulk-import these 30 seeds into the Topic queue.
3. **Day 1–3:** generate 5 videos on Channel 1, run the 90-sec QA gate each, publish manually. Tune word budget / voice / pacing.
4. **Day 4–7:** repeat on Channel 2 (Hindi); verify `localization-dub` timing.
5. **End of week 1:** if QA pass rate is high on Channel 1, flip it to **trusted auto-publish** via MoneyPrinterTurbo headless + n8n cron (DEV_PLAN Phase 5). Keep Channel 2 on review.

## 5. Success signals before adding Channel 3 / collaborators
- A trusted channel posts **hands-off for 3 days** (DEV_PLAN Phase 5 gate).
- Estimate-vs-actual cost within range; spend at/near $0.
- QA pass rate ≥ 80% first-try.
Then: stand up long-form (Channel 3), then invite a friend (pod mode, PLAN §6.1).
