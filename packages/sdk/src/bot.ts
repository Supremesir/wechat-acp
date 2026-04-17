import os from "node:os";
import path from "node:path";

import type { Agent, ChatResponse } from "./agent/interface.js";
import {
  clearAllWeixinAccounts,
  DEFAULT_BASE_URL,
  listWeixinAccountIds,
  loadWeixinAccount,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./auth/accounts.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./auth/login-qr.js";
import { downloadRemoteImageToTemp } from "./cdn/upload.js";
import type { FeedbackBridge } from "./messaging/feedback-bridge.js";
import { extractFirstFeedbackMedia } from "./messaging/feedback-outbound-media.js";
import { getContextToken } from "./messaging/inbound.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { filterMarkdown, sendMessageWeixin } from "./messaging/send.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import { logger } from "./util/logger.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media");

export type LoginOptions = {
  /** Override the API base URL. */
  baseUrl?: string;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
};

export type StartOptions = {
  /** Account ID to use. Auto-selects the first registered account if omitted. */
  accountId?: string;
  /** AbortSignal to stop the bot. */
  abortSignal?: AbortSignal;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
  /** Enable SDK-level follow-up: after each agent reply, wait for user's next message (extra agent.chat per round). */
  enableFollowUp?: boolean;
  /**
   * MCP-based feedback bridge: WeChat follow-ups feed the pending MCP tool inside one agent.chat (Cursor billing is separate).
   * When provided, incoming replies are routed to the pending MCP tool call
   * instead of starting a new agent cycle.  Takes priority over `enableFollowUp`.
   */
  feedbackBridge?: FeedbackBridge;
};

/**
 * Interactive QR-code login. Prints the QR code to the terminal and waits
 * for the user to scan it with WeChat.
 *
 * Returns the normalized account ID on success.
 */
export async function login(opts?: LoginOptions): Promise<string> {
  const log = opts?.log ?? console.log;
  const apiBaseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;

  log("正在启动微信扫码登录...");

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!startResult.qrcodeUrl) {
    throw new Error(startResult.message);
  }

  log("\n使用微信扫描以下二维码，以完成连接：\n");
  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    log(`二维码链接: ${startResult.qrcodeUrl}`);
  }

  log("\n等待扫码...\n");

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl,
    timeoutMs: 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) {
    throw new Error(waitResult.message);
  }

  const normalizedId = normalizeAccountId(waitResult.accountId);
  saveWeixinAccount(normalizedId, {
    token: waitResult.botToken,
    baseUrl: waitResult.baseUrl,
    userId: waitResult.userId,
  });
  registerWeixinAccountId(normalizedId);

  log("\n✅ 与微信连接成功！");
  return normalizedId;
}

/**
 * Remove all stored WeChat account credentials.
 */
export function logout(opts?: { log?: (msg: string) => void }): void {
  const log = opts?.log ?? console.log;
  const ids = listWeixinAccountIds();
  if (ids.length === 0) {
    log("当前没有已登录的账号");
    return;
  }
  clearAllWeixinAccounts();
  log("✅ 已退出登录");
}

/**
 * Check whether at least one WeChat account is logged in and configured.
 */
export function isLoggedIn(): boolean {
  const ids = listWeixinAccountIds();
  if (ids.length === 0) return false;
  const account = resolveWeixinAccount(ids[0]);
  return account.configured;
}

/**
 * A running bot instance — provides proactive messaging capability.
 *
 * - `sendMessage(text)` — send a text message to the logged-in user.
 * - `sendMessage(response)` — send a ChatResponse (text and/or media).
 */
export class Bot {
  private readonly _accountId: string;
  private readonly _baseUrl: string;
  private readonly _cdnBaseUrl: string;
  private readonly _token?: string;
  private readonly _userId: string;

  /** @internal */
  constructor(params: {
    accountId: string;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
    userId: string;
  }) {
    this._accountId = params.accountId;
    this._baseUrl = params.baseUrl;
    this._cdnBaseUrl = params.cdnBaseUrl;
    this._token = params.token;
    this._userId = params.userId;
  }

