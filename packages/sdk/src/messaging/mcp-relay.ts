/**
 * Interface for MCP-based follow-up relay.
 *
 * When an ACP agent has a `wechat_follow_up` MCP tool injected, the tool
 * communicates with the main process through this bridge. The bridge
 * handles message delivery between the MCP tool and the WeChat monitor.
 */
export interface McpRelayBridge {
  /**
   * Try to deliver a WeChat message to a pending follow-up.
   * Returns true if consumed (caller should skip normal processing).
   */
  tryDeliver(userId: string, text: string): boolean;

  /** Whether there's a pending follow-up for this user. */
  hasPending(userId: string): boolean;

  /**
   * Set the active context so the IPC knows where to send messages.
   * Called before agent.chat().
   */
  setContext(ctx: {
    userId: string;
    sendMessage: (text: string) => Promise<void>;
  }): void;

  /** Clear the active context. Called after agent.chat() completes. */
  clearContext(): void;

  /** Whether the MCP follow-up tool was invoked during the current prompt. */
  wasFollowUpUsed(): boolean;
}
