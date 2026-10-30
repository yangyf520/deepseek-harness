---
description: "通过复用布局查看审查发现并处理文档建议。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-audit-review

[English](README.md) | 中文

## 概述

在原文旁查看发现，或按文档排列比较列。共享审查控件支持接受、拒绝和撤销。决定保存失败和文件更新未确认成功会显示相应信息与恢复操作。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

将此客户端插件与 [audit-review](../../audit/audit-review/README.zh.md) 以及入口声明的对话、侧栏、语言和 Remote 服务一起挂载。从对话中的审查卡片打开面板。

## Understand the implementation

<details>
<summary>实现细节</summary>

[ViewSwitcher](src/client/views/ViewSwitcher.tsx)选择布局。分栏和文档比较布局复用 [FindingCard](src/client/views/FindingCard.tsx) 展示证据并处理决定。卡片在操作期间阻止重复点击，区分决定保存失败和文件应用失败，不会应用没有替换建议的发现。Remote 回调同时检查传输和业务结果。

新增布局负责排列，将现有发现和操作属性传给共享组件，不重复实现 Remote 调用或决定处理。共享操作文字归属语言字典。

</details>

## Model Experience

### Review requests

#### What the model sees

客户端只读取 `audit` 投影；模型工具和结果由后端插件提供。

#### Token effect

客户端布局不添加模型输入令牌。

#### KV Cache effect

切换布局不会直接改变模型请求前缀。

## Known Limitations and Deferred Work

- 矩阵、时间线、分组和协作视图主要展示数据；有这些视图不代表具有完整业务流程。
- 决定不是文件应用回执。文件应用失败需要重试或排查。
- 全部主题和窗口尺寸的视觉验收需要浏览器验证。

### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
