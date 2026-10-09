# DSH Desktop — Electron 壳（P0）

Tauri 壳（`../src-tauri/`）的 Electron 替代实现。两者**当前并存**：`src-tauri/` 未做任何改动，仍在正常构建与发布；本目录是迁移的 P0 脚手架。

技术验证结论与证据见 [docs/electron-p0-verification.md](../docs/electron-p0-verification.md)，迁移全案见 [docs/tauri-to-electron-migration.md](../docs/tauri-to-electron-migration.md)。

## 已实现（P0）

- 单实例锁（第二次启动聚焦已有窗口）
- 启动前三道闸门：`dsh --version` ≥ `0.1.2-alpha.2`、`dsh --help` 含 `--patch`、固定端口可用（占用时报出 PID/进程名与两条出路）
- 以 **Electron Node 模式**启动 `dsh web --patch <overlay> --host 127.0.0.1 --port <port> --no-open`（不需要系统 Node，也不需要 `cmd.exe` shim）
- 每次启动重写 overlay，注入 `../src-tauri/resources/dsh-desktop-shell/`（面板插件零改动复用）
- 三种加载模式：`cookie`（默认）、`token`（对齐 Tauri 版行为）、`proxy`（S2 实验，已否决）
- **更新通道**：读共享的 `latest.json` → 版本比较 → 带进度下载 → **minisign 校验落盘字节** → `/S --updated --force-run` 安装；更新窗口是本壳唯一能触发下载/安装的 UI
- **面板桥（P2）**：DSH 设置页「桌面端」可用——preload 提供窄 `__TAURI__` 事件兼容层，插件零改动；5 个白名单动作 + 状态回推
- **任务感知（A1）**：向 DSH 询问「现在停掉会打断什么」（`workspace/session-activity`），接进安装更新与退出确认；查不到按「可能有任务」处理
- **崩溃兜底**：渲染进程崩溃或 DSH 界面加载失败时显示启动页（含日志面板）并给出恢复路径（菜单「界面 → 重新加载界面」），不会只留一个白窗口
- **自绘标题栏**：无边框窗口 + 系统标题栏叠加（保留原生最小化/最大化/关闭与贴靠布局），标题栏由壳自己画：logo、产品名（固定不随页面变）、「应用 / 编辑」按钮（点开弹原生菜单）。原生菜单栏已移除，菜单不再单独占一行；托盘菜单只留「打开 / 关于 / 退出」三项；「关于」是原生对话框（应用图标、通道与 DSH 版本、端口、运行时长），不含用户数据路径这类内部信息——深度诊断走支持包
- **可诊断**：滚动日志 `shell.log`（512 KB 轮转）随进程存活；菜单「导出诊断信息…」产出一份 JSON（版本/通道/运行时/profile/窗口/遗留安装/日志尾部），**认证令牌与代理密码已剔除**
- **开发态隔离**：`pnpm dev` 用 `ai.deepseek.dsh-desktop.dev` 目录与 `dsh-desktop-dev` profile，绝不碰安装版的设置与状态（`DSH_DESKTOP_USER_DATA_DIR` 可覆盖回共享）
- **窗口几何记忆**：记住主窗口的位置与尺寸，只在与当前显示器布局仍相交时复用（拔掉外接屏后不会开到看不见的地方），已最大化状态一并恢复
- **旧版迁移**：首次运行检测遗留的 Tauri 安装，经用户确认后静默卸载
- **随包运行时**：安装包自带 dsh 生产依赖树 + `pnpm`（`resources/runtime/dsh`），**零环境安装**——PATH 里没有 dsh / node / git 也能跑；启动前校验完整性，构建期校验 Electron 与原生插件的 V8 指纹匹配
- **独立 profile**：壳引导 `--profile dsh-desktop`，首次运行从出厂 `web` profile 播种 bundle 与依赖，插件/锁文件/`node_modules` 与命令行的 `dsh` 完全隔离
- 启动页窗口（首帧后显示）、托盘、关于对话框、退出时回收 dsh 子进程
- 日志脱敏（一次性 token 一律 `token=***`，且**脱敏不参与导航**）
- 打包：electron-builder + NSIS，含把 Tauri 的 `/UPDATE` 翻译成静默安装的桥接宏

## 前置条件

- Node ≥ 22.12（本机用 v26.7.0）
- pnpm
- 已安装 DSH ≥ 0.1.2-alpha.2，且其 `--help` 含 `--patch`

