---
name: ext-biz-tools
description: 当用户需要通过外部业务系统（CRM、ERP、OA 等）查询、录入、执行或分析数据时使用。提供取数策略、工具识别、错误处理的通用模式（适用于 MCP、数据库、API 等任何外部工具）
---

# 跨系统业务工具使用指南

## 核心规则

**原则：一次拉够，本地分析。**

- ✅ 用 `entity-search` 一次性拉取原始数据（pageSize=200，时间范围覆盖所有需要的周期）
- ✅ 用 Python 在本地做所有聚合/分组/环比（不调 MCP）
- ❌ 禁止"先验证再批量"的分两次拉取模式
- ❌ 禁止对同一实体调用超过 3 次查询工具

## 取数流程（示例，按实际工具名替换）

```python
# 以下以 CRM 的 entity_search 为例。实际工具名和参数格式以 tools/list 返回的描述为准。

# 1. 计算时间范围（覆盖所有需要的周期，如 60 天）
import datetime
tz = datetime.timezone(datetime.timedelta(hours=8))
today = datetime.date.today()
end = datetime.datetime(today.year, today.month, today.day, 23, 59, 59, tzinfo=tz)
start = end - datetime.timedelta(days=60)
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

## 错误处理

- 校验错误 → **从错误信息中提取可用选项** → 用正确值重试
- 权限错误 → 告知用户
- 数据为空 → 告知用户，建议调整条件
