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

- **优化：DSH「桌面端」设置页布局**：状态卡与各分组改为紧凑的两列布局，控件定宽不再挤压文案（不再出现标签折行），两个更新开关并排，保存操作栏常驻底部，长内容不必滚到底才能保存。
- **修复：安装后打开停在 401 页面**：一次性认证地址的解析曾被日志脱敏抢先执行，WebView 用 `?token=***` 导航而被 DSH 拒绝；现在认证地址在脱敏之前从原始输出提取并单独保存，脱敏占位符一律不再被当作可用地址。
- **新增：DSH 设置页「桌面端」**：桌面壳启动时通过 `--patch` 向 DSH 注入自带面板插件，在 DSH 的「设置 → 桌面端」里即可配置关闭行为、代理、启动时更新检查开关与下次启动端口，并查看桌面端版本、DSH 版本与地址、面板注入状态；「保存并重启 DSH」可直接让代理等设置生效。
- **新增：始终自启并托管自己的 DSH**：不再发现或复用本机已有实例；固定端口 41729（可用环境变量 `DSH_DESKTOP_PORT` 覆盖），端口被占用时明确报错并给出占用进程与解决办法。
- **新增：启动三道闸门**：DSH 版本需不低于 0.1.2-alpha.2（浏览器会话认证基线）、需支持 `--patch`、端口需可用；不满足则不启动服务并引导更新 DSH。
- **变更：删除桌面设置窗口**：设置统一收进 DSH 设置页；「关于」窗口保留版本、运行方式、DSH 状态与面板状态。
- **安全：收敛访问面**：仅绑定回环地址；依赖 DSH 浏览器认证；日志中的一次性认证 token 一律脱敏；面板 API 增加同源校验与 Cookie 回探认证。
- **移除**：`DSH_DESKTOP_URL` 环境变量（不再复用外部实例）。

## 使用

下载 **$ASSET_NAME** 安装；已安装用户重启应用即可收到自动更新。
更新后可在 DSH「设置 → 桌面端」中配置桌面端；「关于」窗口可随时手动检查桌面端更新。"
# gh release create 会覆盖同名标签/资产的旧 Release（--clobber 语义由 GitHub 自动处理）

echo ""
echo "✅ Release v$VERSION 发布完成！"
echo "   下载页: https://github.com/$REPO/releases/tag/v$VERSION"
echo "   更新清单: https://github.com/$REPO/releases/latest/download/latest.json"
