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

## 第二批：浏览改走社区目录，界面重做

### 目录源：npm 搜索 → 社区精选目录

**换的原因（用户一句"人家的市场一打开就有一堆插件，我们的打开是空的"）**：npm 搜索的形状是"命中里大多是噪声，每个候选还要单独取 packument 确认"——所以第一版必须写"翻页填满"这种补丁，且打开时要等一串请求。**真实上游源码**（解包 `dshmarket@1.66.27` 阅读，非凭印象）给了答案：`lib/regions.js` 定义 `CATALOG_OFFICIAL = https://awesome-dsh-plugin.com/plugins.json`，README 写明**每次打开都实时请求**；该文档实测 5.79 MB / 4765 条，每条自带 `category`、`stars`、`downloads`、`npm` 映射、`capabilities`，顶层还有分类词表——**一次请求**即可铺满列表并在本地完成筛选/排序/搜索。

- 放弃「保留 npm 搜索为主」：最强的理由是它零新依赖且已验证；但它是"搜索"而非"浏览"，用户打开看到空列表正是它的形状决定的。
- 放弃「本地目录快照兜底」：上游自己明确拒绝（过期目录会把今早刚发布的插件答成"不存在"，错答比慢答更糟）。我们同样只在内存里缓存 10 分钟，不落盘。
- 目录是**外部输入**：逐条校验、坏条目丢弃、绝不用于准入——装的时候仍由我们自己确认包声明了 `dsh.bundle.patch`。
- 分类词表的真实形状是**对象映射** `{id: {en, zh}}`（自带中文名），且以条目实际用到的分类为准补齐（不能出现"点了没结果"的 chip）。

### 打包态两个 spawn 失败（都在用户机上实测到）

1. `spawn …\resources\app.asar\dsh\bin\node.exe ENOENT`：Electron 的 `fs` 能读归档，于是 `existsSync` 说"在"，但 `spawn` 是真实系统调用、进不了归档。**凡是要启动的东西都必须取归档的物理孪生 `app.asar.unpacked`**。之前没发现，是因为市场所有测试都跑在开发树（路径本来就物理）——现在加了打包态自检：用市场真正会用的那套解析跑 `node pnpm.cjs --version`，成功才写 `market runtime ok`。
2. 新装应用立刻开市场时 `pnpm 没能启动`：安装发生在壳 seed profile **之前**，`cwd`（= profile 目录）不存在，而 spawn 在 `cwd` 缺失时报的是**可执行文件名**——错误信息看起来像"运行时缺失"。市场现在动手前先 `mkdirSync(profileDir)`。

### 界面：四个只有"看"才能发现的 bug

1. 分类 chips 显示 **0 个**：见上（对象映射被当字符串数组解析）。
2. 分类换成 4 行、列表只剩一条缝：页面里**有两个 `<style>` 块**，body 里那个把 `.chips` 重新声明成 `flex-wrap: wrap`，覆盖了头部的单行滚动规则。
3. 切到「已安装」仍残留排序/筛选/分页：`[hidden]` 是 UA 规则，**打不过作者样式里的 `display: flex`**——`node.hidden = true` 对 flex 容器无效。现在全局 `[hidden] { display: none !important }`，并按整块 `.market-only` 切换。
4. "页面加载成功但什么都没画"无法被察觉：脚本在首次绘制前抛错时，`did-finish-load` 照样触发、smoke 照样绿。现在页面通过 `market:note` 通道自报 `market ui rendered N cards of M`，smoke 把它列为必需标记。

### 为了让界面可被验证而加的工具

- `scripts/preview-market.mjs`：用**真实目录数据** + 打桩 `__DSH_MARKET__` 桥把同一份 `dist/market/index.html` 渲染到浏览器里，于是"好不好看"可以截图评审而不是靠想象（市场是 Electron 窗口，截图工具看不到它）。
- `src/market-ui.test.ts`：把上述四个 bug 变成静态守卫（只能有一个 `<style>`、`[hidden]` 兜底存在、`.catbar` 不得 wrap、脚本查的每个 id 必须存在于标记、市场控件必须按 `.market-only` 整块切换、页面必须自报渲染、CSP 保留且脚本不得出现 `fetch`/`innerHTML`）。
- 界面本身：设计令牌（OKLCH 颜色 / 间距 / 圆角 / 字号 / 时长）、头部三行内解决（标题+profile、标签页、工具栏）、分类栏单行横向滚动、列表占满剩余高度、卡片分层次（名称+分类+状态 → star/下载/作者 → 两行描述 → **能力标签，碰机器的能力用琥珀色警示**）、空结果与骨架屏、按钮/输入/chip 的 hover·active·focus-visible·disabled 态、`prefers-reduced-motion`。

