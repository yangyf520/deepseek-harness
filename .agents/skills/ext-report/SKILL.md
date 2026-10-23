---
name: ext-report
description: '当用户要求报表、报告、数据分析、dashboard、复盘、总结、KPI、销售分析、绩效 review，或任何结构化数值展示时使用——销售分析、绩效评估、KPI 汇总、月/季报、趋势对比、排名。输出单个交互式 HTML 文件，使用 ECharts 绘图。'
---

# 报表输出

**工作流只有三步：取数据 → 组 JSON → 嵌入模板 → 交付。** 不要写 HTML，不要写 Python，不要截图自检。

**禁止：** 运行 Python/Node 脚本渲染 HTML、用 Chrome/Playwright 截图、用 read_image 回读验证。模板 CSS Grid + ECharts 已保证布局正确，writeText + present 即交付。

**聊天输出：只说"报告已生成"。** 不要输出分析、总结、数据表、代码块。HTML 文件就是报告。

**报表生成后的追问：** 用户针对已生成报表提问（如"为什么下降""哪个区域最差"）时，基于已取数据直接回答，不要重新生成报表。只有用户明确要求"重新做"或"换口径"时才重新走完整流程。

## 第 0 步：获取数据

数据来源由用户决定：用户在对话中提供了数据（文件、表格、API 返回）就直接用；没提供就问用户数据从哪来。不要自行搜索工作区文件或猜测数据源。绝不编造数字。

**取数策略（当数据来自 MCP/API 时）：**
1. **批量拉取原始数据**：用 `entity-search` 一次性拉取所需实体的原始记录（pageSize 设大，如 200-500），不要对每个分析维度单独调 `entity-aggregate`。
2. **本地分析**：拿到原始数据后，用 Python/JavaScript 在本地做所有聚合、分组、对比、环比计算。避免对同一实体反复调用 MCP 接口。
3. **最少调用原则**：每个实体最多调 1-2 次（一次拉原始数据，必要时一次拉元数据）。13 次 aggregate 调用是反模式——应该 4-5 次 search 拉原始数据 + 本地分析。
4. **时间范围一次拉够**：如果需要"最近30天 vs 上月"对比，一次性拉 60 天数据，本地按时间分组，不要分两次调用。

## 第 1 步：选择图表类型

| 用户意图 | ECharts series.type |
|---|---|
| 分类对比 | `bar` |
| 时间趋势 | `line` |
| 占比/份额 | `pie` |
| 多维画像 | `radar` |
| 阶段/漏斗 | `funnel` |
| 意图模糊 | `bar`（分类）或 `line`（时间） |

## 第 2 步：组装 JSON 数据

**report.html（完整报告）** 使用 `REPORT_DATA`，结构如下：

```json
{
  "title": "2026年Q3华东区销售报告",
  "subtitle": "2026年7月 - 9月 | 华东大区",
  "theme": {
    "primary": "#1a73e8",
    "palette": ["#1a73e8", "#34a853", "#fbbc04", "#ea4335"],
    "bg": "#f8f9fa",
    "font": "Inter, system-ui, sans-serif"
  },
  "summary": ["华东Q3达成率112%，超目标12个百分点", "华南回款率仅38%，需重点关注"],
  "kpis": [
    { "label": "总营收", "value": "1,280万", "sub": "↑ 12% vs Q2", "trend": "↑" },
    { "label": "新签客户", "value": "47", "sub": "↓ 5% vs Q2", "trend": "↓" }
  ],
  "charts": [
    {
      "id": "chart-0",
      "title": "7-9月月度营收趋势",
      "hint": "9月营收环比增长23%，主要受大客户集中签约拉动",
      "option": {
        "xAxis": { "type": "category", "data": ["7月","8月","9月"] },
        "yAxis": { "type": "value", "axisLabel": { "formatter": "{value}万" } },
        "series": [{ "type": "bar", "data": [380, 420, 480] }]
      },
      "detail": {
        "columns": ["月份", "营收(万)", "客户数"],
        "rows": [["7月", 380, 12], ["8月", 420, 15], ["9月", 480, 18]]
      }
    }
  ],
  "table": {
    "title": "客户明细",
    "columns": ["客户", "营收(万)", "达成率", "负责人"],
    "rows": [["华东科技", 320, "128%", "张三"], ["南方集团", 280, "95%", "李四"]]
  },
  "recommendations": ["华南区安排专项回款跟进", "9月大客户签约模式复制到华中"]
}
```

