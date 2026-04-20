import fs from "node:fs";
import path from "node:path";

function toAbsolute(p: string): string {
  const t = p.trim();
  return path.isAbsolute(t) ? t : path.resolve(t);
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Extract the first local media reference from feedback text (same conventions as
 * wechat-acp ResponseCollector). Returns null if none — caller sends plain text.
 */
export function extractFirstFeedbackMedia(text: string): {
  filePath: string;
  displayText: string;
} | null {
  // 1) [WECHAT_IMAGE:path] / VIDEO / FILE (also legacy WEIXIN_ prefix)
  const marker = /\[(?:WECHAT|WEIXIN)_(IMAGE|VIDEO|FILE):([^\]]+)\]/;
  let m = text.match(marker);
  if (m) {
    const rawPath = m[2].trim();
    const resolved = toAbsolute(rawPath);
    if (fileExists(resolved)) {
      const displayText = text.replace(/\[(?:WECHAT|WEIXIN)_(?:IMAGE|VIDEO|FILE):[^\]]+\]\s*/g, "").trim();
      return { filePath: resolved, displayText };
    }
  }

  // 2) Markdown image ![alt](path) — local paths only
  const mdImg = /!\[[^\]]*\]\(([^)]+)\)/;
  m = text.match(mdImg);
  if (m) {
    const rawPath = m[1].trim();
    if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
      return null;
    }
    const resolved = toAbsolute(rawPath);
    if (fileExists(resolved)) {
      const escaped = rawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const displayText = text
        .replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)\\s*`, "g"), "")
        .trim();
      return { filePath: resolved, displayText };
    }
  }

  return null;
}
