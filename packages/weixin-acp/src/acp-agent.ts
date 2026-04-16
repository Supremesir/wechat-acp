import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { McpServer, SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

/**
 * Read MCP server configs from ~/.cursor/mcp.json and convert them
 * to the ACP McpServerStdio format.
 */
function loadUserMcpServers(exclude?: string[]): McpServer[] {
  const candidates = [
    path.join(os.homedir(), ".cursor", "mcp.json"),
    path.join(process.cwd(), ".cursor", "mcp.json"),
  ];

  const excludeSet = new Set(exclude ?? []);
  const servers: McpServer[] = [];
  const seen = new Set<string>();

  for (const configPath of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const entries = raw?.mcpServers ?? {};
      for (const [name, cfg] of Object.entries<Record<string, unknown>>(entries)) {
        if (seen.has(name) || excludeSet.has(name) || !cfg.command) continue;
        seen.add(name);
        servers.push({
          name,
          command: String(cfg.command),
          args: (cfg.args as string[] | undefined) ?? [],
          env: Object.entries((cfg.env as Record<string, string> | undefined) ?? {}).map(
            ([k, v]) => ({ name: k, value: String(v) }),
          ),
        });
      }
    } catch {
      // Config not found or unreadable — skip
    }
  }

  return servers;
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;
  private mcpServers: McpServer[];

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.mcpServers = loadUserMcpServers(options.excludeMcpServers);
    if (this.mcpServers.length > 0) {
      log(`loaded ${this.mcpServers.length} MCP server(s): ${this.mcpServers.map((s) => s.name).join(", ")}`);
    }
    this.connection = new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conn = await this.connection.ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    try {
      await conn.prompt({ sessionId, prompt: blocks });
    } finally {
      this.connection.unregisterCollector(sessionId);
    }

    const response = await collector.toResponse();
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: this.mcpServers,
    });
    log(`session created: ${res.sessionId}`);
    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.connection.dispose();
  }
}
