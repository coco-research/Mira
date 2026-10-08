# Modifications to OpenMontage in Mira

OpenMontage is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`). Section 5(a) requires a modified work to carry prominent notices stating that it was modified, with a relevant date. This file lists the changes Coco made in Mira. A modified file that can hold a comment also carries a short notice pointing here.

## 2026-10-08: third-party skills replaced by link-only stubs (lab-0062)

|                  |                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Removed**      | The vendored upstream text of `.agents/skills/vercel-composition-patterns/`, `.agents/skills/vercel-react-best-practices/` and `.agents/skills/web-design-guidelines/` (rules, references and `AGENTS.md` files from vercel-labs/agent-skills). |
| **Files edited** | Each of those folders' `SKILL.md` is now a short stub that links to the pinned upstream source and its install command. `skills/INDEX.md` (the Design row marks them as link-only stubs).                                                       |
| **Reason**       | The upstream ships no licence file or copyright notice (its README and frontmatter only say MIT), so its terms cannot be complied with and OpenMontage's AGPL-3.0 cannot cover it. See Mira's `THIRD-PARTY.md`.                                 |

## 2026-10-08: slide connector no longer loads a commercial webfont (lab-0062)

|                  |                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files edited** | `.agents/skills/visual-style/references/connectors/html-slides.md`: the Swiss example dropped its Google Fonts `<link>` for "Helvetica Neue" and sets `--font-display` and `--font-body` to `Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`; rule 5 says to load only open-licensed (OFL/Apache) families from a font CDN. The file carries a notice. |
| **Reason**       | Google serves a licensed Monotype/Linotype kit for "Helvetica Neue" that may not be redistributed, and a template that requests it teaches agents to embed it.                                                                                                                                                                                                                 |
