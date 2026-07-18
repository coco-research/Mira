# Mira — Pre-Publication Cleanup Checklist

**Status: 🔴 NOT CLEARED FOR PUBLIC.** Do not flip `coco-research/Mira` to public until
every 🔴 blocker below is resolved and the final go/no-go gate passes.

This checklist was produced from an audit of `main` (26,163 tracked files; ~10 MB
git history; ~200 MB working tree, mostly gitignored media). The core problem is
**not size — it is license compatibility and third-party redistribution.**

---

## 0. TL;DR — the three things that block publication

1. **AGPL copyleft is wired into Mira's own code.** The primary engine
   **OpenMontage is AGPL-3.0** (referenced in 27 core files) and
   **`locally-uncensored` is AGPL-3.0** (5 core files). You cannot license Mira
   as "Coco proprietary / all rights reserved" while bundling and distributing
   AGPL code — AGPL's copyleft would reach the combined work. This must be
   resolved structurally (submodule/external-dep the engines) before publishing.
2. **`CLAUDE-FABLE-5.md`** (internal Anthropic system-prompt doc) is committed at
   the repo root and lives in history. Must be deleted AND purged from history.
3. **Wholesale third-party redistribution.** `repos/` vendors 12 external
   projects (~26,000 files) under mixed licenses, republished under coco-research
   with no attribution/NOTICE and no license audit.

---

## 1. 🔴 License audit of vendored `repos/` (the core blocker)

| Vendored project | License | Referenced in Mira core | Disposition |
|---|---|---|---|
| **OpenMontage** (primary engine) | **AGPL-3.0** | 27 files | ⚠️ Copyleft — submodule/external only; do NOT bundle |
| **locally-uncensored** | **AGPL-3.0** | 5 files | 🔴 Remove entirely (copyleft + brand — see §4) |
| n8n | Sustainable Use License (fair-code) | via top-level `n8n/` | ⚠️ Redistribution-restricted — do NOT bundle |
| avtr-1 | Goodsize Inc. "AVTR-1 Community License" (model) | 1 file | ⚠️ Model license — review terms; likely non-commercial |
| SkyReels-V2 | "license: other" (custom/research) | 7 files | ⚠️ Review custom terms before any use |
| Wan2.2 | Apache-2.0 | 7 files | ✅ OK if attribution/NOTICE preserved |
| hyperframes | Apache-2.0 | 21 files | ✅ OK if attribution/NOTICE preserved |
| StoryGen-Atelier | Apache-2.0 | 6 files | ✅ OK if attribution/NOTICE preserved |
| MoneyPrinterTurbo | MIT | 18 files | ✅ OK if copyright/notice preserved |
| Open-Generative-AI | MIT | 10 files | ✅ OK if copyright/notice preserved |
| Free-ai-video-generator | MIT | 3 files | ✅ OK if copyright/notice preserved |
| ltx-video-mac | MIT | 0 files | ✅ Unused — remove |

**Action items:**
- [ ] Confirm each license above against the upstream repo's current LICENSE (they
      were snapshotted; upstream may have changed).
- [ ] For every project you keep a dependency on, record: upstream URL, exact
      commit/tag vendored, license, and how Mira uses it.
- [ ] Get a licensing sign-off (ideally legal) on the final dependency set before public.

## 2. 🔴 Remove / relocate the vendored `repos/` tree

Mira's README calls `repos/` its "Engines," and code references real paths
(`repos/OpenMontage`, etc.), so you cannot just `rm -rf repos/` — it breaks Mira.
Choose ONE strategy per engine:

- [ ] **Preferred — git submodules.** Replace each kept engine with a submodule
      pointing at its upstream at a pinned commit. Mira's repo then contains
      *pointers, not third-party code* → no redistribution, copyleft obligations
      shift to whoever runs `git submodule update`. AGPL/fair-code engines
      (OpenMontage, n8n) become submodules the user opts into.
