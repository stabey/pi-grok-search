# pi-grok-search

Pi Coding Agent 的**深度联网搜索扩展**：通过 Grok API 注入 14 个搜索/抓取/规划工具，让 pi 拥有实时联网能力。与 MCP 版 grok-search 功能对齐。

## 功能一览（14 个工具）

| 类别 | 工具 |
|---|---|
| 搜索 | `web_search`（Grok 驱动多轮搜索 + 信源追踪）、`x_search`（X/Twitter 帖子搜索） |
| 信源 | `get_sources`（按 session_id 追根溯源） |
| 抓取 | `web_fetch`（Tavily extract → Firecrawl 降级）、`web_map`（站点地图爬取） |
| 配置 | `get_config_info`、`switch_model` |
| 规划 | `plan_intent` → `plan_complexity` → `plan_sub_query` → `plan_search_term` → `plan_tool_mapping` → `plan_execution`（搜索规划六阶段） |

核心链路：Grok API（OpenAI 兼容）注入 `web_search` → Grok 自主多次搜索并带 `citation_card` 作答 → 自动剥离信源缓存，供 `get_sources` 复用。

## 环境要求

- **Node.js ≥ 20**（使用 `AbortSignal.any` / `AbortSignal.timeout`）
- **pi ≥ 0.73**（运行时依赖 `pi-coding-agent` / `pi-ai` / `typebox` 由 pi 提供）

同时兼容：
- pi 0.73.x（`@mariozechner/*`）
- pi 0.74+（`@earendil-works/*`，含当前最新版）

扩展会按新 → 旧的顺序解析包名，不用手改 import。

## 安装（任意环境通用）

### 方式 A：一键脚本（推荐）

```bash
git clone https://github.com/KatouMegumi-dar/pi-grok-search.git
cd pi-grok-search
bash install.sh          # 安装到 ~/.pi/agent/extensions/grok-search/
```

脚本会自动：安装源码到 pi 扩展目录 → 校验 pi 依赖 → 生成配置模板 `~/.config/grok-search/env`。

### 方式 B：手动复制

```bash
mkdir -p ~/.pi/agent/extensions/grok-search
cp index.ts lib/ ~/.pi/agent/extensions/grok-search/ -r
```

## 配置

**必填**：`GROK_API_URL` + `GROK_API_KEY`（官方端点 `https://api.x.ai/v1`，或任意 OpenAI 兼容代理）。

配置方式二选一：
1. 编辑 `~/.config/grok-search/env`（dotenv 风格，与 MCP 版 grok-search 共用）
2. 导出环境变量（优先级更高）

**可选变量**：

| 变量 | 默认 | 说明 |
|---|---|---|
| `GROK_MODEL` | grok-2-latest | 默认模型；OpenRouter 端点自动追加 `:online` 后缀 |
| `GROK_API_MODE` | chat | `chat` / `responses`（官方推荐 responses，citation 更完整） |
| `GROK_REASONING_EFFORT` | - | low / medium / high |
| `GROK_DEBUG` | false | 调试输出 |
| `GROK_RETRY_*` | 3/1/10 | 重试策略（次数/倍率/最大等待秒） |
| `TAVILY_ENABLED` / `TAVILY_API_URL` / `TAVILY_API_KEY` | true | web_fetch/web_map 信源抓取 |
| `FIRECRAWL_API_URL` / `FIRECRAWL_API_KEY` | - | web_fetch 降级链路 |

配置完成后重启 pi，调用 `get_config_info` 验证（会显示脱敏后的配置状态）。

## 测试（仓库内独立可跑，无需 pi）

```bash
npm install        # 安装 devDependencies（jiti / typescript / pi 包）
npm test           # 信源提取逻辑测试（15 断言，纯本地）
npm run typecheck  # 类型检查
npm run test:live  # 真实 API 集成测试（需已配置 GROK_API_URL/KEY，无配置自动跳过）
```

## 目录结构

```
├── index.ts            # 主扩展：注册 14 个工具
├── lib/
│   ├── config.ts       # 配置读取（环境变量 > ~/.config/grok-search/env）
│   ├── grok.ts         # GrokProvider：chat/responses 两模式调用
│   ├── fetch.ts        # Tavily + Firecrawl 抓取链路
│   ├── planning.ts     # 搜索规划六阶段引擎
│   ├── prompts.ts      # 搜索/抓取系统提示词
│   ├── pi-compat.ts    # 兼容 @earendil-works/* 与 @mariozechner/*
│   └── sources.ts      # 信源提取/合并/缓存
├── install.sh          # 一键安装脚本
└── .env.example        # 配置模板
```

## License

MIT
