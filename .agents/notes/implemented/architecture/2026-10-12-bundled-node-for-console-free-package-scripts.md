# Agent Note: 随包一个真正的 node，让 package script 不再弹控制台窗口

Status: implemented

## Problem

在 Windows 上，用户通过 dsh 跑 `pnpm run …` / `nest start` 这类命令时，屏幕上会**弹出命令行窗口**并抢走焦点，跑一条命令弹一次、一次可能弹两个（`pnpm` 的脚本 shell 一跳、脚本内部再拉的 shell 一跳）。

根因不在我们的壳、也不在 dsh 的 spawn 选项上，而在**进程子系统**：

- dsh 自己 spawn 子进程都带 `windowsHide`（= `CREATE_NO_WINDOW`），它拿到的是一个**没有窗口的控制台**，后代继承它就不会有窗口；
- 但 shim 把 `node` / `pnpm` 换成了**应用自己的 Electron**（`ELECTRON_RUN_AS_NODE=1`）。Electron 是 **GUI 子系统**程序、**没有控制台**，于是它下面每一个 `cmd.exe` 都必须**新建**一个控制台；
- Windows 11 把默认终端设为「Windows 终端」时，新建控制台会交给 Windows Terminal —— 肉眼看到的就是一个弹窗。`nest start` 的 `--shell` 默认 `true`（nest CLI `commands/start.command.js`），所以一跳变两跳。

**官方客户端同样如此**：`apps/desktop/scripts/node-bin/node.cmd` 的全部内容就是
`set ELECTRON_RUN_AS_NODE=1` + `"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*`。

## Decision

随包一个**真正的 `node.exe`**（`runtime-pin.json` 的 `node`，24.18.1，与 Electron 内置 node 同版本），并让 **pnpm 与 package script 都跑在它上面**：

- `runtime/dsh/bin/node.exe` 由 `prepare-runtime.mjs` 从官方 zip 下载，**先校验 `SHASUMS256.txt` 的 sha256**，再用 `tar`（bsdtar）只取 `node.exe` 这一个成员（npm/npx 不进安装包，pnpm 已随包）；
- shim 的解析顺序改为 `%~dp0node.exe` → `DSH_DESKTOP_NODE_EXECUTABLE` → 安装根目录的应用二进制 → PATH 里的 `node`。`PATHEXT` 是 `.COM;.EXE;.BAT;.CMD;…`，所以 `node.exe` 也会被 Windows 自己优先解析到；
- **真实 node 完全读不了 `app.asar`**，因此 pnpm 的 `node_modules/pnpm/bin` 与 `dist` 必须物理落盘：新增 `PHYSICAL_JS_TREES` 进 `physical` 清单（本次 62 → 487 项），`electron-builder.config.mjs` 照旧把它翻译成 `asarUnpack`；
- 控制台由此**被继承而不是新建**：dsh 给的不可见控制台 → shim 的 `cmd.exe` → `node.exe` → pnpm → 脚本的 `cmd.exe` → 脚本内的 `node.exe` → nest 再拉的 `cmd.exe`，全程同一个不可见控制台，零窗口。

回归验证（三处，任一处失配都要让构建/校验失败）：

1. `prepare-runtime.mjs`：随包 `node.exe --version` 必须等于 pin；**直接用随包 node 跑随包 pnpm**（无 Electron、无环境变量提示）；
2. `verify-package.mjs`：打包产物里断言 `app.asar.unpacked/dsh/bin/node.exe` 存在且版本与清单一致、pnpm 的 JS **确实解包**，并用随包 node（剥掉 `DSH_*`）实跑一遍 pnpm；
3. `verify-package.mjs` 原有的「剥掉 `DSH_*` 实跑 shim」保持不变 —— 它现在实际走的就是随包 node。

## Alternatives considered

- **只把 pnpm 的 JS 解包，仍用 Electron 跑**：对弹窗**零帮助**（弹窗取决于谁在跑，与文件在不在 asar 里无关），只白付 +426 文件 / +16.6 MB。解包只是"让真 node 能读 pnpm"的前置条件，不是解决方案。
- **R-A：给随包 pnpm 打一个 `windowsHide` 补丁（脚本 spawn 处）+ `node.cmd` 用真 node**：同样是零弹窗，且**不需要解包**（补丁让 pnpm 自己起的 `cmd.exe` 拿到不可见控制台）。放弃的原因是要长期维护一笔对第三方依赖的补丁（每次升 pnpm 重新验证、失配必须让构建失败），而且这正是应当由上游修的缺陷；相比之下，随包 node 是"用正确的进程类型解决问题"，不碰依赖代码。
- **R-B：解包 pnpm + 优先用机器上的 node（不随包）**：零体积增长，但把 package script 的执行环境绑到**用户机器上的 node 版本**上（不同机器行为不一、没有 node 的机器直接回退到弹窗）。放弃的原因是不确定性：我们无法承诺用户机器上有什么。
- **维持现状 + 让用户改配置**：`pnpm-workspace.yaml` 的 `shellEmulator: true` 确实能去掉 pnpm 那一跳（已实测；`.npmrc` 里的同名设置 pnpm 11 已不再读），但它换掉了脚本的 shell 语义 —— `%VAR%` 变成字面量且**不报错**、`del`/`if exist` 等 cmd 语法直接失败 —— 且管不到 `nest --shell` 那一跳，还会连带影响依赖的生命周期脚本。作为"用户可选"保留，不作为产品默认。
- **把 Windows 默认终端从 Windows 终端改回控制台主机**：仍是窗口（只是变成经典黑框），且是全局设置，影响用户所有终端。

## Consequences

- **代价**：安装包 +约 21 MB（`node.exe` 88.3 MB 解压 / LZMA 后 22.9 MB），**每次更新下载同样 +21 MB**（我们发完整安装包）；安装后磁盘 +88.3 MB；物理落盘文件 62 → 487（安装耗时小幅回升，相对当初 12,573 → 84 的收益仍然很小）。另外要维护 node 的版本 pin（安全更新）、把它纳入签名与校验、并在分发中保留 Node.js 的 MIT 许可声明。
- **收益**：零弹窗，且**不依赖用户机器上有 node**；package script 的执行环境变得确定（固定 24.18.1，与 Electron 内置 node 同版本）。
- **边界**：dsh 宿主本身仍跑在 Electron 上；profile、插件链接、更新通道、面板与浏览器功能都不受影响。爆炸半径只有"pnpm / package script"这条路径。
- **与官方的关系**：官方客户端用同一个 Electron-as-node 设计，因此同样存在弹窗；这条是本项目**有意偏离**官方的一处，若将来官方或 pnpm 侧修好（pnpm 在无控制台父进程下 spawn 脚本应带 `CREATE_NO_WINDOW`），可以退回到不随包 node。
