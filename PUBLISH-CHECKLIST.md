# Mira — Pre-Publication Cleanup Checklist

**Status: 🔴 NOT CLEARED FOR PUBLIC.** Do not flip `coco-research/Mira` to public until
every 🔴 blocker below is resolved and the final go/no-go gate passes.

## Decisions locked (owner, 2026-07-18)

- **Mira ships under AGPL-3.0.** Chosen so the AGPL engines (OpenMontage,
  locally-uncensored) can be bundled directly.
- **Multi-license repo.** Root `LICENSE` = AGPL-3.0 for Mira's own code + the
  compatible bundled engines; each vendored engine keeps its own `LICENSE`; a
  `THIRD-PARTY.md` maps every path → license + upstream. Multiple licenses is fine —
  it does not, however, grant permission to redistribute a component whose own terms
  forbid it (see §2).
- **Bundled (compatible):** Mira (AGPL) · OpenMontage (AGPL) · locally-uncensored (AGPL)
  · MoneyPrinterTurbo, Open-Generative-AI, Free-ai-video-generator (MIT) ·
  Wan2.2, hyperframes, StoryGen-Atelier (Apache-2.0).
- **External via git submodule (own terms, NOT in Mira's tree):** n8n, SkyReels-V2.
- **Dropped entirely:** **AVTR-1** (license conflict + ≥$10M commercial-use trigger —
  see §2), **ltx-video-mac** (unused).
- **locally-uncensored: KEPT.** Owner accepts the brand call; legal under AGPL.
- **CLAUDE-FABLE-5.md: removed from HEAD** (done). History purge pending in §3.

---

## 0. TL;DR — remaining blockers

1. 🔴 **Externalize n8n + SkyReels-V2; drop AVTR-1 + ltx-video-mac** (§2).
2. 🔴 **Purge CLAUDE-FABLE-5.md + the dropped engines from git history** (§3) — one
   `git filter-repo` pass.
3. 🔴 **Full-history secret sweep** (§5).
4. 🟢 locally-uncensored — decided (kept). No action.

---

## 1. License disposition of vendored `repos/`

| Vendored project | License | Refs | Disposition |
|---|---|---|---|
| **OpenMontage** (primary) | AGPL-3.0 | 27 | ✅ Bundle — preserve LICENSE |
| **locally-uncensored** | AGPL-3.0 | 5 | ✅ Bundle (kept) — preserve LICENSE |
| MoneyPrinterTurbo | MIT | 18 | ✅ Bundle — preserve copyright/notice |
| Open-Generative-AI | MIT | 10 | ✅ Bundle — preserve copyright/notice |
| Free-ai-video-generator | MIT | 3 | ✅ Bundle — preserve copyright/notice |
| Wan2.2 | Apache-2.0 | 7 | ✅ Bundle — preserve NOTICE |
| hyperframes | Apache-2.0 | 21 | ✅ Bundle — preserve NOTICE |
| StoryGen-Atelier | Apache-2.0 | 6 | ✅ Bundle — preserve NOTICE |
| **n8n** | Sustainable Use License (fair-code) | via `n8n/` | 🔴 External submodule — not AGPL-compatible |
| **SkyReels-V2** | Skywork Community License (custom) | 7 | 🔴 External submodule — custom, not AGPL |
| **AVTR-1** | Goodsize model license | 1 | 🔴 **DROP** — derivatives must stay under AVTR-1 terms (conflicts AGPL) + ≥$10M paid-license trigger |
| ltx-video-mac | MIT | 0 | ➖ **DROP** — unused |

## 2. Externalize / drop (the redistribution fix)

**Why not just bundle these too:** their own licenses either conflict with AGPL or
restrict redistribution — a multi-license repo cannot override that.
- **AVTR-1** — "Any Derivative … must be distributed *exclusively* under the terms of
  this Agreement" (competing copyleft, conflicts with AGPL) **and** requires a paid
  commercial license for entities with ≥$10M revenue. Drop it.
- **SkyReels-V2** — Skywork Community License: commercial use allowed but under its own
  custom terms/PDF; not AGPL. External only.
- **n8n** — fair-code; restricts commercial/hosted redistribution; not AGPL. External only.

**Mechanism — git submodule (keeps them out of Mira's repo + history):**
- [ ] `git rm -r` the vendored `repos/n8n`, `repos/SkyReels-V2`, `repos/avtr-1`,
      `repos/ltx-video-mac`, and the top-level `n8n/` if it embeds n8n source.
- [ ] For the two kept-external: `git submodule add <upstream-url> repos/n8n` and
      `... repos/SkyReels-V2` (pin to a commit). Mira stores only a pointer; users
      fetch from upstream under upstream's license — Mira never redistributes them.
- [ ] AVTR-1 + ltx-video-mac: remove, no submodule (dropped).
- [ ] Update every `repos/<X>` reference in `mira/`, `dashboard/`, `plan/` for moved/dropped engines.
- [ ] Add a `scripts/setup-engines.sh` (or README note) to `git submodule update --init` on setup.
- [ ] Update README "Engines" section: bundled vs external submodules.

## 3. Purge internal + dropped content from history

- [x] Delete `CLAUDE-FABLE-5.md` from HEAD (done 2026-07-18).
- [ ] Single history rewrite (do AFTER §2 removals are committed):
      ```
      git filter-repo \
        --path CLAUDE-FABLE-5.md \
        --path repos/n8n --path repos/SkyReels-V2 \
        --path repos/avtr-1 --path repos/ltx-video-mac \
        --path n8n \
        --invert-paths
      ```
      (history ~10 MB — fast; coordinate the force-push; re-add submodules after.)
- [ ] Confirm the same Fable doc is removed from the `coco` repo (untracked there today).
- [ ] Grep `plan/` for internal architecture/roadmap not meant to be public
      (audit found no mckinsey/client/confidential strings — re-verify after edits).

## 4. Brand review — DECIDED

- [x] locally-uncensored — **kept** (owner decision; legal under AGPL).
- [ ] Review the "Anthropic-styled" dashboard for any Anthropic trademark/logo misuse.

## 5. 🔴 Secret & credential sweep

- [ ] `.gitignore` already excludes `.env`, `config.toml`, media, `node_modules` — good.
- [ ] Full-history scan: `gitleaks detect --source . --log-opts="--all"` and/or
      `trufflehog git file://.` — run AFTER the §3 rewrite.
- [ ] Verify every `.env.example` holds only placeholders.
- [ ] Rotate any key that ever touched a committed file — public history is forever.

## 6. Licenses + attribution (multi-license)

- [ ] Root `LICENSE` = full **AGPL-3.0** text.
- [ ] Copyright header + AGPL notice on Mira's own source files.
- [ ] Preserve each bundled engine's own `LICENSE` in its subdirectory (do not delete them).
- [ ] `THIRD-PARTY.md` / `NOTICE`: for every engine (bundled AND submodule) list name,
      license, upstream URL, and pinned commit.
- [ ] Mark modifications where you changed a bundled engine (AGPL §5 / §7).
- [ ] Document the AGPL **§13 network clause**: if Mira is ever hosted, network users must
      be able to obtain complete corresponding source — link the repo in README.

## 7. 🟡 Repo hygiene before flip

- [ ] Mira's own test suite (~400 tests in `mira/`) passes after the engine refactor.
- [ ] LFS/large-file check — `.mp4/.mov/.wav/.mp3` gitignored; confirm none in history.
- [ ] Add CI (lint + tests).
- [ ] Enable branch protection + secret scanning.

## 8. ✅ Final go/no-go gate (the git-guard rule)

Only after §2–§3 are 🟢 and §5–§7 done:
- [ ] Owner explicitly authorizes public publication.
- [ ] No internal/confidential material in tree OR history.
- [ ] No secrets in tree OR history.
- [ ] No license-incompatible engine bundled (n8n/SkyReels external submodules; AVTR-1 dropped).
- [ ] Then flip: `gh repo edit coco-research/Mira --visibility public --accept-visibility-change-consequences`

---

### Recommended sequence
1. §2 — `git rm` the four dropped/externalized engines; add n8n + SkyReels-V2 as submodules; fix code refs.
2. §3 — single `git filter-repo` pass (Fable + dropped engine paths); re-add submodules.
3. §5 — secret scan on the rewritten history.
4. §6 — AGPL-3.0 LICENSE + THIRD-PARTY.md + preserve per-engine licenses + modification notices.
5. §7 hygiene → §8 gate → flip public.

*This is a real refactor, not a doc edit — do it as its own focused session.*
*Org license spread: MIT (coco core) · proprietary source-available (coco-loops, coco-fusion, Super Intelligence) · AGPL-3.0 (Mira). State this in the org bio.*
