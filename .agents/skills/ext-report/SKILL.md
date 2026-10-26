---
name: ext-report
description: '当用户要求报表、报告、数据分析、dashboard、复盘、总结、KPI、销售分析、绩效 review，或任何结构化数值展示时使用——销售分析、绩效评估、KPI 汇总、月/季报、趋势对比、排名。输出单个交互式 HTML 文件，使用 ECharts 绘图。'
---

# 报表输出

## 核心规则（最高优先级）

**工作流：取数据 → 组 JSON → 嵌入模板 → 交付**

**允许：**
- ✅ 用 Python/JavaScript **做数据分析**（聚合、分组、环比计算）
- ✅ 用 bash 运行 Python 脚本处理数据

**禁止：**
- ❌ 用 Python/Node **渲染 HTML**（模板已保证布局）
- ❌ 用 Chrome/Playwright 截图自检
- ❌ 多次调用 `entity-aggregate`（每实体最多 1 次）

**聊天输出：只说“报告已生成”。** HTML 文件就是报告，不要输出分析/代码块。

## 第 1 步：取数据

**数据来源：** 用户提供的直接用；没提供就问；绝不编造。

**MCP 取数流程（照抄，以下 entity 名以实际 CRM 为例）：**

```python
# 1. 动态计算时间范围（60天，覆盖最近30天+上月）
import datetime
today = datetime.date.today()
tz = datetime.timezone(datetime.timedelta(hours=8))
end = datetime.datetime(today.year, today.month, today.day, 23, 59, 59, tzinfo=tz)
start = end - datetime.timedelta(days=60)
start_ms, end_ms = int(start.timestamp()*1000), int(end.timestamp()*1000)

# 2. 批量拉取原始数据（每个实体只调 1 次 entity-search）
opportunities = entity_search("opportunity",
    conditions=[{"apiKey": "createdAt", "type": 12, "value": f"{start_ms},{end_ms}"}],
    page={"pageNo": 1, "pageSize": 200})

orders = entity_search("order",
    conditions=[{"apiKey": "createdAt", "type": 12, "value": f"{start_ms},{end_ms}"}],
    page={"pageNo": 1, "pageSize": 200})

# 3. 本地分析（Python 做所有聚合/分组/环比）
last_30_start = int((end - datetime.timedelta(days=30)).timestamp()*1000)
recent = [o for o in opportunities if o['createdAt'] >= last_30_start]
previous = [o for o in opportunities if o['createdAt'] < last_30_start]
mom_growth = (len(recent) - len(previous)) / max(len(previous), 1)

# 4. 组装 JSON（见第 3 步）
```

**禁止的行为：**
```
entity-aggregate(opportunity, 最近30天)  ← 第1次
entity-aggregate(opportunity, 上月)      ← 第2次 禁止！
entity-aggregate(order, 最近30天)        ← 第3次 禁止！
... 共12次 aggregate 调用 ← 反模式
```

## 第 2 步：选择图表

| 意图 | ECharts type |
|---|---|
| 分类对比 | `bar` |
| 时间趋势 | `line` |
| 占比/份额 | `pie` |
| 多维画像 | `radar` |
| 阶段/漏斗 | `funnel` |

## 第 3 步：组装 JSON

**report.html** 使用 `REPORT_DATA`：

```json
{
  "title": "2026年Q3销售报告",
  "subtitle": "7-9月 | 华东大区",
  "theme": { "primary": "#1677ff", "palette": ["#1677ff","#34a853","#fbbc04","#ea4335"] },
  "summary": ["Q3达成率112%", "回款率38%需关注"],
  "kpis": [
    { "label": "总营收", "value": "1,280万", "sub": "↑12% vs Q2", "trend": "↑" }
  ],
  "charts": [
    {
      "id": "chart-0", "title": "月度营收趋势",
      "hint": "9月环比+23%，受大客户签约拉动",
      "option": {
        "xAxis": { "type": "category", "data": ["7月","8月","9月"] },
        "yAxis": { "type": "value", "axisLabel": { "formatter": "{value}万" } },
        "series": [{ "type": "bar", "data": [380, 420, 480] }]
      }
    }
  ],
  "table": { "title": "客户明细", "columns": ["客户","营收","达成率"], "rows": [["华东科技",320,"128%"]] },
  "recommendations": ["安排专项回款跟进"]
}
```

**chart.html** 使用 `CHART_DATA`：
```json
{ "title": "近8周商机数", "id": "chart-0", "hint": "第6周峰值42笔", "option": { "xAxis": { "type": "category", "data": ["W1","W2","W3","W4","W5","W6","W7","W8"] }, "yAxis": { "type": "value" }, "series": [{ "type": "bar", "data": [28,32,25,30,35,42,38,33] }] } }
```

## 第 4 步：嵌入模板

1. 用 Read 读取内置模板（`report.html` 或 `chart.html`）
2. 找到 `const REPORT_DATA = null;` 或 `const CHART_DATA = null;`
3. 将 `null` 替换为你的 JSON 数据
4. 用 writeText 写入最终 HTML 文件
5. 用 present 展示文件

**模板完整性约束（缺一不可）：**
- 页脚导出按钮（`导出 Excel` + `导出 PDF`）
- 每个图表的 toolbox（`saveAsImage` + `restore` + `dataView`）
- 图表联动（`echarts.connect`）
- SheetJS CDN 与 `exportExcel()` 函数
- `renderReport(data)` 函数与 `applyTheme()` 函数

**只替换 `null`，不改其他代码。**

## 内容规则

- 规模：3-5 章节、6-10 图表、4-6 KPI
- 标题/表格不用 emoji
- `hint` 必须含洞察（异常值、环比突变>20%、为零项），不复述数据
- `detail` 默认不填，仅用户明确要求时填充
- 视觉格式（柱图方向、饼图半径、坐标轴单位、数据标签、主题色、基准线、条件着色、Excel 导出）均由模板自动处理，不需手动设置
