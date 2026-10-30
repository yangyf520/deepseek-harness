---
description: "Review document evidence, record decisions, and export accepted Word edits."
kind: "package-reference"
---
# @deepseek-ai/dsh-audit-review

English | [中文](README.zh.md)

## Summary

Review findings cite document text and can carry suggested replacements. Accepting a finding without a replacement acknowledges the finding without deleting its source text. Missing or invalid extracted scalar values remain unknown.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount the plugin in a Cordis composition with its required session, projection, filesystem, tools, prompt, sandbox-policy, and shell services. Its browser companion is [ui-audit-review](../../client/ui-audit-review/README.md).

## Understand the implementation

<details>
<summary>Implementation internals</summary>

[Projection](src/projection.ts) owns event replay and validated snapshots. [Scenario settings](src/scenario.ts) validate presentation configuration shared by model tools and snapshots. Explicit round settings override earlier configuration; a round without settings keeps the configured layout. Finding decisions and scenario metadata are scoped to a review round.

[Text edits](src/text-edits.ts) resolve accepted replacements against the original text and reject missing or overlapping anchors. [Extraction](src/extraction.ts) converts scalar matches without treating absent numbers as zero or arbitrary strings as true. [Word adapters](src/document-scripts.ts) own conversion and document export. The service entry owns Remote calls and tool registration.

</details>

## Model Experience

### Review requests

#### What the model sees

The model uses `audit_write`, `analyze_document`, and companion tools to submit findings, extract fields, and configure presentation; the service entry also injects document-review instructions.

#### Token effect

Tool definitions and instructions add input tokens; tool results enter session history when called.

#### KV Cache effect

Mounted definitions and instructions affect the request prefix; tool calls and results extend session history.

## Known Limitations and Deferred Work

- File application and the saved decision are separate operations. A saved decision does not establish that its file update succeeded.
- Original text for undo is held in the service instance; restart-safe undo requires durable document revisions.
- Word export and text application use different adapters. Complex document structures require output verification.
- Capability settings do not implement enterprise approval chains or business-system integration.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
