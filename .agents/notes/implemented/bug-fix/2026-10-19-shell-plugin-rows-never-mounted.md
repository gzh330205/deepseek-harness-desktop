# Agent Note: 随壳插件与 MCP 行从未挂载：junction 删除、patch 语义与菜单守卫三处静默失败（0.4.6 修复）

Status: implemented

## Problem

0.4.5 的发布说明写着「四个面板随壳注入、MCP/Skills 与用量改成壳窗口」，用户装完却报：运行环境、侧栏宽度、git 面板、工作区分类四个插件全部消失；会话里的 MCP 服务也全不可用；标题栏「用量」菜单点了没反应。

三条独立缺陷叠在同一版里，共同点是**没有一条失败路径会报错**：

1. **Electron 里 `fs.rmSync` 删不掉 junction。** `plugin-provision.ts` 的 `linkPackage` 用
   `rmSync(destination, { force: true })` 替换旧链接。普通 Node 里能删，Electron 主进程里却抛
   `ERR_FS_EISDIR: Path is a directory`；异常被 catch 吞掉，紧接着 `symlinkSync` 报 `EEXIST` 也被吞，
   函数返回 “unchanged”。结果：四个链接永远停在旧目标（三个还指向插件源码仓库），启动日志一行没有。
   更危险的是 `rmSync(…, { recursive: true })` 在 Electron 里会**跟随 junction 删掉目标内容**——
   排障时实测复现，绝不能用。
2. **patch 里的新行写错了位置。** DSH Loader 的 patch 语义（`packages` 外的
   `vendor/include/src/index.ts` `applyEntryPatches`）：顶层条目只有在 `- insert: [...]` 里才插入；
   带 `name` 的非 insert 顶层条目只是「断言已有行」，目标不存在时打一条 `patch: entry "…" not found`
   就跳过。旧代码把四个插件行和迁移出来的 MCP 行都写成顶层 `{ id, name }`：插件行本来由
   `dsh-plugin-kit` bundle 提供，kit 被移除后这些断言全部落空；MCP 行则从未存在于任何 bundle。
   真机 `dsh --dump-config` 一次列出 8 条 `not found`（4 个插件 id + 4 个 `mcp-*`）。
3. **打包的插件副本缺少 host 半区要 import 的 `src/`。** `scripts/prepare-plugins.mjs` 只复制
   `package.json`/`index.js`/`cordis.patch.yml` 与 `lib/`、`locale/` 等目录；`dsh-git-panel` 与
   `dsh-run-env-manager` 的 `index.js` 直接 `import './src/host/*.js'`，副本里没有 `src/`。行挂载修好后
   真机立刻暴露出 `2 entries did not activate` 与 `ERR_MODULE_NOT_FOUND`——即使挂载成功，这两个面板
   仍然不会出现。这个缺陷一直存在，只是被「行根本没挂载」掩盖了。
4. **标题栏菜单 IPC 用了手写白名单。** `titlebarMenu` 守卫写着 `'app' | 'plugins' | 'pocket'`，漏了
   `'usage'`；`MENU_TEMPLATES` 里有 usage、标题栏也有按钮，但点击被静默拒绝。菜单冒烟同样只遍历
   那三个名字，所以也没抓到。

## Decision

1. **删链接只删链接本身。** `linkPackage` 改用 `unlinkSync`，失败回退 `rmdirSync`；两者都失败就保留
   原状并写一行日志。`rmSync({ recursive: true })` 明令禁止用于链接（Electron 会跟随删除目标）。
   插件测试补一条读源码的静态断言（含 `unlinkSync(destination)`、不含 `rmSync(destination`），因为
   这个差异在普通 Node 单测里复现不出来。
2. **四个插件按 DSH 自己的装载单位注入。** 不再往用户 patch 写行，而是把包名追加进 profile
   `package.json` 的 `dsh.profile.bundles`。每个随壳插件本来就带 `dsh.bundle.patch`
   （`- insert: [{ id, name }]`），登记包名就把「行 + client 半区」一起交给 harness；用户 patch 里
   原有的同 id 覆盖（分类、运行环境、侧栏宽度等配置）恢复生效。`ensureProfileBundles` 幂等、保序、
   写前备份，`dsh-plugin-kit` 照旧从依赖与 bundle 列表移除。
