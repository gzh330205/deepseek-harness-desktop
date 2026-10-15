# Agent Note: 壳内插件市场（自建薄市场，绕开 dsh-market 的安装链）

Status: implemented

## Problem

插件市场曾是唯一一条**断掉的核心路径**：dsh-market 的安装/更新链路在 DSH Desktop 上以 `spawn D:\Program Files\DSH Desktop\DSH Desktop.exe ENOENT` 失败。

定位过程与已确证的事实：

- **ENOENT 不是文件缺失**：同一个 exe，只要给 spawn 一个**不存在的 `cwd`**，Node 就报出与用户日志逐字一致的错误；正常 `cwd` 下 `status=0`。
- **不是 market 的代码**：在 market 唯一的 spawn 出入口（`spawnShim`）插桩后重试，`shell.log` 里 **0 行**命中。
- **是 dsh 侧的 spawn**：`@deepseek-ai/dsh-plugin-manager` 有 11 处 `spawn(…, { cwd: dir })`，`dsh-web-app` 还会 `spawn(process.execPath, …)`（把 GUI 壳 exe 当 node 用）—— 与"报错里出现 `DSH Desktop.exe`"吻合。market 只是转发子进程错误。
- 三次注入探针都失败（应用带 `NODE_OPTIONS` 启动、终端里 `NODE_OPTIONS`+`ELECTRON_RUN_AS_NODE`、把追踪器当主入口），所以**具体那个 `cwd` 至今未拿到** —— 这一点如实保留为未解。

与此同时，壳自己有一条**实测可用**的路径：`bin/node.exe` + `node_modules/pnpm/bin/pnpm.cjs`，`cwd` = profile，`shell:false`（本次实测 `pnpm update` 退出码 0）。

## Decision

做一个**薄市场**，三层各写各的，只有中间一层必须自写：

| 层 | 文件 | 关键决定 |
|---|---|---|
| 目录 | `electron/src/market-catalog.ts` | 用 **npm registry 搜索**，准入判据是"包声明了 `dsh.bundle.patch`"；整族 `@deepseek-ai/dsh*` 视为平台自身不入列；命中不等于插件，每个候选都要用自己的 packument 确认；spec 一律 pin 到精确版本 |
| 安装 | `electron/src/market-install.ts` | `add name@version` / `remove name`；装完**登记 `dsh.profile.bundles`**（profile 真正加载的补丁层列表）；**pnpm 失败时绝不写 manifest**；失败按 store/git 构建许可/网络/registry 404/workspace 分类，未分类也保留首个 `ERR_` 行与完整输出 |
| 适配 | `electron/src/market-service.ts` | 真实 `fetch`（超时 + UA + 非 2xx 抛错）、真实 `node.exe + pnpm.cjs + shell:false` spawn（stdout/stderr 合并、尾部限长、超时终止）、profile `package.json` **原子写** |
| 界面 | `src/market-window.ts` + `src/market-ui/index.html` + `preload` 桥 | 壳的**原生窗口**，入口是标题栏**「插件」菜单**下的两项：「插件市场…」与「已安装的插件…」（同一个窗口两个视图，视图随菜单切换；`hash` 决定首屏）。CSP `default-src 'none'`（页面自己不能发网络请求）；展示只用 `textContent`/`createElement`；每个 handler 先校验 sender 归属 |
| 分页筛选 | `market-catalog.ts` + 界面控制条 | npm 搜索的 `from`/`size` + 我们自己的排序与筛选；**翻页要填满**：命中里大多不是插件，所以一次搜索会连走多个 registry 页直到凑满一页（否则第二页看起来是空的） |
| 日志 | `electron/src/market-log.ts` | 每次装/更新/卸载记一条 JSONL（含失败的分类、message、pnpm 输出尾部），50 万字节转一代，坏行容忍，**写日志失败绝不影响安装** |
| 诊断 | `electron/src/market-conflict.ts` | 只报**能从本地事实证明**的矛盾（见下）；读取器只读，插件的传递依赖不算"残留" |

## Alternatives considered

- **fork dsh-market 整包（MIT，合法）**：最强理由是它就是成品——浏览/搜索/一键安装/兼容性/地区/备份/恢复全都有（6582 stars，仍在更新），改一处就能用。放弃原因：① 我们要修的安装层正是它最重的部分（`src/routes.ts` 363 KB、`client/client.js` 770 KB、`src/profile.ts` 75 KB…整包数 MB）；② 它的 UI 嵌在 DSH 页面里，而**需要装插件的时候往往正是 DSH 页面不工作的时候**，把救援通道绑在故障面上是设计倒置；③ 我们无法为它其余全部行为负责。
- **只修上游的 spawn 缺陷**：最强理由是成本最低、修好后用户直接拿到完整功能。放弃作为主方案是因为缺陷在第三方代码与 dsh 自身里，我们能提 issue 但无法保证时间；**保留为并行动作**（证据已整理：错误原文、`dsh-plugin-manager`/`dsh-web-app` 的 spawn 位置、最小复现步骤）。
- **继续只给命令行方案**：最强理由是零开发量且已验证可用。放弃原因是它只能装普通 npm/git spec——市场里像 `billion-context` 这种**只存在上游 catalog** 的条目根本装不了，等于把"找插件"和"装插件"都丢给用户自己拼。
- **让 dsh 宿主改跑随包真 node（原方案 A）**：曾被当作"治本"，实测后撤回——ENOENT 与"用哪个 node"无关（是 `cwd`），换了也一样失败。

