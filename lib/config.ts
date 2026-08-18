/**
 * grok-search 扩展配置
 *
 * 读取优先级：进程环境变量 > ~/.config/grok-search/env（dotenv 风格）
 * 模型持久化：~/.config/grok-search/config.json 的 "model" 字段（与 MCP 版 grok-search 共用）
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "grok-search");
export const ENV_FILE = join(CONFIG_DIR, "env");
export const CONFIG_JSON = join(CONFIG_DIR, "config.json");

let _envCache: Record<string, string> | null = null;
let _configJson: Record<string, unknown> | null = null;
let _cachedModel: string | null = null;

/** 解析 dotenv 风格文本：支持注释、KEY=VALUE、单/双引号包裹 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(): Record<string, string> {
  if (_envCache) return _envCache;
  try {
    _envCache = existsSync(ENV_FILE) ? parseDotEnv(readFileSync(ENV_FILE, "utf8")) : {};
  } catch {
    _envCache = {};
  }
  return _envCache;
}

function loadConfigJson(): Record<string, unknown> {
  if (_configJson) return _configJson;
  try {
    _configJson = existsSync(CONFIG_JSON) ? JSON.parse(readFileSync(CONFIG_JSON, "utf8")) : {};
  } catch {
    _configJson = {};
  }
  return _configJson ?? {};
}

function getEnv(key: string): string | undefined {
  return process.env[key] ?? loadEnvFile()[key];
}

/** Missing, empty, or whitespace-only keys are treated as unset. */
export function isConfiguredApiKey(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Which Tavily/Firecrawl tools should be registered with Pi. */
export function resolveFetchTools(input: {
  tavilyApiKey?: string;
  firecrawlApiKey?: string;
  tavilyEnabled: boolean;
}): { webFetch: boolean; webMap: boolean } {
  const tavily = input.tavilyEnabled && isConfiguredApiKey(input.tavilyApiKey);
  const firecrawl = isConfiguredApiKey(input.firecrawlApiKey);
  return {
    webFetch: tavily || firecrawl,
    webMap: tavily,
  };
}

/** plan_tool_mapping / plan_sub_query 只列出实际会注册的搜索/抓取工具。 */
export function planSearchToolNames(fetch: {
  webFetch: boolean;
  webMap: boolean;
}): [string, ...string[]] {
  const tools: [string, ...string[]] = ["web_search"];
  if (fetch.webFetch) tools.push("web_fetch");
  if (fetch.webMap) tools.push("web_map");
  return tools;
}

/** OpenRouter 端点自动追加 :online 后缀（无搜索能力的模型用） */
export function applyModelSuffix(model: string): string {
  const url = getEnv("GROK_API_URL") ?? "";
  if (url.includes("openrouter") && !model.includes(":online")) return `${model}:online`;
  return model;
}

export const config = {
  get grokApiUrl(): string {
    const url = getEnv("GROK_API_URL");
    if (!url) {
      throw new Error(
        "GROK_API_URL 未配置！请在环境变量或 ~/.config/grok-search/env 中设置 GROK_API_URL 和 GROK_API_KEY",
      );
    }
    return url;
  },

  get grokApiKey(): string {
    const key = getEnv("GROK_API_KEY");
    if (!key) {
      throw new Error(
        "GROK_API_KEY 未配置！请在环境变量或 ~/.config/grok-search/env 中设置 GROK_API_KEY",
      );
    }
    return key;
  },

  get grokModel(): string {
    if (_cachedModel) return _cachedModel;
    const model =
      getEnv("GROK_MODEL") ??
      (loadConfigJson()["model"] as string | undefined) ??
      "grok-4-fast";
    _cachedModel = applyModelSuffix(model);
    return _cachedModel;
  },

  /** 持久化切换默认模型（写入 config.json，与 MCP 版共享） */
  setModel(model: string): string {
    const data = loadConfigJson();
    data["model"] = model;
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_JSON, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      throw new Error(`无法保存配置文件 ${CONFIG_JSON}: ${(e as Error).message}`);
    }
    _cachedModel = applyModelSuffix(model);
    return _cachedModel;
  },

  get grokApiMode(): string {
    return (getEnv("GROK_API_MODE") ?? "chat").toLowerCase().trim();
  },

  get grokReasoningEffort(): string {
    return (getEnv("GROK_REASONING_EFFORT") ?? "").toLowerCase().trim();
  },

  get debugEnabled(): boolean {
    return ["true", "1", "yes"].includes((getEnv("GROK_DEBUG") ?? "false").toLowerCase());
  },

  get retryMaxAttempts(): number {
    return parseInt(getEnv("GROK_RETRY_MAX_ATTEMPTS") ?? "3", 10) || 3;
  },

  get retryMultiplier(): number {
    return parseFloat(getEnv("GROK_RETRY_MULTIPLIER") ?? "1") || 1;
  },

  get retryMaxWait(): number {
    return parseInt(getEnv("GROK_RETRY_MAX_WAIT") ?? "10", 10) || 10;
  },

  get tavilyEnabled(): boolean {
    return ["true", "1", "yes"].includes((getEnv("TAVILY_ENABLED") ?? "true").toLowerCase());
  },

  get tavilyApiUrl(): string {
    return getEnv("TAVILY_API_URL") ?? "https://api.tavily.com";
  },

  get tavilyApiKey(): string | undefined {
    return getEnv("TAVILY_API_KEY");
  },

  get firecrawlApiUrl(): string {
    return getEnv("FIRECRAWL_API_URL") ?? "https://api.firecrawl.dev/v2";
  },

  get firecrawlApiKey(): string | undefined {
    return getEnv("FIRECRAWL_API_KEY");
  },

  maskKey(key?: string): string {
    if (!key || key.length <= 8) return "***";
    return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
  },

  getConfigInfo(): Record<string, unknown> {
    let apiUrl: string;
    let apiKeyMasked: string;
    let configStatus: string;
    try {
      apiUrl = this.grokApiUrl;
      apiKeyMasked = this.maskKey(this.grokApiKey);
      configStatus = "✅ 配置完整";
    } catch (e) {
      apiUrl = "未配置";
      apiKeyMasked = "未配置";
      configStatus = `❌ 配置错误: ${(e as Error).message}`;
    }
    return {
      GROK_API_URL: apiUrl,
      GROK_API_KEY: apiKeyMasked,
      GROK_MODEL: this.grokModel,
      GROK_API_MODE: this.grokApiMode,
      GROK_REASONING_EFFORT: this.grokReasoningEffort || "未设置",
      GROK_DEBUG: this.debugEnabled,
      GROK_RETRY_MAX_ATTEMPTS: this.retryMaxAttempts,
      TAVILY_API_URL: this.tavilyApiUrl,
      TAVILY_ENABLED: this.tavilyEnabled,
      TAVILY_API_KEY: this.tavilyApiKey ? this.maskKey(this.tavilyApiKey) : "未配置",
      FIRECRAWL_API_URL: this.firecrawlApiUrl,
      FIRECRAWL_API_KEY: this.firecrawlApiKey ? this.maskKey(this.firecrawlApiKey) : "未配置",
      config_file: CONFIG_JSON,
      env_file: ENV_FILE,
      config_status: configStatus,
    };
  },
};
