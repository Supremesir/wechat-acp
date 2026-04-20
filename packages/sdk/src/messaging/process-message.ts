import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import type { FeedbackBridge } from "./feedback-bridge.js";
import type { FollowUpManager } from "./follow-up.js";
import { FOLLOW_UP_HINT, FOLLOW_UP_EXPIRED_HINT } from "./follow-up.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { filterMarkdown, sendMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "wechat-acp/media");

/** Save a buffer to a temporary file, returning the file path. */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** When set, enables the follow-up loop after each agent reply. */
  followUpManager?: FollowUpManager;
  /** MCP-based feedback bridge (one SDK chat per user message; no followUpManager loop). Takes priority over followUpManager. */
  feedbackBridge?: FeedbackBridge;
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Find the first downloadable media item from a message. */
export function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList?.length) return undefined;

  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    m?.encrypt_query_param || m?.full_url;

  // Direct media: IMAGE > VIDEO > FILE > VOICE (skip voice with transcription)
  const direct =
    itemList.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  if (direct) return direct;

  // Quoted media: check ref_msg
  const refItem = itemList.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item ?? undefined;
}

async function resolveMediaPath(url: string): Promise<string> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return downloadRemoteImageToTemp(url, path.join(MEDIA_TEMP_DIR, "outbound"));
  }
  return path.isAbsolute(url) ? url : path.resolve(url);
}

/** Send agent response (text and/or media) to a WeChat user. */
async function sendResponseToWeixin(
  response: import("../agent/interface.js").ChatResponse,
  to: string,
  contextToken: string | undefined,
  deps: ProcessMessageDeps,
  footer?: string,
): Promise<void> {
  const appendFooter = (text: string) =>
    footer ? `${text}\n\n---\n> ${footer}` : text;
  const apiOpts = { baseUrl: deps.baseUrl, token: deps.token, contextToken };

  if (response.media) {
    const filePath = await resolveMediaPath(response.media.url);
    await sendWeixinMediaFile({
      filePath,
      to,
      text: response.text ? appendFooter(filterMarkdown(response.text)) : (footer ?? ""),
      opts: apiOpts,
      cdnBaseUrl: deps.cdnBaseUrl,
    });

    if (response.extraMedia) {
      for (const extra of response.extraMedia) {
        try {
          const extraPath = await resolveMediaPath(extra.url);
          await sendWeixinMediaFile({
            filePath: extraPath,
            to,
            text: "",
            opts: apiOpts,
            cdnBaseUrl: deps.cdnBaseUrl,
          });
        } catch (err) {
          deps.log(`[send] extra media failed (${extra.url}): ${err}`);
        }
      }
    }
  } else if (response.text) {
    await sendMessageWeixin({
      to,
      text: appendFooter(filterMarkdown(response.text)),
      opts: apiOpts,
    });
  }
}

