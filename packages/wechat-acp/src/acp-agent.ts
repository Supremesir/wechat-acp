import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Agent, ChatRequest, ChatResponse, FeedbackBridge } from "wechat-sdk";
import type { McpServer, SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

/**
 * Injected into every prompt when feedbackBridge is active.
 * Tells the agent to call interactive_feedback instead of replying directly.
 */
const FEEDBACK_SYSTEM_INSTRUCTION = `[SYSTEM] You are communicating with a user through WeChat (not an IDE).
After completing your response, you MUST call the "interactive_feedback" tool (from wechat-feedback MCP server).
Pass your ENTIRE response text as the "summary" parameter — do NOT summarize or truncate.
This tool sends your response to the WeChat user and waits for their reply.

HANDLING THE RESULT:
- If the result contains a user message, continue the conversation with that message.
- If the result is "__WAITING__", call interactive_feedback AGAIN immediately with the SAME summary to continue waiting.
- If the result is empty string "", the user chose not to reply — end the task normally.
- The tool may take several minutes to return while waiting for the user. This is normal — do NOT treat slow return as an error.

SENDING IMAGES/MEDIA:
When you need to send an image, screenshot, or file to the user, include this marker in your summary text:
  [WECHAT_IMAGE:/absolute/path/to/image.png]
  [WECHAT_VIDEO:/absolute/path/to/video.mp4]
  [WECHAT_FILE:/absolute/path/to/file.pdf]
The bridge will automatically extract the file and send it to WeChat. The marker is removed from the displayed text.
The path MUST be an absolute local path to an existing file. Use the screenshot MCP to capture screenshots first, then reference the saved file path.
You can use take_system_screenshot with mode "window" + windowName to capture a specific window, or mode "fullscreen" for the entire screen.
Example: After calling take_system_screenshot, include [WECHAT_IMAGE:path/to/saved/screenshot.png] in your summary.

CRITICAL RULES:
- Do NOT call relay_interactive_feedback — it does not exist here. Use interactive_feedback only.
- Keep responses concise — the user reads on a phone screen. Markdown is supported.`;

type RawMcpEntry = {
  command?: string;
  args?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
};

/**
 * Write a project-level .cursor/mcp.json that disables certain MCP servers.
 * Cursor CLI merges project and global configs; project-level `disabled: true`
 * prevents those MCPs from being loaded.
 */
function disableMcpServers(cwd: string, names: string[]): void {
  if (names.length === 0) return;

  const cursorDir = path.join(cwd, ".cursor");
  const configPath = path.join(cursorDir, "mcp.json");

  let existing: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    existing = raw?.mcpServers ?? {};
  } catch {
    // not found or invalid — start fresh
  }

  let changed = false;
  for (const name of names) {
    const cur = existing[name] as Record<string, unknown> | undefined;
    if (!cur || cur.disabled !== true) {
      existing[name] = {
        ...(cur ?? { command: "echo", args: ["disabled"] }),
        disabled: true,
      };
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: existing }, null, 2) + "\n",
    );
    log(`wrote .cursor/mcp.json — disabled: ${names.join(", ")}`);
  }
}

/**
 * Ensure an MCP server entry exists in the global ~/.cursor/mcp.json.
 * Creates or updates the entry so it includes the timeout hook.
 */
function ensureGlobalMcpEntry(name: string, entry: Record<string, unknown>): void {
  const globalConfigPath = path.join(os.homedir(), ".cursor", "mcp.json");
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(globalConfigPath, "utf8"));
  } catch {
    // start fresh
  }
  const servers = (raw.mcpServers ?? {}) as Record<string, unknown>;
  const existing = servers[name] as Record<string, unknown> | undefined;

  const needsUpdate =
    !existing ||
    existing.command !== entry.command ||
    JSON.stringify(existing.args) !== JSON.stringify(entry.args) ||
    JSON.stringify(existing.env) !== JSON.stringify(entry.env);

  if (needsUpdate) {
    servers[name] = { ...entry, disabled: false };
    raw.mcpServers = servers;
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify(raw, null, 2) + "\n");
    log(`registered ${name} in global ~/.cursor/mcp.json`);
  }
}