  /**
   * Proactively send a message to the logged-in WeChat user.
   *
   * Accepts either a plain string (sent as text) or a full `ChatResponse`
   * object (text and/or media).
   *
   * Requires at least one inbound message to have been received so that a
   * valid `context_token` is cached (tokens are valid for ~24 hours).
   */
  async sendMessage(message: string | ChatResponse): Promise<void> {
    const response: ChatResponse =
      typeof message === "string" ? { text: message } : message;

    const contextToken = getContextToken(this._accountId, this._userId);
    if (!contextToken) {
      throw new Error(
        "没有找到 context_token，需要在 start() 运行期间至少收到过一条消息",
      );
    }

    const apiOpts = {
      baseUrl: this._baseUrl,
      token: this._token,
      contextToken,
    };

    if (response.media) {
      let filePath: string;
      const mediaUrl = response.media.url;
      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        filePath = await downloadRemoteImageToTemp(
          mediaUrl,
          path.join(MEDIA_TEMP_DIR, "outbound"),
        );
      } else {
        filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
      }
      await sendWeixinMediaFile({
        filePath,
        to: this._userId,
        text: response.text ? filterMarkdown(response.text) : "",
        opts: apiOpts,
        cdnBaseUrl: this._cdnBaseUrl,
      });
      return;
    }

    if (response.text) {
      await sendMessageWeixin({
        to: this._userId,
        text: filterMarkdown(response.text),
        opts: apiOpts,
      });
      return;
    }

    throw new Error("消息必须包含 text 或 media");
  }
}

/**
 * Start the bot — long-polls for new messages and dispatches them to the agent.
 * Blocks until the abort signal fires or an unrecoverable error occurs.
 *
 * Returns a `Bot` instance with `sendMessage()` for proactive messaging.
 */
export async function start(agent: Agent, opts?: StartOptions): Promise<Bot> {
  const log = opts?.log ?? console.log;

  // Resolve account
  let accountId = opts?.accountId;
  if (!accountId) {
    const ids = listWeixinAccountIds();
    if (ids.length === 0) {
      throw new Error("没有已登录的账号，请先运行 login");
    }
    accountId = ids[0];
    if (ids.length > 1) {
      log(`[weixin] 检测到多个账号，使用第一个: ${accountId}`);
    }
  }

  const account = resolveWeixinAccount(accountId);
  if (!account.configured) {
    throw new Error(
      `账号 ${accountId} 未配置 (缺少 token)，请先运行 login`,
    );
  }

  const accountData = loadWeixinAccount(account.accountId);
  const userId = accountData?.userId;
  if (!userId) {
    throw new Error(
      `账号 ${accountId} 没有关联的用户 ID，请重新运行 login`,
    );
  }

  log(`[weixin] 启动 bot, account=${account.accountId}`);

  if (opts?.feedbackBridge) {
    const bridge = opts.feedbackBridge;
    bridge.setSendCallback(async (userId: string, text: string) => {
      const ct = getContextToken(account.accountId, userId);
      if (!ct) throw new Error("no context_token for feedback send");
      const extracted = extractFirstFeedbackMedia(text);
      if (extracted) {
        await sendWeixinMediaFile({
          filePath: extracted.filePath,
          to: userId,
          text: filterMarkdown(extracted.displayText),
          opts: { baseUrl: account.baseUrl, token: account.token, contextToken: ct },
          cdnBaseUrl: account.cdnBaseUrl,
        });
        return;
      }
      await sendMessageWeixin({
        to: userId,
        text: filterMarkdown(text),
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken: ct },
      });
    });
    log("[weixin] MCP feedback bridge configured");
  }

  const bot = new Bot({
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    token: account.token,
    userId,
  });

  await monitorWeixinProvider({
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    token: account.token,
    accountId: account.accountId,
    agent,
    abortSignal: opts?.abortSignal,
    log,
    enableFollowUp: opts?.enableFollowUp,
    feedbackBridge: opts?.feedbackBridge,
  });

  return bot;
}
