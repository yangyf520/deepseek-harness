---
name: ext-dev-loop
description: 实现需求、修复 bug 或推进清单项时使用。先加载 git-flow 确认仓库 URL/访问/分支门禁，然后计划、实现、验证。编码期间对 `.wiki/` 只读。不要等用户命名此技能。
---

# DeepSeek Harness 开发循环

对 `standard` / `web` 预设已挂载能力的轻量编排。无 Cordis 插件。
Git 安全在 **`git-flow`** 中——改产品代码前先加载并满足它。

## 硬规则：代码 vs wiki

**计划、实现或验证代码**期间：

- **只读** `.wiki/`（Query Lite / 索引查约束）
- **不要**创建、编辑、移动或删除 `.wiki/` 下的任何内容（包括 `inventory/`、`log.md`、`raw/`、`wiki/`）
- Wiki 更新属于显式知识工作（通过 `llm-wiki` 摄入/编译），或用户自己编辑文件——不在编码路径中

## 用户做什么

用自然语言陈述目标。当仓库未验证时，预期早期从 `git-flow` 获取 git URL / 项目确认。不要要求他们说 plan、todo 或 write-back。

## 流程

0. **Git 门禁** — 加载 `git-flow`。解析 URL、探测访问、落在 `dev`（功能开发不在 `prd`）。门禁通过前**阻塞**。后续提交/推送也遵循 `git-flow`（用户确认、无密钥）
1. **加载知识** — 如果 `<workspace>/.wiki/` 存在，加载 `llm-wiki` 做**只读**接地
2. **解析任务** — 从用户和/或**阅读** `.wiki/inventory/` 获取目标、范围、验收标准。编码期间不重写 inventory
3. **计划** — 非琐碎变更优先用 plan 模式。计划批准后用 `todo_write`（或微小修复用简短内联计划）。会话跨多步时设置或更新 `goal`
4. **Wiki 接地（只读）** — 广泛仓库搜索前，用 Query Lite 查范围内主题。引用 wiki 路径作为实质约束
5. **实现** — 只编辑产品/源文件——绝不 `.wiki/**`。仅在明确合理时使用 subagent / workflow / ralph；默认单代理
6. **验证** — 运行证明验收的最窄检查（仓库 README / `AGENTS.md` 命令，有则用之）。失败时：修复代码或报告阻塞
7. **简报** — 改了什么、验证了什么、后续跟进。仅作为单独轮次建议 wiki/文档更新（`dev-docs` + `llm-wiki`）

## 停止并询问

- `git-flow` 门禁失败或 URL 模糊
- 验收标准缺失且无法推断
- 破坏性操作（生产部署、force-push、合并到 `prd`、批量删除）未经明确要求
- 一轮澄清后 wiki 范围在 >3 个索引候选间模糊

## 超出范围

- 详细 git/MR/冲突规则 → `git-flow`
- 需求/设计/测试文档模板 → `dev-docs`
- 文档摄入/wiki 编译 → `llm-wiki`
- 主机/群组 URL 默认值 → 工作区 `AGENTS.md`
- 每项目测试/发布检查清单 → 该仓库的文档
