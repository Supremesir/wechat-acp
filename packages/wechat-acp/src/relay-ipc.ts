/**
 * Combined MCP + IPC HTTP server for WeChat follow-up.
 *
 * Runs in the main wechat-acp process. Cursor CLI connects to it via
 * Streamable HTTP transport (POST /mcp). This replaces the separate
 * weixin-relay-mcp-server.mjs subprocess approach.
 *
 * Endpoints:
 *   POST /mcp — MCP protocol (JSON-RPC 2.0) for Cursor CLI
 *
 * The MCP server exposes a single tool `weixin_follow_up` that sends
 * the agent's message to WeChat and waits for a reply.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

function log(msg: string) {
  console.log(`[mcp-relay] ${msg}`);
}

const TOOL_DEF = {
  name: "wechat_follow_up",
  description:
    "Send your response to the WeChat user and wait for their reply. " +
    "Use this tool whenever you want to ask the user a question, request " +
    "confirmation, or present intermediate results before continuing. " +
    "The user sees your message on WeChat and can reply from their phone. " +
    "If the user does not reply within the timeout, the tool returns a timeout notice.",
  inputSchema: {
    type: "object" as const,
    properties: {
      message: {
        type: "string",
        description: "Your message to send to the WeChat user",
      },
      timeout_seconds: {
        type: "number",
        description:
          "How long to wait for a reply in seconds (default: 120, max: 300)",
      },
    },
    required: ["message"],
  },
};

export class RelayIpcServer {
  private server: http.Server | null = null;
  port = 0;

  private context: {
    userId: string;
    sendMessage: (text: string) => Promise<void>;
  } | null = null;

  private followUpUsed = false;

  private messageWaiter: {
    resolve: (text: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private mcpInitialized = false;

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as AddressInfo).port;
        log(`listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
      this.server.on("error", reject);
    });
  }

  setContext(ctx: {
    userId: string;
    sendMessage: (text: string) => Promise<void>;
  }): void {
    this.context = ctx;
    this.followUpUsed = false;
  }

  clearContext(): void {
    this.context = null;
    if (this.messageWaiter) {
      clearTimeout(this.messageWaiter.timer);
      this.messageWaiter.resolve(null);
      this.messageWaiter = null;
    }
  }

  wasFollowUpUsed(): boolean {
    return this.followUpUsed;
  }

  tryDeliver(userId: string, text: string): boolean {
    if (!this.context || this.context.userId !== userId || !this.messageWaiter) {
      return false;
    }
    clearTimeout(this.messageWaiter.timer);
    this.messageWaiter.resolve(text);
    this.messageWaiter = null;
    return true;
  }

  hasPending(userId: string): boolean {
    return this.context?.userId === userId && this.messageWaiter !== null;
  }

  // ── HTTP handler ───────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.method === "POST" && req.url === "/mcp") {
      this.readBody(req).then((body) => {
        this.handleMcp(body, res);
      });
      return;
    }

    if (req.method === "DELETE" && req.url === "/mcp") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/mcp") {
      res.writeHead(405);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
    });
  }

  // ── MCP protocol (JSON-RPC 2.0 over Streamable HTTP) ──────────

  private handleMcp(body: string, res: http.ServerResponse): void {
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
      return;
    }

    if (msg.jsonrpc !== "2.0") {
      res.writeHead(400);
      res.end();
      return;
    }

    // Notifications (no id) — acknowledge with 202
    if (msg.id == null) {
      res.writeHead(202);
      res.end();
      return;
    }

    const sendResult = (result: unknown) => {
      const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(resp).toString(),
      });
      res.end(resp);
    };

    const sendError = (code: number, message: string) => {
      const resp = JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(resp).toString(),
      });
      res.end(resp);
    };

    switch (msg.method) {
      case "initialize":
        this.mcpInitialized = true;
        log("MCP initialized by Cursor CLI");
        sendResult({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "wechat-relay", version: "0.2.0" },
        });
        break;

      case "tools/list":
        sendResult({ tools: [TOOL_DEF] });
        break;

      case "tools/call": {
        const args = (msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {};
        const message = (args.message as string) ?? "";
        const timeoutSec = Math.min((args.timeout_seconds as number) ?? 120, 300);
        const timeoutMs = timeoutSec * 1000;

        this.handleFollowUp(message, timeoutMs)
          .then((result) => {
            if (result.timeout) {
              sendResult({
                content: [
                  {
                    type: "text",
                    text: "⏹️ 用户未在规定时间内回复，追问窗口已关闭。请继续完成当前任务或给出最终回复。",
                  },
                ],
              });
            } else {
              sendResult({
                content: [{ type: "text", text: result.text ?? "" }],
              });
            }
          })
          .catch((err: Error) => {
            sendResult({
              content: [{ type: "text", text: `⚠️ 追问通信失败: ${err.message}` }],
              isError: true,
            });
          });
        break;
      }

      default:
        sendError(-32601, `Method not found: ${msg.method}`);
    }
  }

  // ── Follow-up logic ────────────────────────────────────────────

  private async handleFollowUp(
    message: string,
    timeoutMs: number,
  ): Promise<{ text?: string; timeout?: boolean }> {
    if (!this.context) {
      log("no active context — returning timeout");
      return { timeout: true };
    }

    this.followUpUsed = true;
    const userId = this.context.userId;
    log(`follow-up for ${userId}: sending message (${message.length} chars)`);

    try {
      await this.context.sendMessage(message);
    } catch (err) {
      log(`failed to send message to WeChat: ${String(err)}`);
    }

    log(`waiting for reply from ${userId} (timeout=${timeoutMs}ms)`);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.messageWaiter = null;
        log(`follow-up timeout for ${userId}`);
        resolve({ timeout: true });
      }, timeoutMs);

      this.messageWaiter = {
        resolve: (text) => {
          if (text !== null) {
            log(`follow-up reply from ${userId}: ${text.slice(0, 80)}`);
            resolve({ text });
          } else {
            resolve({ timeout: true });
          }
        },
        timer,
      };
    });
  }

  async stop(): Promise<void> {
    this.clearContext();
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