/**
 * Build the MCP server list for the ACP session.
 * Reads the global config, applies whitelist/blacklist, and passes env vars.
 */
function buildMcpServerList(
  excludeNames: Set<string>,
  onlyNames?: Set<string>,
): McpServer[] {
  const globalConfigPath = path.join(os.homedir(), ".cursor", "mcp.json");
  let rawServers: Record<string, RawMcpEntry> = {};
  try {
    const data = JSON.parse(fs.readFileSync(globalConfigPath, "utf8"));
    rawServers = data?.mcpServers ?? {};
  } catch {
    // no global config
  }

  const servers: McpServer[] = [];
  for (const [name, entry] of Object.entries(rawServers)) {
    if (onlyNames && !onlyNames.has(name)) continue;
    if (excludeNames.has(name)) continue;
    if (entry.disabled) continue;
    if (!entry.command) continue;

    const env = Object.entries(entry.env ?? {}).map(([k, v]) => ({
      name: k,
      value: v,
    }));

    servers.push({
      name,
      command: entry.command,
      args: entry.args ?? [],
      env,
    });
  }

  return servers;
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the wechat-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;
  private feedbackBridge?: FeedbackBridge;
  private mcpServers: McpServer[];

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.feedbackBridge = options.feedbackBridge;
    const cwd = options.cwd ?? process.cwd();

    const feedbackServerPath = path.resolve(__dirname, "..", "wechat-feedback-server.cjs");
    const timeoutHookPath = path.resolve(__dirname, "..", "mcp-timeout-hook.cjs");
    const feedbackPort = parseInt(options.env?.WECHAT_FEEDBACK_PORT || "19826", 10);

    const disableList = [...(options.excludeMcpServers ?? [])];
    for (const name of ["weixin-feedback", "wps-feedback"]) {
      if (!disableList.includes(name)) disableList.push(name);
    }
    disableMcpServers(cwd, disableList);

    if (options.feedbackBridge) {
      ensureGlobalMcpEntry("wechat-feedback", {
        command: "node",
        args: ["--require", timeoutHookPath, feedbackServerPath],
        env: {
          WECHAT_FEEDBACK_PORT: String(feedbackPort),
          MCP_REQUEST_TIMEOUT_MS: "600000",
        },
        timeout: 600,
        autoApprove: ["interactive_feedback"],
      });
    }

    // Pass wechat-feedback through ACP (agent acp mode doesn't read global mcp.json)
    const excludeSet = new Set(disableList);
    const onlySet = options.onlyMcpServers ? new Set(options.onlyMcpServers) : undefined;
    this.mcpServers = buildMcpServerList(excludeSet, onlySet);
    log(`MCP servers: ${this.mcpServers.map((s) => s.name).join(", ") || "(none)"}`);

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

    // When feedback bridge is active, inject instructions so the agent knows
    // to call interactive_feedback (from wechat-feedback MCP) after responding.
    // The agent won't know about this tool otherwise — project rules may not
    // load in ACP subprocess mode.
    if (this.feedbackBridge) {
      blocks.unshift({
        type: "text",
        text: FEEDBACK_SYSTEM_INSTRUCTION,
      });
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    this.feedbackBridge?.setActiveUser(request.conversationId);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    try {
      await conn.prompt({ sessionId, prompt: blocks });
    } finally {
      this.connection.unregisterCollector(sessionId);
      this.feedbackBridge?.clearActiveUser(request.conversationId);
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

    if (this.options.model) {
      try {
        await conn.unstable_setSessionModel({
          sessionId: res.sessionId,
          modelId: this.options.model,
        });
        log(`model set: ${this.options.model}`);
      } catch (err) {
        log(`failed to set model: ${err}`);
      }
    }

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
