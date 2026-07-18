# Mira — Pre-Publication Cleanup Checklist

**Status: 🔴 NOT CLEARED FOR PUBLIC.** Do not flip `coco-research/Mira` to public until
every 🔴 blocker below is resolved and the final go/no-go gate passes.

> **License decision (owner, 2026-07-18): Mira ships under AGPL-3.0.**
> Chosen so the AGPL engines (OpenMontage, locally-uncensored) can be bundled directly
> without arm's-length gymnastics. See §1 for what this does and does not permit.

This checklist was produced from an audit of `main` (26,163 tracked files; ~10 MB
git history; ~200 MB working tree, mostly gitignored media).

---

## 0. TL;DR — what AGPL-3.0 resolves, and what still blocks

**Resolved by choosing AGPL-3.0 for Mira:**
- OpenMontage (AGPL) + locally-uncensored (AGPL) — same license, bundle freely.
- MIT engines — MIT is compatible *into* AGPL (keep notices).
- Apache-2.0 engines — one-way compatible *into* AGPLv3 (keep NOTICE).

**Still blocking (AGPL does NOT fix these):**
1. 🔴 **License-incompatible vendored engines** — **n8n** (Sustainable Use License /
   fair-code — not open source, not AGPL-compatible), **avtr-1** (Goodsize model
   license), **SkyReels-V2** ("license: other"). Cannot be redistributed under AGPL.
   Remove or keep strictly external.
2. 🔴 **`CLAUDE-FABLE-5.md`** — internal Anthropic system-prompt doc, committed at root
   and in history. Delete AND purge from history. (Content issue, not licensing.)
3. 🔴 **Full-history secret sweep** — files were committed; scan all history.
4. 🟡 **`locally-uncensored` name** — legal under AGPL, but a reputational flag under a
   McKinsey-affiliated org. Owner's call whether to keep.

---

## 1. License disposition of vendored `repos/` (under Mira = AGPL-3.0)

| Vendored project | License | Refs in core | Disposition under AGPL |
|---|---|---|---|
| **OpenMontage** (primary engine) | AGPL-3.0 | 27 | ✅ Bundle OK — same license |
| **locally-uncensored** | AGPL-3.0 | 5 | ✅ Legal to bundle; 🟡 brand call (see §4) |
| MoneyPrinterTurbo | MIT | 18 | ✅ Bundle OK — preserve copyright/notice |
| Open-Generative-AI | MIT | 10 | ✅ Bundle OK — preserve copyright/notice |
| Free-ai-video-generator | MIT | 3 | ✅ Bundle OK — preserve copyright/notice |
| ltx-video-mac | MIT | 0 | ➖ Unused — remove |
| Wan2.2 | Apache-2.0 | 7 | ✅ Bundle OK — preserve NOTICE |
| hyperframes | Apache-2.0 | 21 | ✅ Bundle OK — preserve NOTICE |
| StoryGen-Atelier | Apache-2.0 | 6 | ✅ Bundle OK — preserve NOTICE |
| **n8n** | Sustainable Use License (fair-code) | via `n8n/` | 🔴 NOT AGPL-compatible — external/remove |
| **avtr-1** | Goodsize model license | 1 | 🔴 Review terms — likely external/remove |
| **SkyReels-V2** | "license: other" (custom) | 7 | 🔴 Review terms — likely external/remove |

**Action items:**
- [ ] Re-verify each license against the current upstream (these are snapshots).
- [ ] For every retained engine, record upstream URL, exact commit/tag vendored, license.
- [ ] Confirm avtr-1 and SkyReels-V2 terms (commercial use? redistribution? research-only?).
- [ ] Licensing sign-off (ideally legal) on the final bundled set before public.

## 2. Remove / externalize the incompatible engines

Only n8n, avtr-1, SkyReels-V2 (and unused ltx-video-mac) must leave the bundle now;
the AGPL/MIT/Apache engines may stay.

- [ ] Remove `ltx-video-mac` (0 references).
- [ ] Remove or externalize **n8n**, **avtr-1**, **SkyReels-V2** (submodule the user
      inits, or a `scripts/fetch-engines.sh`) — do not redistribute under AGPL.
