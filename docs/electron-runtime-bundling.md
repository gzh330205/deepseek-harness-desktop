# 随包运行时（D3 落地）验证记录

> 执行时间：2026-09-28
> 代码位置：`electron/scripts/prepare-runtime.mjs`、`electron/src/runtime-tree.ts`、`electron/scripts/verify-package.mjs`
> 关联：[迁移评估](tauri-to-electron-migration.md) 4.6 · [更新通道设计](update-channel-design.md) · [P3 验证](electron-p3-verification.md)

## 0. 结论

**零环境安装达成。** 打包产物在 `PATH` 只剩 `C:\Windows\System32;C:\Windows`（没有系统 dsh、没有 Node、没有 git）时仍能完整启动 DSH 界面，运行时来自应用自己的随包运行时。

> **2026-09-30 更新**：运行时已从 `resources/runtime/dsh/**`（12,439 个松散文件）改为**打进 `resources/app.asar`**（1 个文件）+ 58 个必须物理落盘的文件，安装时创建的文件数从 **12,573 降到 84**。设计与实测见 §10；下表的路径按当时（loose）记录。

| 指标 | 数值 |
|---|---|
| 定向安装后的 dsh 树（含 pnpm） | 472.8 MiB |
| 裁剪后（随包） | **360.9 MiB**，12489 个文件（移除 13844 项 / 111.9 MiB） |
| 解包后的应用目录 | 约 700 MiB（Electron 320 + 运行时 361 + 其他） |
| **NSIS 安装包** | **188.6 MiB**（不含运行时 97.6 MiB；运行时净增约 88 MiB，随包 pnpm 约 3.4 MiB） |
| 关键校验文件 | 31 个（入口 + 2 个工具 shim + 全部原生模块） |

> 为此对照一下：官方桌面端约 1 GB。我们 188.6 MiB 且完全自给自足。

## 1. 运行时是怎么造出来的

`scripts/prepare-runtime.mjs`（`pnpm runtime:prepare`，也被两个打包脚本自动调用）：

1. 读 `runtime-pin.json` 的 pinned 版本（当前 `0.2.0-rc.1`），在 `.runtime-build/` 里
   `npm install --omit=dev --os=win32 --cpu=x64`（按目标平台安装，跳过其他平台的可选依赖）；
2. **构建期护栏（最关键的一条）**：用随包的 Electron 二进制问出自己的 V8 指纹
   （`ELECTRON_RUN_AS_NODE=1 electron.exe -p process.versions.v8` → `15.2.124.13-electron.0`），
   再去随包 dsh 的 `node-addon-require-builtin` 预构建二进制里找这个字符串，**找不到就中止构建**。
   这正是 S1 阶段那个「dsh 以 `Unsupported/no-context` 启动失败」的失败模式，现在在构建期就被拦住；
3. 复制到 `runtime/dsh/`，**在副本上裁剪**（见下），然后**自证能加载**；
4. 写 `desktop-runtime.json`：版本、平台、Electron/V8、文件数、列表摘要，以及 23 个关键文件的
   sha256（dsh 入口 + 每个 `.node` / `.dll` / `.exe`）。

裁剪策略（刻意保守）：

| 移除 | 说明 |
|---|---|
| `*.d.ts` / `*.d.mts` / `*.d.cts` | 类型声明，运行期不需要 |
| `*.map` | source map |
| `src/**/*.ts` | 包内源码（运行的是 `lib/*.js`） |
| `*.tsbuildinfo` | 构建缓存 |
| `tests` / `__tests__` / `__mocks__` 目录 | 测试 |
| 其他平台预构建目录 | `darwin-*` / `linux-*` / `android-*` / `win32-arm64` / `win32-ia32` |

**不碰 `docs`/`doc` 目录**——第一版规则里写了 `docs?`，把 `yaml/dist/doc/directives.js` 删了，
dsh 启动即 `Cannot find module '../doc/directives.js'`。这正是下面那条自证步骤存在的理由。

## 2. 三个只有真打真跑才会暴露的坑

### 2.1 裁剪删掉了运行期文件（已修 + 已加护栏）

```
dsh: fatal load failure: Error: Cannot find module '../doc/directives.js'
  Require stack: …/runtime/dsh/node_modules/yaml/dist/compose/composer.js
```

规则 `docs?` 匹配到了 `yaml/dist/doc/`。修法有两层：