3. **MCP 行写进置顶的 insert 容器。** 同一层 patch 按文件顺序应用，容器必须最先，后面的顶层 override
   才能命中新行。`migrateLegacy` 即使 `alreadyDone` 也执行 `normalizeMcpRows`，把旧壳写坏的顶层行
   原样搬进容器（保留字段与注释），`MigrationResult.repaired` 暴露修复数；
   `saveMcpServer` / `removeMcpServer` / `setMcpEnabled` / `listMcpServers` / `removeRows` 都同时覆盖
   容器与顶层，新行永远不会再以顶层形式落盘。
4. **启动顺序调整。** `installBundledPlugins()` 从「install* 批次」挪到 profile 播种/repair 与 pnpm
   store 迁移之后、DSH 子进程启动之前；`profileNeedsInstall` 在创建任何 `node_modules` 之前算好并缓存。
   原先 `linkPackage` 会先把 `profiles/<name>/node_modules` 建出来，于是全新安装首启：
   `ensureDesktopProfile` 的 web 克隆因目标路径已存在而失败、`profileNeedsInstall` 把 profile 误判为
   已安装、bundle 登记也因为 package.json 还不存在而被跳过。
5. **菜单守卫与冒烟从模板表派生。** `isShellMenuName()` 用 `Object.hasOwn(MENU_TEMPLATES, …)`；菜单
   冒烟遍历 `Object.keys(MENU_TEMPLATES)`。新增菜单不再需要维护第二份名单。
6. **插件副本按入口点的相对 import 自检。** `prepare-plugins.mjs` 的 `KEEP_DIRECTORIES` 加入 `src/`
   （四个插件共 300 文件 / 2.38 MiB），复制后扫描 `index.js` 的每个 `from './…'` 并断言目标存在，
   缺失直接构建失败。同时 `verify-package.mjs` 新增**组合门禁**：用打包壳在干净 home 上冒烟、再跑
   打包 dsh 的 `--dump-config`，断言四个插件包已登记并链接、MCP 行已进 insert 且无 `not found`、
   用户 `sidebarWidth` 配置作用到挂载行，并断言启动日志没有 `did not activate` / `failed to import`。
7. **首启不再把「patch 还不存在」当迁移失败。** `installMcpWindow` 在 `patchPath` 不存在时跳过读取/
   迁移；老 profile 照常修复。

## 为什么 0.4.5 的验收没抓到

- 开发机 profile 是长期手装的：四个插件在 `node_modules` 里是 10 月 9 日手工建的 junction，插件行由
  `dsh-plugin-kit` 提供，所以「行不挂载」在开发机上被 kit 掩盖；发版冒烟有打包产物，但没有任何一步会
  看 `--dump-config` 的挂载结果。
- junction 替换失败只在 Electron 主进程里发生；单测与 dev 期间用普通 Node 跑的脚本都正常，正好落进
  `electron/README.md` 第 18 条「只在开发路径上验过的路径/命令行处理等于没验」。
- 菜单冒烟维护的是第二个手写名单，与 IPC 守卫一样漏了 usage。
- 打包校验只断言插件目录里「有 package.json / index.js / schemastery」，没有把插件真正 import 一次；
  而「行根本没挂载」又让缺 `src/` 的插件永远不会被 DSH 加载，两个缺陷互相掩盖。

因此这次补的是**结构**而不是再补一个名字：守卫与冒烟从同一张表派生；Electron 的 fs 差异用源码静态
断言钉住；插件复制按入口点的相对 import 自检；`verify-package.mjs` 用打包壳在干净 home 上跑一次真
`--dump-config` 组合门禁（含激活日志断言），让「装上了但没挂载/导入不了」在发版门禁就失败。另在真实
profile 副本上做修复前后 `--dump-config` 对照（`.tmp-perf/verify/`，不入库）。

## Alternatives considered

- **把四个插件行直接写进用户 patch 的 insert 容器**：能挂载，但只挂 host 半区；client 半区要靠
  `dsh.client` 扫描 loader 条目，行与包名的对应关系、未来升级都要壳自己维护，等于复制 DSH 的 bundle
  机制。profile bundles 是市场和 `dsh plugin add` 的既有路径，升级换包也只改列表。
- **把 junctions 改成复制目录**：能绕开链接删除问题，但每次壳升级都要重写用户 profile，旧副本还会遮蔽
  新版本；链接是既有设计（壳原地升级、profile 不存副本）。
