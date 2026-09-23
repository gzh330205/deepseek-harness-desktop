#!/usr/bin/env bash
# 发布脚本：打包（签名）→ 生成 latest.json → 创建 GitHub Release 并上传资产
# 用法: scripts/release.sh <version>   （如 scripts/release.sh 0.2.7）
# 前置: 已安装 GitHub CLI 并登录（gh auth status 确认）
set -euo pipefail

VERSION="${1:?usage: release.sh <version>}"
cd "$(dirname "$0")/.."
REPO="gzh330205/deepseek-harness-desktop"

# 定位 gh（PATH 找不到时尝试常见安装路径）
if ! command -v gh >/dev/null 2>&1; then
  for p in "/c/Program Files/GitHub CLI" "/d/Program Files/GitHub CLI" \
           "$LOCALAPPDATA/Microsoft/WinGet/Links" "$USERPROFILE/AppData/Local/Programs/GitHub CLI"; do
    if [ -x "$p/gh.exe" ]; then
      export PATH="$p:$PATH"
      break
    fi
  done
fi
command -v gh >/dev/null || { echo "错误: 未安装 GitHub CLI，请先: winget install GitHub.cli"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "错误: 未登录 GitHub，请先: gh auth login"; exit 1; }

# 签名密钥（默认项目内 src-tauri/keys/dsh-desktop.key，可用环境变量覆盖）
KEY="${DSH_DESKTOP_SIGNING_KEY_PATH:-src-tauri/keys/dsh-desktop.key}"
[ -f "$KEY" ] || { echo "错误: 缺少签名密钥 $KEY（请勿提交到 Git）"; exit 1; }
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PATH="$(cygpath -w "$KEY" 2>/dev/null || echo "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# 1. 版本号一致性检查（三处）
node -e "
const c = require('./src-tauri/tauri.conf.json');
const p = require('./package.json');
const fs = require('fs');
const cargo = fs.readFileSync('./src-tauri/Cargo.toml', 'utf8').match(/^version = \"([^\"]+)\"/m)?.[1];
if (c.version !== '$VERSION') { console.error('tauri.conf.json version =', c.version, '!=', '$VERSION'); process.exit(1); }
if (p.version !== '$VERSION') { console.error('package.json version =', p.version, '!=', '$VERSION'); process.exit(1); }
if (cargo !== '$VERSION') { console.error('Cargo.toml version =', cargo, '!=', '$VERSION'); process.exit(1); }
console.log('版本一致:', '$VERSION');
"

# 2. 打包（NSIS + MSI，含 updater 签名）
echo "==> pnpm tauri build"
pnpm tauri build

BUNDLE="src-tauri/target/release/bundle"
NSIS="$BUNDLE/nsis/DSH Desktop_${VERSION}_x64-setup.exe"
SIG="${NSIS}.sig"
MSI="$BUNDLE/msi/DSH Desktop_${VERSION}_x64_en-US.msi"
[ -f "$SIG" ] || { echo "错误: 缺少签名文件 $SIG（检查签名环境变量）"; exit 1; }
echo "==> 打包完成:"
ls -la "$NSIS" "$SIG" "$MSI"

# 3. 生成 latest.json（自动更新清单）
# GitHub 上传资产时会把文件名中的空格替换为点号，清单 URL 必须使用规范化后的名字
SIGNATURE="$(cat "$SIG")"
ASSET_NAME="$(basename "$NSIS" | tr ' ' '.')"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$BUNDLE/latest.json" <<EOF
{
  "version": "$VERSION",
  "notes": "https://github.com/$REPO/releases/tag/v$VERSION",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "windows-x86_64": {
      "signature": "$SIGNATURE",
      "url": "https://github.com/$REPO/releases/download/v$VERSION/$ASSET_NAME"
    }
  }
}
EOF
echo "==> latest.json 已生成"

# 4. 创建 Release 并上传资产
echo "==> 创建 GitHub Release v$VERSION 并上传资产"
gh release create "v$VERSION" \
  "$NSIS" "$SIG" "$MSI" "$BUNDLE/latest.json" \
  --repo "$REPO" \
  --title "v$VERSION" \
  --notes "**DSH Desktop v$VERSION**

## 本次更新

- **新增：代理配置**：设置窗口可开启代理并填写地址（HTTPS 代理 / HTTP 代理 / 例外列表），桌面端启动 DSH 服务时注入 \`HTTPS_PROXY\` / \`HTTP_PROXY\` / \`NO_PROXY\` 环境变量，供联网搜索与网页抓取使用。地址可省略 \`http://\` 前缀，支持 http / https / socks5；未启用时会显式清除这些变量，避免系统级代理意外生效。保存时可选择「保存并重启 DSH」立即生效。
- **新增：手动检查更新**：设置窗口新增「检查更新」按钮，可随时重查桌面端更新，并给出「已是最新版本 / 发现新版本 / 检查失败」的明确反馈；发现新版本时直接打开更新窗口（自动检查仍只在启动时静默执行一次）。
- **修复：设置窗口内容被裁切**：设置项增多后，原 560×330 的固定尺寸窗口显示不全，已调整为 620×720 并为面板增加滚动兜底。

## 使用

下载 **$ASSET_NAME** 安装；已安装用户重启应用即可收到自动更新。
更新后可在「设置」中配置代理，或用「检查更新」随时手动重查新版本。"
# gh release create 会覆盖同名标签/资产的旧 Release（--clobber 语义由 GitHub 自动处理）

echo ""
echo "✅ Release v$VERSION 发布完成！"
echo "   下载页: https://github.com/$REPO/releases/tag/v$VERSION"
echo "   更新清单: https://github.com/$REPO/releases/latest/download/latest.json"
