#!/usr/bin/env bash
# ============================================================
# pi-grok-search 一键安装脚本（任意环境的 pi 均可使用）
#
# 功能:
#   1. 把扩展源码安装到 pi 的用户扩展目录 ~/.pi/agent/extensions/grok-search/
#   2. 校验 pi 运行时依赖（@earendil-works/* 或 @mariozechner/* 的 pi-coding-agent / pi-ai / typebox）
#   3. 首次安装自动生成配置模板 ~/.config/grok-search/env
#
# 用法:
#   bash install.sh                # 安装到默认目录
#   PI_EXT_DIR=/path/to/ext bash install.sh   # 自定义扩展目录
#   bash install.sh --help
# ============================================================
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '1,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

echo "== pi-grok-search 安装 =="

# 1. 目标扩展目录
if [[ -n "${PI_EXT_DIR:-}" ]]; then
  PI_EXT_DIR="${PI_EXT_DIR%/}"
  echo "使用自定义扩展目录: $PI_EXT_DIR"
elif command -v pi >/dev/null 2>&1; then
  PI_EXT_DIR="$HOME/.pi/agent/extensions"
  echo "检测到 pi ($(command -v pi))，安装到默认扩展目录: $PI_EXT_DIR"
else
  PI_EXT_DIR="$HOME/.pi/agent/extensions"
  echo "⚠️  未检测到 pi 命令（若已安装请确认在 PATH 中）。"
  echo "   仍将安装到: $PI_EXT_DIR"
fi
DEST="$PI_EXT_DIR/grok-search"

# 2. 校验 pi 运行时依赖
PI_MODULES=""
if command -v pi >/dev/null 2>&1; then
  PI_BIN="$(readlink -f "$(command -v pi)")"
  for probe in \
    "$(dirname "$(dirname "$PI_BIN")")/node_modules" \
    "$(dirname "$(dirname "$(dirname "$PI_BIN")")")/node_modules" \
    "$(npm root -g 2>/dev/null || true)"; do
    if [[ -n "$probe" && ( -d "$probe/@earendil-works/pi-coding-agent" || -d "$probe/@mariozechner/pi-coding-agent" ) ]]; then
      PI_MODULES="$probe"
      break
    fi
  done
fi
if [[ -z "$PI_MODULES" ]]; then
  echo "⚠️  未找到 pi 依赖 @earendil-works/pi-coding-agent 或 @mariozechner/pi-coding-agent（确认 pi 安装完整即可，扩展运行时由 pi 提供这些包）。"
else
  echo "✅ pi 依赖正常: $PI_MODULES"
fi

# 3. 复制源码
mkdir -p "$DEST"
cp "$SRC_DIR/index.ts" "$DEST/"
cp -r "$SRC_DIR/lib" "$DEST/"
echo "✅ 源码已安装: $DEST"
echo "   - index.ts (主扩展, 注册 14 个工具)"
echo "   - lib/ (config / grok / fetch / planning / prompts / sources / pi-compat)"

# 4. 配置初始化（不覆盖已有配置）
CONFIG_DIR="$HOME/.config/grok-search"
if [[ -f "$CONFIG_DIR/env" ]]; then
  echo "ℹ️  配置已存在，跳过: $CONFIG_DIR/env"
else
  mkdir -p "$CONFIG_DIR"
  cp "$SRC_DIR/.env.example" "$CONFIG_DIR/env"
  echo "📝 已生成配置模板: $CONFIG_DIR/env"
  echo "   请编辑填入 GROK_API_URL 与 GROK_API_KEY（官方端点 https://api.x.ai/v1）"
fi

echo ""
echo "🎉 安装完成！重启 pi 后即可使用 web_search / x_search / get_sources / web_fetch / web_map / get_config_info / switch_model / plan_* 共 14 个工具。"
echo "   验证: 让 pi 调用 get_config_info，或直接使用 web_search。"
