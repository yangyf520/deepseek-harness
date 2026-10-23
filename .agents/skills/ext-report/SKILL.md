---
name: ext-report
description: '当用户要求报表、报告、数据分析、dashboard、复盘、总结、KPI、销售分析、绩效 review，或任何结构化数值展示时使用——销售分析、绩效评估、KPI 汇总、月/季报、趋势对比、排名。输出单个交互式 HTML 文件，使用 ECharts 绘图。'
---

# 报表输出

**CRITICAL: 只输出一个 HTML 文件。所有图表必须通过 `registerChart()` 使用 ECharts。所有数据必须来自 MCP 服务——绝不硬编码或编造。** 取数据 → 读模板 → 替换占位符 → writeText → 展示。这就是整个工作流。不要手绘 div 条、SVG 环、纯 CSS 图表、emoji 方块或任何非 ECharts 可视化。

**聊天输出：只说"报告已生成"。** 不要在聊天中输出分析、总结、数据表、代码块或任何其他内容。HTML 文件就是报告——仅此而已。

**强制：生成 HTML 前必须先用 Read 工具读取模板文件（chart.html 或 report.html）。** 不要凭记忆写 HTML。**不要修改共享类（.card/.kpi/.chart-box）或 handler 函数——只替换 {{PLACEHOLDER}} 内容。**

## 第 0 步：获取实时数据

调用相关 MCP 工具获取实时数据。如果 MCP 服务不可用，请用户提供数据——绝不编造数字。

### MCP 取数效率

见 `ext-biz-tools` 技能的 MCP 效率规则（发现次数限制、批量查询、参数计算、并行查询）。

## 第 1 步：选择图表类型

| 用户意图 | ECharts 系列类型 |
|---|---|
| 分类对比 | `bar` |
| 时间趋势 | `line` |
| 占比/份额 | `pie` |
| 多维画像 | `radar` |
| 阶段/漏斗 | `funnel` |
| 意图模糊时默认 | `bar`（分类）或 `line`（时间） |

其他类型（scatter、gauge、treemap、sankey、heatmap、map、waterfall、双轴）参见 ECharts 文档。

## 第 2 步：填充模板

读取模板文件，用实际数据替换 `{{PLACEHOLDER}}`，通过 `writeText` 写入。

| 场景 | 模板 | 占位符 |
|---|---|---|
| 单图（快速查看） | `chart.html` | `{{CHART_TITLE}}`、`{{CHART_ID}}`、`{{CHART_OPTION}}`、`{{HINT}}` |
| 完整报告（KPI + 图表 + 表格） | `report.html` | `{{TITLE}}`、`{{SUBTITLE}}`、`{{SUMMARY}}`、`{{KPI_ROW}}`、`{{FILTER_BAR}}`、`{{CHART_CARDS}}`、`{{TABLE_CARD}}`、`{{RECOMMENDATIONS}}`、`{{CHART_SCRIPTS}}` |

**占位符契约：**

- `{{KPI_ROW}}`：`<div class="card kpi"><div class="num">VALUE</div><div class="label">LABEL</div><div class="sub">SUB</div></div>` — 每个 KPI 重复一次
- `{{CHART_CARDS}}`：只放扁平卡片 — `<div class="card chart-card"><h2>TITLE</h2><div class="chart-box" id="chartN"></div><div class="hint">一行洞察</div></div>`。`.hint` 是一句话：从**该**图表得出的关键发现或行动（例如"华东达成率 578%，远超目标；华中仅 149%，需关注"）。**不要用 `.section`、`.charts` 或 grid div 包裹** — 模板的 `normalizeLayout()` 会自动两两分组进 section，表格/建议作为独立全宽卡片
- `{{TABLE_CARD}}`：`<div class="card"><h2>TITLE</h2><div class="table-search"><input type="text" placeholder="搜索..."><span class="row-counter"></span></div><table><thead>...</thead><tbody>...</tbody></table><div class="table-empty">无匹配数据</div></div>` — 模板自动接入搜索、行数统计、排序指示、空状态
- `{{CHART_SCRIPTS}}`：每个图表一个 `registerChart('chartN', {...})` — 模板使用 ECharts 'walden' 主题，自动注入 tooltip/legend/toolbox/dataZoom，单系列柱状图自动用调色板区分颜色。除非语义需要，不要设 `itemStyle.color`
- `{{RECOMMENDATIONS}}`：`<div class="card recommendations"><h2>行动建议</h2><ul><li>...</li></ul></div>` — 单卡，编号列表
- `{{SUMMARY}}`：放在副标题后、KPI 行前 — `<div class="card summary-card"><h2>核心结论</h2><ul><li>...</li></ul></div>` — 要点列表，每项一个维度
- `{{FILTER_BAR}}`：仅当有横切维度影响多个图表时。否则省略

**内容规则：**

- 报告范围：3-5 个章节（共 6-10 个图表）。每章 = 一个分析维度
- KPI 数量：4-6 个。少于 4 个显稀疏；多于 6 个换行不佳
- **标题和表格单元格中不用 emoji**
- **不用 `linear-gradient` 背景** — 用 `.card` 加 `border-left` 强调色
- 柱状图：始终垂直（`xAxis: {type:'category'}`，`yAxis: {type:'value'}`）。`registerChart()` 自动为单系列柱状图应用 walden 调色板区分颜色。除非语义需要（如绿色=达标/红色=未达标），不要设 `itemStyle.color`。绝不用统一单色
- 每个图表卡必须有 `.hint` — 一句话：从**该**图表得出的关键洞察或行动。不是数据重复，不是泛泛总结。例如"华南回款率仅 38%，7 笔逾期中 4 笔由其经手"
- 报告末尾：所有图表后放一个 `{{SUMMARY}}` 卡 — 整体诊断 + 前 3-5 项行动建议。这是唯一做跨图表综合的地方
- 图表标题：包含时间范围 + 范围 — "2026年1-9月华东区销售趋势" 而非 "销售趋势"
- 数据标签：`label: { show: true }` — 柱/线：`position: 'top'`；饼：`formatter: '{b}: {d}%'`
- 坐标轴单位：始终显示 — `axisLabel: { formatter: v => v + '万' }` 或 `v + '%'`
- 饼图：`radius: '60%'`，数据降序排列

## 第 3 步：专业特性

- **基准线**：`markLine: { data: [{ yAxis: 100, name: '目标' }] }` — 仅在图例未说明目标时使用
- **条件格式**：KPI — 好则绿色，差则红色。用 `.warn` 或 `style="color:#d32f2f"`
- **同环比**：`↑ 12%` 绿色，`↓ 5%` 红色 — 作为 KPI 子标签
- **告警**：`<div class="alert"><strong>⚠ 问题</strong><br>描述</div>`
- **筛选器**：图表上方放 `<select>` 或 `<input type="date">`。变更时过滤数据数组并调用 `chart.setOption()`
