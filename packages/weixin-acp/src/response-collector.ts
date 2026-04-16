import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatResponse } from "weixin-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const ACP_MEDIA_OUT_DIR = path.join(os.tmpdir(), "weixin-agent/media/acp-out");

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tiff", ".tif", ".ico",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

/**
 * Extract file paths from text using common patterns:
 * - Markdown image syntax: ![alt](path)
 * - Explicit marker: [WEIXIN_IMAGE:path] / [WEIXIN_VIDEO:path] / [WEIXIN_FILE:path]
 * - Bare absolute paths on their own line (Unix or Windows style)
 */
function extractMediaPaths(text: string): { path: string; type: "image" | "video" | "file" }[] {
  const results: { path: string; type: "image" | "video" | "file" }[] = [];
  const seen = new Set<string>();

  const add = (p: string, type: "image" | "video" | "file") => {
    const normalized = p.replace(/\\/g, "/");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      results.push({ path: p, type });
    }
  };

  // [WEIXIN_IMAGE:path], [WEIXIN_VIDEO:path], [WEIXIN_FILE:path]
  const markerRe = /\[WEIXIN_(IMAGE|VIDEO|FILE):([^\]]+)\]/g;
  for (const m of text.matchAll(markerRe)) {
    const kind = m[1].toLowerCase() as "image" | "video" | "file";
    add(m[2].trim(), kind);
  }

  // Markdown image: ![...](path)
  const mdImgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const m of text.matchAll(mdImgRe)) {
    const p = m[1].trim();
    if (!p.startsWith("http://") && !p.startsWith("https://")) {
      add(p, "image");
    }
  }

  // Bare absolute paths on their own line
  // Unix: /tmp/foo.png  |  Windows: C:\Users\foo.png or C:/Users/foo.png
  const lineRe = /^[ \t]*(?:`([^`]+)`|(\/?(?:[A-Za-z]:[\\/]|\/)[^\s*"<>|]+\.\w+))[ \t]*$/gm;
  for (const m of text.matchAll(lineRe)) {
    const p = (m[1] ?? m[2]).trim();
    if (p.startsWith("http://") || p.startsWith("https://")) continue;
    const ext = path.extname(p).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      add(p, "image");
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      add(p, "video");
    }
  }

  return results;
}

/**
 * Remove media markers and markdown image references from text so the user
 * sees clean prose instead of raw paths.
 */
function stripMediaMarkers(text: string, extractedPath: string): string {
  // Strip [WEIXIN_*:path] markers
  text = text.replace(/\[WEIXIN_(?:IMAGE|VIDEO|FILE):[^\]]+\]\s*/g, "");
  // Strip markdown image refs pointing to extracted path
  const escaped = extractedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  text = text.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)\\s*`, "g"), "");
  return text.trim();
}

function log(msg: string) {
  console.log(`[acp-collector] ${msg}`);
}

/**
 * Collects sessionUpdate notifications for a single prompt round-trip
 * and converts the accumulated result into a ChatResponse.
 */
export class ResponseCollector {
  private textChunks: string[] = [];
  private imageData: { base64: string; mimeType: string } | null = null;
  private generatedImagePath: string | null = null;

  /**
   * Feed a sessionUpdate notification into the collector.
   */
  handleUpdate(notification: SessionNotification): void {
    const update = notification.update;

    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content;

      if (content.type === "text") {
        this.textChunks.push(content.text);
      } else if (content.type === "image") {
        this.imageData = {
          base64: content.data,
          mimeType: content.mimeType,
        };
      }
    }
  }

  /**
   * Accept an image path from the cursor/generate_image extension.
   */
  setGeneratedImage(filePath: string): void {
    this.generatedImagePath = filePath;
  }

  /**
   * Build a ChatResponse from all collected chunks.
   *
   * Priority for media:
   * 1. ACP native image content block (base64 via agent_message_chunk)
   * 2. cursor/generate_image extension path
   * 3. Image paths extracted from text (markers, markdown, bare paths)
   */
  async toResponse(): Promise<ChatResponse> {
    const response: ChatResponse = {};

    let text = this.textChunks.join("");

    // --- Priority 1: ACP native image ---
    if (this.imageData) {
      await fs.mkdir(ACP_MEDIA_OUT_DIR, { recursive: true });
      const ext = this.imageData.mimeType.split("/")[1] ?? "png";
      const filename = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(ACP_MEDIA_OUT_DIR, filename);
      await fs.writeFile(filePath, Buffer.from(this.imageData.base64, "base64"));
      response.media = { type: "image", url: filePath };
      if (text) response.text = text;
      return response;
    }

    // --- Priority 2: cursor/generate_image path ---
    if (this.generatedImagePath) {
      try {
        await fs.access(this.generatedImagePath);
        response.media = { type: "image", url: this.generatedImagePath };
        log(`using cursor/generate_image path: ${this.generatedImagePath}`);
        if (text) response.text = text;
        return response;
      } catch {
        log(`cursor/generate_image path not accessible: ${this.generatedImagePath}`);
      }
    }

    // --- Priority 3: extract media paths from text ---
    if (text) {
      const candidates = extractMediaPaths(text);
      for (const candidate of candidates) {
        try {
          await fs.access(candidate.path);
          response.media = { type: candidate.type, url: candidate.path };
          text = stripMediaMarkers(text, candidate.path);
          log(`extracted media from text: ${candidate.path} (${candidate.type})`);
          break;
        } catch {
          log(`candidate path not accessible: ${candidate.path}`);
        }
      }
    }

    if (text) {
      response.text = text;
    }

    return response;
  }
}
