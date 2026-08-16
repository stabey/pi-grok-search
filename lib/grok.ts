/**
 * Grok API 调用核心：chat/responses 双模式流式调用 + 指数退避重试
 *
 * - chat 模式：POST /chat/completions，SSE 解析 choices[].delta.content
 * - responses 模式：POST /responses，SSE 解析 response.output_text.delta
 * - 重试：408/429/500/502/503/504 + 网络错误；429 优先读 Retry-After 头
 * - 查询含时间词时自动注入本地时间上下文
 */
import { config } from "./config.ts";
import { SEARCH_PROMPT, FETCH_PROMPT } from "./prompts.ts";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export interface XSearchOpts {
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}

export function getLocalTimeInfo(): string {
  const now = new Date();
  const weekdaysCn = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
  const weekday = weekdaysCn[now.getDay()];
  const tzName = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Local";
    } catch {
      return "Local";
    }
  })();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `[Current Time Context]\n` +
    `- Date: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${weekday})\n` +
    `- Time: ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}\n` +
    `- Timezone: ${tzName}\n`
  );
}

const CN_TIME_KEYWORDS = [
  "当前", "现在", "今天", "明天", "昨天",
  "本周", "上周", "下周", "这周",
  "本月", "上月", "下月", "这个月",
  "今年", "去年", "明年",
  "最新", "最近", "近期", "刚刚", "刚才",
  "实时", "即时", "目前",
];

const EN_TIME_KEYWORDS = [
  "current", "now", "today", "tomorrow", "yesterday",
  "this week", "last week", "next week",
  "this month", "last month", "next month",
  "this year", "last year", "next year",
  "latest", "recent", "recently", "just now",
  "real-time", "realtime", "up-to-date",
];

export function needsTimeContext(query: string): boolean {
  const lower = query.toLowerCase();
  return CN_TIME_KEYWORDS.some((k) => query.includes(k)) || EN_TIME_KEYWORDS.some((k) => lower.includes(k));
}

export function isRetryableHttp(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  // Node fetch 网络错误通常是 TypeError("fetch failed") / AggregateError
  if (err instanceof TypeError) return true;
  if (err instanceof AggregateError) return true;
  return false;
}

/** 429 读 Retry-After 头（秒数或 HTTP 日期），否则按指数退避 */
function waitMs(res: Response | null, attempt: number, multiplier: number, maxWait: number): number {
  if (res && res.status === 429) {
    const header = res.headers.get("retry-after");
    if (header) {
      const seconds = parseInt(header, 10);
      if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, maxWait * 1000);
      const dt = Date.parse(header);
      if (!Number.isNaN(dt)) return Math.min(Math.max(0, dt - Date.now()), maxWait * 1000);
    }
  }
  const base = multiplier * Math.pow(2, attempt);
  return Math.min(base * 1000, maxWait * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 消费 SSE 流，逐 data: 行回调解析后的 JSON。空闲超时（无数据 120s）而非总时长限制 */
export async function consumeSSE(
  res: Response,
  onData: (data: Record<string, unknown>) => void,
  signal?: AbortSignal,
  idleMs = 120_000,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const readWithIdle = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (idleTimer) clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      idleTimer = setTimeout(() => {
        reject(new Error("Grok 流式读取超时（120s 无数据）"));
      }, idleMs);
      reader.read().then(
        (v) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          resolve(v);
        },
        (e) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          reject(e);
        },
      );
    });
  };

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await readWithIdle();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith("event:")) continue;
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            onData(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            // 跳过无法解析的行
          }
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await reader.cancel();
    } catch {
      // 忽略
    }
  }
}

/** 解析 chat/completions SSE 流（兼容 "data: {...}" 与 "data:{...}"） */
export async function parseChatStream(res: Response, signal?: AbortSignal): Promise<string> {
  let content = "";
  const rawLines: string[] = [];
  await consumeSSE(
    res,
    (data) => {
      rawLines.push(JSON.stringify(data));
      const choices = data["choices"];
      if (Array.isArray(choices) && choices.length > 0) {
        const choice = choices[0] as Record<string, unknown>;
        const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
        if (typeof delta["content"] === "string") content += delta["content"];
      }
    },
    signal,
  );
  if (content) return content;
  // 兜底：非流式单 JSON 响应
  try {
    const full = rawLines.join("");
    const data = JSON.parse(full) as Record<string, unknown>;
    const choices = data["choices"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = choices[0]["message"] as Record<string, unknown> | undefined;
      if (typeof msg?.["content"] === "string") return msg["content"];
    }
  } catch {
    // 忽略
  }
  return "";
}

/** 从 Responses API 完整响应体中提取文本（兼容 output[] 与 choices[]） */
function extractResponsesText(data: Record<string, unknown>): string {
  let text = "";
  const output = data["output"];
  if (Array.isArray(output)) {
    for (const item of output as Array<Record<string, unknown>>) {
      if (item["type"] !== "message") continue;
      const parts = item["content"];
      if (Array.isArray(parts)) {
        for (const part of parts as Array<Record<string, unknown>>) {
          if (part["type"] === "output_text" && typeof part["text"] === "string") {
            text += part["text"];
          }
        }
      }
    }
  }
  if (text) return text;
  const choices = data["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices as Array<Record<string, unknown>>) {
      const msg = choice["message"] as Record<string, unknown> | undefined;
      if (typeof msg?.["content"] === "string") text += msg["content"];
    }
  }
  return text;
}