## Consequences

- 装/更新/卸载不再经过 dsh 的子进程 spawn，**不受该缺陷影响**；失败带分类原因、处置提示、pnpm 原始输出与"复制诊断信息"。
- **冲突诊断只报可证明的矛盾**（`market-conflict.ts`）：声明了却没装（error）、装了却没登记进 `dsh.profile.bundles`（"装了但没生效"的半状态）、`node_modules` 里的残留、bundle 列表重复、平台包被当插件装、声明版本与实际不符（info），以及两类会让所有安装都失败的环境问题（profile 落在 pnpm workspace 之下、`node_modules` 的 store 主版本与随包 pnpm 不一致）。**能力冲突只取可读形式**：插件自己的补丁文件里缩进为 0 的顶层键＝它声明要改的挂点，两个插件写同一个键就报 `capability-overlap`（warn，因为 DSH 允许多层补丁，用户需要知道的是"两个插件在这里相遇"）。**任何需要猜的（例如"谁抢了某个工具名"）一律不报** —— 诊断报错报多了比没有更糟。
- **一条给未来的教训**：诊断里的版本前缀解析用**扫描**而不是 `-` 字符类正则。这个仓库的文件常被脚本改，一层多余的转义会把 `\\d` 变成 `\\\\d`、让分类器静默失效（实测发生过，被单元测试抓到）。
- 市场只收录声明了 `dsh` 字段的包，且把"要装的 spec"原样展示；供应链风险被限制在"来源明确 + 准入字段"两条上，而不是靠上游 catalog 的隐藏规则。
- **只读到 dsh 插件（`bundle.patch`）这一半**：插件若还要求运行时预装、或依赖上游 catalog 的归一化（如 `billion-context`），本市场目前装不到 —— 这是已知边界，不是 bug。
- 上游若修好 spawn 缺陷，本市场依然有效（更薄、更贴近壳）；届时应以"壳内市场"为唯一入口，避免两套 UI 造成困惑。

## Evidence

- 单元测试：目录层 14 条（含"翻页填满"与"未请求的名字不发 packument"）、安装层 10 条、适配层 13 条（含"真实随包运行时跑 `pnpm --version`"、分页请求转发、日志往返与坏行容忍、`checkUpdates` 对 link 依赖不猜）、诊断 14 条（含"不该说什么"：传递依赖不是残留、自己的挂点不算重叠）、日志写法 1 条；失败路径均有断言（失败不落盘、未分类失败保留错误行、平台包在取 packument 前即被拒）。
- **端到端**（`DSH_DESKTOP_MARKET_E2E=1` 开启，默认跳过）：真实随包 node + pnpm 把 `dsh-win-notify@0.1.0` 装进临时 profile → 断言 `dependencies` 与 `dsh.profile.bundles` 双双写入 → 卸载后双双复原；不存在的版本 → 失败被分类且 profile 未被改动。实测两条通过（1460ms / 1741ms）。
- 套件：323 条 / 313 通过 / 7 条既有 blake2b 失败；`tsc` 干净。
- **页面内联脚本单独 `node --check`**（从 `index.html` 抽出 `<script>` 再检查）：窗口 smoke **抓不到**内联脚本的语法错（页面照样 `did-finish-load`），这条检查抓到过一次真实故障（`\`n` 被写成了字面量导致脚本未闭合）。发版前固定跑。
- 打包：`verify-package` 新增断言（市场页面、preload 桥、main.js 的市场频道必须在 asar 内），`build` + `--dir` + `verify-package` + 打包态 smoke 全通过。
- **窗口能真的打开**（`scripts/smoke-market.mjs`）：壳支持 `DSH_DESKTOP_OPEN_MARKET=1` 的验证钩子在启动时开窗，窗口在 `ready-to-show` 与 `did-finish-load` 各记一行日志，smoke 断言两行都出现、且没有 `did-fail-load`。实测输出 `{"ok":true,"markers":["market window ready","market page loaded"]}` —— 而且全程**没有用到 DSH 服务**，这正是"市场必须是壳的面板而不是 DSH 页面里的插件"的实测依据。
  （`DSH_DESKTOP_OPEN_MARKET` 是验证钩子，不是用户功能：菜单项本身仍需要人点。）