**chart.html（单图快速查看）** 使用 `CHART_DATA`：

```json
{ "title": "近8周新建商机数", "id": "chart-0", "hint": "第6周峰值42笔，受促销活动拉动", "option": { "xAxis": { "type": "category", "data": ["W1","W2","W3","W4","W5","W6","W7","W8"] }, "yAxis": { "type": "value" }, "series": [{ "type": "bar", "data": [28,32,25,30,35,42,38,33] }] } }
```

## 第 3 步：选择模板并嵌入

1. 如果用户提供了自定义 HTML 文件（附件、文件路径、或对话中指定），用 Read 读取它作为样式参考。从中提取配色（primary、bg、text 等颜色值）和字体，映射到 theme 字段。不需要用户模板包含任何注入点——模型自动适配。
2. 否则，用 Read 读取内置模板（`report.html` 或 `chart.html`）。
3. 找到 `const REPORT_DATA = null;` 或 `const CHART_DATA = null;` 这一行。
4. 将 `null` 替换为你的 JSON 数据（包含第 1 步提取的 theme 字段）。
5. 用 writeText 直接写入最终 HTML 文件。**不要通过 bash 运行 Python/Node 脚本来拼接或生成文件。**
6. 用 present 展示文件。

**模板完整性约束：** 无论用 writeText 还是 edit，最终产物必须完整保留模板中的以下内容——缺少任何一项即为不合格：
- 页脚导出按钮（`导出 Excel` + `导出 PDF`）
- 每个图表的 toolbox（`saveAsImage` + `restore` + `dataView`）
- 图表联动（`echarts.connect`）
- SheetJS CDN 与 `exportExcel()` 函数
- `renderReport(data)` 函数与 `applyTheme()` 函数

只替换 `const REPORT_DATA = null;` 中的 `null`，不要改动其他任何代码。

## 内容规则

- 报告范围：3-5 个章节（共 6-10 个图表）。每章 = 一个分析维度
- KPI 数量：4-6 个
- 标题和表格单元格中不用 emoji
- 柱状图始终垂直（xAxis category, yAxis value）。单系列柱状图不要设 itemStyle.color，registerChart 自动用 walden 调色板
- 每个图表必须有 hint — 一句话关键洞察，不是数据重复
- **智能洞察：** 组 JSON 时自动标记异常值——最高/最低项、环比突变超 20% 的项、为零的项。写入对应 chart 的 hint 和 summary
- 饼图 radius: '60%'，数据降序排列
- 坐标轴单位始终显示：axisLabel.formatter
- 数据标签：label.show = true，柱/线 position: 'top'，饼 formatter: '{b}: {d}%'

## 专业特性

- **主题定制**：`theme` 字段可选。`primary` 控制主色（KPI数字、卡片左边框、按钮、表头 hover）；`palette` 覆盖图表调色板；`bg`/`text`/`cardBg` 控制背景与文字色；`font` 指定字体。不传则用默认值
- **基准线**：markLine: { data: [{ yAxis: 100, name: '目标' }] }
- **条件格式**：KPI trend 用 "↑"（绿色）或 "↓"（红色）前缀，模板自动着色
- **告警**：在 summary 或 recommendations 中描述，不要单独做 alert div
- **筛选器**：filters 数组，type 为 "select" 或 "date"。仅当有横切维度影响多个图表时使用
- **下钻明细**：chart 的 `detail` 字段**默认不填**。仅当用户明确要求"附明细""展开数据"时才填充 `columns` + `rows`。填充后图表可点击展开明细表格，同时该明细会出现在 Excel 导出中
- **Excel 导出**：模板内置 SheetJS，导出按钮自动生成 xlsx（KPI + 表格 + 图表明细各一个 sheet）