/**
 * Process a single inbound message:
 *   slash command check → download media → call agent → send reply.
 *   When followUpManager is provided, enters follow-up loop after each reply.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);

  // --- Slash commands ---
  if (textBody.startsWith("/")) {
    const conversationId = full.from_user_id ?? "";
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        onClear: () => deps.agent.clearSession?.(conversationId),
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) return;
  }

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // --- Download media ---
  let media: ChatRequest["media"];
  const mediaItem = findMediaItem(full.item_list);
  if (mediaItem) {
    try {
      const downloaded = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: saveMediaBuffer,
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      if (downloaded.decryptedPicPath) {
        media = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
      } else if (downloaded.decryptedVideoPath) {
        media = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
          mimeType: downloaded.fileMediaType ?? "application/octet-stream",
        };
      } else if (downloaded.decryptedVoicePath) {
        media = {
          type: "audio",
          filePath: downloaded.decryptedVoicePath,
          mimeType: downloaded.voiceMediaType ?? "audio/wav",
        };
      }
    } catch (err) {
      logger.error(`media download failed: ${String(err)}`);
    }
  }

  // --- Build ChatRequest ---
  const request: ChatRequest = {
    conversationId: full.from_user_id ?? "",
    text: bodyFromItemList(full.item_list),
    media,
  };

  // --- Typing indicator (start + periodic refresh) ---
  const to = full.from_user_id ?? "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    if (!deps.typingTicket) return;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  };
  if (deps.typingTicket) {
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }

  // --- Call agent & send reply (with optional follow-up loop) ---
  try {
    let currentRequest = request;
    let followUpRound = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await deps.agent.chat(currentRequest);

      // When MCP feedback bridge handled multi-turn within agent.chat(),
      // the output was already sent to WeChat by the MCP tool.
      // Only skip if agent returned no meaningful final content.
      if (deps.feedbackBridge?.wasFeedbackUsed(to)) {
        deps.feedbackBridge.resetFeedbackUsed(to);
        const hasContent = !!(response.text?.trim() || response.media);
        if (!hasContent) {
          deps.log(`[feedback] response sent by MCP tool, skipping empty final response`);
          break;
        }
        deps.log(`[feedback] MCP tool was used but agent returned additional content — sending`);
      }

      // --- Send response to WeChat ---
      if (!deps.followUpManager) {
        await sendResponseToWeixin(response, to, contextToken, deps);
        break;
      }

      // Append follow-up hint to the agent reply
      await sendResponseToWeixin(response, to, contextToken, deps, FOLLOW_UP_HINT);

      deps.log(`[follow-up] round ${followUpRound} — waiting for follow-up from ${to}`);
      const followUpMsg = await deps.followUpManager.waitForFollowUp(to);

      if (!followUpMsg) {
        deps.log(`[follow-up] timeout — closing follow-up window for ${to}`);
        await sendMessageWeixin({
          to,
          text: FOLLOW_UP_EXPIRED_HINT,
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        }).catch(() => {});
        break;
      }

      // Update context token if the follow-up message carries a new one
      if (followUpMsg.context_token) {
        setContextToken(deps.accountId, to, followUpMsg.context_token);
      }

      // Build follow-up request from the new message
      let followUpMedia: ChatRequest["media"];
      const followUpMediaItem = findMediaItem(followUpMsg.item_list);
      if (followUpMediaItem) {
        try {
          const downloaded = await downloadMediaFromItem(followUpMediaItem, {
            cdnBaseUrl: deps.cdnBaseUrl,
            saveMedia: saveMediaBuffer,
            log: deps.log,
            errLog: deps.errLog,
            label: "follow-up",
          });
          if (downloaded.decryptedPicPath) {
            followUpMedia = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
          } else if (downloaded.decryptedVideoPath) {
            followUpMedia = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
          } else if (downloaded.decryptedFilePath) {
            followUpMedia = {
              type: "file",
              filePath: downloaded.decryptedFilePath,
              mimeType: downloaded.fileMediaType ?? "application/octet-stream",
            };
          } else if (downloaded.decryptedVoicePath) {
            followUpMedia = {
              type: "audio",
              filePath: downloaded.decryptedVoicePath,
              mimeType: downloaded.voiceMediaType ?? "audio/wav",
            };
          }
        } catch (err) {
          logger.error(`follow-up media download failed: ${String(err)}`);
        }
      }

      currentRequest = {
        conversationId: to,
        text: bodyFromItemList(followUpMsg.item_list),
        media: followUpMedia,
      };

      followUpRound++;
      deps.log(`[follow-up] round ${followUpRound} — processing follow-up from ${to}`);

      // Restart typing indicator for the new round
      if (deps.typingTicket) startTyping();
    }
  } catch (err) {
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    // --- Typing indicator (cancel) ---
    if (typingTimer) clearInterval(typingTimer);
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
    // Ensure follow-up window is closed on error/exit
    deps.followUpManager?.cancel(to);
    deps.feedbackBridge?.resetFeedbackUsed(to);
  }
}
