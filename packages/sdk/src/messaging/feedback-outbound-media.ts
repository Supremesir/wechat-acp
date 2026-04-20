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

export type ExtractedMedia = {
  filePath: string;
  displayText: string;
};

/**
 * Extract ALL local media references from feedback text.
 * Returns an array of { filePath, displayText } — displayText has all
 * media markers stripped. Returns empty array if none found.
 */
export function extractAllFeedbackMedia(text: string): ExtractedMedia[] {
  const results: ExtractedMedia[] = [];
  const seen = new Set<string>();
  let remaining = text;

  // 1) [WECHAT_IMAGE:path] / VIDEO / FILE (also legacy WEIXIN_ prefix)
  const markerRe = /\[(?:WECHAT|WEIXIN)_(IMAGE|VIDEO|FILE):([^\]]+)\]/g;
  for (const m of text.matchAll(markerRe)) {
    const rawPath = m[2].trim();
    const resolved = toAbsolute(rawPath);
    if (fileExists(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      results.push({ filePath: resolved, displayText: "" });
    }
  }
  remaining = remaining.replace(/\[(?:WECHAT|WEIXIN)_(?:IMAGE|VIDEO|FILE):[^\]]+\]\s*/g, "");

  // 2) Markdown image ![alt](path) — local paths only
  const mdImgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const m of text.matchAll(mdImgRe)) {
    const rawPath = m[1].trim();
    if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) continue;
    const resolved = toAbsolute(rawPath);
    if (fileExists(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      results.push({ filePath: resolved, displayText: "" });
    }
  }
  remaining = remaining.replace(/!\[[^\]]*\]\([^)]+\)\s*/g, "");

  const displayText = remaining.trim();
  for (const r of results) r.displayText = displayText;

  return results;
}

/**
 * Extract the first local media reference from feedback text.
 * Backward-compatible wrapper around extractAllFeedbackMedia.
 */
export function extractFirstFeedbackMedia(text: string): ExtractedMedia | null {
  const all = extractAllFeedbackMedia(text);
  return all.length > 0 ? all[0] : null;
}
