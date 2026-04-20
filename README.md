# wechat-acp

微信 AI Agent 桥接框架 —— 通过简单的 Agent 接口，将任意 AI 后端接入微信。

> **致谢：** 本项目基于 [weixin-agent-sdk](https://github.com/wong2/weixin-agent-sdk) 改造而来，感谢 [@wong2](https://github.com/wong2) 的出色工作。底层通信协议基于 [@tencent-weixin/openclaw-weixin](https://npmx.dev/package/@tencent-weixin/openclaw-weixin)（微信 OpenClaw 通道插件），感谢腾讯微信团队提供的原始 SDK 与协议实现。本项目非微信官方项目，仅供学习交流使用。
>
> **姊妹项目：** 如需将 AI Agent 接入 WPS 数字员工平台，请查看 [woa-acp](https://github.com/user/woa-acp)。

## 相比上游的增强

| 特性 | 说明 |
|------|------|
| 🔄 **MCP Feedback 追问** | 基于 MCP 工具的多轮追问，一次 agent.chat() 内完成多轮对话，支持文本和图片回复 |
| 🖼️ **图片/视频/文件发送** | 三层提取机制（ACP 原生 → cursor/generate_image → 文本路径解析），feedback 回复也支持图片 |
| 🔌 **MCP 服务器管理** | 自动从 `~/.cursor/mcp.json` 加载 MCP，支持排除/白名单，ACP 模式自动排除 relay |
| 💬 **SDK 追问模式** | 无需 MCP 的轻量追问（60 秒窗口），作为 MCP Feedback 的 fallback |
| 📝 **Markdown 部分支持** | 同步上游 `StreamingMarkdownFilter`，代码块、表格、加粗等格式不再被剥离 |
| 🔄 **会话过期自动重登** | 检测 errcode -14 后自动弹出二维码重新登录，无需手动重启 |
| ⏱️ **移除扫码登录超时** | 同步上游 v2.1.4 修复，网络慢时不再超时失败 |

## 项目结构

```
packages/
  sdk/                  wechat-sdk —— 微信桥接 SDK
  wechat-acp/           ACP (Agent Client Protocol) 适配器
  example-openai/       基于 OpenAI 的示例
```

## 通过 ACP 接入 Claude Code, Codex, Cursor CLI 等 Agent

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/) 是一个开放的 Agent 通信协议。如果你已有兼容 ACP 的 agent，可以直接通过 [`wechat-acp`](https://www.npmjs.com/package/wechat-acp) 接入微信，无需编写任何代码。

### Claude Code

```bash
npx wechat-acp claude-code
```

### Codex

```bash
npx wechat-acp codex
```

### Cursor CLI (ACP 模式)

```bash
npx wechat-acp start -- agent acp
```

### 其它 ACP Agent

比如 kimi-cli：

```bash
npx wechat-acp start -- kimi acp
```

`--` 后面的部分就是你的 ACP agent 启动命令，`wechat-acp` 会自动以子进程方式启动它，通过 JSON-RPC over stdio 进行通信。

更多 ACP 兼容 agent 请参考 [ACP agent 列表](https://agentclientprotocol.com/get-started/agents)。

### 本地开发运行

如果你 clone 了本项目源码，可以使用快捷脚本：

```bash
pnpm install

# 扫码登录
pnpm run login

# 启动 Cursor ACP 模式
pnpm start
```

## 自定义 Agent

SDK 主要导出三样东西：

- **`Agent`** 接口 —— 实现它就能接入微信
- **`login()`** —— 扫码登录
- **`start(agent)`** —— 启动消息循环，并返回可主动发消息的 `Bot`

### Agent 接口

```typescript
interface Agent {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

interface ChatRequest {
  conversationId: string;         // 用户标识，可用于维护多轮对话
  text: string;                   // 文本内容
  media?: {                       // 附件（图片/语音/视频/文件）
    type: "image" | "audio" | "video" | "file";
    filePath: string;             // 本地文件路径（已下载解密）
    mimeType: string;
    fileName?: string;
  };
}

interface ChatResponse {
  text?: string;                  // 回复文本（支持 markdown，发送前由 StreamingMarkdownFilter 处理）
  media?: {                       // 回复媒体
    type: "image" | "video" | "file";
    url: string;                  // 本地路径或 HTTPS URL
    fileName?: string;
  };
}
```

### 最简示例

```typescript
import { login, start, type Agent } from "wechat-sdk";

const echo: Agent = {
  async chat(req) {
    return { text: `你说了: ${req.text}` };
  },
};

await login();
const bot = await start(echo);
```

### 完整示例（自己管理对话历史）

```typescript
import { login, start, type Agent } from "wechat-sdk";

const conversations = new Map<string, string[]>();

const myAgent: Agent = {
  async chat(req) {
    const history = conversations.get(req.conversationId) ?? [];
    history.push(req.text);

    // 调用你的 AI 服务...
    const reply = await callMyAI(history);

    history.push(reply);
    conversations.set(req.conversationId, history);
    return { text: reply };
  },
};

await login();
const bot = await start(myAgent);
```

### 主动发送消息

`start()` 返回的 `Bot` 实例提供了 `sendMessage()`，可以在收到微信消息之外，主动给当前登录用户发送内容。

```typescript
import { login, start, type Agent } from "wechat-sdk";

const agent: Agent = {
  async chat(req) {
    if (req.text === "ping") {
      return { text: "pong" };
    }
    return { text: `收到：${req.text}` };
  },
};

await login();
const bot = await start(agent);

setInterval(() => {
  void bot.sendMessage("定时提醒：记得查看最新状态");
}, 60_000);
```

也可以主动发送完整的 `ChatResponse`，包括图片、视频或文件：

```typescript
await bot.sendMessage({
  text: "这是最新报表",
  media: {
    type: "file",
    url: "./reports/daily.pdf",
    fileName: "daily.pdf",
  },
});
```

注意事项：

- 主动发送依赖微信下发的 `context_token`
- 需要在 `start()` 运行期间，至少先收到过当前账号的一条入站消息
- `context_token` 有时效，可能是 24 小时；过期后需要再次收到新消息才能继续主动发送

### OpenAI 示例

`packages/example-openai/` 是一个完整的 OpenAI Agent 实现，支持多轮对话和图片输入：

```bash
pnpm install

# 扫码登录微信
pnpm run login -w packages/example-openai

# 启动 bot
OPENAI_API_KEY=sk-xxx pnpm run start -w packages/example-openai
```

支持的环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 是 | OpenAI API Key |
| `OPENAI_BASE_URL` | 否 | 自定义 API 地址（兼容 OpenAI 接口的第三方服务） |
| `OPENAI_MODEL` | 否 | 模型名称，默认 `gpt-5.4` |
| `SYSTEM_PROMPT` | 否 | 系统提示词 |

## 支持的消息类型

### 接收（微信 → Agent）

| 类型 | `media.type` | 说明 |
|------|-------------|------|
| 文本 | — | `request.text` 直接拿到文字 |
| 图片 | `image` | 自动从 CDN 下载解密，`filePath` 指向本地文件 |
| 语音 | `audio` | SILK 格式自动转 WAV（需安装 `silk-wasm`） |
| 视频 | `video` | 自动下载解密 |
| 文件 | `file` | 自动下载解密，保留原始文件名 |
| 引用消息 | — | 被引用的文本拼入 `request.text`，被引用的媒体作为 `media` 传入 |
| 语音转文字 | — | 微信侧转写的文字直接作为 `request.text` |

### 发送（Agent → 微信）

| 类型 | 用法 |
|------|------|
| 文本 | 返回 `{ text: "..." }` |
| 图片 | 返回 `{ media: { type: "image", url: "/path/to/img.png" } }` |
| 视频 | 返回 `{ media: { type: "video", url: "/path/to/video.mp4" } }` |
| 文件 | 返回 `{ media: { type: "file", url: "/path/to/doc.pdf" } }` |
| 文本 + 媒体 | `text` 和 `media` 同时返回，文本作为附带说明发送 |
| 远程图片 | `url` 填 HTTPS 链接，SDK 自动下载后上传到微信 CDN |
| 主动发送 | 通过 `const bot = await start(agent)` 后调用 `bot.sendMessage(...)` |

## 🔄 MCP Feedback 追问（推荐）

基于 MCP 工具的多轮追问模式。Agent 调用 `interactive_feedback` 工具将回复发送到微信，并在同一次 `agent.chat()` 内等待用户回复，实现真正的多轮对话。

```
你：帮我写一个快速排序
AI：（调用 interactive_feedback 工具）
    好的，这是实现...
    ---
    > 💬 追问模式已开启，10 分钟内回复可继续当前对话

你：能改成归并排序吗？                    ← 回复（同一 agent.chat 内）
AI：（再次调用 interactive_feedback）
    好的，改成归并排序...
    ---
    > 💬 追问模式已开启，10 分钟内回复可继续当前对话

你：[发送一张截图]                         ← 支持图片回复
AI：（收到图片 + 文字）
    我看到了你的截图...

                                          ← 超过 10 分钟没回复
                                            agent.chat() 正常结束
```

### 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    wechat-acp 主进程                         │
│                                                             │
│  ┌──────────────┐     ┌─────────────────────────────────┐   │
│  │  AcpAgent    │     │  FeedbackIpcServer (HTTP)       │   │
│  │              │     │                                 │   │
│  │  agent.chat()├────►│  POST /feedback                 │   │
│  │  (阻塞等待)  │     │  ├─ 发送摘要到微信               │   │
│  │              │     │  ├─ 等待用户回复 (≤10min)        │   │
│  │              │◄────┤  └─ 返回回复文本 + 图片          │   │
│  └──────────────┘     └──────────┬──────────────────────┘   │
│                                  │ deliverReply()            │
│  ┌──────────────────────────┐    │                           │
│  │  Monitor 轮询             │────┘                           │
│  │  (getUpdates)            │  用户回复时投递到 pending       │
│  └──────────────────────────┘                                │
└─────────────────────────────────┬───────────────────────────┘
                                  │ stdio JSON-RPC
┌─────────────────────────────────┴───────────────────────────┐
│  wechat-feedback-server.cjs (MCP Server)                    │
│  ├─ tools/list → interactive_feedback                       │
│  ├─ tools/call → POST http://127.0.0.1:{port}/feedback      │
│  └─ 返回 text + image (base64) 给 Agent                     │
└─────────────────────────────────────────────────────────────┘
```

### 超时防护（双重保险）

| 层级 | 机制 | 说明 |
|------|------|------|
| 1 | `mcp-timeout-hook.cjs` | 预加载脚本 patch MCP SDK 的 60s 默认超时为 10 分钟 |
| 2 | `__WAITING__` 轮询 | 若 Hook 未生效，MCP server 返回 `__WAITING__`，agent 自动重试 |

### 关键设计

| 要点 | 说明 |
|------|------|
| **一次 chat 多轮对话** | Agent 在一次 `agent.chat()` 内通过 MCP 工具实现多轮，无需多次调用 |
| **图片支持** | 用户在追问中发送图片，Monitor 自动下载解密，通过 IPC 传递给 MCP，Agent 收到 base64 图片 |
| **防重复发送** | IPC Server 追踪 `activeSendUsers`，Cursor 内部超时重试时不会重复发送摘要 |
| **Race Condition 防护** | 先创建 pending entry 再发送摘要，防止用户快速回复时回复丢失 |
| **Relay MCP 自动排除** | ACP 模式下自动排除 `relay-mcp`，避免与 `wechat-feedback` 冲突 |
| **MCP 自动注册** | `ensureGlobalMcpEntry` 启动时自动将 `wechat-feedback` 注册到 `~/.cursor/mcp.json`，含 timeout hook |

### 配置

MCP Feedback 由 `wechat-acp` 启动时自动注册到 `~/.cursor/mcp.json`（无需手动配置）。等效配置如下：

```json
{
  "mcpServers": {
    "wechat-feedback": {
      "command": "node",
      "args": ["--require", "mcp-timeout-hook.cjs", "wechat-feedback-server.cjs"],
      "env": { "WECHAT_FEEDBACK_PORT": "19826", "MCP_REQUEST_TIMEOUT_MS": "600000" },
      "timeout": 600,
      "autoApprove": ["interactive_feedback"]
    }
  }
}
```

通过 `start()` 的 `feedbackBridge` 选项启用（优先级高于 `enableFollowUp`）：

```typescript
import { FeedbackIpcServer } from "./src/feedback-ipc.js";

const feedbackIpc = new FeedbackIpcServer();
await feedbackIpc.start();

await start(agent, { feedbackBridge: feedbackIpc });
```

## 💬 SDK 追问模式（轻量 Fallback）

无需 MCP 的轻量追问方案，灵感来自 [ide-relay-mcp](https://github.com/andeya/ide-relay-mcp)。Agent 每次回复后自动开启 **60 秒追问窗口**，对 Agent 完全透明。

```
你：帮我写一个快速排序
AI：好的，这是实现...
    ---
    > 💬 追问模式已开启，60 秒内回复可继续当前对话

你：能改成归并排序吗？                    ← 追问（同一 ACP session）
AI：好的，改成归并排序...

                                          ← 超过 60 秒没回复
系统：⏹️ 追问窗口已关闭
```

**与 MCP Feedback 的区别**：不依赖 MCP 工具调用，直接在 SDK 桥接层实现。追问超时默认 60 秒，适合不支持 MCP 的 Agent。

```typescript
await start(agent, { enableFollowUp: true });
```

## 🖼️ ACP 模式图片发送

ACP 适配器支持 Agent 向微信发送图片/视频/文件，采用三层优先级提取：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | ACP 原生 image 内容块 | 标准 ACP 协议的图片输出 |
| 2 | `cursor/generate_image` 通知 | Cursor 扩展方法（拦截 stdout） |
| 3 | 文本路径提取 | 从 Agent 回复文本中解析图片路径 |

### 文本路径格式

Agent 在回复中使用以下格式，适配器会自动提取并作为图片发送：

```
[WECHAT_IMAGE:/path/to/image.png]      推荐标记语法
![描述](/path/to/image.png)            Markdown 图片语法
/absolute/path/to/image.png            独立行绝对路径
```

视频和文件同理：`[WECHAT_VIDEO:path]`、`[WECHAT_FILE:path]`。

### 配合截图 MCP 使用（可选）

AI Agent 本身无法截图，但可以通过 MCP 工具获取截图能力。图片发送功能已内置于 SDK，只需安装一个截图 MCP 即可。

**推荐：[screenshot-mcp](https://github.com/chunlea/screenshot-mcp)**（跨平台，支持窗口/全屏/区域截图）

在 `~/.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "screenshot-server": {
      "command": "npx",
      "args": ["-y", "screenshot-mcp"],
      "autoApprove": ["list_windows", "list_displays", "screenshot_window", "screenshot_screen", "screenshot_region"]
    }
  }
}
```

`wechat-acp` 启动时会自动读取此配置并加载到 ACP session 中。Agent 就可以：

1. 调用 `list_windows` 查看所有窗口，或 `list_displays` 查看显示器
2. 调用 `screenshot_window` 按窗口标题截图，或 `screenshot_screen` 全屏截图
3. 在回复中使用 `[WECHAT_IMAGE:/path/to/screenshot.png]` 引用
4. SDK 自动提取路径并将图片发送到微信

> 也可使用其他截图 MCP（如 `@mcpcn/screenshot-mcp`），只要能输出本地文件路径即可。

**排除不需要的 MCP**：ACP 模式下 `relay-mcp` 会被自动排除（避免与 `wechat-feedback` 冲突）。如需排除其他 MCP：

```typescript
new AcpAgent({
  command: "agent",
  args: ["acp"],
  excludeMcpServers: ["relay-mcp", "some-other-mcp"],
});
```

## 内置斜杠命令

在微信中发送以下命令：

- `/echo <消息>` —— 直接回复（不经过 Agent），附带通道耗时统计
- `/toggle-debug` —— 开关 debug 模式，启用后每条回复追加全链路耗时
- `/clear` —— 清除当前会话上下文

## 技术细节

- 使用 **长轮询** (`getUpdates`) 接收消息，无需公网服务器
- 媒体文件通过微信 CDN 中转，**AES-128-ECB** 加密传输
- 单账号模式：每次 `login` 覆盖之前的账号
- 断点续传：`get_updates_buf` 持久化到 `~/.openclaw/`，重启后从上次位置继续
- **会话过期自动重登**：检测 errcode -14 后自动弹出二维码重新扫码
- **Markdown 部分支持**：`StreamingMarkdownFilter` 流式过滤，保留代码块/表格/加粗
- **MCP 自动管理**：从 `~/.cursor/mcp.json` 读取 MCP 配置，支持 `excludeMcpServers`（黑名单）和 `onlyMcpServers`（白名单），env 变量正确传递
- **Feedback IPC**：`FeedbackIpcServer` 在 localhost HTTP 上桥接 MCP 工具与 WeChat SDK，支持文本和图片回复
- Node.js >= 22
