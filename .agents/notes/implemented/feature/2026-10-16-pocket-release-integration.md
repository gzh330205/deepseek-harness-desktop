# Agent Note: 手机访问的发版集成（APK 资产、smoke 闸门、清单附加字段）

Status: implemented

功能本身见三篇 implemented 笔记：[局域网网关](../architecture/2026-10-16-phone-gateway.md)、
[公网门](2026-10-16-pocket-public-access.md)、[移动布局与压缩](2026-10-16-pocket-mobile-layout.md) 与
[Android 客户端](2026-10-16-pocket-apk.md)。本笔记只讲**怎么把它交到用户手上**。

## Problem

手机客户端必须在**发布**这条路上被正确处理，而不是"记得手动打个包"：

- 一个**没签名**或**版本没跟上**的 APK 一旦进了 Release，用户装上去要么装不了，要么装的是旧代码；
- 手机那边没有自动更新通道，**下载地址必须是稳定的**——否则每次发版都得让用户重新找链接；
- 桌面客户端的自动更新**不能**因为清单里多了手机端的东西而坏掉；
- 发版前应该跑真实的端到端检查，而不是签完名才发现打出来的壳根本起不来。

## Decision

### 1. APK 由发布脚本构建并检验，失败即拒绝发布

`release-electron.mjs` 在构建安装包之后：

1. 跑 `gradlew :app:assembleRelease`；
2. 用 `aapt2 dump badging` 读**包名、版本号、minSdk、targetSdk**（这四个数字决定哪些手机能装，缺一个就
   `fail`）；
3. 用 `apksigner verify --print-certs` 要求 **v2 签名方案通过**，并把签名者 DN 打出来；
4. 以**固定资产名** `DSH.Pocket.apk` 复制到产物目录，并算出 sha256。

两个 Windows 细节值得记下来（都踩过）：`gradlew.bat` 与 `apksigner.bat` **不能**被 Node 直接 spawn
（`EINVAL`），要经 `cmd.exe /c`；参数固定字面量，永远不拼用户输入。另外 build-tools 36 把 `aapt2 badging`
里的 `sdkVersion:` 改名成了 `minSdkVersion:`，校验要同时接受两种写法——否则在一台机器上能过、另一台上报
"元数据读不出来"。

### 2. 固定资产名，而不是带版本号的名字

上传名固定为 `DSH.Pocket.apk`，于是
`https://github.com/gzh330205/deepseek-harness-desktop/releases/latest/download/DSH.Pocket.apk` **永远指向最新
版**。设置页把它做成二维码（在「手机访问」区块里，**不需要先有监听器就显示**——用户得先装上 App 才有东西可
连）。版本号不靠文件名表达：它写在 APK 自己里面，也写进了 `latest.json` 的 `apk` 段。

### 3. `latest.json` 只加不改

新增的 `apk` 段（包名、版本、versionCode、minSdk、targetSdk、固定 URL、sha256）是**纯附加字段**。
`fetchManifest` 只读它认识的键（`version`、`platforms.windows-x86_64.{url,signature}`、`notes`、
`pub_date`），所以老客户端行为不变。这条承诺有回归测试钉住：新增的用例把带 `apk` 段的清单真的喂给随壳的
解析器，断言它照常读出 `version` 与 `entry`。

### 4. 两个 smoke 是闸门，不是装饰

签名与上传**之前**依次跑：

- `scripts/smoke.mjs cookie --packaged`（打包版壳：启动、加载模式、面板桥、代理、WS）；
- `scripts/smoke-pocket.mjs`（手机访问网关：真实 socket，含 Host 403、401、登录、WebSocket 升级）。

任一失败即 `fail` 中止发布；`--skip-smoke` 可以跳过，但消息里写明"先弄清原因"。理由很直接：这是发现"打出来
的壳起不来"的最后时机，也是所有已安装用户开始自动更新到它之前的最后时机。

## Alternatives considered

- **带版本号的资产名 + 靠 `latest.json` 找到当前 APK**（最强理由：文件名自解释，历史版本一目了然）→ 弃。
  二维码必须活的：要么每次发版重新生成二维码，要么让手机先读一份 JSON 再下载——而"扫一个固定的码"是这个
  功能最省事的部分，不该为了文件名好看牺牲掉。历史版本仍然各自留在自己的 Release 里。
- **把 APK 放进 `latest.json` 的 `platforms`**（最强理由：复用同一份清单结构）→ 弃。`platforms` 是**更新器**
  的命名空间，里面每个键都意味着"这个平台能自动更新"。手机端不自更新（Android 的安装权限决定了它必须由用户
  点一次），把它塞进更新器的命名空间会误导后来的人以为它参与更新。
- **手动打 APK，发版时用 `gh release upload` 补上**（最强理由：改动最小）→ 弃。这正是本阶段要防的失败模式：
  忘了、打的是旧版本、或忘了签名——三种都不会有人发现，直到用户装不上。
- **发版时把网关 smoke 换成单元测试**（最强理由：快，且不依赖端口）→ 弃。单元测试打的是 stub；这里要证明的
  是"真实的壳 + 真实的网关 + 真实 socket"能一起工作，而这条路径上已经有过只有真机/真进程才能发现的问题。

## Consequences

- 每次发版多花约 1–2 分钟构建 APK、约 3–4 分钟跑两个 smoke；换来的是"不会发布一个装不上的手机端"。
- 发布产物从一个安装包变成**四个资产**：安装包、安装包签名、`latest.json`、`DSH.Pocket.apk`。
- 手机端需要**用户手动更新**（扫码下载新 APK 覆盖安装）。这是 Android 的规则，不是取舍；清单里的 `apk.version`
  与固定 URL 让它至少可以被后续的"检查新版本"功能读到。
- 网关 smoke 使用固定端口 41734/41735，所以发版机上**不能有开发实例占着**。占用了会明确报出"端口 41734 已被
  占用：electron.exe（PID …）"并中止发布——安全方向是对的，但值得知道这条消息意味着什么。

## Evidence

- **完整干跑**（`node scripts/release-electron.mjs 0.4.0 --dry-run --notes "…"`，真构建、真校验、真 smoke、
  不发布）：
  - `==> 随包 cloudflared 2026.10.1 哈希与 pin 一致`
  - `==> 产物 DSH.Desktop_0.4.0_x64-setup.exe：214.6 MiB`
  - `打包校验通过：dsh 0.2.0-rc.2（Electron 44.0.0）、asar 内 12097 个文件、关键文件 27 个、物理落盘 485 个`
  - `==> DSH.Pocket.apk：3.4 MiB，包名 com.dshdesktop.pocket，版本 1.0.0(1)，minSdk 26，targetSdk 34，`
    `签名者 CN=DSH Pocket, OU=Phone access, O=DSH Desktop, …`
  - `SMOKE cookie [packaged] → PASS`，随后网关 smoke 通过
  - `==> 签名自校验通过`，`latest.json` 与四资产发布计划打印正确
- **清单兼容性回归测试**：把带 `apk` 段的清单喂给随壳的 `fetchManifest`，断言 `version`/`entry`/`isNewer` 全部
  正常（`src/update.test.ts`，8 条全过）。
- 设置页静态守卫新增一条：手机 App 的二维码与链接在**没有运行中的监听器**时也要渲染（否则用户先看到的是一
  片空白）。