- 收窄规则（去掉 `docs?`、`fixtures`、`*.md` 这类「看着像文档就删」的项）；
- **裁剪后立刻自证**：用随包 Electron 跑 `dsh --version` 与 `dsh web --help`，任何一个失败就中止构建。

### 2.2 electron-builder 静默不拷贝 `node_modules`（已修 + 已加护栏）

`extraResources` 指向 `runtime/dsh` 时，只拷了 `desktop-runtime.json` 一个文件，
**退出码仍是 0**，日志也没有任何警告——因为 electron-builder 会排除源目录根的 `node_modules`
（官方配置里那句注释就是这个坑）。解法是给 `node_modules` 单独加一条：

```js
{ from: 'runtime/dsh', to: 'runtime/dsh' },
{ from: 'runtime/dsh/node_modules', to: 'runtime/dsh/node_modules', filter: ['**/*'] },
```

并新增 `scripts/verify-package.mjs`（`pnpm verify:package`，打包命令末尾自动执行）：
用清单声明的文件数、关键文件与入口反查打包目录，**数量不符就失败**。

### 2.3 手动打包时踩到的（非产品问题）

`spawnSync('npm.cmd')` 在 Node 20+ 报 `EINVAL`（`.cmd` 启动缓解），改为用 node 跑
`npm-cli.js`；`robocopy` 的成功退出码非 0，改用 `fs.cpSync`。

## 3. 启动时的完整性校验

`src/runtime-tree.ts` 在**拉起任何子进程之前**校验随包运行时：

| 检查 | 失败原因码 |
|---|---|
| 清单可读、schema 受支持 | `manifest-unreadable` |
| 平台/架构匹配 | `platform-mismatch` |
| Electron 版本匹配（运行时随某个精确 Electron 打包） | `electron-mismatch` |
| 入口存在 | `entry-missing` |
| 23 个关键文件存在、非空、sha256 一致 | `file-missing` / `file-empty` / `hash-mismatch` |

**为什么不校验整棵树**：11724 个文件全哈希在每次启动要花数秒。执行代码的只有入口与原生模块，
把这 23 个文件哈希一遍是毫秒级，而且攻击者或损坏的安装想执行代码就必须改这些文件。
这是一个有意识的取舍，不是遗漏。

校验失败时：启动页显示「随包运行时损坏或不完整，请重新安装本应用」，不 spawn 任何东西，
`desktop-facts.json` 与冒烟结果里都能看到 `runtime.source`。

运行时来源也会写进 `desktop-facts.json`（`runtime: { source: 'bundled'|'system', version, files }`），
DSH 设置页与诊断因此能区分「随包」与「系统安装」。

## 4. 决定性验证：零环境

先用最小 PATH 确认系统里确实没有 dsh，再让打包产物在同样的 PATH 下启动：

```
PATH=C:\Windows\System32;C:\Windows      （无 dsh、无 node、无 git）

SMOKE cookie (isolated home) [packaged] → PASS
ok=true   title="DeepSeek Harness"   nodes=379
runtime={"source":"bundled","version":"0.2.0-rc.1","files":12546}
entry=D:\…\release\win-unpacked\resources\runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js
panelReady=true   panelSettings={"read":true,"write":true,"revision":0}
tasks={"answer":"idle","families":[],"sessions":0}
```

同一次运行同时证明了：运行时来自包内、面板桥照常工作、任务查询照常工作。
开发态另跑了一轮（`DSH_DESKTOP_BUNDLED_RUNTIME` 指向 `runtime/dsh`），结果同样为
`source=bundled`、DSH 界面 467 节点。

## 5. 测试

```
npx tsc --noEmit   → 通过
npm test           → 39/39 通过（新增 runtime-tree 7 项）
  · runtime-tree.test.ts：匹配即通过；入口被篡改 / 原生模块被篡改 / 换个 Electron /
    关键文件缺失 / 清单坏掉 / 平台不符 —— 六种拒绝路径
```

## 6. profile 隔离与随包 pnpm

隔离的目的：`dsh web` 只是出厂自带的一个 profile，用户命令行的 `dsh` 与桌面壳如果共用它，
插件激活、锁文件与 `node_modules` 会互相踩——尤其是壳内 dsh 版本与全局 dsh 版本分叉之后。

### 6.1 一个上游硬约束：`desktop` 这个名字不能用