## 命令

```bash
pnpm install            # postinstall 执行 install-electron 下载二进制（Electron 44 起无 postinstall）
pnpm typecheck          # tsc --noEmit
pnpm test               # 纯函数单测（node --test，直接跑 .ts）
pnpm build              # esbuild 打包到 dist/
pnpm dev                # 构建后启动（会显示真实窗口）
pnpm smoke              # 端到端冒烟（不显示窗口，打印 SMOKE_RESULT）
pnpm smoke:token        # 对照 Tauri 版加载行为
pnpm smoke:proxy        # S2a 实验
pnpm package:win        # 构建 NSIS 安装包到 release/（自动先备运行时 + 末尾校验）
pnpm package:dir        # 只产出 win-unpacked 目录（调试用）
pnpm runtime:prepare    # 单独备随包运行时（安装 → 裁剪 → 自证加载 → 写清单）
pnpm verify:package     # 校验打包目录里运行时完整（文件数 / 关键文件 / 入口）
node scripts/smoke.mjs cookie --isolate-home --packaged   # 让打包产物自己跑冒烟
pnpm release:dry        # 发布演习：签名 + 自校验 + 生成 latest.json，不上传
```

## 环境变量

| 变量 | 用途 |
|---|---|
| `DSH_DESKTOP_PORT` | 覆盖固定端口（默认 41729） |
| `DSH_DESKTOP_DSH_ENTRY` | 直接指向 `.../@deepseek-ai/dsh/lib/bin.js` |
| `DSH_DESKTOP_DSH_COMMAND` | 指向 `dsh` 可执行文件所在目录（否则从 PATH 解析） |
| `DSH_DESKTOP_BUNDLED_RUNTIME` | 随包运行时根目录（存在时优先于 PATH） |
| `DSH_DESKTOP_PLUGIN_PATH` | 直接指向面板插件入口 `dsh-desktop-shell/index.js` |
| `DSH_DESKTOP_DSH_HOME` | 给子进程设置 `DSH_HOME`，把 Harness home 与用户的 `~/.dsh` 隔离 |
| `DSH_DESKTOP_USER_DATA_DIR` | 隔离壳自身的 userData（设置、事实、overlay） |
| `DSH_DESKTOP_LOAD_MODE` | `cookie`（默认）/ `token` / `proxy` |
| `DSH_DESKTOP_UPDATE_MANIFEST_URL` | 覆盖更新清单地址（演习时指向某个 prerelease 的 `latest.json`） |
| `DSH_DESKTOP_SKIP_LEGACY_CLEANUP` | `1` 时不询问是否卸载遗留的 Tauri 版 |
| `DSH_DESKTOP_PROXY_ORIGIN` | `app`（默认）/ `loopback`（S2b 实验） |
| `DSH_DESKTOP_SMOKE` | `1` 时执行一次冒烟并打印 `SMOKE_RESULT` |
| `DSH_DESKTOP_PROFILE` | 覆盖壳自己的 profile 名（默认 `dsh-desktop`；不能是 `desktop`） |
| `DSH_DESKTOP_SMOKE_PATH` | 只给被冒烟的子进程替换 `PATH`——用于「零环境」验证 |

## 硬约束（改动前必读）

1. **Electron 必须精确锁定 `44.0.0`，不能写 `^44.0.0`。**
   dsh 的原生插件 `node-addon-require-builtin` 内嵌 V8 指纹白名单（`43.0.0` / `44.0.0` / `45.0.0-alpha.6` 对应的精确 V8 版本）。`44.4.5` 的 V8 是 `15.2.124.28`，与白名单的 `15.2.124.13` 不匹配，dsh 会以 `Unsupported/no-context` 直接退出。升级 Electron 前必须先确认 dsh 侧白名单。
