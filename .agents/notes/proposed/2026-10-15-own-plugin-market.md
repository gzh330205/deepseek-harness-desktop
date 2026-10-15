# Agent Note: 自建一个薄市场，而不是 fork dsh-market

Status: proposed

## Problem

插件市场是我们这边**唯一一条断掉的核心路径**：dsh-market 的安装/更新链路在 DSH Desktop 上会以 `spawn D:\Program Files\DSH Desktop\DSH Desktop.exe ENOENT` 失败（实证：ENOENT 的真因是 spawn 收到**不存在的 `cwd`**，而非文件缺失；发起点在 dsh 侧的 `dsh-plugin-manager`（11 处 `spawn(…, { cwd: dir })`）与 `dsh-web-app` 的 `spawn(process.execPath, …)`；market 只是转发子进程错误）。同一条链上安装、更新、回滚、源迁移四项一起失效，用户无法自助装插件。

同时我们已有的能力恰好覆盖它最脆弱的一环：壳里有一条**实测可用**的安装路径 —— `bin/node.exe` + `node_modules/pnpm/bin/pnpm.cjs`，`cwd` = profile，`shell:false`（本次实测 `pnpm update` 退出码 0）。

## Decision

自己做一个**薄市场**，三层里只自写必须自写的那层：

| 层 | 做法 |
|---|---|
| 目录/搜索 | 直接用 **npm registry 搜索 API**（关键词 + 名称族），再用"包声明了 `dsh` 字段"做**准入校验**；不引入上游 catalog 代码 |
| 安装/更新/卸载 | **壳自己执行**已验证的 pnpm 路径：`bin/node.exe` + `pnpm.cjs`，`cwd` = profile，`shell:false`；pnpm 输出原样透传，失败按"网络/registry/构建许可/版本冲突"分类展示 |
| UI | 壳的**原生窗口**（复用 `settings-window.ts` 的既有模式），入口挂在标题栏「应用」菜单 |

## Alternatives considered

- **fork dsh-market 整包（MIT，可合法复用）**：最强理由是它就是成品 —— 浏览、搜索、一键安装、兼容性检查、地区、备份、恢复全都写好了（6582 stars，仍在更新），fork 出来改一处就能用。放弃的原因有三条：① **我们要修的那层正是它最重的部分** —— `src/routes.ts` 363 KB、`src/profile.ts` 75 KB、`src/dsh-cli.ts` 72 KB、`src/pnpm-compat.ts` 64 KB、`client/client.js` 770 KB，整包是数 MB 的第三方代码，而我们只需要其中"搜索 + 装/卸"这一小片；② 它的 UI 是**嵌在 DSH 页面**里的，而 DSH 页面加载失败时人最需要装/修插件 —— 把市场绑在可能加载失败的页面上是把自己的救援通道也一起交出去；③ 我们无法为它的全部行为负责（备份/热重载/预设/加速等），一旦用户在那些路径上出问题，我们只能继续猜。
- **只修上游的 spawn 缺陷（改动最小）**：最强理由是成本最低，且修好之后用户拿到的就是完整功能。放弃作为**主方案**的原因是：缺陷在第三方代码 + dsh 自身的 plugin-manager 里，我们能提 issue 但无法保证何时修好；而 `cwd` 不存在这类错误的根因在调用方，第三方随时可能再引入。**保留为并行动作**：把证据整理成 issue 提给上游。
- **继续只给用户命令行方案**：最强理由是零开发量、已验证可用。放弃的原因是 `pnpm add` 只能装"普通 npm/git spec"，而市场里像 `billion-context` 这种**只存在于上游 catalog** 的条目根本没法这样装；把"能找到什么插件"和"能不能装"两件事都留给用户自己拼，不是产品该有的样子。

## Plan

1. **目录层**：npm registry 搜索 + `dsh` 字段准入 + 版本兼容提示（对照我们 pin 的 DSH 版本）；
2. **安装层**：壳内实现 install / update / uninstall，更新 profile 的 `dependencies`，并实测 DSH 是否会自动把声明了 `dsh.bundle` 的依赖纳入 bundle 列表（若需要显式登记则一并实现）；附测试；
3. **UI**：市场窗口（搜索、列表、安装/更新/卸载、进度、错误详情、"复制诊断信息"）；
4. **验证与发布**：tsc + 全量测试 + 打包校验 + 打包态 smoke，然后发版。

## Risks

- **供应链**：只列出来源明确、声明了 `dsh` 字段的包，并把"安装的是什么 spec"原样展示给用户；
- **版本兼容**：插件可能要求更高版本的 DSH，需要在列表上标注并与运行时 pin 对照；
- **与上游重复**：上游若修好了 spawn 缺陷，我们这套仍然有效（更薄、更贴近壳），但要避免两套 UI 同时给用户造成困惑 —— 届时以"壳内市场"为唯一入口。