第一版把 profile 命名为 `desktop`，dsh 直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

源码里是硬编码的名字检查（`dsh/lib/bin.js` 的 `rejectElectronProfile`，
`profile.toLowerCase() === "desktop"`），且在**引导**与 `dsh plugin --profile desktop` **两处**都拦。
所以第三方壳必须另选名字，我们用 **`dsh-desktop`**（可用 `DSH_DESKTOP_PROFILE` 覆盖）。

### 6.2 播种规则：克隆，而不是"抄模板"

第一版只把出厂 `web` profile 的 **bundle 列表 + dependencies** 抄进新 profile，结果真实用户第一次迁移就炸了：

```
新建会话失败：agent-preset/not-found: Unknown agent preset: git-bash
```

`git-bash` 这个 preset 定义在用户的 **`cordis.patch.yml` 用户层**里（23 KB），而新 profile 只有 dsh 生成的骨架（622 字节，`default: standard`）。模板里没有的东西——用户层 patch、patch 解析所需的插件包、插件管理器状态、workspace 文件——全都没迁过去。

现在的规则：

| 情况 | 行为 |
|---|---|
| 目标 profile 已存在 | 原样复用，绝不覆盖 |
| 出厂 `web` profile 存在 | **完整克隆它**（含 `cordis.patch.yml`、`node_modules`、`.plugin-manager`、`.dsh-market`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`），只把清单里的 name 改成自己的（`seededFrom: cloned-web`） |
| 都没有 | 兜底最小播种（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`） |

克隆用「先复制到临时目录、改名、再原子 rename」——半个 profile 会在下次启动时被当成"已存在"，那比不克隆更糟。拷贝保留符号链接原样（pnpm 的 `node_modules` 依赖这一点）。克隆完成即 `node_modules` 齐备，**不会再跑一次安装**。

### 6.2b 一次性修复已被旧逻辑播种的 profile

克隆只在 profile 不存在时发生，所以 0.3.6/0.3.7 已经迁移过的用户不会被自动修好。`repairSeededProfile()` 补这一步：

- 触发条件刻意保守：**目标的 `cordis.patch.yml` 小于源的四分之一**（622 B vs 23 KB = 2.7%，而正常配置过的目标在同一个量级）。有疑问就不动。
- 只补齐用户层文件；`cordis.patch.yml` 覆盖前会留 `.bak-seeded-<ts>`；其余文件已存在则不覆盖。
- 用户层 patch 里点名的插件**不在 `package.json` 依赖里**（它们是 marketplace 装进来的 `link:` 符号链接），所以修复会把这些链接逐个列出来，交给随包 pnpm 用 `pnpm add link:…` 补齐。

### 6.3 随包 pnpm

dsh 的插件操作是把参数**转发给 PATH 里的 `pnpm`**（`execa('pnpm', …)`；找不到就 exit 127 打印
「pnpm was not found」）。所以随包运行时里多装了 `pnpm@10.34.2`，并在 `runtime/dsh/bin/` 写两个 shim：

```cmd
rem pnpm.cmd
"%DSH_DESKTOP_NODE_EXECUTABLE%" "%~dp0..\node_modules\pnpm\bin\pnpm.cjs" %*
```

壳把 `bin/` 前置到 dsh 子进程的 PATH，并把 `DSH_DESKTOP_NODE_EXECUTABLE` 指向自己的二进制——
**不需要机器上有第二个 Node**。（`node.cmd` 同理，用于插件安装脚本。）

构建期会真的执行一次 `pnpm.cmd --version` 并断言输出形如版本号：shim 坏掉只会在用户装插件时才暴露。

播种出依赖后，壳在**后台**用这把 pnpm 跑一次 `install`（10 分钟上限），窗口不等待；
失败只记录日志，profile 仍能启动（dsh 对解析不到的 bundle 是 `skipping profile bundle` 后继续）。

### 6.4 实测（开发态，隔离 home，迁移源为真实的 web profile）

```
迁移源:        bundles 8 项 / deps dsh-plugin-kit, dshmarket
播种结果:      seededFrom="web-template", bundles=8, dependencies=2
host 启动:     dsh --profile dsh-desktop --patch <overlay> --host 127.0.0.1 --port 41752
                (对尚未装好的 bundle 打印 skipping profile bundle 后继续)
后台安装:      桌面端 profile 插件安装：完成（重启后生效）
装出内容:      node_modules/{dshmarket@1.66.3, dsh-plugin-kit(link)} + pnpm-lock.yaml，8.1 MB
```

