/**
 * Bridge interface for MCP-based interactive feedback.
 *
 * When an ACP agent calls the `interactive_feedback` MCP tool, the tool
 * sends the agent's output to WeChat and waits for the user's reply — all
 * within one `agent.chat()` / one ACP `prompt()` (no second SDK round-trip).
 * Cursor usage/billing is product-defined (e.g. per generation or tool step);
 * do not assume one line item in the IDE for the whole wait.
 *
 * The monitor checks this bridge on every incoming message: if a feedback
 * request is pending for the sender, the message is delivered to the bridge
 * instead of starting a new agent cycle.
 */

export interface FeedbackBridge {
  /** Register which user is currently being served by agent.chat(). */
  setActiveUser(userId: string): void;
  /** Clear the active-user slot after agent.chat() returns. */
  clearActiveUser(userId: string): void;

  /**
   * Deliver a user's reply text to a pending feedback wait.
   * Returns `true` if a pending request consumed the message.
   */
  deliverReply(userId: string, text: string): boolean;

  /** Whether feedback was used during the last agent.chat() for this conversation. */
  wasFeedbackUsed(conversationId: string): boolean;
  /** Reset the flag so the next round starts clean. */
  resetFeedbackUsed(conversationId: string): void;

  /** Configure the WeChat send callback (called once by SDK `start()`). */
  setSendCallback(fn: (userId: string, text: string) => Promise<void>): void;
}