- [ ] **Alternative — external-dependency install.** Remove `repos/` entirely and
      add a `scripts/fetch-engines.sh` that clones the engines locally on setup;
      document in README.
- [ ] Remove engines with **0 references** and no plan to use (`ltx-video-mac`).
- [ ] Update every `repos/<X>` path reference in `mira/`, `dashboard/`, `plan/`,
      `n8n/` to the new submodule/local path.
- [ ] Update README "Engines" section to describe the new structure.
- [ ] **Purge `repos/` from git history** (they were committed):
      `git filter-repo --path repos/ --invert-paths`
      (history is ~10 MB, so this is fast; coordinate the force-push).

## 3. 🔴 Remove internal / confidential artifacts

- [ ] Delete `CLAUDE-FABLE-5.md` from the working tree.
- [ ] **Purge it from history:** `git filter-repo --path CLAUDE-FABLE-5.md --invert-paths`
- [ ] Confirm the same file is removed from the `coco` repo too (it's untracked there).
- [ ] Grep `plan/` for any internal architecture/roadmap that shouldn't be public.
      (Audit found no "mckinsey/client/confidential" strings — re-verify after edits.)
- [ ] Confirm `.claude/` is not committed (it's in `.gitignore` — verify history is clean).

## 4. 🔴 Reputational / brand review

- [ ] **Remove `locally-uncensored` entirely** — an "uncensored LLM" project
      published under a McKinsey-affiliated org is a brand risk, and it's AGPL.
      Remove its 5 code references and any feature depending on it.
- [ ] Review the "Anthropic-styled" dashboard for any Anthropic trademark/logo
      misuse before public.
- [ ] Confirm "faceless channels / personal-brand automation" framing is acceptable
      for the org's public image.

## 5. 🟡 Secret & credential sweep

- [ ] `.gitignore` already excludes `.env`, `config.toml`, media, `node_modules` — good.
- [ ] Run a **full-history** secret scan (files were committed):
      `gitleaks detect --source . --log-opts="--all"` and/or `trufflehog git file://.`
- [ ] Verify every `.env.example` contains only placeholders (no real keys).
- [ ] If any real key ever touched a committed file in history, **rotate it** — public
      history is forever.
- [ ] Confirm no API keys hardcoded in `mira/` (audit found only a redaction-test string).

## 6. 🟡 License Mira itself + attribution

- [ ] Add a top-level `LICENSE`. Per the org open-core pattern, Coco-Research
      proprietary (source-available) is fine **only once no bundled copyleft code
      remains** (i.e. after §2). If any AGPL/fair-code code is still bundled, a
      proprietary license is invalid.
- [ ] Add a `NOTICE` / `THIRD-PARTY.md` crediting every retained dependency
      (name, license, upstream URL) — required by MIT/Apache, good practice overall.

## 7. 🟡 Repo hygiene before flip

- [ ] Mira's own test suite (~400 tests in `mira/`) passes.
- [ ] LFS/large-file check — `.mp4/.mov/.wav/.mp3` already gitignored; confirm none in history.
- [ ] Add CI (lint + tests) mirroring the other coco-research repos.
- [ ] Enable branch protection + secret scanning on the repo.

## 8. ✅ Final go/no-go gate (the git-guard rule)

Only after §1–§4 are 🟢 and §5–§7 done:
- [ ] Owner explicitly authorizes public publication.
- [ ] No internal/confidential material in tree OR history.
- [ ] No secrets in tree OR history.
- [ ] Then flip: `gh repo edit coco-research/Mira --visibility public --accept-visibility-change-consequences`

---

### Recommended sequence
1. §3 (delete Fable doc) + §4 (remove locally-uncensored) — quick wins.
2. §1 license audit → decide keep/drop per engine.
3. §2 convert kept engines to submodules; purge `repos/` + Fable from history (one `filter-repo` pass).
4. §5 secret scan on the rewritten history.
5. §6 add LICENSE + NOTICE; §7 hygiene.
6. §8 gate → flip public.

*Do this as its own focused session — it is a real refactor, not a doc edit.*
