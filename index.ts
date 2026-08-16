/**
 * grok-search for pi — 让 pi 通过 Grok 获得深度联网搜索能力
 *
 * 功能与 MCP 版 grok-search (guda.studio) 对齐：
 *   web_search / x_search / get_sources / web_fetch / web_map
 *   get_config_info / switch_model / plan_*（搜索规划六阶段）
 *
 * 核心链路：Grok API（本地 grok2api 代理，OpenAI 兼容）注入 web_search 工具 →
 *           Grok 自主多次搜索并带 citation_card 作答 → 从回答中剥离信源缓存。
 * 配置：环境变量 > ~/.config/grok-search/env（与 MCP 版共用同一份配置）
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { config, CONFIG_JSON } from "./lib/config.ts";
import { GrokProvider, type XSearchOpts } from "./lib/grok.ts";
import {
  SourcesCache,
  mergeSources,
  newSessionId,
  splitAnswerAndSources,
  type SourceItem,
} from "./lib/sources.ts";
import {
  firecrawlSearch,
  firecrawlScrape,
  tavilyExtract,
  tavilyMap,
  tavilySearch,
} from "./lib/fetch.ts";
import { engine as planningEngine, splitCsv } from "./lib/planning.ts";

const SOURCES_CACHE = new SourcesCache(256);
const MODELS_CACHE = new Map<string, string[]>();
const MODELS_CACHE_TTL = 5 * 60 * 1000;
const MODELS_CACHE_TS = new Map<string, number>();

async function fetchAvailableModels(
  apiUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const key = `${apiUrl}|${apiKey}`;
  const now = Date.now();
  const ts = MODELS_CACHE_TS.get(key);
  if (ts && now - ts < MODELS_CACHE_TTL) {
    const cached = MODELS_CACHE.get(key);
    if (cached) return cached;
  }
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    MODELS_CACHE.set(key, models);
    MODELS_CACHE_TS.set(key, now);
    return models;
  } catch {
    return [];
  }
}

function extraSourcesToSourceItems(
  tavilyResults: Array<{ title: string; url: string; content: string }> | null,
  firecrawlResults: Array<{ title?: string; url: string; description?: string }> | null,
): SourceItem[] {
  const sources: SourceItem[] = [];
  const seen = new Set<string>();

  for (const r of firecrawlResults ?? []) {
    const url = (r.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const item: SourceItem = { url, provider: "firecrawl" };
    if (r.title?.trim()) item.title = r.title.trim();
    if (r.description?.trim()) item.description = r.description.trim();
    sources.push(item);
  }

  for (const r of tavilyResults ?? []) {
    const url = (r.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const item: SourceItem = { url, provider: "tavily" };
    if (r.title?.trim()) item.title = r.title.trim();
    if (r.content?.trim()) item.description = r.content.trim();
    sources.push(item);
  }

  return sources;
}

/** 内容截断（50KB / 2000 行），防止撑爆 LLM 上下文 */
function truncate(text: string): string {
  const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  return (
    t.content +
    `\n\n[输出已截断：${t.outputLines}/${t.totalLines} 行，${Math.round(t.outputBytes / 1024)}/${Math.round(t.totalBytes / 1024)} KB，完整内容保存在 details]`
  );
}

