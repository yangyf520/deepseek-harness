---
name: ext-biz-tools
description: 跨系统业务工具使用指南——查询、录入、执行、分析、决策、协调的通用模式（适用于 MCP、数据库、API 等任何外部工具）
---

# 跨系统业务工具使用指南

## 核心规则（最高优先级）

**原则：一次拉够，本地分析。**

- ✅ 用 `entity-search` 一次性拉取原始数据（pageSize=200，时间范围覆盖所有需要的周期）
- ✅ 用 Python 在本地做所有聚合/分组/环比（不调 MCP）
- ✅ 报错后根据错误信息修正参数，不要忽略错误继续其他查询
- ✅ 并行调用无依赖的工具（工具 A 的输出不是工具 B 的输入）
- ❌ 禁止"先验证再批量"的分两次拉取模式
- ❌ 禁止对同一实体调用超过 3 次查询工具
- ❌ 禁止调用不存在的工具（幻觉工具名）

## 工具识别

外部工具通常以 `mcp__<server>__<tool>` 或 `db__<tool>` 等命名，按前缀判断类型：

| 前缀 | 类型 | 行为 |
|---|---|---|
| `query_*` / `list_*` / `get_*` / `select_*` | 查询 | 安全，直接调用 |
| `create_*` / `update_*` / `record_*` / `insert_*` | 写入 | 执行前确认关键参数 |
| `send_*` / `schedule_*` / `generate_*` / `execute_*` | 执行 | 有副作用，必须先告知用户 |

写入/执行类操作：必填字段缺失时必须追问，不要猜测。操作前向用户确认内容。

## 取数流程（照抄）

```python
# 1. 计算时间范围（覆盖所有需要的周期，如 60 天）
import datetime
tz = datetime.timezone(datetime.timedelta(hours=8))
end = datetime.datetime(2026, 10, 23, 23, 59, 59, tzinfo=tz)
start = datetime.datetime(2026, 8, 24, 0, 0, 0, tzinfo=tz)
start_ms, end_ms = int(start.timestamp()*1000), int(end.timestamp()*1000)

# 2. 批量拉取原始数据（每个实体只调 1 次 entity-search）
data = entity_search("opportunity",
    conditions=[{"apiKey": "createdAt", "type": 12, "value": f"{start_ms},{end_ms}"}],
    page={"pageNo": 1, "pageSize": 200})

# 3. 本地分析（Python 做所有聚合/分组/环比）
by_status = {}
for row in data:
    status = row.get('status', 'unknown')
    by_status[status] = by_status.get(status, 0) + 1

# 4. 组装结果
result = {"by_status": by_status, "total": len(data)}
```

## 查询优化

- **优先多维 GROUP BY**：一次查询返回多个维度的交叉分析
- **时间序列一次查完**：用 `DATE_TRUNC('week', createdAt)` 一次返回所有周的数据
- **多视图场景**：根据用户意图选择视图（如 `*_owner` / `*_all` / `*_approval`），不确定时主动询问

## 错误处理

- 工具返回错误 → 分析错误原因 → 自动修正参数重试
- 校验错误（如 missing required field、invalid view）→ **从错误信息中提取可用选项** → 用正确值重试
- 权限错误 → 告知用户无权限
- 数据为空 → 告知用户未找到匹配数据，建议调整条件
- **仔细阅读工具描述**：多数工具描述已包含必填参数、参数格式、可用选项等信息，调用前务必通读
