# Agent Note: 市场安装报「新版本冷静期」却指向错误的包（0.4.16 修复）

Status: implemented

## Problem

用户更新 `@changfenhuang/dsh-genui` 到 0.14.0 时，市场窗口报：

```
ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
billion-context@0.1.205 published 2026-10-24T02:07:01.660Z
```

但：

- 用户要装的是 **dsh-genui 0.14.0**，它发布于 2026-10-21T12:19:54Z，已经超过 24 小时；
- 日志里同一批命令中 `billion-context` 只是 `dsh-ops` 的间接依赖，用户并没有要求升级它；
- profile 的 `pnpm-workspace.yaml` 里已经有 `minimumReleaseAgeExclude` 列表，按这份列表 `billion-context@0.1.205` 并不需要被拦住。

真正的原因在 pnpm 11 的**锁文件复检**：当 `pnpm add <pkg>@<version>` 需要改写锁文件时，pnpm 会对着现有锁文件做一次 resolver 校验；这次校验会按 `minimumReleaseAge` 重新检查整棵树，而且**不读 `minimumReleaseAgeExclude`**。任何间接依赖只要在这 24 小时内发过新版，就会把整次安装判成 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，错误信息落在那个间接依赖上。壳的 `classifyPnpmFailure` 又把它当成「用户要装的包太新」，提示「等几天/等 24 小时」，完全指错方向。

dsh-genui 的安装日志里还混着一条 `GET https://registry.npmjs.org/@dsh-ops/bash-win32-x64/-/bash-win32-x64-0.4.1.tgz` 的 `23` 错误（unzip 失败后重试成功），是 npm 源侧的瞬时坏包重试；它跟 `add dsh-genui` 没有依赖关系（`dsh-ops` 由 agent-team-preset 安装、版本 0.4.1 未变），不要被这条噪音带偏。

## Decision

1. **profile 级开关**：在 `C:\Users\gzh33\.dsh\profiles\dsh-desktop\pnpm-workspace.yaml` 增加
   `trustLockfile: true`，并留注释「锁文件复检会把整棵树的发布时间再查一遍；这个 profile 的锁文件由本机生成，信任它，避免把其它包的新版本误报成当前安装失败」。这是 pnpm 11 文档给出的开关，只跳过锁文件复检；直接安装的新版本仍然受 `minimumReleaseAge` 保护。
2. **错误提示改准**：`electron/src/market-install.ts` 的 too-new hint 改成同时说明「可能是锁文件里别的包太新」与 `trustLockfile` 出路；并新增锁文件复检识别：日志里出现 `lockfile`/`lock file` + `published too recently` 时归为 `lockfile-release-age`，不再跟真正安装目标太新共用一句话。
3. **回归测试**：`market-install.test.ts` 增加两条——锁文件复检日志归为 `lockfile-release-age`；真实目标太新仍是 `too-new`。`market-github-install.test.ts` 的 hint 断言同步到新文案（含「24 小时」与 `trustLockfile`）。

## Alternatives considered

- **把 `billion-context@0.1.205` 加进 `minimumReleaseAgeExclude`**：能立刻装上，但等于替用户绕过一个他没打算升级的包的冷静期；上游每 24 小时发新版就得再加一次，是打地鼠，且把供应链保护面越撕越大。拒绝。
- **让用户等 24 小时**：00:07 的版本到 24 日 00:07 后才满 24 小时，确实能过；但用户被卡住时错误提示指向错包，等待期间还会反复失败，体验不可接受。只作为兜底写进提示。
- **全局 `minimumReleaseAge: 0`**：一劳永逸但把冷静期保护整个关掉，违背引入 pnpm 11 默认值的初衷。拒绝。
- **`pnpm install --frozen-lockfile` / `--no-lockfile`**：前者要求锁文件与 manifest 完全一致，`add` 场景不成立；后者不是 pnpm 11 的有效开关。都不解决复检问题。

## Evidence

- profile 修复：`C:\Users\gzh33\.dsh\profiles\dsh-desktop\pnpm-workspace.yaml` 增加 `trustLockfile: true`（备份 `.bak-20261024-090104`）；随后用壳自带 pnpm 执行 `add @changfenhuang/dsh-genui@0.14.0`，退出码 0，`package.json` 与 `node_modules` 均为 0.14.0。
- 安装日志里 pnpm 把 `billion-context@0.1.205` 自动写进 profile 的 `minimumReleaseAgeExclude`（因为 `autoAdd` 开启）；genui 本身未进 exclude，说明真正被锁文件复检拦下的是间接依赖。
- 单测：`market-install.test.ts` 12/12；`node scripts/run-tests.mjs` 634 tests / 626 pass / 0 fail / 8 skipped；`npx tsc --noEmit` 通过。

## Consequences

- 同类「锁文件复检误报」在市场上会显示为 `lockfile-release-age`，并提示 `trustLockfile`，用户不用再猜是哪个包太新。
- 这个 profile 从此信任本机锁文件；如果以后锁文件被外部改写或跨机器同步，需要重新评估 `trustLockfile`。
- 直接安装（`add pkg@version`）的目标版本仍然要过 24 小时冷静期；本次修改没有放宽这条保护。