2. **`--patch` 必须排在 web app 自己的参数之前**（`dsh web --patch <overlay> --host …`）。放在 `--host` 之后会被 commander 透传并报 `unknown option '--patch'`。
3. **脱敏只作用于日志，绝不参与导航**：曾出现「先脱敏、后解析」把 `?token=***` 交给页面导致停在 401。
4. **只绑定 loopback**，端口被占用即报错，不退回随机端口。
5. 面板插件的路由**不受** DSH 认证保护，因此插件自身做 Cookie 回探 + 同源校验 + 一次性 bootstrap token；本壳不额外放宽。
6. 预加载脚本只对**壳自有文档**（`file://` / `dsh-app://shell`）暴露 API，产品页不获得任何桥接口。
7. **安装参数必须是 `/S --updated --force-run`**：electron-builder 的 assisted 安装器只在 `${isForceRun} ${andIf} ${Silent}` 时自启应用（`installSection.nsh:106`），少了 `--force-run` 就会「装完但应用没回来」。桥接路径由 `installer-bridge.nsh` 的 `customInstall` 补上这一步。
8. **旧版检测不要用 `reg query /d` 搜值数据**：Tauri 的卸载项登记在**键名**上（键名即 `DSH Desktop`），必须枚举子键名；排除自己时要用**卸载器所在目录**，因为 electron-builder 不往卸载键写 `InstallLocation`。
9. **面板事件双白名单**：preload 只暴露 `event.emit` / `event.listen`，且事件名受限；主进程再校验发送方（主窗口主 frame + loopback 来源）与动作白名单。设置页要新增动作时，两处都要加。
10. **任务查询失败一律按 `unknown` 处理**，绝不当成 `idle`——把「查不到」当「没任务」会丢掉用户正在跑的 agent。
11. **改了 `runtime-pin.json` 或 `electron` 版本后必须重跑 `pnpm runtime:prepare`**：随包 dsh 的原生插件只接受白名单里的精确 V8 指纹，不匹配时 dsh 会以 `Unsupported/no-context` 启动失败。构建脚本会拦住这种情况。
12. **裁剪规则只做减法验证是不够的**：`prepare-runtime.mjs` 裁完必须跑通 `dsh --version` 与 `dsh web --help`。第一版规则里一个 `docs?` 就把 `yaml/dist/doc/directives.js` 删了。
13. **`extraResources` 指向的目录若根层有 `node_modules`，必须单独再加一条**，否则 electron-builder 静默不拷贝它、退出码仍是 0。`pnpm verify:package` 会抓住这个。
14. **profile 名不能叫 `desktop`**：dsh 的启动器硬编码保留该名字给官方 Electron 应用（引导与 `dsh plugin` 两处都拦）。我们用的是 `dsh-desktop`。
15. **`dsh plugin` 是把参数转发给 PATH 里的 `pnpm`**，所以随包运行时里带了 pnpm，并在 `runtime/dsh/bin` 放 `pnpm.cmd` / `node.cmd` shim（用应用自己的 Electron 以 Node 模式执行，不需要机器上第二个 Node）。**但壳自己调 pnpm 时不要走 shim + shell**：安装目录常带空格（`D:\Program Files\…`），`shell: true` 会把路径拆开并报 `'D:\Program' is not recognized`。用 `nodeExecutable + node_modules/pnpm/bin/pnpm.cjs`，`shell: false`。
16. **只把「这台机器上真的会执行的文件」算作关键校验文件**：`scripts/runtime-policy.mjs` 按目标平台推导外地 token 集合，外地二进制既随包裁剪、也不进校验集——把一个永不加载的 ARM64 文件算进去，真实用户就被挡在了门外。
17. **不要给已崩溃的渲染进程发 IPC**：`webContents.send` 到崩溃的帧会在 Electron 内部打出 `Render frame was disposed…`，`try/catch` 拦不住——用 `webContents.isCrashed()` 提前不发；状态留在模块里，新页面订阅时会自己拉。
18. **只在开发路径上验过的路径/命令行处理等于没验**：`electron/runtime` 没有空格，用户装到 `D:\Program Files\…` 才有空格；插件迁移因此静默失败了一整个版本。
19. **运行时进 ASAR 后，`asarUnpack` 的前缀是「源路径」而不是归档里的路径**：`asarUnpack` 用的是 `runtime/dsh/...`（appDir 相对），写 `dsh/...` 会**静默失效**——运行时照旧全打进 asar、一个都不 unpack，而 electron-builder 退出码仍是 0。清单的 `physical` 列表由 `prepare-runtime.mjs` 生成，`verify-package.mjs` 逐个断言它们真的落在 `app.asar.unpacked`。
20. **打包布局下 pnpm 的 JS 在 `app.asar` **里**，shim 在归档外**：`pnpm.cmd` 不能再用相对路径找 `node_modules/pnpm/bin/pnpm.cjs`（那是 `.cjs`，不会 unpack）。**而且 shim 一个环境变量都不能依赖**：DSH 在 spawn 子进程时会剥掉**所有 `DSH_` 开头的变量**（`dsh-subprocess` 的 `scrubbedParentEnv`），而它的插件安装器正是这样跑 `pnpm add` 的 —— `PATH` 还在、壳注入的 `DSH_DESKTOP_NODE_EXECUTABLE` / `DSH_DESKTOP_PNPM_ENTRY` 全没了，于是「安装插件」报 `DSH Desktop: cannot find the bundled pnpm`（真实用户报障）。shim 现在自己从安装位置推出应用二进制（`%~dp0..\..\..\..\DSH Desktop.exe`，兼容 debug 通道的 `DSH Desktop Debug.exe`）、自己设 `ELECTRON_RUN_AS_NODE=1`；环境变量只作首选提示。回归验证：`verify-package.mjs` 用**剥掉 `DSH_*` 的环境**实跑打包后的 shim。另外 `bundledPnpmEntry()` 必须在 asar 里找（`app.getAppPath()/dsh/...`），找到不存在的 `.unpacked` 路径会返回 `undefined`，于是**profile 插件安装被静默跳过**。
21. **从应用内部发起的构建会继承它自己运行时的 `PATH`**：`host-process.ts` 把随包 `bin` 前置给 dsh 子进程，于是 agent 会话/终端里跑 electron-builder 时，它探测到的 `pnpm` 是**应用的运行时 shim**，不是项目工具链。`release-electron.mjs` 因此给 electron-builder 传净化过的 PATH（剔掉含 `DSH Desktop` 的项）。
22. **通知桥的事件名是插件的 `tauriEventName`（`dsh-notify`），不是包名 `dsh-win-notify`**：`PANEL_EMIT_EVENTS` 两种都收，且 preload 会把被拒的名字报给主进程记一行日志。写错这类名字**两端都不会报错**——preload 的 `emit` 仍然 resolve，插件据此认为"壳已弹过"而不再回退浏览器通知，用户什么都看不到。回归验证：`DSH_DESKTOP_SMOKE_NOTIFY=1`（真实产品页里演练 emit，结果写 `notify-smoke.json`，期望 `accepted: 1, refused: 1`）。

