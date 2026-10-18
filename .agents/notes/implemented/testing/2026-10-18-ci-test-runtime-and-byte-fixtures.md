# Agent Note: CI 用两个运行时跑同一套测试，签名 fixture 必须钉住字节

Status: implemented

## Problem

2026-10-12 退役 Tauri 壳（`6f0ebcb`）时，`.github/workflows/ci.yml` 从「`pnpm build` + `cargo check`」改成了
「`tsc --noEmit` + 在 Electron 运行时里跑全部单测」（`ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/run-tests.mjs`）。
从那一刻起每个 push 的 CI 都红（10 个测试失败），原因有两类，互不相干：

1. **运行时差异**：Electron 的 Node 用 BoringSSL，没有 OpenSSL 的 BLAKE2b。
   `blake2b.test.ts` 的参照实现直接 `createHash('blake2b512')`，在 Electron 里抛
   `Digest method not supported`，7 个测试连断言都没走到。
2. **checkout 字节差异**：`electron/src/fixtures/artifact.txt` 是 minisign 签名覆盖的**原始字节**，
   但仓库没有 `.gitattributes`。CI runner 的 `core.autocrlf=true`（本机系统 Git 配置也是）在 checkout 时
   把它变成 CRLF，签名对不上：`minisign.test.ts` 2 个 + `update.test.ts` 1 个验证测试失败。

本地一直绿，因为开发者跑 `pnpm test`（系统 Node + 工作树里已存在的 LF fixture），CI 跑的是 Electron + 全新 checkout。
同一套测试在两个环境里结论不同，CI 的红色就只是噪音：它既没证明代码坏，也没人再去修。发布本身不受影响——
发布由本机 `electron/scripts/release-electron.mjs` 执行，CI 不产出任何资产——但「每次提交收失败邮件」成了固定成本。

## Decision

1. **CI 跑两遍同一套测试**。先 `pnpm test`（Node，和开发者一致，OpenSSL 的 BLAKE2b 作为独立 oracle），
   再用 Electron 的 Node（`ELECTRON_RUN_AS_NODE=1`）跑一遍。前者保证有参照物，后者保证 app 真实运行时的
   行为也成立——BoringSSL 缺 BLAKE2b 正是曾经让安装包验签整体失效的那类差异，不能因为「本地 Node 能过」就丢。
2. **`blake2b.test.ts` 变成运行时感知**。OpenSSL 在就与 OpenSSL 对照；不在就把依赖 OpenSSL 的对照标
   `{ skip: … }`，而 RFC 7693 向量、「高位字节计入」「128 字节整块不补零块」这些回归断言在任何运行时都执行。
   辅助函数测试改成「与当前运行时可用的实现对齐」。
3. **新增根 `.gitattributes`**：`electron/src/fixtures/** -text`。这些文件的内容是签名输入，
   checkout 时任何行尾转换都会让签名测试失效。

## Verification

- 本机 Node 24.18.1：`node scripts/run-tests.mjs` → 529 pass / 0 fail / 8 skipped。
- 本机 Electron 44（`ELECTRON_RUN_AS_NODE=1 electron scripts/run-tests.mjs`）：525 pass / 0 fail / 12 skipped
  （多出的 4 个就是被跳过的 OpenSSL 对照）。
- 连不上 OpenSSL 的运行时不再抛异常：修复前同一条 Electron 命令是 7 fail。
- `core.autocrlf=true` 的模拟 checkout：修复前 `artifact.txt` 是 40 字节（CRLF）且 minisign 测试失败；
  加上 `.gitattributes` 后是 39 字节（LF），整套测试通过。
- `tsc --noEmit` 干净。

## Alternatives considered

- **CI 只跑 Node（等价 `pnpm test`）**：最小改动，但放弃 app 真实运行时的检查。BLAKE2b 缺失这类问题只在
  Electron/BoringSSL 下暴露，而它恰好是本仓库踩过的真事故（更新下载后验签全部失败）。放弃。
- **只跑 Electron，把期望摘要硬编码进测试**：能过 CI，但没有独立参照物——手写 128 位十六进制常数等于把实现
  自己的输出抄一遍，测试失去意义，换输入还要重算。放弃。
- **fixture 改成 base64 文本或在测试里生成**：仍然需要「字节不被转换」这条保证；base64 只是把二进制藏进
  文本，反而让人看不出它是签名输入。放弃。
- **CI 里关掉 `core.autocrlf`**（checkout 后改配置再 reset）：只治 CI，治不了任何新 clone 的开发机
  （本机系统 Git 就是 `autocrlf=true`），而且依赖 runner 细节。放弃。

## Consequences

- CI 时间约翻倍（两遍单测，各约 1 分钟）；换来「本地能过 = CI 能过」，且 app 运行时仍有覆盖。
- 测试文件从此必须运行时无关：新增测试若只能在一个运行时跑，要用 `{ skip: … }` 说明，而不是假定 Node。
  `blake2b.test.ts` 是范例。
- `.gitattributes` 成为契约：以后任何被签名/哈希覆盖的 fixture 入仓，都要 `-text`（或放进
  `electron/src/fixtures/`）。否则只有全新 clone 上才会红，最难查。
- 发布通道不受影响，也说明 CI 红从来不是「在线构建坏了」：发布在本地执行，CI 只做校验。
  根 `README.md` 与 `AGENTS.md` 里「CI 仅做 `pnpm build` + `cargo check`」的说法已过期，需另行清理。
- 发布脚本自己仍不跑测试/类型检查（`release-electron.mjs` 只构建、验包、签名），测试回归不会被发版拦住；
  这是另一个决定，本次未做。
