---
name: ext-llm-wiki
description: Load when the user explicitly mentions wiki/knowledge/ingest, OR when a document upload arrives without a stated task AND `.wiki/` already exists. Do NOT load for simple file uploads where the user states a clear task (audit, review, summarize, etc.). Clarify intent in ONE question before acting; auto-ingest only after user confirms wiki use.
---

# LLM Wiki on DeepSeek Harness

Portable [nvk/llm-wiki](https://github.com/nvk/llm-wiki) behavior. No npm package, no Cordis plugin — this skill is the integration surface.

Full protocol: [upstream AGENTS.md](https://github.com/nvk/llm-wiki/blob/master/AGENTS.md). This file adds DSH-specific triggers/constraints on top.

## DSH Triggers

Load on the **first** matching turn:

| Load | Do NOT load |
|------|-------------|
| User mentions wiki/knowledge/ingest/入库 | User uploads a document AND states a clear task |
| `.wiki/_index.md` exists AND document uploaded without task | User continues an existing task turn |
| `.wiki/inbox/` has files not yet under `raw/` | No `.wiki/` and user hasn't mentioned wiki |
| User asks a question answerable from project-local knowledge | |

## DSH Constraints

### Untasked upload

A document arrival is not a task. **No audit, report, rewrite, or answer starts before the reply.**

**Workflow (≤2 tool calls before asking):**

1. **Identify** — read first pages/headings. Name document and type. **1 call max.**
2. **Infer intent** — read `.wiki/_index.md` + tail of `.wiki/log.md` in one call. If `.wiki/` empty, rank by document type alone.
3. **Ask** — one `ask_user_question`, user's language. 2–4 options, most likely first with `(Recommended)`.
4. **Execute** — archive-only stops after ingest. Otherwise: archive source first (`raw/` + `log.md` line), then run the task.

**Skip the question** when the message already states the task, or the file arrives inside an ongoing task.

**Infer intent from document nature** (step 2):

- **Regulatory / normative** (laws, standards, policies) → compliance review, clause lookup, build regulation wiki
- **Specification / design** (PRD, API spec, architecture) → requirement review, implementation check, build technical wiki
- **Analytical / research** (papers, reports, theses) → summarize, compare, thesis verification, build knowledge wiki
- **Operational** (manuals, SOPs, meeting notes) → archive, process check, action tracking
- **Contractual** (agreements, contracts) → clause review, risk identification, build contract wiki
- **Data** (datasets, reports) → analysis, trend report, archive

General rule: the more formal/binding the document, the more likely review/compliance is the top intent. The more informational, the more likely knowledge-base building is.

**Existing wiki bias:** if `.wiki/` already has a topic wiki whose scope matches the document, bias toward that wiki (e.g. existing law wiki + law doc → "加入法规库" as top option).

**Hard constraints:**
- No `bash ls/find/cd` to scout — read `_index.md` directly
- No copy to `raw/`/`work/`/`.wiki/` until user states intent
- No redundant extraction — reuse `work/<name>.txt` if exists
- No `.wiki/` creation until user confirms wiki use

### Separation from coding

Code turns: use this skill **read-only**. Do not ingest, compile, init, or mutate `.wiki/`.

### Initialize

Create skeleton silently when triggers match and `.wiki/_index.md` is missing:

```
.wiki/
  inbox/          # drop zone
  raw/            # immutable sources
  wiki/
    concepts/
    topics/
    references/
  output/         # generated artifacts
  _index.md       # title + scope + links to raw/wiki/inbox
  schema.md       # naming rules, wikilink style, page-type conventions
  log.md          # append-only activity
```

Add `.wiki/` to `.gitignore` only when user wants private wiki.