## 更新通道

决议与完整证据见 [docs/update-channel-design.md](../docs/update-channel-design.md)。要点：

- 信任根沿用现有的 **minisign 密钥对**（私钥 `src-tauri/keys/dsh-desktop.key`，公钥在 `tauri.conf.json`），不采购代码签名证书。
- **一份 `latest.json`** 同时服务 Tauri 老客户端与 Electron 新客户端。
- `electron-updater` 在 `app-update.yml` 没有 `publisherName` 时**静默跳过验签**，所以它不能作为完整性依据；安装前必须由本模块的 `src/minisign.ts` 校验落盘字节。
- 老用户无感迁移：用同一把私钥给 electron-builder 的 NSIS 产物签名，写进老 `latest.json`。

```bash
pnpm test                # 含 minisign 校验的 5 项测试
pnpm minisign:check      # 真实产物往返：真钥签名 → 自校验通过 → 篡改被拒
```

## 目录

```
electron/
  src/
    main.ts             shell 编排：单实例、闸门、加载模式、窗口、生命周期
    gates.ts            三道闸门 + 端口占用者解析
    host-process.ts     dsh 子进程（overlay、就绪、脱敏日志、停止）
    dsh-output.ts       脱敏与认证地址解析（纯函数）
    dsh-runner.ts       Electron Node 模式的一次性命令执行
    desktop-files.ts    overlay 与 desktop-facts.json
    paths.ts            路径解析与运行时/入口定位
    settings.ts         复用 Tauri 的 shell-settings.json
    proxy.ts            S2 反向代理（保留 dsh-app://shell/ 文档路由）
    update.ts           清单解析、下载、minisign 校验、安装交接
    update-controller.ts 检查→下载→校验→安装 状态机
    update-window.ts    更新窗口
    legacy-cleanup.ts   检测/卸载遗留的 Tauri 版
    tray.ts             托盘
    preload.ts          窄接口 preload
    launcher/index.html 启动页
    update/index.html   更新窗口页面
  scripts/
    smoke.mjs           端到端冒烟运行器（支持 --packaged）
    release-electron.mjs 发布脚本
    installer-bridge.nsh NSIS 桥接宏
    minisign-roundtrip.mjs 签名往返验证
  electron-builder.config.mjs 打包配置
```
