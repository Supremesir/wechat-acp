import type { FeedbackBridge } from "weixin-agent-sdk";

export type AcpAgentOptions = {
  /** Command to launch the ACP agent, e.g. "npx" */
  command: string;
  /** Command arguments, e.g. ["@zed-industries/codex-acp"] */
  args?: string[];
  /** Extra environment variables for the subprocess */
  env?: Record<string, string>;
  /** Working directory for the subprocess and ACP sessions */
  cwd?: string;
  /** Prompt timeout in milliseconds (default: 120_000) */
  promptTimeoutMs?: number;
  /** MCP server names to exclude when loading from ~/.cursor/mcp.json */
  excludeMcpServers?: string[];
  /**
   * MCP-based feedback bridge. When provided, the weixin-feedback MCP server
   * is registered in the project .cursor/mcp.json so that Cursor CLI auto-loads it.
   */
  feedbackBridge?: FeedbackBridge;
  /**
   * Model ID to use for sessions, e.g. "claude-3.5-sonnet", "gpt-4o".
   * Uses a non-thinking model to reduce request consumption.
   */
  model?: string;
};
