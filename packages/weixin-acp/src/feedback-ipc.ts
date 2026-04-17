import http from "node:http";

import type { FeedbackBridge } from "weixin-agent-sdk";

const FEEDBACK_PORT = parseInt(process.env.WEIXIN_FEEDBACK_PORT || "19826", 10);
const FEEDBACK_TIMEOUT_MS = parseInt(
  process.env.WEIXIN_FEEDBACK_TIMEOUT_MS || "600000",
  10,
);

function log(msg: string) {
  console.log(`[feedback-ipc] ${msg}`);
}

type PendingFeedback = {
  resolve: (reply: string) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * HTTP server on localhost that bridges the MCP `interactive_feedback` tool
 * with the WeChat SDK.
 *
 * Flow:
 *   1. MCP server POSTs to /feedback with `{ summary }`
 *   2. This server sends the summary to WeChat via the configured callback
 *   3. Holds the HTTP connection open until a reply arrives or timeout
 *   4. Returns `{ reply }` to the MCP server
 */
export class FeedbackIpcServer implements FeedbackBridge {
  private server: http.Server | null = null;
  private port = 0;

  /** Currently active userId being processed by agent.chat(). */
  private activeUserId: string | null = null;

  /** Pending feedback waits, keyed by userId. */
  private pending = new Map<string, PendingFeedback>();

  /** Conversations where feedback was used (for skipping double-send). */
  private usedConversations = new Set<string>();

  /** Callback to send text to a WeChat user (configured by SDK start()). */
  private sendCallback:
    | ((userId: string, text: string) => Promise<void>)
    | null = null;

  getPort(): number {
    return this.port;
  }

  setSendCallback(fn: (userId: string, text: string) => Promise<void>): void {
    this.sendCallback = fn;
  }

  setActiveUser(userId: string): void {
    log(`setActiveUser: ${userId}`);
    this.activeUserId = userId;
  }

  clearActiveUser(userId: string): void {
    log(`clearActiveUser: ${userId}`);
    if (this.activeUserId === userId) {
      this.activeUserId = null;
    }
  }

  deliverReply(userId: string, text: string): boolean {
    const entry = this.pending.get(userId);
    if (!entry) {
      log(`deliverReply: no pending feedback for user=${userId}`);
      return false;
    }
    clearTimeout(entry.timeout);
    this.pending.delete(userId);
    log(`deliverReply: delivered to user=${userId}, text="${text.slice(0, 50)}"`);
    entry.resolve(text);
    return true;
  }

  wasFeedbackUsed(conversationId: string): boolean {
    return this.usedConversations.has(conversationId);
  }

  resetFeedbackUsed(conversationId: string): void {
    this.usedConversations.delete(conversationId);
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/feedback") {
          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            this.handleFeedbackRequest(body, res).catch((err) => {
              log(`feedback handler error: ${err}`);
              res.writeHead(500);
              res.end(JSON.stringify({ reply: "", error: String(err) }));
            });
          });
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });

      server.listen(FEEDBACK_PORT, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
        }
        this.server = server;
        log(`listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      server.on("error", reject);
    });
  }

  private async handleFeedbackRequest(
    rawBody: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const { summary } = JSON.parse(rawBody) as { summary?: string };
    const userId = this.activeUserId;

    if (!userId) {
      log("no active user — returning empty reply");
      res.writeHead(200);
      res.end(JSON.stringify({ reply: "" }));
      return;
    }

    log(`feedback for user=${userId} (${(summary?.length ?? 0)} chars)`);
    this.usedConversations.add(userId);

    if (this.sendCallback && summary) {
      try {
        const timeoutMins = Math.round(FEEDBACK_TIMEOUT_MS / 60_000);
        const hint = `💬 追问模式已开启，${timeoutMins} 分钟内回复可继续当前对话`;
        const text = `${summary}\n\n---\n> ${hint}`;
        await this.sendCallback(userId, text);
        log(`sent summary to WeChat user=${userId}`);
      } catch (err) {
        log(`failed to send summary: ${err}`);
      }
    }

    const reply = await this.waitForReply(userId);
    log(
      reply
        ? `got reply from user=${userId}: "${reply.slice(0, 50)}"`
        : `timeout for user=${userId}`,
    );

    res.writeHead(200);
    res.end(JSON.stringify({ reply }));
  }

  private waitForReply(userId: string): Promise<string> {
    const existing = this.pending.get(userId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.resolve("");
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(userId);
        log(`timeout waiting for reply from user=${userId}`);
        resolve("");
      }, FEEDBACK_TIMEOUT_MS);

      this.pending.set(userId, { resolve, timeout });
    });
  }

  close(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.resolve("");
    }
    this.pending.clear();
    this.server?.close();
    this.server = null;
  }
}
