# Agent Note: 手机访问后续阶段（公网隧道 + 移动布局 + 发版）

Status: proposed

> - 局域网网关（P1）已落地：[implemented: 手机访问网关](../../implemented/architecture/2026-10-16-phone-gateway.md)
> - Android 客户端（P2）已落地：[implemented: Android 客户端](../../implemented/feature/2026-10-16-pocket-apk.md)
> - 公网隧道（P3）已落地：[implemented: 公网门](../../implemented/feature/2026-10-16-pocket-public-access.md)
>
> 本笔记只覆盖**尚未开工**的部分：移动布局与保活（P4）、发版集成（P5）。

## Problem

- **手机上渲染的是桌面布局**，窄屏难用（侧栏挤占、触控目标过小），长会话的大 JSON 响应在移动网络上也很重。
- **发版时要把 APK 一起交付**：现在 release 只传 Windows 安装包 + 签名 + `latest.json`。

## Proposal

### P4 移动布局与体验

- 窄屏抽屉布局（移植 **MIT** 的 `dsh-web-mobile`），注入我们**已有的**客户端插件
  （`resources/dsh-desktop-shell/client.js`），不引入第二套插件。手机端已经会把
  `DshPocket/1.0` 附在 User-Agent 里，可据此只在 App 内启用。
- 大 JSON 响应的 gzip/brotli（长会话体积差一个数量级）、心跳保活与断线重连。

### P5 发版集成

- `release-electron.mjs` 产出并上传 `DSH.Pocket_<version>.apk`，APK 内做版本检查。
- 打包态 smoke 扩展：现有 `scripts/smoke-pocket.mjs` 已覆盖网关；再加隧道与 APK 资产的存在性断言。

## Alternatives considered

- **让手机端自己连 DSH 的 loopback 服务**：不可行（也不该可行）——这正是网关存在的理由。
- **公网隧道的四个备选方案**（运行期下载 cloudflared、让用户自己装、单监听器靠 Host 判定、公网口也套 Host
  白名单）以及它们各自被否的实测原因，见
  [implemented: 公网门](../../implemented/feature/2026-10-16-pocket-public-access.md)——包括被 E2E 推翻的那一条。

## Acceptance criteria

- **移动布局**：窄屏下侧栏变抽屉、会话全宽、不出现横向滚动条；长会话响应被压缩。
- **发版**：release 脚本上传 APK，`latest.json` 与 APK 版本一致。

## Risks

- **壳的加载模式**：`advanced` 模式禁用网页布局，手机端会白屏；开启手机访问前要检测并阻止/提示。
- **长连接存活**：手机省电策略会掐 WebSocket，需要心跳 + 自动重连；若实测仍频繁断，再考虑前台服务
  （会带来常驻通知）。
- **GPL 边界**：读 `dsh-pocket` 取行为与取舍可以，**不能抄代码表达**；移动布局若移植，取 MIT 的
  `dsh-web-mobile`。
