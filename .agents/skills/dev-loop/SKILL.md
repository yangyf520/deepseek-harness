---
name: dev-loop
description: Use when implementing a requirement, fixing a bug, or advancing an inventory item. Load git-flow first for repo URL/access/branch gate, then plan, implement, and verify. Read-only on `.wiki/` while coding. Do not wait for the user to name this skill.
---

# Dev Loop on DeepSeek Harness

Thin orchestration over capabilities the `standard` / `web` presets already mount. No Cordis plugin.
Git safety lives in **`git-flow`** — load and satisfy it before changing product code.

## Hard rule: code vs wiki

While planning, implementing, or verifying **code**:

- **Read** `.wiki/` only (Query Lite / indexes for constraints).
- **Do not** create, edit, move, or delete anything under `.wiki/` (including `inventory/`, `log.md`, `raw/`, `wiki/`).
- Wiki updates belong to explicit knowledge work via `llm-wiki` (ingest / compile), or the user editing files themselves — not the coding path.

## What the user does

State a goal in normal language. Expect an early git URL / project confirmation from `git-flow` when the repo is not already proven. Do not require them to say plan, todo, or write-back.

## Pipeline

0. **Git gate** — Load `git-flow`. Resolve URL, probe access, land on `dev` (not `prd` for feature work). **Block** until the gate passes. Commit/push later also follow `git-flow` (user confirm, no secrets).
1. **Load knowledge** — If `<workspace>/.wiki/` exists, load `llm-wiki` for **read-only** grounding.
2. **Resolve task** — Goal, scope, acceptance criteria from the user and/or **reading** `.wiki/inventory/`. Do not rewrite inventory during coding.
3. **Plan** — Prefer plan mode when the change is non-trivial. Use `todo_write` after plan approval (or a short inline plan for tiny fixes). Set or update a `goal` when the session spans multiple steps.
4. **Ground in wiki (read-only)** — Query Lite for in-scope topics before broad repo search. Cite wiki paths for material constraints.
5. **Implement** — Edit product/source files only — never `.wiki/**`. Use subagent / workflow / ralph only when clearly justified; default is single-agent.
6. **Verify** — Run the narrowest checks that prove acceptance (repo README / `AGENTS.md` commands when present). On failure: fix code or report blocked.
7. **Brief** — What changed, what was verified, open follow-ups. Suggest wiki/docs updates only as a separate turn (`dev-docs` + `llm-wiki`).

## DSH tools to prefer

| Step | Prefer |
|---|---|
| Repo / branch / commit | `skill` → `git-flow` + shell `git` |
| Plan | plan mode + `exit_plan_mode` |
| Track steps | `todo_write` |
| Session objective | `goal` |
| Knowledge (read) | `skill` → `llm-wiki` Query Lite |
| Code / tests | fs + shell on non-`.wiki` paths |
| Heavy parallel / retry | `subagent` / `workflow` / `ralph` when justified |

## Stop and ask

- `git-flow` gate failed or URL ambiguous
- Acceptance criteria missing and cannot be inferred
- Destructive ops (prod deploy, force-push, merge to `prd`, mass delete) without explicit ask
- Wiki scope ambiguous among >3 index candidates after one clarifying pass

## Out of scope

- Detailed git/MR/conflict rules → `git-flow`
- Requirement / design / test document templates → `dev-docs`
- Document ingest / wiki compile → `llm-wiki`
- Host/group URL defaults → workspace `AGENTS.md`
- Per-repo test/release checklists → that repository's docs
