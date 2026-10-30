---
description: "Inspect audit findings in reusable layouts and act on document suggestions."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-audit-review

English | [中文](README.zh.md)

## Summary

Inspect findings beside their source document or grouped into comparison columns. Shared review controls support acceptance, rejection, and undo. Failed decisions and unconfirmed file updates remain visible with recovery actions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount this client plugin with [audit-review](../../audit/audit-review/README.md) and the conversation, sidebar, locale, and Remote services declared by its entry point. Open the review panel from the conversation's audit card.

## Understand the implementation

<details>
<summary>Implementation internals</summary>

[ViewSwitcher](src/client/views/ViewSwitcher.tsx) selects a layout. Split-panel and document-comparison layouts reuse [FindingCard](src/client/views/FindingCard.tsx) for evidence and decision handling. The card blocks duplicate clicks while an operation is pending, distinguishes decision failure from file-application failure, and never applies a finding without a replacement. Remote callbacks check both transport and business outcomes.

A new layout supplies positioning and passes the existing finding and operation props to shared components. It does not duplicate Remote calls or decision handling. Shared operation labels belong to the locale dictionary.

</details>

## Model Experience

### Review requests

#### What the model sees

The client only reads the `audit` projection; the Host plugin supplies model tools and results.

#### Token effect

Client layouts add no model input tokens.

#### KV Cache effect

Switching layouts does not directly change the model request prefix.

## Known Limitations and Deferred Work

- Matrix, timeline, grouping, and collaboration views primarily display data; their presence does not establish a complete business workflow.
- A decision is not an application receipt. File-application errors require retry or investigation.
- Full visual acceptance across themes and viewport sizes requires browser verification.

### Dev Note

<details>
<summary>Maintainer notes</summary>

None.

</details>
