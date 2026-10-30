---
kind: upgrade-guide
description: Audit review capability Remote requests now require the review round.
---

# Pass the review round to audit capability requests

English | [中文](guide.zh.md)

## Change

The `group`, `rate`, `comment`, `tag`, and `exportData` methods in `@deepseek-ai/dsh-audit-review` now require `round`; the new `track` method requires it as well. Clients that call these Remote methods directly must identify the projection round so a delayed action cannot update a newer review.

## Migration

1. Read `round` from the current `audit` projection state.
2. Add that value to every audit capability request, for example `{ sessionId, round, targetId, score }`.
3. Regenerate Typert clients if the application vendors generated Remote declarations.
4. Confirm that an action for the current round succeeds and that replaying it after a newer `audit/write` returns a stale-round failure.
