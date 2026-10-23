---
name: ext-biz-tools
description: 跨系统业务工具使用指南——查询、录入、执行、分析、决策、协调的通用模式（适用于 MCP、数据库、API 等任何外部工具）
---

# 跨系统业务工具使用指南

## CRITICAL: 强制规则

**核心原则：最少工具调用完成任务。**

- ✅ 第一次查询获取全部需要的字段和数据，后续用 bash/python 本地处理
- ✅ 报错后根据错误信息修正参数，不要忽略错误继续其他查询
- ✅ 并行调用无依赖的工具（工具 A 的输出不是工具 B 的输入）
- ❌ 禁止对同一实体调用超过 5 次查询工具（entity-query + entity-search 总计）
- ❌ 禁止调用不存在的工具（幻觉工具名）
- ❌ 禁止用不同参数重复查询相似数据

## 工具识别

外部工具通常以 `mcp__<server>__<tool>` 或 `db__<tool>` 等命名，按前缀判断类型：

| 前缀 | 类型 | 行为 |
|---|---|---|
| `query_*` / `list_*` / `get_*` / `select_*` | 查询 | 安全，直接调用 |
| `create_*` / `update_*` / `record_*` / `insert_*` | 写入 | 执行前确认关键参数 |
| `send_*` / `schedule_*` / `generate_*` / `execute_*` | 执行 | 有副作用，必须先告知用户 |

写入/执行类操作：必填字段缺失时必须追问，不要猜测。操作前向用户确认内容。

## 高级查询优化

### 标准流程：分页拉取 → CSV 导出 → 本地分析

1. **分页拉取**：用 entity-search 拉取原始数据（pageSize=50，最多 10 页 = 500 条）
2. **CSV 导出**：用 write 工具把数据写成 CSV 文件
3. **本地分析**：用 bash 运行 python 读取 CSV，做 GROUP BY / SUM / COUNT / 多维交叉分析

### 硬规则

- **优先多维 GROUP BY**：一次查询返回多个维度的交叉分析（如 `GROUP BY status, dimDepartId, saleStageId`）
- **时间序列一次查完**：用 `DATE_TRUNC('week', createdAt)` 一次返回所有周的数据
- **先验证再批量**：先查询 5-10 条验证字段名和结构，确认无误后扩大范围
- **多视图场景**：根据用户意图选择视图（如 `*_owner` / `*_all` / `*_approval`），不确定时主动询问

### 示例

```python
# 拉取 500 条商机后，本地分析
import csv
with open('data.csv') as f:
    data = list(csv.DictReader(f))
# 按部门统计
by_dept = {}
for row in data:
    dept = row['dimDepartId']
    by_dept[dept] = by_dept.get(dept, 0) + 1
```

## 错误处理

- 工具返回错误 → 分析错误原因 → 自动修正参数重试
- 校验错误 → 根据错误信息修正 → 重试
- 权限错误 → 告知用户无权限
- 数据为空 → 告知用户未找到匹配数据，建议调整条件
