---
description: "审阅文档证据、记录决定并导出接受的 Word 修改。"
kind: "package-reference"
---
# @deepseek-ai/dsh-audit-review

[English](README.md) | 中文

## 概述

审查发现引用文档原文，并可携带替换建议。接受没有替换建议的发现只表示认可，不会删除原文。缺失或无效的标量提取结果保持未知。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

在 Cordis 组合中挂载插件，并提供所需的会话、投影、文件系统、工具、提示词、沙箱策略和 shell 服务。浏览器配套插件是 [ui-audit-review](../../client/ui-audit-review/README.zh.md)。

## Understand the implementation

<details>
<summary>实现细节</summary>

[投影](src/projection.ts)负责事件重放和快照校验。[场景设置](src/scenario.ts)校验模型工具与快照共享的展示配置。轮次显式设置优先于先前配置；没有设置的轮次保留已配置布局。发现决定和场景元数据归属各自的审查轮次。

[文本修改](src/text-edits.ts)基于原始文本定位接受的替换，拒绝缺失或重叠的引用。[提取](src/extraction.ts)转换标量匹配，不会把缺失数字当作零或任意字符串当作真。[Word 适配器](src/document-scripts.ts)负责转换和文档导出。服务入口负责 Remote 调用和工具注册。

</details>

## Model Experience

### Review requests

#### What the model sees

模型通过 `audit_write`、`analyze_document` 和配套工具提交发现、提取字段并配置展示；服务入口还注入文档审查操作指引。

#### Token effect

工具定义和操作指引增加输入令牌；工具结果随调用进入会话历史。

#### KV Cache effect

挂载配置和操作指引影响请求前缀；工具调用与结果扩展会话历史。

## Known Limitations and Deferred Work

- 文件应用和保存决定是独立操作。决定已保存不代表文件更新成功。
- 撤销所用原始文本保存在服务实例中；重启后可靠撤销需要持久化文档版本。
- Word 导出和文本应用使用不同适配器。复杂文档结构需要核验输出。
- 能力设置不实现企业审批链或业务系统集成。

### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
