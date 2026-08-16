/**
 * 信源提取与缓存：从 Grok 回答文本中剥离信源（5 种格式），LRU 缓存关联 session_id
 *
 * 提取策略（按优先级）：
 *   1. citation_card() 函数调用（sources/citations/references/citation_card/source_card...）
 *   2. "## Sources / 信源 / 参考资料" 等标题块
 *   3. <details> 折叠块
 *   4. 文尾纯链接块（≥2 行）
 *   5. 行内 [N](url) 引用
 */
import { randomUUID } from "node:crypto";

const MD_LINK_SOURCE = "\\[(\\[?[^\\]]+\\]?)\\]\\((https?:\\/\\/[^)]+)\\)";
const SOURCES_HEADING_SOURCE =
  "^(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(sources?|references?|citations?|信源|参考资料|参考|引用|来源列表|来源)\\s*(?:\\*\\*|__)?(?:\\s*[（(][^)\n]*[)）])?\\s*[:：]?\\s*$";
const SOURCES_FUNCTION_SOURCE =
  "(^|\\n)\\s*(sources|source|citations|citation|references|reference|citation_card|source_cards|source_card)\\s*\\(";
const URL_SOURCE = "https?:\\/\\/[^\\s<>\"'`，。、；：！？》）】\\)]+";

// JS 的 matchAll 要求全局标志，且全局正则实例共享 lastIndex 状态。
// 统一走工厂函数每次创建全新实例，避免跨调用污染。
function mdLinkPattern(): RegExp {
  return new RegExp(MD_LINK_SOURCE, "g");
}
function sourcesHeadingPattern(): RegExp {
  return new RegExp(SOURCES_HEADING_SOURCE, "gim");
}
function sourcesFunctionPattern(): RegExp {
  return new RegExp(SOURCES_FUNCTION_SOURCE, "gim");
}
function urlPattern(): RegExp {
  return new RegExp(URL_SOURCE, "g");
}
function matchAllSafe(pattern: RegExp, text: string): RegExpMatchArray[] {
  return [...text.matchAll(pattern)];
}

export interface SourceItem {
  url: string;
  title?: string;
  description?: string;
  provider?: string;
}

export function newSessionId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** 提取文本中所有唯一 URL（按首次出现顺序） */
export function extractUniqueUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of matchAllSafe(urlPattern(), text)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/** 多来源列表合并去重（按 url） */
export function mergeSources(...lists: Array<SourceItem[] | null | undefined>): SourceItem[] {
  const seen = new Set<string>();
  const merged: SourceItem[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const url = (item?.url ?? "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      merged.push(item);
    }
  }
  return merged;
}

export class SourcesCache {
  private maxSize: number;
  private cache = new Map<string, SourceItem[]>();

  constructor(maxSize = 256) {
    this.maxSize = maxSize;
  }

  async set(sessionId: string, sources: SourceItem[]): Promise<void> {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, sources);
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async get(sessionId: string): Promise<SourceItem[] | null> {
    const sources = this.cache.get(sessionId);
    if (sources === undefined) return null;
    this.cache.delete(sessionId);
    this.cache.set(sessionId, sources); // LRU
    return sources;
  }
}

/** 答案与信源分离：依次尝试 5 种策略，返回 [答案, 信源] */
export function splitAnswerAndSources(text: string): [string, SourceItem[]] {
  const raw = (text ?? "").trim();
  if (!raw) return ["", []];

  const fromFunction = splitFunctionCallSources(raw);
  if (fromFunction) return fromFunction;

  const fromHeading = splitHeadingSources(raw);
  if (fromHeading) return fromHeading;

  const fromDetails = splitDetailsBlockSources(raw);
  if (fromDetails) return fromDetails;

  const fromTail = splitTailLinkBlock(raw);
  if (fromTail) return fromTail;

  const fromInline = splitInlineRefs(raw);
  if (fromInline) return fromInline;

  return [raw, []];
}

/* ---------- 策略 5：行内 [N](url) 引用 ---------- */
function splitInlineRefs(text: string): [string, SourceItem[]] | null {
  const matches = matchAllSafe(mdLinkPattern(), text);
  if (matches.length === 0) return null;
  const sources: SourceItem[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const label = m[1];
    const url = m[2];
    if (!/^\[?\d+\]?$/.test(label)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, provider: "grok-inline" });
  }
  if (sources.length === 0) return null;
  return [text, sources];
}

/* ---------- 策略 1：citation_card() 函数调用 ---------- */
function splitFunctionCallSources(text: string): [string, SourceItem[]] | null {
  const matches = matchAllSafe(sourcesFunctionPattern(), text);
  if (matches.length === 0) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const openParenIdx = m.index! + m[0].length - 1;
    const extracted = extractBalancedCallAtEnd(text, openParenIdx);
    if (!extracted) continue;
    const [closeParenIdx, argsText] = extracted;
    const sources = parseSourcesPayload(argsText);
    if (sources.length === 0) continue;
    const answer = text.slice(0, m.index!).trimEnd();
    return [answer, sources];
  }
  return null;
}

/** 从 "(" 位置开始提取到末尾的平衡括号内容；必须到文本结尾，否则视为无效 */
function extractBalancedCallAtEnd(
  text: string,
  openParenIdx: number,
): [number, string] | null {
  if (openParenIdx < 0 || openParenIdx >= text.length || text[openParenIdx] !== "(") return null;

  let depth = 1;
  let inString: string | null = null;
  let escape = false;

  for (let idx = openParenIdx + 1; idx < text.length; idx++) {
    const ch = text[idx];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        if (text.slice(idx + 1).trim()) return null;
        return [idx, text.slice(openParenIdx + 1, idx)];
      }
    }
  }
  return null;
}

