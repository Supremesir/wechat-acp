/**
 * Follow-up manager — Relay-inspired mechanism for multi-turn conversations
 * within a single ACP session over WeChat.
 *
 * When an agent finishes processing a message, the manager opens a "follow-up
 * window" for that user. If the user sends another message within the timeout,
 * it's delivered directly into the waiting promise instead of creating a new
 * processOneMessage cycle — keeping the conversation in the same ACP session.
 */

import type { WeixinMessage } from "../api/types.js";

export const FOLLOW_UP_TIMEOUT_MS = 60_000;
export const FOLLOW_UP_HINT = "💬 追问模式已开启，60 秒内回复可继续当前对话";
export const FOLLOW_UP_EXPIRED_HINT = "⏹️ 追问窗口已关闭";

type PendingFollowUp = {
  resolve: (msg: WeixinMessage) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class FollowUpManager {
  private pending = new Map<string, PendingFollowUp>();

  /**
   * Block until the given user sends a follow-up message or the timeout expires.
   * Returns the raw WeixinMessage (so caller can extract media/text) or null on timeout.
   */
  waitForFollowUp(userId: string, timeoutMs = FOLLOW_UP_TIMEOUT_MS): Promise<WeixinMessage | null> {
    this.cancel(userId);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(userId);
        resolve(null);
      }, timeoutMs);

      this.pending.set(userId, {
        resolve: (msg) => {
          clearTimeout(timeout);
          this.pending.delete(userId);
          resolve(msg);
        },
        timeout,
      });
    });
  }

  /**
   * Called by the monitor when a new message arrives.
   * Returns true if the message was consumed by a pending follow-up (caller should skip normal dispatch).
   */
  tryDeliver(userId: string, msg: WeixinMessage): boolean {
    const entry = this.pending.get(userId);
    if (!entry) return false;
    entry.resolve(msg);
    return true;
  }

  /** Check whether a user currently has a pending follow-up window open. */
  hasPending(userId: string): boolean {
    return this.pending.has(userId);
  }

  /** Cancel a pending follow-up for a user (e.g. on /clear). */
  cancel(userId: string): void {
    const entry = this.pending.get(userId);
    if (entry) {
      clearTimeout(entry.timeout);
      this.pending.delete(userId);
    }
  }

  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
    }
    this.pending.clear();
  }
}
