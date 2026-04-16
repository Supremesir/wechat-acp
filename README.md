# weixin-agent-sdk

> 本项目基于 [@tencent-weixin/openclaw-weixin](https://npmx.dev/package/@tencent-weixin/openclaw-weixin) 改造，非微信官方项目，仅供学习交流使用。

微信 AI Agent 桥接框架 —— 通过简单的 Agent 接口，将任意 AI 后端接入微信。

## 相比上游的增强

| 特性 | 说明 |
|------|------|
| 🖼️ **图片/视频/文件发送** | ACP 模式支持 Agent 向微信发送图片，三层提取机制（ACP 原生 → cursor/generate_image → 文本路径解析） |
| 💬 **Relay 风格追问** | Agent 回复后自动等待 60 秒，用户在微信直接回复即可继续当前对话（同一 ACP session） |
| 📝 **Markdown 部分支持** | 同步上游 `StreamingMarkdownFilter`，代码块、表格、加粗等格式不再被剥离 |
| 🔄 **会话过期自动重登** | 检测 errcode -14 后自动弹出二维码重新登录，无需手动重启 |
| 🔌 **MCP 服务器自动加载** | 从 `~/.cursor/mcp.json` 读取 MCP 配置传入 ACP session，支持排除指定 MCP |
| ⏱️ **移除扫码登录超时** | 同步上游 v2.1.4 修复，网络慢时不再超时失败 |

## 项目结构

```
packages/
  sdk/                  weixin-agent-sdk —— 微信桥接 SDK
  weixin-acp/           ACP (Agent Client Protocol) 适配器
  example-openai/       基于 OpenAI 的示例
```

## 通过 ACP 接入 Claude Code, Codex, Cursor CLI 等 Agent

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/) 是一个开放的 Agent 通信协议。如果你已有兼容 ACP 的 agent，可以直接通过 [`weixin-acp`](https://www.npmjs.com/package/weixin-acp) 接入微信，无需编写任何代码。

### Claude Code

```bash
npx weixin-acp claude-code
```

### Codex

```bash
npx weixin-acp codex
```

### Cursor CLI (ACP 模式)

```bash
npx weixin-acp start -- agent acp
```

### 其它 ACP Agent

比如 kimi-cli：

```bash
npx weixin-acp start -- kimi acp
```

`--` 后面的部分就是你的 ACP agent 启动命令，`weixin-acp` 会自动以子进程方式启动它，通过 JSON-RPC over stdio 进行通信。

更多 ACP 兼容 agent 请参考 [ACP agent 列表](https://agentclientprotocol.com/get-started/agents)。

### 本地开发运行

如果你 clone 了本项目源码，可以使用快捷脚本：

```bash
pnpm install

# 扫码登录
pnpm run login

# 启动 Cursor ACP 模式
pnpm run cursor
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
import { login, start, type Agent } from "weixin-agent-sdk";

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
import { login, start, type Agent } from "weixin-agent-sdk";

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
import { login, start, type Agent } from "weixin-agent-sdk";

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

## 💬 追问模式（Relay 风格多轮对话）

灵感来自 [ide-relay-mcp](https://github.com/andeya/ide-relay-mcp)。Agent 每次回复后自动开启 **60 秒追问窗口**，用户在手机微信上直接回复即可继续当前对话。

```
你：帮我写一个快速排序
AI：好的，这是实现...
    ---
    > 💬 追问模式已开启，60 秒内回复可继续当前对话

你：能改成归并排序吗？                    ← 追问（同一 ACP session）
AI：好的，改成归并排序...
    ---
    > 💬 追问模式已开启，60 秒内回复可继续当前对话

                                          ← 超过 60 秒没回复
系统：⏹️ 追问窗口已关闭

你：写一个二分查找                        ← 新对话
```

### 工作原理

```
微信消息 → monitor 轮询 → FollowUpManager 检查
                               │
                    有等待中的追问窗口？
                    ├─ YES → 投递给等待中的 processOneMessage（同一 ACP session）
                    └─ NO  → 正常 processOneMessage → agent.chat()
                                                         │
                                                    回复后开启追问窗口
                                                    等待 60 秒
                                                    ├─ 用户回复 → 继续 chat()
                                                    └─ 超时 → 关闭，结束对话
```

**与 Relay MCP 的区别**：不依赖 MCP 工具调用，直接在桥接层实现，对 Agent 完全透明。Monitor 轮询不被阻塞，追问消息通过 `FollowUpManager` 投递。

### 配置

追问超时默认 60 秒，可在 `packages/sdk/src/messaging/follow-up.ts` 中调整 `FOLLOW_UP_TIMEOUT_MS`。

通过 `start()` 的 `enableFollowUp` 选项启用（`weixin-acp` 默认已启用）：

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
[WEIXIN_IMAGE:/path/to/image.png]      推荐标记语法
![描述](/path/to/image.png)            Markdown 图片语法
/absolute/path/to/image.png            独立行绝对路径
```

视频和文件同理：`[WEIXIN_VIDEO:path]`、`[WEIXIN_FILE:path]`。

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
- **MCP 自动加载**：从 `~/.cursor/mcp.json` 读取 MCP 配置，支持 `excludeMcpServers` 排除
- Node.js >= 22

## Star History

<a href="https://www.star-history.com/?repos=wong2%2Fweixin-agent-sdk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&legend=top-left" />
 </picture>
</a>