### 证据（本批）

- 套件 **340 / 330 / 7**（当时 7 条为既有 blake2b 失败；这 7 条已不复现，当前实测见第四批证据），`tsc` 干净；页面内联脚本单独 `node --check` 通过。
- 打包态 smoke（`--install dsh-win-notify@0.1.0`）实测六标记全中，`shell.log` 证据链：
  `market window ready` → `market page loaded` → `market runtime ok pnpm 11.7.0` → `market install ok dsh-win-notify@0.1.0` → `market catalog ok 4765 entries, 40 on page` → **`market ui rendered 40 cards of 4765`**。
- 界面截图（侧边栏浏览器渲染同一页面）：市场视图与「已安装」视图各一张，确认分类栏、列表可视区与"已安装视图无市场控件"。

## 第三批：GitHub 源安装（既不在目录的 npm 映射、也不在 registry 的插件）

**为什么必须补这条路**：用户的原话是"我还需要安装一些 github 上的插件，可能既不在目录里，也不在 registry 中"。社区目录 4765 条里 **2347 条只做 GitHub 发布**（实测：`dsh-prompt-polish`、`dsh-quality-review`、`dsh-outswourcing-expert`…），npm 永远搜不到它们。

**三条实测事实撑起整个设计**（都是先验证再动手）：

1. **目录已经给出上游使用的 spec**：`dsh plugin --profile web add github:CAI-MH/dsh-quality-review`、`… add "https://github.com/<owner>/<repo>/releases/download/v0.2.3/<name>.tgz"`、`…/releases/latest/download/<name>.tgz` 三种。所以市场按目录原样安装，不猜 ref：目录给 tarball 就用 tarball，给 `github:` 就用 `github:`。
2. **装前可以准入**：`https://raw.githubusercontent.com/<owner>/<repo>/HEAD/package.json` 对公开仓库返回 200 且含 `name` 与 `dsh`——抽查 8 个"仅 GitHub"条目，**8/8 都声明了 `dsh.bundle.patch`**，所以准入门槛不需要为 GitHub 放宽。
3. **登记的必须是仓库声明的包名**：抽查里 `portable-dsh-multi-agent-plugin` → 真名 `portable-dsh-multi-agent`、`dsh-workspace-menu` → `@dsh-external/dsh-workspace-menu`、`dsh-prompt-polish` → `@benrong/dsh-prompt-polish`。harness 按 `dsh.profile.bundles` 里的名字加载，登记目录条目名等于装了一个永不加载的插件。

**顺序是安全性质，不是实现细节**：先读仓库 manifest 并准入，再启动 pnpm。不是插件就**一个字都不动 profile**（装完再卸载会在中间留下半登记状态，而半登记的 bundle 会让 harness 起不来）。

**安装脚本必须说清楚**：清单声明 `preinstall/install/postinstall/prepare` 时，界面写出"会在你机器上执行安装脚本（…）"，并把按钮换成"确认执行安装脚本并安装"，必须再点一次（不弹窗）。`prepublishOnly`/`prepack` **不列入**——它们只在发布/打包时运行，把它算进去就是一次假警报，而假警报会教会用户忽略警报（这是实现里踩到并改掉的）。

**放弃的方案**：①"让用户在命令行自己 `dsh plugin add github:…`"——零开发量，但把"找插件"和"装插件"又丢回给用户，且失败时没有分类原因；②"装完再验证是否声明 dsh，不是就卸载"——会在 profile 里留下中间状态，违反本项目"pnpm 失败/不是插件时绝不改 profile"的硬约束；③把 GitHub 仓库整体 clone 下来自己读——比一次 raw 请求重得多，而且判定所需信息只有 package.json。

**证据**：真实网络 + 真实随包 pnpm 的 gated E2E（`DSH_DESKTOP_MARKET_E2E=1`）——`github:CAI-MH/dsh-quality-review` 装成（11.4 s）、`dependencies` 以声明名记录、`dsh.profile.bundles` 同名登记、卸载后双双复原；非插件仓库（`jonschlinkert/is-odd`）被拒且 profile 未变。打包态 smoke 新增 `--github`：`market github install ok dsh-quality-review (github:CAI-MH/dsh-quality-review)`，以及目录原样 tarball spec 的 `market github install ok @benrong/dsh-prompt-polish (…tgz)`——两种 spec 形状都在打包后跑通。