打包态（最小 PATH）另跑一轮：`runtime.source=bundled`（12489 文件）、
`profile={path: …/profiles/dsh-desktop, created:true}`、DSH 界面 379 节点、面板桥与任务查询均正常。

## 7. 测试

```
npx tsc --noEmit   → 通过
npm test           → 46/46 通过（runtime-tree 7 项 + profile 7 项）
  · profile.test.ts：DSH_HOME 解析、从 web 模板播种、无模板兜底、已有 profile 绝不覆盖、
    不重复创建、随包 pnpm 调用形态（cwd/环境/需要 shell）、安装失败可上报不致命
```

## 8. 还没做的

| 项 | 说明 |
|---|---|
| blockmap 差分 | 现在每次全量 187.8 MiB；产物里的 `.blockmap` 已生成，接入时仍须保证 minisign 是安装前的闸门 |
| 播种后的首次体验 | 插件在后台装完需要用户重启一次桌面端才生效（`profile-install.json` 与日志里已写明）；做成「装完自动提示重启」更好 |
| 正式发布 | `releases/latest` 仍指向 Tauri 的 0.2.26；带运行时的正式版本尚未发布 |

## 9. 升级路径实测（真机，2026-09-28/29）

目标：证明「安装器替换整个 358.5 MiB 运行时树」在真实安装上是干净的。用 debug 通道做（正式通道默认 41729，被用户正在运行的 Tauri 版占着）。

### 9.1 验收结果（0.3.2 → 0.3.3，真实安装到 `D:\Program Files\DSH Desktop Debug`）

| 验收点 | 结果 |
|---|---|
| 运行时树被完整替换 | 已安装目录 `verify-package` 通过：**12396 个文件**（清单声明 12395 + 清单本身）✔ |
| 没有旧版本残留 | 文件数与清单**精确相等**——0.3.2 时代多出来的 94 个外地文件已被清掉，不是「只增不减」的叠加安装 ✔ |
| 新运行时通过自检 | 真实 userData 的 facts：`runtime {source: bundled, files: 12395, shell: "0.3.3"}`、`desktopVersion 0.3.3` ✔ |
| 关键文件哈希全对 | 26 个关键文件逐一比对通过（包装脚本直接核对已安装目录）✔ |
| 与旧版共存 | Tauri 版在 41729、debug 版在 41731，同时 LISTENING ✔ |
| 插件迁移落地 | profile 为 `~/.dsh/profiles/dsh-desktop-debug`，`seededFrom: web-template`、`dependencies: 2` ✔ |

**升级期间的关键顺序**（`before-quit`）：先 `await host.stop()`（等子进程 `close`，超时才 SIGKILL），再 `launchInstaller`，最后 `app.exit(0)`——所以安装器动手时 dsh 子进程已经死透，不会锁住运行时里的文件。

### 9.2 这次实测在真机上抓到两个 bug（都已修）

**① 启动被拒绝：ARM64 文件进了校验集**

安装后启动直接失败：`随包运行时文件损坏或不完整（node_modules/node-pty/third_party/conpty/<v>/win10-arm64/OpenConsole.exe）`。

三份副本对比：源 12490 文件、`win-unpacked` 12490（字节一致）、**安装后 12488**——只少了那 2 个 **ARM64** 二进制（`OpenConsole.exe` + `conpty.dll`），且该目录存在但为空。Defender 无隔离记录，安装器载荷是压缩的、机器上无 7z 无法直接核对，**机制未能钉死**。

但它**本来就不该随包**，三层缺陷：

1. 裁剪正则写的是 `win32-arm64`，node-pty 实际叫 **`win10-arm64`** → 没被裁掉；
2. 校验集规则是「所有 `.exe`/`.dll`/`.node` 都哈希」→ 一个 x64 上永不加载的 ARM64 辅助程序成了「关键文件」；
3. 装机时它没落地 → 校验失败 → 拒绝启动。

修法（`scripts/runtime-policy.mjs`，随目标平台推导「外地 token 集合」，因为 `win32` 在编 Windows 时是自己人、编 macOS 时是外地人）：

