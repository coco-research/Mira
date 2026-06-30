# AVTR-1 — avatar / talking-head (deep-dive)

- **Repo:** `github.com/avaturn-live/avtr-1` · **fork:** `github.com/rkz91/avtr-1` · **local:** `repos/avtr-1`
- **License:** **split** — `LICENSE-MODEL.md`, `LICENSE-RENDERER.md`, `LICENSE-STREAMER.md` (the **renderer is non-commercial**; see `PATENTS.md`)
- **Verdict:** **MAYBE — deferred; personal-brand only**
- **Canonical analysis:** chat [AVTR-1 license check](48a78ed4-a6be-4a41-8c58-132bc550d0ff)

## What it actually is
A real-time **photo→talking-head avatar** system (renderer + streamer + model), Python/pixi packaging (`pixi.toml`, `pyproject.toml`, `src/`, `scripts/`, `example/`).

## On disk (verified)
- `src/`, `scripts/`, `example/`, `pixi.lock`, `pyproject.toml`, plus the three split LICENSE files + `PATENTS.md` + `THIRD-PARTY-NOTICES.md`.

## Role in Mira
**Parked.** The with-face channel defaults to **filming yourself** + OpenMontage `talking-head`/`avatar-spokesperson`. AVTR-1 only comes in if you later want a synthetic avatar of yourself for a personal-brand channel — and **only for personal, non-monetized use** unless the renderer license changes.

## Why deferred (not skipped)
- The split license (non-commercial renderer + patents) makes it risky for any future monetization.
- Filming yourself is simpler, higher-trust, and avoids "AI face" uncanny/policy issues now.

## Integration tasks (if revived)
- Sandbox locally; confirm `LICENSE-RENDERER.md` + `PATENTS.md` terms before any public posting; AI-disclosure mandatory.

## Caveats
Non-commercial renderer; patents; synthetic-likeness disclosure/ethics. Keep out of the monetized path.