## 第四批：冲突诊断的误报（真机 profile 上十几条黄条把真问题埋了）

**为什么改**：用户在真机上打开「已安装的插件」，看到一片警告，里面**没有一条是真问题**：

- profile 自己的 `pnpm-workspace.yaml` 被判成致命（error）「workspace 接管」——但 pnpm 11 正是把设置（`nodeLinker`、`onlyBuiltDependencies`）放在这个文件里，**profile 拥有它是正常的**；
- harness 给每个 profile 自播种的包（`@deepseek-ai/dsh-base`、`dsh-web-app`、experimental profiles）在 `node_modules` 里，被报成「残留」；
- 由**别的插件管理器**装的插件（profile 里带着 `.dsh-market` / `.plugin-manager` 的状态）同样被报成「残留」；
- 插件把补丁写成 YAML 列表（`- insert:`）时，**列表项被当成顶层挂点键**，于是一整族插件看起来都改了同一个挂点——一条吓人且错误的结论。

「诊断报错报多了比没有更糟」是第一批就定下的原则，所以这一批只做**收窄**，不加任何新检查。

**五条收窄**（全部在 `market-conflict.ts`）：

1. 不再只看「有没有 `pnpm-workspace.yaml`」，而是读它的**上下文**：`inProfile`（是否就在 profile 目录里）与 `packages`（它声明的成员）。profile 自己的、且只声明 `.`（或根本没声明 packages）＝**跳过**；profile 自己的但把别的目录拉进来＝warn；**祖先**目录里的＝error 原样保留——它真的会把 profile 的安装连 store 一起接管。
2. `isPlatformPackage` 命中的包一律不参与「残留」判定：harness 自播种的包必然出现在 `node_modules` 而不在 `dependencies` 里。
3. 已登记进 `dsh.profile.bundles` 的也不算残留——那是「本 profile 会加载它」的另一半证据。
4. `orphan-install` 从 warn 降为 **info**：本地事实只支持「没人声明它」，不支持「它是残留」；hint 里直接写明「如果是别的插件管理器装的，这属于正常」。
5. `readPatchKeys` 跳过以 `-` 开头的行：列表项不是挂点键。

**不引 YAML 解析器**：这里只需要顶层 `packages:` 下的 `- <glob>`，一个扫描器（遇到另一个顶层键就结束、剥掉引号）就够；读不出来就当「没声明成员」，也就是**不会**因为解析失败而误报。

**放弃的方案**：① 保持 warn、只在文案里加一句「可能是别的管理器装的」——最强理由是严重级别不变、信息最全；放弃是因为黄条的数量本身就是噪声源，用户看到的就是一片黄。② 直接删掉 `orphan-install`——最强理由是零误报；放弃是因为「确实没人声明」对排查半登记状态仍有用，降级保留比删掉划算。③ 引一个 YAML 依赖把文件解析准——最强理由是正确性；放弃是因为市场至今零新依赖，而这里要的只是一个列表。④ 只要 profile 里有这个文件就整块跳过——最强理由是彻底消除误报；放弃是因为**祖先**目录的 workspace 是真会把安装接管走（连 store 一起换），必须报。

**代价与收益**：正常 profile 安静下来（真机实测只剩 6 条 info、0 warn、0 error）；代价是「别的管理器装的插件」不再被升级为警告，用户得自己到市场重装一次才会登记进 `dsh.profile.bundles`——这一点写进了那条 hint 里。

**证据**：

- 新增 gated 用例 `market-conflict-profile.test.ts`（`DSH_DESKTOP_MARKET_PROFILE=<profile 目录>` 才跑，因为它读的是「只有跑过应用的机器上才有」的路径）：对真实 profile 断言「正常的东西不被报警」。
- 离线单测 +69 行（workspace 上下文、平台包、bundle 登记、补丁列表项各一条），并保留「该报的还是要报」的反向断言。
- 实测（2026-10-16）：默认 361 条 / 355 通过 / 0 失败 / 6 跳过；`DSH_DESKTOP_MARKET_E2E=1` 下 360 通过 / 0 失败 / 1 跳过；真实 profile 那条单跑通过（输出 6 条 info）；blake2b + minisign 8 条全过。
