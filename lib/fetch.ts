/**
 * 网页抓取服务：Tavily（extract/search/map）+ Firecrawl（search/scrape）
 * web_fetch 链路：Tavily extract → Firecrawl scrape（带 waitFor 递增重试）
 */
import { config } from "./config.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(
  url: string,
  body: unknown,
  apiKey?: string,
  timeoutMs = 90_000,
  signal?: AbortSignal,
): Promise<Response> {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface FirecrawlResult {
  title?: string;
  url: string;
  description?: string;
}

export async function tavilySearch(
  query: string,
  maxResults = 6,
  signal?: AbortSignal,
): Promise<TavilyResult[] | null> {
  const apiKey = config.tavilyApiKey;
  if (!config.tavilyEnabled || !apiKey) return null;
  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/search`;
  try {
    const res = await postJson(
      endpoint,
      {
        query,
        max_results: maxResults,
        search_depth: "advanced",
        include_raw_content: false,
        include_answer: false,
      },
      apiKey,
      90_000,
      signal,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results ?? [];
    if (results.length === 0) return null;
    return results.map((r) => ({
      title: String(r["title"] ?? ""),
      url: String(r["url"] ?? ""),
      content: String(r["content"] ?? ""),
      score: typeof r["score"] === "number" ? r["score"] : 0,
    }));
  } catch {
    return null;
  }
}

export async function tavilyExtract(url: string, signal?: AbortSignal): Promise<string | null> {
  const apiKey = config.tavilyApiKey;
  if (!config.tavilyEnabled || !apiKey) return null;
  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/extract`;
  try {
    const res = await postJson(
      endpoint,
      { urls: [url], format: "markdown" },
      apiKey,
      60_000,
      signal,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const results = data.results ?? [];
    if (results.length === 0) return null;
    const content = String(results[0]["raw_content"] ?? "");
    return content.trim() ? content : null;
  } catch {
    return null;
  }
}

export async function tavilyMap(
  url: string,
  instructions: string,
  maxDepth: number,
  maxBreadth: number,
  limit: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = config.tavilyApiKey;
  if (!config.tavilyEnabled || !apiKey) {
    return config.tavilyEnabled
      ? "配置错误: TAVILY_API_KEY 未配置，请设置环境变量 TAVILY_API_KEY"
      : "配置错误: Tavily 已禁用（TAVILY_ENABLED=false）";
  }
  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/map`;
  const body: Record<string, unknown> = {
    url,
    max_depth: maxDepth,
    max_breadth: maxBreadth,
    limit,
    timeout,
  };
  if (instructions) body["instructions"] = instructions;
  try {
    const res = await postJson(endpoint, body, apiKey, timeout + 10_000, signal);
    if (!res.ok) {
      return `HTTP错误: ${res.status} - ${(await res.text()).slice(0, 200)}`;
    }
    const data = (await res.json()) as Record<string, unknown>;
    return JSON.stringify(
      {
        base_url: data["base_url"] ?? "",
        results: data["results"] ?? [],
        response_time: data["response_time"] ?? 0,
      },
      null,
      2,
    );
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return `映射超时: 请求超过${timeout}秒`;
    return `映射错误: ${(e as Error).message}`;
  }
}

export async function firecrawlSearch(
  query: string,
  limit = 14,
  signal?: AbortSignal,
): Promise<FirecrawlResult[] | null> {
  const apiKey = config.firecrawlApiKey;
  if (!apiKey) return null;
  const endpoint = `${config.firecrawlApiUrl.replace(/\/+$/, "")}/search`;
  try {
    const res = await postJson(endpoint, { query, limit }, apiKey, 90_000, signal);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { web?: Array<Record<string, unknown>> } };
    const results = data.data?.web ?? [];
    if (results.length === 0) return null;
    return results.map((r) => ({
      title: typeof r["title"] === "string" ? r["title"] : undefined,
      url: String(r["url"] ?? ""),
      description: typeof r["description"] === "string" ? r["description"] : undefined,
    }));
  } catch {
    return null;
  }
}

/** Firecrawl scrape：markdown 为空时按 waitFor 递增重试 */
export async function firecrawlScrape(
  url: string,
  signal?: AbortSignal,
  maxRetries = config.retryMaxAttempts,
): Promise<string | null> {
  const apiKey = config.firecrawlApiKey;
  if (!apiKey) return null;
  const endpoint = `${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const body = {
      url,
      formats: ["markdown"],
      timeout: 60_000,
      waitFor: (attempt + 1) * 1500,
    };
    try {
      const res = await postJson(endpoint, body, apiKey, 90_000, signal);
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { markdown?: string } };
      const markdown = data.data?.markdown ?? "";
      if (markdown.trim()) return markdown;
    } catch {
      return null;
    }
  }
  return null;
}
