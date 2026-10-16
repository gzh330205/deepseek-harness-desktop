# Agent Note: 手机访问后续阶段（公网隧道 + 移动布局 + 发版）

Status: proposed

> - 局域网网关（P1）已落地：[implemented: 手机访问网关](../../implemented/architecture/2026-10-16-phone-gateway.md)
> - Android 客户端（P2）已落地：[implemented: Android 客户端](../../implemented/feature/2026-10-16-pocket-apk.md)
> - 公网隧道（P3）已落地：[implemented: 公网门](../../implemented/feature/2026-10-16-pocket-public-access.md)
> - 移动布局与压缩（P4）已落地：[implemented: 移动布局与传输压缩](../../implemented/feature/2026-10-16-pocket-mobile-layout.md)
> - 发版集成（P5）已落地：[implemented: 发版集成](../../implemented/feature/2026-10-16-pocket-release-integration.md)
>
> **P1–P5 全部落地，本笔记的规划部分已全部完成。**保留它是为了留下当初的取舍记录；后续若要继续做
> （例如手机端自更新、前台服务保活），应新开一篇 proposed 而不是改这篇。

## Problem

- **发版时要把 APK 一起交付**：现在 release 只传 Windows 安装包 + 签名 + `latest.json`。

## Proposal

## Alternatives considered

- **让手机端自己连 DSH 的 loopback 服务**：不可行（也不该可行）——这正是网关存在的理由。
- **公网隧道的四个备选方案**（运行期下载 cloudflared、让用户自己装、单监听器靠 Host 判定、公网口也套 Host
  白名单）以及它们各自被否的实测原因，见
  [implemented: 公网门](../../implemented/feature/2026-10-16-pocket-public-access.md)——包括被 E2E 推翻的那一条。

## Acceptance criteria


## Risks

- **壳的加载模式**：`advanced` 模式禁用网页布局，手机端会白屏；开启手机访问前要检测并阻止/提示。
- **GPL 边界**：读 `dsh-pocket` 取行为与取舍可以，**不能抄代码表达**；移动布局若移植，取 MIT 的
  `dsh-web-mobile`。