- [ ] Update every `repos/<X>` path reference in `mira/`, `dashboard/`, `plan/`, `n8n/`
      for anything moved to external.
- [ ] Update README "Engines" section to reflect bundled vs external.
- [ ] Purge removed engines from git history:
      `git filter-repo --path repos/ltx-video-mac --path repos/n8n --path repos/avtr-1 --path repos/SkyReels-V2 --invert-paths`
      (history is ~10 MB — fast; coordinate the force-push).

## 3. 🔴 Remove internal / confidential artifacts

- [ ] Delete `CLAUDE-FABLE-5.md` from the working tree.
- [ ] Purge from history: `git filter-repo --path CLAUDE-FABLE-5.md --invert-paths`
- [ ] Confirm the same file is removed from the `coco` repo (untracked there today).
- [ ] Grep `plan/` for internal architecture/roadmap not meant to be public
      (audit found no mckinsey/client/confidential strings — re-verify after edits).
- [ ] Confirm `.claude/` is not in history (it's gitignored).

## 4. 🟡 Reputational / brand review

- [ ] Decide on **locally-uncensored** — legal under AGPL, but an "uncensored LLM" under
      a McKinsey-affiliated org is a brand risk. If removing, strip its 5 code refs.
- [ ] Review the "Anthropic-styled" dashboard for any Anthropic trademark/logo misuse.
- [ ] Confirm the "faceless channels / personal-brand automation" framing is acceptable
      for the org's public image.

## 5. 🟡 Secret & credential sweep

- [ ] `.gitignore` already excludes `.env`, `config.toml`, media, `node_modules` — good.
- [ ] Full-history scan: `gitleaks detect --source . --log-opts="--all"` and/or
      `trufflehog git file://.`
- [ ] Verify every `.env.example` holds only placeholders.
- [ ] Rotate any key that ever touched a committed file — public history is forever.

## 6. License Mira itself (AGPL-3.0) + attribution

- [ ] Add the **full AGPL-3.0 license text** as top-level `LICENSE`.
- [ ] Add copyright header + AGPL notice to Mira's own source files (`mira/`, etc.).
- [ ] Add `THIRD-PARTY.md` / `NOTICE` crediting every retained engine (name, license,
      upstream URL, vendored commit) — preserve each engine's own LICENSE file in-tree.
- [ ] Mark modifications where you changed a vendored engine (AGPL §5 / §7).
- [ ] Note the **§13 network clause**: if Mira is ever hosted, network users must be able
      to obtain complete corresponding source. Document how (repo link) in README.

## 7. 🟡 Repo hygiene before flip

- [ ] Mira's own test suite (~400 tests in `mira/`) passes.
- [ ] LFS/large-file check — `.mp4/.mov/.wav/.mp3` gitignored; confirm none in history.
- [ ] Add CI (lint + tests).
- [ ] Enable branch protection + secret scanning.

## 8. ✅ Final go/no-go gate (the git-guard rule)

Only after §1–§3 are 🟢 and §4–§7 done:
- [ ] Owner explicitly authorizes public publication.
- [ ] No internal/confidential material in tree OR history.
- [ ] No secrets in tree OR history.
- [ ] No license-incompatible engine (n8n / avtr-1 / SkyReels) remains bundled.
- [ ] Then flip: `gh repo edit coco-research/Mira --visibility public --accept-visibility-change-consequences`

---

### Recommended sequence
1. §3 (delete Fable doc) — quick win.
2. §1 license verify → §2 remove/externalize n8n, avtr-1, SkyReels, ltx-video-mac.
3. Single `git filter-repo` pass: purge Fable doc + the removed engines from history.
4. §5 secret scan on the rewritten history.
5. §6 add AGPL-3.0 LICENSE + NOTICE/THIRD-PARTY + modification notices.
6. §4 brand decision (locally-uncensored) · §7 hygiene.
7. §8 gate → flip public.

*Do this as its own focused session — it is a real refactor, not a doc edit.*
*Note: the org now spans MIT (coco core), proprietary source-available (coco-loops, coco-fusion, Super Intelligence), and AGPL-3.0 (Mira). State this in the org bio.*
