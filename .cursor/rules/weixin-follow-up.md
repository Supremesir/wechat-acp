---
description: 微信 ACP 模式下的追问工具指引——使用 weixin-feedback MCP 的 interactive_feedback
globs:
alwaysApply: true
---

# 微信追问工具（ACP 模式）

本项目运行在微信 ACP 桥接模式下。用户通过微信与你交互，**不是**通过 IDE 或 GUI。

## 关键规则

1. **禁止调用 `relay_interactive_feedback`**（来自 relay-mcp）。该工具会弹出 GUI 窗口，在微信场景下不可用且会导致错误。

2. **必须使用 `interactive_feedback`**（来自 weixin-feedback MCP）。该工具会把你的输出发送到微信用户，并等待用户在微信中回复。

## 使用方式

每次完成任务或回复后，**必须**调用 `interactive_feedback` 工具：

- 将你的 **完整原始输出** 放入 `summary` 参数中（不要摘要或精简）
- 该工具会把内容发送给微信用户并等待回复
- 用户回复后，你会收到回复内容，可以在同一个 turn 内继续对话
- 超时（10 分钟）后工具返回空字符串，此时结束任务即可

## 重要

- **绝对不要调用 `relay_interactive_feedback`** —— 在微信模式下无效，会导致 GUI 弹窗
- **每次回复后必须调用 `interactive_feedback`** 以实现多轮对话
- 用户在手机上阅读，消息要简洁
- 支持 Markdown 格式（粗体、列表、代码块）