- 外地平台/架构的二进制**一律裁剪**；
- 外地文件**永不进校验集**（即使漏网，也不会因一个永不加载的文件把用户挡在门外）；
- `verify-package` 在**打包阶段**直接失败——只要关键文件表出现外地文件。

写测试时又抓到两个漏洞：`sharp-darwin-x64` 的**连字符前缀**匹配不到；跨平台构建时 `win32` 没被当成外地平台。回归用例用的都是真实命名（`win10-arm64`、`win10-x64`、`reflink.win32-arm64-msvc-*.node`、`win32_x64`）。

结果：随包文件 12489 → **12395**，关键文件 31 → **26**，运行时 360.9 → **358.5 MiB**。

**② 插件迁移静默失败：路径里的空格**

用户的 debug 版装在 `D:\Program Files\…`（**带空格**）。后台安装用 `shell: true` 把 shim 路径未加引号地拼进命令行：

```
'D:\Program' is not recognized as an internal or external command
```

于是 profile 的 `node_modules` 从未生成，迁移承诺的插件一个都没装上——**开发态路径没有空格，所以一直看着是好的**。

修法有两处：

- **不再经过 shell**：直接用应用自己的二进制以 Node 模式执行 `pnpm.cjs`（而不是 `pnpm.cmd` shim），空格、引号、`.cmd` 全部绕开；
- **不再只试一次**：触发条件从「刚创建 profile」改为「声明了依赖但 `node_modules` 不存在」，失败会在下次启动自动重试；结果同时写入 `profile-install.json`（内存日志随进程消失，正是这次失败不可见的原因）。

修复后实测：随包 pnpm 在该 profile 里 8.5 秒装好 `dsh-plugin-kit`（link）+ `dshmarket 1.66.5`。

### 9.3 这一节改变了什么

- 启动完整性校验**保留严格**：它这次做对了事——宁可拒绝启动并指名文件，也不肯用一个自己无法担保的运行时。它把一个可能表现为「莫名其妙崩溃」的问题变成了一句可读的提示。
- 但**「关键文件」的范围必须等于「这台机器上真的会执行的文件」**，否则校验会变成误报源。
- 教训写进了 `AGENTS`/README：**只在开发路径上验过的路径/命令行处理，等于没验**。

## 10. 后续优化：运行时进 ASAR —— 安装从 12,573 个文件降到 84 个（2026-09-30）

用户实报「安装包安装很慢」。查下来**慢的不是 189 MB，而是 12,500 个小文件**：

| 实测（本机 D 盘，16 核） | 耗时 |
|---|---|
| 复制整个随包运行时（12,447 个文件 / 360 MiB） | **18.5 s** |
| 复制**同样字节数**的单个大文件 | **0.2 s** |
| 7z 多线程解包同一棵树 | 12.3 s / 10.6 s |
| 7z 单线程解包 | 12.3 s |

瓶颈在「创建文件」本身（每文件一次的 MFT 更新 + Defender 实时扫描），所以**多线程解包也救不了**（12.3 vs 12.3）。文件数的来源是 npm 的粒度：一个运行时 = **803 个包 / 8,424 个 JS 文件**，其中 **73% 的文件小于 4 KB、合计只有 10 MiB**；体积则来自另外 72 个原生大文件（287.8 MiB）。**体积和文件数是两件不相干的事**。

修法照官方桌面端（`deepseek-harness/apps/desktop`）：**把整个运行时打进 `app.asar`，只把不能从归档里加载的文件 unpack 到旁边**（官方 `asar: true` + `files` 里挂 `dsh` 树 + `asarUnpack`，并在 `src/main.ts` 里直接用 `join(app.getAppPath(), 'dsh')`）。

### 10.1 改了什么