/* ---------- 策略 2：标题块 ---------- */
function splitHeadingSources(text: string): [string, SourceItem[]] | null {
  const matches = matchAllSafe(sourcesHeadingPattern(), text);
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const start = m.index!;
    const sourcesText = text.slice(start);
    const sources = extractSourcesFromText(sourcesText);
    if (sources.length === 0) continue;
    const answer = text.slice(0, start).trimEnd();
    return [answer, sources];
  }
  return null;
}

/* ---------- 策略 3：<details> 折叠块 ---------- */
function splitDetailsBlockSources(text: string): [string, SourceItem[]] | null {
  const lower = text.toLowerCase();
  const closeIdx = lower.lastIndexOf("</details>");
  if (closeIdx === -1) return null;
  const tail = text.slice(closeIdx + "</details>".length).trim();
  if (tail) return null;

  const openIdx = lower.lastIndexOf("<details", closeIdx);
  if (openIdx === -1) return null;

  const blockText = text.slice(openIdx, closeIdx + "</details>".length);
  const sources = extractSourcesFromText(blockText);
  if (sources.length < 2) return null;

  const answer = text.slice(0, openIdx).trimEnd();
  return [answer, sources];
}

/* ---------- 策略 4：文尾纯链接块（≥2 行） ---------- */
function isLinkOnlyLine(line: string): boolean {
  const stripped = line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim();
  if (!stripped) return false;
  if (stripped.startsWith("http://") || stripped.startsWith("https://")) return true;
  return mdLinkPattern().test(stripped);
}

function splitTailLinkBlock(text: string): [string, SourceItem[]] | null {
  const lines = text.split("\n");
  if (lines.length === 0) return null;

  let idx = lines.length - 1;
  while (idx >= 0 && !lines[idx].trim()) idx--;
  if (idx < 0) return null;

  const tailEnd = idx;
  let linkLikeCount = 0;
  while (idx >= 0) {
    const line = lines[idx].trim();
    if (!line) {
      idx--;
      continue;
    }
    if (!isLinkOnlyLine(line)) break;
    linkLikeCount++;
    idx--;
  }

  const tailStart = idx + 1;
  if (linkLikeCount < 2) return null;

  const blockText = lines.slice(tailStart, tailEnd + 1).join("\n");
  const sources = extractSourcesFromText(blockText);
  if (sources.length === 0) return null;

  const answer = lines.slice(0, tailStart).join("\n").trimEnd();
  return [answer, sources];
}

/* ---------- payload 解析 ---------- */
function parseSourcesPayload(payload: string): SourceItem[] {
  const cleaned = payload.trim().replace(/;\s*$/, "");
  if (!cleaned) return [];

  let data: unknown = null;
  try {
    data = JSON.parse(cleaned);
  } catch {
    try {
      // Python literal 兼容（单引号、元组等）
      data = Function(`"use strict"; return (${cleaned});`)();
    } catch {
      data = null;
    }
  }

  if (data === null) return extractSourcesFromText(cleaned);

  if (Array.isArray(data) || typeof data === "object") {
    if (!Array.isArray(data) && data !== null) {
      const obj = data as Record<string, unknown>;
      for (const key of ["sources", "citations", "references", "urls"]) {
        if (key in obj) return normalizeSources(obj[key]);
      }
    }
    return normalizeSources(data);
  }
  return normalizeSources(data);
}

function normalizeSources(data: unknown): SourceItem[] {
  const items: unknown[] = Array.isArray(data) ? data : [data];
  const normalized: SourceItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (typeof item === "string") {
      for (const url of extractUniqueUrls(item)) {
        if (!seen.has(url)) {
          seen.add(url);
          normalized.push({ url });
        }
      }
      continue;
    }

    if (Array.isArray(item) && item.length >= 2) {
      const [title, url] = item as [unknown, unknown];
      if (typeof url === "string" && url.startsWith("http") && !seen.has(url)) {
        seen.add(url);
        const out: SourceItem = { url };
        if (typeof title === "string" && title.trim()) out.title = title.trim();
        normalized.push(out);
      }
      continue;
    }

    if (item !== null && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const url = (obj["url"] ?? obj["href"] ?? obj["link"]) as unknown;
      if (typeof url !== "string" || !url.startsWith("http")) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const out: SourceItem = { url };
      const title = (obj["title"] ?? obj["name"] ?? obj["label"]) as unknown;
      if (typeof title === "string" && title.trim()) out.title = title.trim();
      const desc = (obj["description"] ?? obj["snippet"] ?? obj["content"]) as unknown;
      if (typeof desc === "string" && desc.trim()) out.description = desc.trim();
      normalized.push(out);
    }
  }
  return normalized;
}

/** 从纯文本中提取信源（markdown 链接 + 裸 URL） */
function extractSourcesFromText(text: string): SourceItem[] {
  const sources: SourceItem[] = [];
  const seen = new Set<string>();

  for (const m of matchAllSafe(mdLinkPattern(), text)) {
    const url = (m[2] ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let title = (m[1] ?? "").trim();
    // 兼容 [[1]] / [1] 数字引用标签，去掉外层方括号
    if (/^\[?\d+\]?$/.test(title)) title = title.replace(/^\[|\]$/g, "");
    if (title) sources.push({ title, url });
    else sources.push({ url });
  }

  for (const url of extractUniqueUrls(text)) {
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({ url });
  }

  return sources;
}