- **用 `rmSync(..., { recursive: true })` 删 junction**：普通 Node 下看似能删，Electron 里实测会把目标
  目录内容一起删掉（本次排障中真实误删过插件源码，已从 git 恢复）。任何删除链接的代码都不许用它。
- **只给用量补进手写白名单**：能修这一个按钮，但下一个菜单还会漏；改为从模板表派生。
- **MCP 行保留顶层写法、读取时容错**：窗口能显示，但运行时仍然不挂载，DSH 的 `not found` 警告也会一直
  在日志里。必须写到 insert。

## Evidence

- 单测：`node scripts/run-tests.mjs` → 544 项 / 537 pass / 0 fail / 8 skipped；`tsc --noEmit` 干净；
  `node build.mjs` 成功。
- 真机修复前基线（真实 profile 副本 + 安装版 `dsh --profile dsh-desktop --dump-config`）：6/6 断言确认
  8 条 `patch: entry "…" not found`（4 个插件 id + 4 个 `mcp-*`），组合结果里 0 个插件行、0 个 MCP 行，
  4 个 junction 仍指向旧目标。
- 真机修复后（dev 壳 + 安装版运行时，真实 profile 副本）：20/20 PASS —— 四个 junction 目标改为
  `electron/resources/plugins/<name>`；profile `dsh.profile.bundles` 含四个包名且原 6 个未丢；
  `cordis.patch.yml` 里 MCP 行全部位于首位 insert 容器，顶层不再有 `name: @deepseek-ai/dsh-mcp-client`；
  `--dump-config` 不再有 `not found`，四个插件行与四个 `mcp-*` 行都在组合结果里且保留用户 config
  （`sidebarWidth: 301`、`rightbarWidth: 300`、workspace-category 配置）；菜单冒烟 `usage/app/plugins/pocket`
  全 opened，用量/MCP 窗口 loaded + bridge 为真；启动日志无 `did not activate` / `failed to import`
  （4/4 插件 host 半激活），36 个插件 .js 的相对 import 目标全部存在。
- 全新空 home 首启：8/8 PASS —— 创建 profile（default 播种）、4 个 bundle 登记、4 个 junction 指向随壳副本，
  且没有「读取 cordis.patch.yml 失败」噪音（首启 ENOENT 修复）。
- 打包组合门禁：先用旧插件副本（缺 `src/`）跑一次，门禁按预期失败并打印
  `2 entries did not activate … ERR_MODULE_NOT_FOUND`；`prepare-plugins` 修复后重打包，门禁通过
  （`==> 组合校验：4 个随壳插件与 MCP 行在打包 dsh 里真实挂载，用户配置生效`）。
- 完整报告与原始日志：`.tmp-perf/verify/REPORT.md`（不入库）。
- 发版：v0.4.6 已发布（4 个资产：安装包 235,002,565 B、`.sig`、`DSH.Pocket.apk` 3.56 MB、`latest.json`）；
  `latest.json` 匿名可读且 version=0.4.6，安装包与 APK 的匿名 HEAD 均 200。

## Consequences

- 已有 profile 下次启动会改两处：`package.json` 追加四个 bundle、`cordis.patch.yml` 把 MCP 行搬进置顶
  insert 容器；两处都有 `.bak-shell-*` 备份，且幂等。
- 插件不再需要往用户 patch 写行，市场里能看到这四个包「已安装」；若从市场卸载，壳下次启动会重新登记。
- 首次启动的异步 `pnpm install` 仍可能在几分钟后把 junction 当 extraneous 清掉（bundle 登记不受影响，
  下次启动重建链接）。首启当次 DSH 已经从链接加载完毕，记录为已知代价。
- 用量登录态：0.4.5 曾在真实 profile 上跑过一次迁移，消费掉旧 ONE-WAY 行，但 cookie 写进了那次运行的
  userData；升级到 0.4.6 后若用量窗口仍显示未登录，需要重新扫码——这是历史数据损失，不是本次代码缺陷。
- `normalizeMcpRows` 假定「顶层 `name: @deepseek-ai/dsh-mcp-client`」的行都是旧壳写坏的；若有人手写顶层
  name 去断言某个 bundle 行，会被改成新增行。本壳场景可接受，记在这里备忘。