| 位置 | 之前 | 现在 |
|---|---|---|
| 运行时落点 | `resources/runtime/dsh/**`（12,439 个松散文件） | `resources/app.asar/**`（**1 个文件**）+ `resources/app.asar.unpacked/dsh/**`（58 个） |
| 谁决定必须物理 | 无 | `prepare-runtime.mjs` 写出清单的 `physical`：按扩展名（`.exe/.dll/.node/.com/.cmd/.bat/.ps1/.sh/.so/.dylib`）+ 对无扩展名文件做魔数嗅探（PE/ELF/Mach-O） |
| `asarUnpack` | — | `scripts/asar-unpack.mjs` 把 `physical` 转成 glob，**前缀必须是源路径 `runtime/dsh/...`**：builder 用源路径匹配，`to:` 只决定写进归档的位置。写错是**静默失效**（运行时照旧全打进 asar、一个都不 unpack） |
| `pnpm.cmd` shim | 相对路径 `..\node_modules\pnpm\bin\pnpm.cjs` | 优先用壳注入的 `DSH_DESKTOP_PNPM_ENTRY`：shim 必须是真实文件（cmd.exe 读不了归档），而 pnpm 的 JS 在归档里，相对路径已不可达 |
| 裁剪 | 声明 / source map / 测试 / 其他平台 | 再加 `.pdb`、`.lib`、`.exp`、`.ilk`、`.gypi`、`.vcxproj*`、`binding.sln`（原生模块的构建与调试产物，永不加载）：−7 项 / −10.2 MiB |

### 10.2 实测结果

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 安装时要创建的文件 | **12,573** | **84**（asar 本体 + 58 个物理文件 + Electron 自己的 26 个） |
| 其中运行时 | 12,547 | 58 |
| `app.asar` 本体 | — | 133.8 MiB |
| 解包后应用目录 | 679 MiB | 675 MiB |
| NSIS 安装包体积 | 188.2 MiB（0.3.10） | **178.3 MiB**（0.3.11，asar 比几千个松散文件更好压） |

**决定性的前后对比**（同一台机器、同样 675/679 MiB 载荷、同一个工具；用 7-Zip 把两个安装包的载荷各自解开，**不做安装、不动注册表**）：

| 安装包 | 解开并写出全部文件 | 文件数 |
|---|---|---|
| `DSH.Desktop_0.3.10`（松散运行时） | **13.4 s** | 12,572 |
| `DSH.Desktop_0.3.11`（运行时进 asar） | **1.8 s** | 85 |

**同一份载荷，快 7.4 倍**。而 NSIS 自己是单线程、且每文件开销比 7za 更重，所以真实安装的差距只会更大——注意这个数字是「解压之后的落盘阶段」，NSIS 块的解压成本两边一样，没有算在差值里。

### 10.3 验证（全部是打包态，不是开发态）

1. `verify-package.mjs`：从 `app.asar` 里读清单、走 12,440 个归档条目，并**逐个断言 58 个 `physical` 真的落在 `app.asar.unpacked`**——漏一个不是慢，是启动即失败。
2. `prepare-runtime.mjs` 自证：裁剪后 `dsh --version` / `web --help` 正常，pnpm shim 的**两个分支**（相对路径 + `DSH_DESKTOP_PNPM_ENTRY`）都验过。
3. `scripts/smoke.mjs cookie --isolate-home --packaged`：`ok: true`，入口是 `...\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`，日志 `随包运行时校验通过：dsh 0.2.0-rc.2，12439 个文件`，`panelReady: true`。
4. 真机跑打包产物（隔离 userData/DSH home，端口 41735）：`navigate` 1346 ms 打开 example.com、`snapshot` 22 ms、遮罩成对出现与撤下；14 个原生工具 / 路由 / 内置技能全部注册。
5. **pnpm 从归档里真的能跑**：用打包后的 shim + `DSH_DESKTOP_PNPM_ENTRY` 指向 `app.asar\dsh\node_modules\pnpm\bin\pnpm.cjs` → `pnpm --version` = 10.34.2、`pnpm add is-number` 1.7 s 成功。这一条同时证明 **Electron 会把 asar 内标记为 unpacked 的可执行文件重定向到 `app.asar.unpacked`**（pnpm 会 spawn `dist/vendor/fastlist-x64.exe`）。
6. 单测 257 项 / 250 通过（7 个既有 blake2b 失败）、`tsc --noEmit` 干净。
7. 安装包本身也验证过：`electron-builder --win nsis` 出的 0.3.11 包能正常产出（178.3 MiB），其载荷解开后就是第 10.2 节那张对比表。

### 10.4 还没做

- 官方 NSIS 层还有三件事（`windows-directory-installer.mjs`）：目标目录相同时**跳过旧版卸载**、先解到暂存目录再**目录改名上位**、自研带进度的解包插件。asar 之后载荷只剩 1 个大文件 + 58 个小文件，这三件事的收益已经很小。
- 更新仍是整包下载；差分更新是另一件事（官方有 `installed-update-*` 一套）。