/** 解析 Responses API SSE 流 */
export async function parseResponsesStream(res: Response, signal?: AbortSignal): Promise<string> {
  let content = "";
  const rawLines: string[] = [];
  await consumeSSE(
    res,
    (data) => {
      rawLines.push(JSON.stringify(data));
      const type = data["type"];
      if (type === "response.output_text.delta" && typeof data["delta"] === "string") {
        content += data["delta"];
      } else if (type === "response.output_text.done") {
        if (!content && typeof data["text"] === "string") content = data["text"];
      } else if (type === "response.completed" || type === "response.done") {
        if (!content) {
          const resp = data["response"] as Record<string, unknown> | undefined;
          if (resp) content = extractResponsesText(resp);
        }
      }
    },
    signal,
  );
  if (content) return content;
  // 兜底：非流式响应
  try {
    const joined = rawLines
      .map((l) => {
        try {
          const obj = JSON.parse(l) as Record<string, unknown>;
          return JSON.stringify(obj);
        } catch {
          return l;
        }
      })
      .join("");
    const data = JSON.parse(joined) as Record<string, unknown>;
    content = extractResponsesText(data);
  } catch {
    // 忽略
  }
  return content;
}

export class GrokProvider {
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private apiMode: string;
  private reasoningEffort: string;

  constructor(
    apiUrl: string,
    apiKey: string,
    model: string,
    apiMode: string,
    reasoningEffort = "",
  ) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.model = model;
    this.apiMode = apiMode;
    this.reasoningEffort = reasoningEffort;
  }

  private buildPayload(
    system: string,
    user: string,
    tools?: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    if (this.apiMode === "responses") {
      const payload: Record<string, unknown> = {
        model: this.model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: true,
        store: false,
      };
      if (tools?.length) payload["tools"] = tools;
      if (this.reasoningEffort && REASONING_EFFORTS.has(this.reasoningEffort)) {
        payload["reasoning"] = { effort: this.reasoningEffort };
      }
      return payload;
    }
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
    };
    if (tools?.length) payload["tools"] = tools;
    return payload;
  }

  private getSearchTools(platform = "", xSearchOpts?: XSearchOpts): Array<Record<string, unknown>> {
    const tools: Array<Record<string, unknown>> = [{ type: "web_search" }];
    const needX =
      !!xSearchOpts ||
      (platform && ["twitter", "x", "x.com"].includes(platform.trim().toLowerCase()));
    if (needX) {
      const xTool: Record<string, unknown> = { type: "x_search" };
      if (xSearchOpts) {
        for (const key of [
          "allowed_x_handles",
          "excluded_x_handles",
          "from_date",
          "to_date",
          "enable_image_understanding",
          "enable_video_understanding",
        ] as const) {
          const v = xSearchOpts[key];
          if (v !== undefined && v !== null) xTool[key] = v;
        }
      }
      tools.push(xTool);
    }
    return tools;
  }

  async search(
    query: string,
    platform = "",
    xSearchOpts?: XSearchOpts,
    signal?: AbortSignal,
  ): Promise<string> {
    const platformPrompt = platform
      ? `\n\nYou should search the web for the information you need, and focus on these platform: ${platform}\n`
      : "";
    const userContent = `${getLocalTimeInfo()}\n${query}${platformPrompt}`;
    const payload = this.buildPayload(
      SEARCH_PROMPT,
      userContent,
      this.getSearchTools(platform, xSearchOpts),
    );
    return this.executeWithRetry(payload, signal);
  }

  async fetch(url: string, signal?: AbortSignal): Promise<string> {
    const payload = this.buildPayload(FETCH_PROMPT, `${url}\n获取该网页内容并返回其结构化Markdown格式`);
    return this.executeWithRetry(payload, signal);
  }

  /** 带重试的流式请求；read 超时 120s，连接失败快速重试 */
  private async executeWithRetry(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const endpoint = this.apiMode === "responses" ? "/responses" : "/chat/completions";
    const url = `${this.apiUrl.replace(/\/+$/, "")}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    const maxAttempts = config.retryMaxAttempts + 1;
    const abortSignals: AbortSignal[] = [];
    // 注意：这里不能对总时长设硬限制（multi-agent 深度搜索可能 >120s），
    // 空闲超时由 consumeSSE 内部处理；连接卡死由 fetch 底层超时兜底。
    if (signal) abortSignals.push(signal);
    const requestSignal = abortSignals.length > 0 ? AbortSignal.any(abortSignals) : undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response | undefined;
      let err: unknown;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: requestSignal,
        });
      } catch (e) {
        err = e;
      }

      if (err) {
        if (attempt < maxAttempts - 1 && isRetryableError(err)) {
          await sleep(waitMs(null, attempt, config.retryMultiplier, config.retryMaxWait));
          continue;
        }
        throw err instanceof Error ? err : new Error(String(err));
      }

      if (!res!.ok) {
        if (attempt < maxAttempts - 1 && isRetryableHttp(res!.status)) {
          await sleep(waitMs(res!, attempt, config.retryMultiplier, config.retryMaxWait));
          continue;
        }
        const body = await res!.text().catch(() => "");
        throw new Error(`Grok API HTTP ${res!.status}: ${body.slice(0, 500)}`);
      }

      if (this.apiMode === "responses") {
        return parseResponsesStream(res!, signal);
      }
      return parseChatStream(res!, signal);
    }
    throw new Error("Grok API 请求失败（重试次数耗尽）");
  }
}