export default function grokSearchExtension(pi: ExtensionAPI) {
  /* ================= web_search ================= */
  pi.registerTool({
    name: "web_search",
    label: "Web Search (Grok)",
    description: `基于 Grok 的深度联网搜索。使用前建议先用 plan_intent 规划搜索。返回：
- session_id: 对内容感到困惑或想追根溯源时，用该 ID 调用 get_sources 获取信源列表
- content: 答案正文（Grok 已多轮搜索并附带引用）
- sources_count: 信源数量
支持平台聚焦（platform，如 Twitter/GitHub/Reddit）与 Tavily/Firecrawl 额外信源（extra_sources）。`,
    promptSnippet: "深度联网搜索（Grok 驱动，含信源追踪）",
    promptGuidelines: [
      "Use web_search when the user asks questions about current events, real-time data, or topics beyond training knowledge.",
      "Use get_sources with the returned session_id when source verification of a web_search answer is needed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "清晰、自包含的自然语言搜索查询" }),
      platform: Type.Optional(
        Type.String({
          description: "聚焦的目标平台（如 'Twitter'、'GitHub'、'Reddit'），通用搜索留空",
        }),
      ),
      model: Type.Optional(
        Type.String({ description: "仅当用户明确指定时使用的模型 ID，否则留空" }),
      ),
      extra_sources: Type.Optional(
        Type.Number({
          description: "额外信源数量（Tavily/Firecrawl），0 表示禁用，默认 0",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const sessionId = newSessionId();
      let apiUrl: string;
      let apiKey: string;
      try {
        apiUrl = config.grokApiUrl;
        apiKey = config.grokApiKey;
      } catch (e) {
        return {
          content: [{ type: "text", text: `配置错误: ${(e as Error).message}` }],
          details: { session_id: sessionId, sources_count: 0 },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: "🤖 Grok 搜索中…" }], details: {} });

      let effectiveModel = config.grokModel;
      if (params.model) {
        const available = await fetchAvailableModels(apiUrl, apiKey, signal);
        if (available.length > 0 && !available.includes(params.model)) {
          return {
            content: [{ type: "text", text: `无效模型: ${params.model}（可用模型见 get_config_info）` }],
            details: { session_id: sessionId, sources_count: 0 },
          };
        }
        effectiveModel = params.model;
      }

      const provider = new GrokProvider(
        apiUrl,
        apiKey,
        effectiveModel,
        config.grokApiMode,
        config.grokReasoningEffort,
      );

      // 额外信源配额（与 MCP 版一致：两者都有时优先 Firecrawl）
      const hasTavily = !!config.tavilyApiKey;
      const hasFirecrawl = !!config.firecrawlApiKey;
      const extra = Math.max(0, Math.floor(params.extra_sources ?? 0));
      let firecrawlCount = 0;
      let tavilyCount = 0;
      if (extra > 0) {
        if (hasFirecrawl && hasTavily) firecrawlCount = extra;
        else if (hasFirecrawl) firecrawlCount = extra;
        else if (hasTavily) tavilyCount = extra;
      }

      const tasks: Promise<unknown>[] = [
        provider.search(params.query, params.platform ?? "", undefined, signal).catch(() => ""),
      ];
      if (tavilyCount > 0) tasks.push(tavilySearch(params.query, tavilyCount, signal).catch(() => null));
      if (firecrawlCount > 0) tasks.push(firecrawlSearch(params.query, firecrawlCount, signal).catch(() => null));

      const gathered = await Promise.all(tasks);
      const grokResult = gathered[0] as string;
      const tavilyResults =
        tavilyCount > 0 ? ((gathered[1] as Array<Record<string, unknown>> | null) ?? null) : null;
      const firecrawlResults =
        firecrawlCount > 0
          ? ((gathered[tavilyCount > 0 ? 2 : 1] as Array<Record<string, unknown>> | null) ?? null)
          : null;

      const [answer, grokSources] = splitAnswerAndSources(grokResult);
      const extraItems = extraSourcesToSourceItems(
        tavilyResults as Array<{ title: string; url: string; content: string }> | null,
        firecrawlResults as Array<{ title?: string; url: string; description?: string }> | null,
      );
      const allSources = mergeSources(grokSources, extraItems);
      await SOURCES_CACHE.set(sessionId, allSources);

      const content =
        answer ||
        (grokResult
          ? grokResult.slice(0, 500) + "\n\n（未能从回答中解析出正文）"
          : "搜索失败：Grok API 无返回（检查 get_config_info 的连通性测试）");

      return {
        content: [{ type: "text", text: truncate(content) }],
        details: {
          session_id: sessionId,
          sources_count: allSources.length,
          model: effectiveModel,
          full_content: content.length > 200_000 ? content.slice(0, 200_000) : content,
        },
      };
    },
  });

  /* ================= x_search ================= */
  pi.registerTool({
    name: "x_search",
    label: "X Search (Grok)",
    description: `搜索 X（Twitter）帖子（xAI x_search 工具，需 GROK_API_MODE=responses）。适用场景：
- 搜索大众对某个话题的讨论
- 指定账号的最新帖子（如 "@elonmusk 关于 AI 的最新帖子"）
- 限定日期范围搜索
返回结构与 web_search 相同（session_id / content / sources_count）。`,
    parameters: Type.Object({
      query: Type.String({ description: "X/Twitter 帖子的自然语言搜索查询" }),
      x_handles: Type.Optional(
        Type.String({ description: "限定账号，逗号分隔最多 10 个，不带 @（如 'elonmusk,xai'）" }),
      ),
      excluded_x_handles: Type.Optional(
        Type.String({ description: "排除账号，逗号分隔最多 10 个，不带 @" }),
      ),
      from_date: Type.Optional(
        Type.String({ description: "起始日期 ISO8601（如 '2026-03-01T00:00:00Z'）" }),
      ),
      to_date: Type.Optional(
        Type.String({ description: "结束日期 ISO8601（如 '2026-03-20T00:00:00Z'）" }),
      ),
      image_understanding: Type.Optional(Type.Boolean({ description: "分析帖子中的图片" })),
      video_understanding: Type.Optional(Type.Boolean({ description: "分析帖子中的视频" })),
      model: Type.Optional(Type.String({ description: "仅当用户明确指定时使用的模型 ID" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const sessionId = newSessionId();

      if (config.grokApiMode !== "responses") {
        return {
          content: [{ type: "text", text: "x_search 仅在 GROK_API_MODE=responses 时可用" }],
          details: { session_id: sessionId, sources_count: 0 },
        };
      }

      let apiUrl: string;
      let apiKey: string;
      try {
        apiUrl = config.grokApiUrl;
        apiKey = config.grokApiKey;
      } catch (e) {
        return {
          content: [{ type: "text", text: `配置错误: ${(e as Error).message}` }],
          details: { session_id: sessionId, sources_count: 0 },
        };
      }

      onUpdate?.({ content: [{ type: "text", text: "🔎 X 搜索中…" }], details: {} });

      let effectiveModel = config.grokModel;
      if (params.model) {
        const available = await fetchAvailableModels(apiUrl, apiKey, signal);
        if (available.length > 0 && !available.includes(params.model)) {
          return {
            content: [{ type: "text", text: `无效模型: ${params.model}` }],
            details: { session_id: sessionId, sources_count: 0 },
          };
        }
        effectiveModel = params.model;
      }

      const xOpts: XSearchOpts = {};
      if (params.x_handles) {
        xOpts.allowed_x_handles = params.x_handles
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
          .slice(0, 10);
      }
      if (params.excluded_x_handles) {
        xOpts.excluded_x_handles = params.excluded_x_handles
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
          .slice(0, 10);
      }
      if (params.from_date) xOpts.from_date = params.from_date;
      if (params.to_date) xOpts.to_date = params.to_date;
      if (params.image_understanding) xOpts.enable_image_understanding = true;
      if (params.video_understanding) xOpts.enable_video_understanding = true;

      const provider = new GrokProvider(
        apiUrl,
        apiKey,
        effectiveModel,
        config.grokApiMode,
        config.grokReasoningEffort,
      );
      const result = await provider
        .search(params.query, "X", Object.keys(xOpts).length > 0 ? xOpts : undefined, signal)
        .catch(() => "");

      const [answer, grokSources] = splitAnswerAndSources(result);
      await SOURCES_CACHE.set(sessionId, grokSources);
      return {
        content: [
          { type: "text", text: truncate(answer || result || "搜索失败：Grok API 无返回") },
        ],
        details: { session_id: sessionId, sources_count: grokSources.length },
      };
    },
  });

  /* ================= get_sources ================= */
  pi.registerTool({
    name: "get_sources",
    label: "Get Sources",
    description: `通过 web_search / x_search 返回的 session_id 获取对应搜索的信源列表。
对搜索回答中的内容感到困惑或想追根溯源时使用。`,
    parameters: Type.Object({
      session_id: Type.String({ description: "web_search / x_search 返回的 session_id" }),
    }),
    async execute(_toolCallId, params) {
      const sources = await SOURCES_CACHE.get(params.session_id);
      if (sources === null) {
        return {
          content: [
            {
              type: "text",
              text: `session_id "${params.session_id}" 未找到或已过期（缓存上限 256 条，超出后最早条目被淘汰）`,
            },
          ],
          details: { sources: [], sources_count: 0 },
        };
      }
      const lines = sources.map(
        (s, i) =>
          `${i + 1}. ${s.title ? `**${s.title}** ` : ""}${s.url}${s.provider ? ` (${s.provider})` : ""}`,
      );
      return {
        content: [
          {
            type: "text",
            text: lines.length > 0 ? lines.join("\n") : "该搜索没有提取到信源",
          },
        ],
        details: { sources, sources_count: sources.length },
      };
    },
  });

  /* ================= web_fetch ================= */
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `抓取指定 URL 的完整内容并转为结构化 Markdown（100% 保真，不摘要不改写）。
链路：Tavily extract → 失败降级 Firecrawl scrape（带 waitFor 重试）。
注意：需要 TAVILY_API_KEY 或 FIRECRAWL_API_KEY 之一；无法抓取需要登录/JS 渲染的内容。`,
    promptSnippet: "抓取网页为 Markdown（Tavily/Firecrawl）",
    parameters: Type.Object({
      url: Type.String({ description: "有效的 HTTP/HTTPS 网页地址" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "📥 抓取中…" }], details: {} });
      const url = params.url.trim();

      const tavilyResult = await tavilyExtract(url, signal);
      if (tavilyResult) {
        return { content: [{ type: "text", text: truncate(tavilyResult) }], details: { via: "tavily" } };
      }

      const firecrawlResult = await firecrawlScrape(url, signal);
      if (firecrawlResult) {
        return { content: [{ type: "text", text: truncate(firecrawlResult) }], details: { via: "firecrawl" } };
      }

      if (!config.tavilyApiKey && !config.firecrawlApiKey) {
        return {
          content: [{ type: "text", text: "配置错误: TAVILY_API_KEY 和 FIRECRAWL_API_KEY 均未配置" }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: "提取失败: 所有提取服务均未能获取内容" }],
        details: {},
      };
    },
  });

  /* ================= web_map ================= */
  pi.registerTool({
    name: "web_map",
    label: "Web Map",
    description: `以图遍历方式爬取网站结构，生成站点地图（URL 清单）。可用自然语言指令聚焦特定内容。
建议先以低 max_depth (1-2) 探索，再按需加深。需要 TAVILY_API_KEY。`,
    parameters: Type.Object({
      url: Type.String({ description: "起始根 URL（如 https://docs.example.com）" }),
      instructions: Type.Optional(
        Type.String({ description: "自然语言爬取指令（如 '只抓文档页面'）" }),
      ),
      max_depth: Type.Optional(Type.Number({ description: "最大爬取深度 1-5，默认 1" })),
      max_breadth: Type.Optional(Type.Number({ description: "每页最多跟随链接数 1-500，默认 20" })),
      limit: Type.Optional(Type.Number({ description: "处理链接总数上限 1-500，默认 50" })),
      timeout: Type.Optional(Type.Number({ description: "操作超时秒数 10-150，默认 150" })),
    }),
    async execute(_toolCallId, params, signal) {
      const depth = Math.min(5, Math.max(1, Math.floor(params.max_depth ?? 1)));
      const breadth = Math.min(500, Math.max(1, Math.floor(params.max_breadth ?? 20)));
      const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 50)));
      const timeout = Math.min(150, Math.max(10, Math.floor(params.timeout ?? 150)));
      const result = await tavilyMap(
        params.url,
        params.instructions ?? "",
        depth,
        breadth,
        limit,
        timeout,
        signal,
      );
      return { content: [{ type: "text", text: truncate(result) }], details: {} };
    },
  });

  /* ================= get_config_info ================= */
  pi.registerTool({
    name: "get_config_info",
    label: "Get Config Info",
    description: `查看 grok-search 当前配置（API Key 已脱敏）并测试 Grok API 连通性（GET /models）。
排查连接/配置问题时优先使用。`,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const info = config.getConfigInfo() as Record<string, unknown>;
      const testResult: Record<string, unknown> = {
        status: "未测试",
        message: "",
        response_time_ms: 0,
      };
      try {
        const apiUrl = config.grokApiUrl;
        const apiKey = config.grokApiKey;
        const start = Date.now();
        const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        });
        const elapsed = Date.now() - start;
        if (res.ok) {
          testResult["status"] = "✅ 连接成功";
          testResult["message"] = `HTTP ${res.status}`;
          testResult["response_time_ms"] = elapsed;
          try {
            const data = (await res.json()) as { data?: Array<{ id?: string }> };
            const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
            testResult["message"] += `，共 ${models.length} 个模型`;
            testResult["available_models"] = models;
          } catch {
            // 忽略解析失败
          }
        } else {
          testResult["status"] = "⚠️ 连接异常";
          testResult["message"] = `HTTP ${res.status}`;
          testResult["response_time_ms"] = elapsed;
        }
      } catch (e) {
        const err = e as Error;
        if (err.name === "TimeoutError") {
          testResult["status"] = "❌ 连接超时";
          testResult["message"] = "请求超时（10 秒），请检查网络或 API URL";
        } else {
          testResult["status"] = "❌ 连接失败";
          testResult["message"] = err.message;
        }
      }
      info["connection_test"] = testResult;
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(info, null, 2)) }],
        details: { config: info },
      };
    },
  });

  /* ================= switch_model ================= */
  pi.registerTool({
    name: "switch_model",
    label: "Switch Model",
    description: `切换 grok-search 默认模型并持久化（写入 ~/.config/grok-search/config.json，与 MCP 版共享）。
切换前可用 get_config_info 查看可用模型。`,
    parameters: Type.Object({
      model: Type.String({ description: "目标模型 ID（如 'grok-4-fast'、'grok-2-latest'）" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const previous = config.grokModel;
        const current = config.setModel(params.model);
        return {
          content: [
            {
              type: "text",
              text: `✅ 模型已从 ${previous} 切换到 ${current}\n配置文件: ${CONFIG_JSON}`,
            },
          ],
          details: { previous_model: previous, current_model: current, error: "" },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ 切换模型失败: ${(e as Error).message}` }],
          details: { previous_model: "", current_model: "", error: (e as Error).message },
        };
      }
    },
  });

  /* ================= 规划六阶段 ================= */
  const planCommonParams = {
    thought: Type.String({ description: "本阶段的推理过程" }),
    session_id: Type.String({ description: "plan_intent 返回的 session_id" }),
    confidence: Type.Optional(Type.Number({ description: "置信度 0.0-1.0" })),
    is_revision: Type.Optional(Type.Boolean({ description: "True 覆盖已有阶段数据" })),
  };

  pi.registerTool({
    name: "plan_intent",
    label: "Plan Intent",
    description: `搜索规划阶段 1/6：分析用户意图。任何复杂搜索都先调用此工具创建 session。
流程：plan_intent → plan_complexity → plan_sub_query(×N) → plan_search_term(×N) → plan_tool_mapping(×N) → plan_execution。
复杂度要求：Level 1 = 阶段 1-3；Level 2 = 阶段 1-5；Level 3 = 全部 6 阶段。`,
    parameters: Type.Object({
      thought: Type.String({ description: "本阶段推理" }),
      core_question: Type.String({ description: "提炼成一句话的核心问题" }),
      query_type: StringEnum(["factual", "comparative", "exploratory", "analytical"] as const),
      time_sensitivity: StringEnum(["realtime", "recent", "historical", "irrelevant"] as const),
      session_id: Type.Optional(Type.String({ description: "留空创建新 session，或传入已有 ID 修订" })),
      confidence: Type.Optional(Type.Number({ description: "置信度 0.0-1.0" })),
      domain: Type.Optional(Type.String({ description: "可识别的具体领域" })),
      premise_valid: Type.Optional(Type.Boolean({ description: "问题前提有缺陷时为 False" })),
      ambiguities: Type.Optional(Type.String({ description: "逗号分隔的未解决歧义" })),
      unverified_terms: Type.Optional(
        Type.String({ description: "逗号分隔的需要外部核实的名词（如 CCF-A、OWASP Top 10）" }),
      ),
      is_revision: Type.Optional(Type.Boolean({ description: "True 覆盖已有 intent" })),
    }),
    async execute(_toolCallId, params) {
      const data: Record<string, unknown> = {
        core_question: params.core_question,
        query_type: params.query_type,
        time_sensitivity: params.time_sensitivity,
      };
      if (params.domain) data["domain"] = params.domain;
      if (params.premise_valid !== undefined) data["premise_valid"] = params.premise_valid;
      if (params.ambiguities) data["ambiguities"] = splitCsv(params.ambiguities);
      if (params.unverified_terms) data["unverified_terms"] = splitCsv(params.unverified_terms);

      const sessionId = params.session_id || "";
      const result = planningEngine.processPhase({
        phase: "intent_analysis",
        thought: params.thought,
        sessionId,
        isRevision: !!params.is_revision,
        confidence: params.confidence,
        phaseData: data,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  const requireSession = (sessionId: string): string | null =>
    planningEngine.getSession(sessionId) ? null : `Session '${sessionId}' not found. Call plan_intent first.`;

  pi.registerTool({
    name: "plan_complexity",
    label: "Plan Complexity",
    description: "搜索规划阶段 2/6：评估复杂度（1-3），决定后续所需阶段。",
    parameters: Type.Object({
      ...planCommonParams,
      level: Type.Number({ description: "复杂度 1-3" }),
      estimated_sub_queries: Type.Number({ description: "预计子查询数量" }),
      estimated_tool_calls: Type.Number({ description: "预计工具调用总数" }),
      justification: Type.String({ description: "选择该复杂度的理由" }),
    }),
    async execute(_toolCallId, params) {
      const missing = requireSession(params.session_id);
      if (missing) return { content: [{ type: "text", text: JSON.stringify({ error: missing }) }], details: {} };
      const result = planningEngine.processPhase({
        phase: "complexity_assessment",
        thought: params.thought,
        sessionId: params.session_id,
        isRevision: !!params.is_revision,
        confidence: params.confidence,
        phaseData: {
          level: params.level,
          estimated_sub_queries: params.estimated_sub_queries,
          estimated_tool_calls: params.estimated_tool_calls,
          justification: params.justification,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "plan_sub_query",
    label: "Plan Sub-Query",
    description: "搜索规划阶段 3/6：添加一个子查询。每个子查询调用一次；is_revision=true 覆盖全部。",
    parameters: Type.Object({
      ...planCommonParams,
      id: Type.String({ description: "唯一 ID（如 'sq1'）" }),
      goal: Type.String({ description: "子查询目标" }),
      expected_output: Type.String({ description: "成功的样子" }),
      boundary: Type.String({ description: "排除什么——与兄弟子查询互斥" }),
      depends_on: Type.Optional(Type.String({ description: "逗号分隔的前置 ID 列表" })),
      tool_hint: Type.Optional(Type.String({ description: "建议工具：web_search | web_fetch | web_map" })),
    }),
    async execute(_toolCallId, params) {
      const missing = requireSession(params.session_id);
      if (missing) return { content: [{ type: "text", text: JSON.stringify({ error: missing }) }], details: {} };
      const item: Record<string, unknown> = {
        id: params.id,
        goal: params.goal,
        expected_output: params.expected_output,
        boundary: params.boundary,
      };
      if (params.depends_on) item["depends_on"] = splitCsv(params.depends_on);
      if (params.tool_hint) item["tool_hint"] = params.tool_hint;
      const result = planningEngine.processPhase({
        phase: "query_decomposition",
        thought: params.thought,
        sessionId: params.session_id,
        isRevision: !!params.is_revision,
        confidence: params.confidence,
        phaseData: item,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "plan_search_term",
    label: "Plan Search Term",
    description: "搜索规划阶段 4/6：添加一个搜索词（≤8 词）。每个搜索词调用一次；首次调用必须设置 approach。",
    parameters: Type.Object({
      ...planCommonParams,
      term: Type.String({ description: "搜索查询（最多 8 个词）" }),
      purpose: Type.String({ description: "服务的子查询 ID（如 'sq1'）" }),
      round: Type.Number({ description: "执行轮次：1=宽泛，2+=定向跟进" }),
      approach: Type.Optional(
        Type.String({ description: "broad_first | narrow_first | targeted（首次调用必填）" }),
      ),
      fallback_plan: Type.Optional(Type.String({ description: "主搜索失败时的后备方案" })),
    }),
    async execute(_toolCallId, params) {
      const missing = requireSession(params.session_id);
      if (missing) return { content: [{ type: "text", text: JSON.stringify({ error: missing }) }], details: {} };
      const data: Record<string, unknown> = {
        search_terms: [{ term: params.term, purpose: params.purpose, round: params.round }],
      };
      if (params.approach) data["approach"] = params.approach;
      if (params.fallback_plan) data["fallback_plan"] = params.fallback_plan;
      const result = planningEngine.processPhase({
        phase: "search_strategy",
        thought: params.thought,
        sessionId: params.session_id,
        isRevision: !!params.is_revision,
        confidence: params.confidence,
        phaseData: data,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "plan_tool_mapping",
    label: "Plan Tool Mapping",
    description: "搜索规划阶段 5/6：把子查询映射到具体工具。每个映射调用一次；is_revision=true 覆盖全部。",
    parameters: Type.Object({
      ...planCommonParams,
      sub_query_id: Type.String({ description: "要映射的子查询 ID" }),
      tool: StringEnum(["web_search", "web_fetch", "web_map"] as const),
      reason: Type.String({ description: "为什么选这个工具" }),
      params_json: Type.Optional(Type.String({ description: "工具参数的 JSON 字符串" })),
    }),
    async execute(_toolCallId, params) {
      const missing = requireSession(params.session_id);
      if (missing) return { content: [{ type: "text", text: JSON.stringify({ error: missing }) }], details: {} };
      const item: Record<string, unknown> = {
        sub_query_id: params.sub_query_id,
        tool: params.tool,
        reason: params.reason,
      };
      if (params.params_json) {
        try {
          item["params"] = JSON.parse(params.params_json);
        } catch {
          // 忽略非法 JSON
        }
      }
      const result = planningEngine.processPhase({
        phase: "tool_selection",
        thought: params.thought,
        sessionId: params.session_id,
        isRevision: !!params.is_revision,
        confidence: params.confidence,
        phaseData: item,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "plan_execution",
    label: "Plan Execution",
    description: `搜索规划阶段 6/6：定义执行顺序。parallel_groups 用分号分隔并行组、逗号分隔组内 ID（如 'sq1,sq2;sq3'）。`,
    parameters: Type.Object({
      ...planCommonParams,
      parallel_groups: Type.String({
        description: "并行批次：'sq1,sq2;sq3,sq4'（分号=组，逗号=ID）",
      }),
      sequential: Type.String({ description: "必须按顺序执行的 ID（逗号分隔）" }),
      estimated_rounds: Type.Number({ description: "预计执行轮次" }),
    }),
    async execute(_toolCallId, params) {
      const missing = requireSession(params.session_id);
      if (missing) return { content: [{ type: "text", text: JSON.stringify({ error: missing }) }], details: {} };
      const parallel = params.parallel_groups
        .split(";")
        .filter((g: string) => g.trim())
        .map((g: string) => splitCsv(g));
      const result = planningEngine.processPhase({
        phase: "execution_order",
        thought: params.thought,
        sessionId: params.session_id,
        isRevision: !!params.is_revision,
        confidence: params.confidence,
        phaseData: {
          parallel,
          sequential: splitCsv(params.sequential),
          estimated_rounds: params.estimated_rounds,
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
