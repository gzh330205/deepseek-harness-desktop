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

- **修复新版 DSH 认证页 401**：DSH 0.1.2-alpha.2+ 的 \`dsh web\` 带浏览器一次性认证（匿名访问返回 401）。桌面端以 CLI 输出的带 token 认证地址判定服务就绪，并自动完成认证：启动页与 DSH 同站（开发模式）时一次导航即达；安装版（启动页跨站，`SameSite=Strict` 登录 cookie 不会随重定向发送）自动执行二次导航（约 400ms 内完成），可靠打开 DSH 页面。
- **更新检测升级**：遍历 npm 全部 dist-tags 取 semver 最大版本，不再只查 next/latest——alpha/beta 等新版本也能检出。
- **更新交互优化**：桌面更新与 DSH 更新检查全程静默，仅在发现新版本时居中弹窗询问；DSH 更新期间右下角显示进度条，完成后弹窗询问立即/稍后重启，更新不阻塞正常使用。
- **问题修复**：主线程创建辅助窗口死锁、窗口状态插件误恢复可见性、缺失窗口关闭权限导致弹窗无法关闭等。

## 使用

下载 **$ASSET_NAME** 安装；已安装用户重启应用即可收到自动更新（含 DSH 后台更新与重启）。"
# gh release create 会覆盖同名标签/资产的旧 Release（--clobber 语义由 GitHub 自动处理）

echo ""
echo "✅ Release v$VERSION 发布完成！"
echo "   下载页: https://github.com/$REPO/releases/tag/v$VERSION"
echo "   更新清单: https://github.com/$REPO/releases/latest/download/latest.json"
