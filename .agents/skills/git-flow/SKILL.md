---
name: git-flow
description: Use before cloning, committing, pushing, opening MRs, or switching branches for delivery work. Resolve the git URL with the user, prove reachability and permission, enforce dev vs prd, and stop on auth or conflict failures. Load before code changes when the repo is unclear.
---

# Git Flow

Portable git safety for DeepSeek Harness agents. No Cordis plugin.
**Host/group URLs and credentials stay in workspace `AGENTS.md` or the machine credential helper — never in this skill.**

## When to load

- Starting implementation and the target repo is not proven
- Clone, commit, push, MR, branch switch, or merge involving `dev` / `prd`
- Git probe failed earlier in the session and work must resume

## Forbidden (protect the remote)

**Never** do these unless the user explicitly orders that exact action in this turn:

| Forbidden | Why |
|---|---|
| `git init` / create a new local repo for product work | Repos are created in GitLab by humans; Agent only **clones** existing URLs |
| Create projects on GitLab (API/UI automation) | Same — no Agent-owned empty remotes |
| `git push --force` / `--force-with-lease` to `dev` or `prd` | Can destroy shared history |
| Commit or push directly to `prd` for features | Production promote is human-gated |
| `git remote add` inventing a new upstream | Use the user-confirmed clone URL / existing `origin` only |
| `reset --hard`, branch `-D`, `clean -fdx` on shared checkouts | Destructive; ask first |
| Rewrite `git config` (user.name, credential helpers, insteadOf) | Local machine policy is human-owned |

**Allowed git shape:** ask URL → `ls-remote` → `git clone` (or reuse checkout) → work on `dev` → diff → **user confirms** → commit → push/MR.

If there is no remote URL yet: **stop** and ask the user to create the project in GitLab (or paste an existing URL). Do not `git init` as a substitute.

## Repo gate

Do not plan or edit product code until this gate passes.

### 1. Resolve URL

Prefer, in order:

1. Workspace is already a git checkout with `origin` → show `git remote -v` and confirm with the user it is the intended project.
2. Workspace `AGENTS.md` documents a default **group** only → ask for **project name or full URL** (never invent a path under the group).
3. Otherwise → ask once for the HTTPS or SSH git URL (`ask_user_question` when available).

Never ask for passwords or tokens in chat.

### 2. Probe (non-destructive)

Stop on failure; report the classified cause (network, auth, not found, forbidden, timeout):

| Check | How |
|---|---|
| Reach / read | `git ls-remote <url>` or `git ls-remote origin` |
| Local state | `git status -sb`, current branch, clean/dirty |
| Branch policy | Work on `dev` (or a short-lived branch based on `dev`). Refuse feature commits on `prd`. |
| Write (preferred before promising delivery) | `git push --dry-run origin HEAD:dev` when a checkout exists and remote updates are expected |

Do not print credentials or `.env` contents.

### 3. Land checkout

- URL only → **`git clone`** into the workspace (or a user-named subdirectory); prefer an existing clean checkout over recloning.
- **Never `git init`.** No remote URL → stop and ask the user.
- If the Host session cwd is still the parent folder, tell the user to open the clone as the workspace when required.

## Branch policy

| Branch | Role |
|---|---|
| `dev` | Develop and test — default integration branch |
| `prd` | Production — no feature commits; promote / merge only with **explicit** user confirmation |

- Never force-push `dev` or `prd`.
- Prefer merge requests when the remote protects branches; do not bypass with direct push if policy forbids it.
- Short-lived branches: base on `dev`, name briefly, open MR into `dev` unless the user specifies otherwise.

## Commit and push

1. Show `git status` and a concise diff summary.
2. **Wait for user confirmation** before `git commit` or `git push`.
3. Commit message: why over what; follow the repo's existing style when present.
4. Never commit: `.env`, secrets, `.wiki/`, build artifacts, or credential files.
5. Real `git push` only after confirm; dry-run is for the gate, not a substitute for consent.

## Conflicts and recovery

- On conflict or unexpected dirty tree: **stop**, summarize conflicting paths, propose rebase-vs-merge options; do not rewrite shared history without explicit ask.
- Do not `reset --hard` or delete branches unless the user explicitly requests it.
- If `ls-remote` / push fails: guide VPN, credential helper, SSH agent, or access request — then re-run the gate.

## Multi-repo

If a task spans multiple remotes: gate **each** repo (URL + probe + branch) before editing that tree. Do not assume one `origin` covers all.

## Out of scope

- Company hostname defaults → workspace `AGENTS.md`
- Per-project test/release checklists → that repo's README / `AGENTS.md`
- Implementing product features → `dev-loop` after this gate passes
- Wiki ingest → `llm-wiki`
