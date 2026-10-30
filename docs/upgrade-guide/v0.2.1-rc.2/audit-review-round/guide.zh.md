---
kind: upgrade-guide
description: 文档审查能力的 Remote 请求现在必须携带审查轮次。
---

# 为审查能力请求传入审查轮次

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-audit-review` 的 `group`、`rate`、`comment`、`tag` 和 `exportData` 方法现在必须传入 `round`；新增的 `track` 方法也必须传入该字段。直接调用这些 Remote 方法的客户端必须标明投影轮次，避免延迟操作修改较新的审查结果。

## 迁移

1. 从当前 `audit` 投影状态读取 `round`。
2. 在每个审查能力请求中加入该值，例如 `{ sessionId, round, targetId, score }`。
3. 如果应用保存了生成的 Remote 声明，重新生成 Typert 客户端。
4. 确认当前轮次的操作成功，并确认新的 `audit/write` 产生后重放旧操作会返回轮次过期错误。
