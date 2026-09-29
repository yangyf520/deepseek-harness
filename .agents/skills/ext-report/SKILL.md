---
name: ext-report
description: 'Use when the user asks for 报表、报告、数据分析、dashboard、复盘、总结、KPI、销售分析、绩效 review, or any structured numerical presentation — sales analysis, performance reviews, KPI summaries, monthly/quarterly reports, trend comparisons, rankings. Outputs a single interactive HTML file with ECharts.'
---

# Report output

**CRITICAL: ONE HTML file only. ALL charts MUST use ECharts via `registerChart()`. ALL data MUST come from MCP services — never hardcoded or fabricated.** Fetch data → read template → replace placeholders → writeText → present. That's the entire workflow. No hand-crafted div bars, SVG donuts, CSS-only charts, emoji squares, or any non-ECharts visualization.

**Chat output: ONLY "报告已生成".** Do NOT output analysis, summaries, data tables, code blocks, or any other content in the chat. The HTML file IS the report — nothing else.

**MANDATORY: You MUST read the template file (chart.html or report.html) with the Read tool before generating HTML.** Do not write HTML from memory. **Do NOT modify shared classes (.card/.kpi/.chart-box) or handler functions — replace only {{PLACEHOLDER}} content.**

## Step 0: Fetch live data

Call the relevant MCP tools to get real-time data. Use `tools/list` to discover available tools in the current session. If MCP services are unavailable, ask the user to provide data — never fabricate numbers.

## Step 1: Choose chart type

| User intent | ECharts series type |
|---|---|
| Compare categories | `bar` |
| Trend over time | `line` |
| Proportion / share | `pie` |
| Multi-dimension profile | `radar` |
| Stages / funnel | `funnel` |
| Default when ambiguous | `bar` (categorical) or `line` (temporal) |

For other types (scatter, gauge, treemap, sankey, heatmap, map, waterfall, dual-axis), consult ECharts docs.

## Step 2: Fill template

Read the template file, replace `{{PLACEHOLDER}}` with actual data, write via `writeText`.

| Scenario | Template | Placeholders |
|---|---|---|
| Single chart (quick view) | `chart.html` | `{{CHART_TITLE}}`, `{{CHART_ID}}`, `{{CHART_OPTION}}`, `{{HINT}}` |
| Full report (KPI + charts + table) | `report.html` | `{{TITLE}}`, `{{SUBTITLE}}`, `{{SUMMARY}}`, `{{KPI_ROW}}`, `{{FILTER_BAR}}`, `{{CHART_CARDS}}`, `{{TABLE_CARD}}`, `{{RECOMMENDATIONS}}`, `{{CHART_SCRIPTS}}` |

**Placeholder contracts:**

- `{{KPI_ROW}}`: `<div class="card kpi"><div class="num">VALUE</div><div class="label">LABEL</div><div class="sub">SUB</div></div>` — repeat per KPI.
- `{{CHART_CARDS}}`: flat cards only — `<div class="card chart-card"><h2>TITLE</h2><div class="chart-box" id="chartN"></div><div class="hint">ONE-LINE INSIGHT</div></div>`. The `.hint` is a single sentence: key finding or action from THIS chart only (e.g., "华东达成率 578%，远超目标；华中仅 149%，需关注"). **Do NOT wrap in `.section`, `.charts`, or grid divs** — template's `normalizeLayout()` auto-groups into 2-per-row sections and places tables/recommendations as standalone full-width cards.
- `{{TABLE_CARD}}`: `<div class="card"><h2>TITLE</h2><div class="table-search"><input type="text" placeholder="搜索..."><span class="row-counter"></span></div><table><thead>...</thead><tbody>...</tbody></table><div class="table-empty">无匹配数据</div></div>` — template auto-wires search, row counter, sort indicators, empty state.
- `{{CHART_SCRIPTS}}`: `registerChart('chartN', {...})` per chart — template uses ECharts 'walden' theme, auto-injects tooltip/legend/toolbox/dataZoom, and auto-colors single-series bar charts with distinct palette colors. Do NOT set `itemStyle.color` unless semantically required.
- `{{RECOMMENDATIONS}}`: `<div class="card recommendations"><h2>行动建议</h2><ul><li>...</li></ul></div>` — single card, numbered list.
- `{{SUMMARY}}`: goes after subtitle, before KPI row — `<div class="card summary-card"><h2>核心结论</h2><ul><li>...</li></ul></div>` — bullet list, one dimension per item.
- `{{FILTER_BAR}}`: only when a cross-cutting dimension affects multiple charts. Omit otherwise.

**Content rules:**

- Report scope: 3-5 sections (6-10 charts total). Each section = one analytical dimension.
- KPI count: 4-6. Fewer than 4 looks sparse; more than 6 wraps awkwardly.
- **No emoji** anywhere in headings or table cells.
- **No `linear-gradient` backgrounds** — use `.card` with `border-left` accent for emphasis.
- Bar charts: always vertical (`xAxis: {type:'category'}`, `yAxis: {type:'value'}`). `registerChart()` auto-applies distinct walden palette colors per data point for single-series bars. Do NOT set `itemStyle.color` unless semantically required (e.g., green=达标/red=未达标). Never use uniform single color for all bars.
- Each chart card MUST have a `.hint` — ONE sentence: the key insight or action derived from THAT specific chart. Not a data repeat, not a generic summary. E.g., "华南回款率仅 38%，7 笔逾期中 4 笔由其经手".
- End of report: one `{{SUMMARY}}` card after all charts — overall diagnosis + top 3-5 action items. This is the only place for cross-chart synthesis.
- Chart titles: include time range + scope — "2026年1-9月华东区销售趋势" not "销售趋势".
- Data labels: `label: { show: true }` — bar/line: `position: 'top'`; pie: `formatter: '{b}: {d}%'`.
- Axis units: always show — `axisLabel: { formatter: v => v + '万' }` or `v + '%'`.
- Pie: `radius: '60%'`, sort data descending.

## Step 3: Professional features

- **Benchmark lines**: `markLine: { data: [{ yAxis: 100, name: '目标' }] }` — only when legend doesn't already explain target.
- **Conditional formatting**: KPI — green if good, red if bad. Use `.warn` or `style="color:#d32f2f"`.
- **Period comparison (同环比)**: `↑ 12%` green, `↓ 5%` red — add as KPI sub-label.
- **Alerts**: `<div class="alert"><strong>⚠ 问题</strong><br>描述</div>`.
- **Filters**: `<select>` or `<input type="date">` above charts. On change, filter data array and call `chart.setOption()`.
