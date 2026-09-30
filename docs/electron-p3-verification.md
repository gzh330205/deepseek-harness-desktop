# P3 验证记录：Electron 打包与更新通道

> 执行时间：2026-09-28
> 代码位置：`electron/`
> 关联：[更新通道设计](update-channel-design.md) · [P0 技术验证记录](electron-p0-verification.md)

## 0. 结论

打包链路与更新通道的本地可验证环节**全部通过**：真实 NSIS 产物构建成功、**打包后的应用自己跑通了端到端冒烟**（Electron Node 模式 fuse、面板插件注入、Cookie 认证、DSH 界面渲染）、**真机以 Tauri 原始参数安装成功并拉起应用**、真实产物用现有 minisign 密钥签名并通过自校验、发布脚本 dry-run 与一次 prerelease 实际发布都产出正确的清单，线上产物下载后仍能通过验签。

真机安装还暴露并修复了三个只有落地才会发现的 bug：静默安装不自启应用、旧版检测把 Electron 自己当成旧版、我们自己的更新参数缺 `--force-run`（第 7 节）。

## 1. 交付物

| 路径 | 说明 |
|---|---|
| `electron/electron-builder.config.mjs` | 打包配置：appId 复用 Tauri 标识、`runAsNode` fuse、语言包收敛、extraResources 携带面板插件、无 `publish` |
| `electron/scripts/installer-bridge.nsh` | 桥接宏：把 Tauri 的 `/UPDATE` 翻译成 `SetSilent silent` |
| `electron/src/update.ts` | 清单解析、版本比较、下载（带进度）、minisign 校验、`/S --updated` 安装 |
| `electron/src/update-controller.ts` | 检查 → 下载 → 校验 → 安装的状态机 |
| `electron/src/update-window.ts` + `src/update/index.html` | 更新窗口与 UI |
| `electron/src/legacy-cleanup.ts` | 检测并（经用户同意）卸载遗留的 Tauri 版 |
| `electron/scripts/release-electron.mjs` | 构建 → 签名 → 自校验 → 生成 `latest.json` → 发布（`--dry-run` / `--prerelease` / `--yes`） |
| `electron/src/update.test.ts` | 清单/版本/下载/校验的 7 项测试 |
| `electron/src/fixtures/artifact.txt(.sig)` | 真钥签名的校验夹具 |

## 2. 打包实测数字

```
==> electron-builder --win nsis
    DSH.Desktop_0.3.0_x64-setup.exe   102,289,835 字节（97.6 MiB）
    DSH.Desktop_0.3.0_x64-setup.exe.blockmap
    win-unpacked/                     320 MiB
    win-unpacked/locales/             en-US.pak zh-CN.pak（收敛前为 55 个、49 MB）
```

`app.asar` 只有 **7 个条目**，没有 node_modules（本壳没有运行期依赖）：

```
/dist/launcher/index.html  /dist/main.js  /dist/main.js.map
/dist/preload.cjs  /dist/preload.cjs.map  /dist/update/index.html  /package.json
```

资源目录（`resources/`）：`app.asar`、`dsh-desktop-shell/`（面板插件三件套）、`icon.png`、`tray.ico`、`elevate.exe`。

> 体积结论：**97.6 MiB 里绝大部分是 Electron 运行时本身**，语言包只贡献约 8 MiB（.pak 压缩率高）。这也说明为什么 P4 的 blockmap 差分值得做——每次全量下载近 100 MB。

## 3. 打包产物端到端冒烟（关键验证）

```
DSH_DESKTOP_PORT=41731 node scripts/smoke.mjs cookie --isolate-home --packaged
SMOKE cookie (isolated home) [packaged] → PASS

ok=true            title="DeepSeek Harness"   root=true   nodes=467
panelInjected=true cookieAcquired=true        target=http://127.0.0.1:41731/
userData=<临时目录>  dshHome=<临时目录>/dsh-home

日志：[dsh-desktop-shell] host apply pid=59248 bridgeDir=<临时目录>
      [dsh-desktop-shell] 已注册路由 /dsh-desktop-shell/v1/*（除 ping 外均需 DSH 会话认证）
```

这一次运行同时证明了四件事：

1. **`runAsNode` fuse 生效**：打包应用能用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑通 dsh；
2. **extraResources 正确**：面板插件从 `process.resourcesPath/dsh-desktop-shell` 被找到并经 `--patch` 注入 dsh 进程；
3. **Cookie 加载模式在打包态成立**：token 由主进程换取 Cookie，页面渲染出完整 DSH 界面；
4. **`DSH_HOME` 隔离在打包态成立**：Harness home 落在临时目录，未污染用户 `~/.dsh`。

> 打包产物是 GUI 子系统程序，stdout 可能接不到控制台，因此壳在冒烟模式下**同时**把结论写入 `<userData>/smoke-result.json`，冒烟脚本优先读 stdout、缺失时读该文件。

## 4. 签名链路（真实产物）

发布脚本在**真实 97.6 MiB 产物**上跑通：

```
==> 产物 DSH.Desktop_0.3.0_x64-setup.exe：97.6 MiB
==> tauri signer sign
==> 签名自校验通过
==> latest.json 已生成：electron/release/latest.json
```

生成的清单（`signature` 已截断）：

```json
{
  "version": "0.3.0",
  "notes": "https://github.com/gzh330205/deepseek-harness-desktop/releases/tag/v0.3.0",
  "pub_date": "2026-09-28T07:36:48Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6…",
      "url": "https://github.com/gzh330205/deepseek-harness-desktop/releases/download/v0.3.0/DSH.Desktop_0.3.0_x64-setup.exe"
    }
  },
  "shell": { "minimum": "0.3.0", "channel": "stable" }
}
```

两处刻意的设计：

- **资产名不含空格**（`DSH.Desktop_0.3.0_x64-setup.exe`），绕开 GitHub 把空格换成点号导致的清单 URL 404；
- 发布脚本在上传前**用应用内置的同一把公钥自校验**，校验不过直接退出——不会发布一个自己都验不过的包。

## 5. 桥接设计的一处修正

原设计（[更新通道设计](update-channel-design.md) 5.3）打算在 NSIS 的 `customInstall` 里用 `ExecWait` 卸载旧 Tauri 版。落地时改成**由应用在首次运行时做**：

- `ExecWait` 等的是**另一个产品**的卸载器，NSIS 里没有超时；那个卸载器一旦弹 UI，安装过程就永久卡住；
- 放到应用侧后，有超时（90 s）、有返回码、有日志，而且**只在用户点「卸载旧版」后**才执行；
- 卸载检测按注册表 `DisplayName === 'DSH Desktop'` 匹配，并用安装目录排除掉 electron-builder 自己写的那一项。

因此 `installer-bridge.nsh` 现在做两件事：把 `/UPDATE` 翻译成静默安装，以及在 `customInstall` 里把应用拉回来（原因见第 7.1 节——真机实测才发现不做这一步应用不会自启）。

## 7. 真机安装实测（本节修复了三个只有真装才会暴露的 bug）

按 Tauri updater 的**原始参数**在真机上运行安装器：

```
DSH.Desktop_0.3.0_x64-setup.exe /P /R /UPDATE /ARGS "C:\...\DSH Desktop.exe"
installer exit=0  elapsed_ms=11990          # 静默、无界面、12 秒
```

### 7.1 bug 1：静默安装不会把应用拉回来

第一次实测：安装器退出码 0、文件/快捷方式/注册项都写好了，但**应用没有启动**。

源码依据：`installSection.nsh:106` 对 assisted 安装器只在 `${isForceRun} ${andIf} ${Silent}` 时执行 `doStartApp`；Tauri 传的是 `/P /R /UPDATE /ARGS`，既没有 `--force-run` 也没有 `--updated`。而 Tauri 的 updater 早在 `ShellExecuteW` 之后就 `exit(0)` 了——结果就是「应用关了，什么都没发生」。

修复：桥接的 `customInstall` 里显式 `ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"`（此时文件、注册项、快捷方式都已就绪）。

**顺带发现**：我们自己的更新路径也漏了这个——`electron-updater` 的 `NsisUpdater.doInstall` 会传 `--force-run`，而我们原来的 `launchInstaller` 只传了 `/S --updated`。已改为 `/S --updated --force-run`。

### 7.2 bug 2：旧版检测把 Electron 自己当成了旧版

实测的注册项（真机 dump）：

| 安装 | 键名 | DisplayName | InstallLocation | UninstallString |
|---|---|---|---|---|
| Tauri 0.2.31 | `…\Uninstall\DSH Desktop` | `DSH Desktop` | `D:\Program Files\DSH Desktop` | `"D:\Program Files\DSH Desktop\uninstall.exe"` |
| Electron 0.3.0 | `…\Uninstall\94656c7c-…`（appId 派生的 UUID） | **`DSH Desktop 0.3.0`** | **缺失** | `"C:\…\Uninstall DSH Desktop.exe" /currentuser` |

两个错都在第一版实现里：

1. 检测用 `reg query <key> /s /f "DSH Desktop" /d`（搜**值数据**）——Tauri 的项登记在**键名**上，结果一条都找不到，检测形同虚设；
2. 只用 `InstallLocation` 排除自己——electron-builder **不往卸载键写 `InstallLocation`**，于是应用会提议卸载它自己。

修复：改为枚举卸载键的**子键名**逐个读取；排除条件加上**卸载器所在目录**；`UninstallString` 按「第一对引号内」解析路径（它后面还跟着 ` /currentuser`，朴素的去引号会把路径解析错）。

修复后从真实安装目录运行，检测结果**恰好一条**：

```json
[{ "name": "DSH Desktop", "ver": "0.2.31", "loc": "D:\\Program Files\\DSH Desktop" }]
```

并加了 `src/legacy-cleanup.test.ts`（5 项），用上面这份真机 dump 作夹具，钉住这两条规则。

### 7.3 验证结果

安装器以 Tauri 参数运行 → 静默完成 → **应用被拉起**，被拉起的应用自己写出冒烟结果：

```
ok=true  title="DeepSeek Harness"  nodes=467
legacyInstalls=[ { name: "DSH Desktop", ver: "0.2.31", loc: "D:\Program Files\DSH Desktop" } ]
```

真机落盘结果：安装目录 `%LOCALAPPDATA%\Programs\DSH Desktop`（320 MB）、开始菜单与桌面快捷方式、卸载注册项 `94656c7c-…`（DisplayName `DSH Desktop 0.3.0`）。

> 本次实测用 `DSH_DESKTOP_SKIP_LEGACY_CLEANUP=1`，**没有**卸载机器上原有的 Tauri 版；两者目前并存。

## 8. 测试

```
npx tsc --noEmit        → 通过
npm test                → 25/25 通过
  · 脱敏与认证地址解析（4）
  · 三道闸门与版本比较（4）
  · minisign 校验（5，含篡改/异钥 keyId/畸形输入）
  · 更新通道（7：版本前向、清单解析与未知字段、畸形清单拒绝、流式下载后可校验、截断下载被拒、签名不匹配被拒）
  · 旧版检测匹配规则（5，夹具为真机注册表 dump）
```

## 9. 发布与清理结果

| 步骤 | 结果 |
|---|---|
| v0.3.0 演习 Release | 已删除（含 tag）——它的安装包是修复前的构建 |
| v0.3.1 **prerelease** | 已发布：<https://github.com/gzh330205/deepseek-harness-desktop/releases/tag/v0.3.1> |
| `releases/latest` | 仍是 **0.2.26**（Tauri 版）→ 已安装的 Tauri 客户端**不受影响** |
| 线上产物验收 | 从 GitHub 下载 0.3.1 安装包（97.6 MiB）+ 用应用内置公钥验签 → `ok: true` |
| 本机 Electron 0.3.0 安装 | 已卸载：安装目录、卸载注册项、快捷方式全部清除；共享 userData 与 Tauri 版安装完好 |

卸载后的复查（`HKCU\…\Uninstall` 与文件系统）：

```
安装目录 %LOCALAPPDATA%\Programs\DSH Desktop   → 已删除
注册项 94656c7c-…（DisplayName "DSH Desktop 0.3.0"）→ 已删除
桌面快捷方式                                    → 已删除
开始菜单 DSH Desktop.lnk（mtime 9-24，Tauri 版） → 保留
Tauri 注册项（键名 "DSH Desktop"，0.2.31）      → 保留
%APPDATA%\ai.deepseek.dsh-desktop（共享设置）    → 保留（deleteAppDataOnUninstall: false 生效）
```

> 注意：electron-builder 的卸载器会把自己复制到临时目录再重启，**父进程几十毫秒就返回**，实际删除在后台继续；脚本里判断「卸载完成」必须等目录与注册项消失，不能只看退出码。

## 10. 剩下的待办

| # | 事项 | 说明 |
|---|---|---|
| 1 | **正式发布**（`--yes`） | 让 `releases/latest` 指向 Electron 版，所有已安装 Tauri 客户端下次检查即迁移；本机那台 0.2.31 正好可以用来跑完整升级链路 |
| 2 | ~~Tauri 的 serde 是否忽略 `latest.json` 新顶层键 `shell`~~ | ✅ **已确认兼容**（见下节） |
| 3 | SmartScreen 行为 | 无代码签名证书的已知代价，需正式包实测提示文案 |
| 4 | P4：blockmap 差分 | 现在每次更新全量下载 **187.8 MiB**（随包运行时之后）；`.blockmap` 已在产物里生成，接入时要保证 minisign 仍是安装前的闸门 |

## 预发布验证：v0.3.5

带随包运行时的首个可发布构建，以**预发布**形式验证整条发布链路——预发布不会移动 `releases/latest`，所以对已安装用户零影响，却能把「资产命名 / 匿名下载 / 清单字段 / 签名 / 载荷」一次验完。

### 发布内容

| 项 | 值 |
|---|---|
| 版本 | 0.3.5（Pre-release） |
| 安装包 | `DSH.Desktop_0.3.5_x64-setup.exe`，**187.8 MiB** |
| 随包运行时 | dsh 0.1.7-rc.2 + pnpm 10.34.2，12395 文件 / 358.5 MiB，关键文件 26 个 |
| 资产 | 安装包 + `.sig` + `latest.json` |

### 验证结果

| 检查 | 结果 |
|---|---|
| **现有用户不受影响** | `releases/latest/download/latest.json` → 仍为 **0.2.26**（Tauri 版）✔ |
| 资产完整 | 三个资产齐全，`isPrerelease: true` ✔ |
| 清单可取 | 按 tag 取到 `latest.json`：`version 0.3.5`、`shell {minimum, channel:"prerelease"}` ✔ |
| **匿名下载 + 验签** | `verify-published.mjs` 经清单自身的 URL 下载 **196,925,185 字节**并用应用内置公钥验签通过 ✔（这一步同时排除了「上传资产名与清单 URL 不一致导致 404」这个经典失败模式） |

### 老客户端兼容性：已确认，不必等真机

`src-tauri/src/lib.rs` 的更新检查走 `tauri_plugin_updater::UpdaterExt` → `updater.check()`，用的是插件里的 `RemoteRelease` 反序列化（`tauri-plugin-updater-2.10.1/src/updater.rs:1383` 的 `impl Deserialize for RemoteRelease`）。该实现是普通 `#[derive(Deserialize)]`，**没有 `deny_unknown_fields`** → 我们新增的顶层 `shell` 键会被忽略；而它要求的 `version` / `notes` / `pub_date`(RFC3339) / `platforms["windows-x86_64"].{url,signature}` 我们全部提供。**所以翻 `releases/latest` 不会让老客户端解析失败。**

### 本次发布顺带补的两道护栏

1. **发布脚本检查随包运行时是否为本版本构建**：`desktop-runtime.json` 记录 `shell` 版本，与待发布版本不一致直接失败并提示 `pnpm runtime:prepare`。没有这道检查，版本一升就会**静默**把上一版运行时打进安装包（文件数与哈希依旧自洽，只是描述的是旧运行时）。
2. **签名前先校验打包载荷**：调用 `verify-package.mjs` 核对已打包目录的文件数、关键文件哈希、以及「关键文件表里没有外地平台文件」。签名一个载荷有问题的安装包比不发布更糟。



## 正式切换：v0.3.6（2026-09-29）

预发布验证通过后，把更新通道正式切到 Electron 版。

| 项 | 值 |
|---|---|
| 版本 | **0.3.6**（Latest，非预发布） |
| 安装包 | `DSH.Desktop_0.3.6_x64-setup.exe`，187.8 MiB |
| 清单 | `shell {minimum:"0.3.0", channel:"stable"}` |

### 验证结果

| 检查 | 结果 |
|---|---|
| **更新通道已切换** | `releases/latest/download/latest.json` → **0.3.6** ✔ |
| Release 类型 | `isPrerelease: false`，已成为 Latest ✔ |
| 资产完整 | 安装包 + `.sig` + `latest.json` ✔ |
| **匿名下载 + 验签（走 latest 通道）** | 196,926,227 字节，应用内置公钥验签通过 ✔ |

### 切换后已安装的 Tauri 客户端会经历什么

1. 启动后 10 秒的静默检查发现 0.3.6 → 弹出居中更新窗口；
2. 用户确认 → Tauri 用**内置公钥**验签并运行安装器，参数为 `/P /R /UPDATE /ARGS "<exe>"`；
3. 我们的桥接把 `/UPDATE` 翻译成静默安装，安装完成后 `ExecShell open` 启动新版；
4. 安装目录不同（Tauri 在 `D:\Program Files\DSH Desktop`，Electron 发布版在 `%LOCALAPPDATA%\Programs\DSH Desktop`），所以是**并存安装 + 提示卸载**，不是原地覆盖；
5. Tauri 进程 `std::process::exit(0)` → `RunEvent::Exit` → `taskkill /PID <child> /T /F` 清掉 dsh 进程树 → 41729 释放；
6. 新版启动，检测到遗留 Tauri 安装 → 询问用户是否卸载旧版。

**第 5 与第 6 步之间存在时序竞争**：新应用走到端口闸门通常要 0.5–2 秒，而旧进程释放端口只要几十毫秒，正常是安全的；慢机器上可能撞上。为此给端口闸门加了**有界等待**（`waitForPort`，15 秒内每 500ms 重试，仍被占用才报错）——**不退回随机端口**，固定端口规则不变。3 项测试覆盖：端口空闲立即通过、等待旧进程释放后通过、始终占用时受控失败。

### 已知边界

| 项 | 说明 |
|---|---|
| blockmap 差分 | 每次更新仍是全量 187.8 MiB；`.blockmap` 已生成但未接入自建通道 |
| SmartScreen | 无代码签名证书；由更新流程启动的安装包通常不带 MOTW，手动下载首次运行可能有提示 |
| 老客户端实测 | 清单兼容性是**静态论证**（`tauri-plugin-updater` 无 `deny_unknown_fields`）+ 匿名下载验签；未在真机上跑过一次 Tauri → Electron 的自迁移 |

## 后续发布：v0.3.7（2026-09-29）

切换之后的第一批用户可见改动，走同一条流水线（演习 → 正式 → 发布后验证）。

| 项 | 值 |
|---|---|
| 版本 | **0.3.7**（Latest） |
| 安装包 | `DSH.Desktop_0.3.7_x64-setup.exe`，187.8 MiB |
| 随包运行时 | dsh 0.1.7-rc.2，12395 文件，关键文件 26 个 |
| 清单 | `shell {minimum:"0.3.0", channel:"stable"}` |

内容（用户可见）：窗口几何记忆、崩溃兜底、持久日志 + 诊断支持包、启动页改用真实 logo、托盘图标改用多尺寸 ico、「关于」重做、托盘菜单精简。另含仅影响开发的开发态数据隔离（`pnpm dev` 使用 `.dev` 目录，不再污染安装版设置）。

### 验证结果

| 检查 | 结果 |
|---|---|
| 更新通道 | `releases/latest/download/latest.json` → **0.3.7**，`channel: stable` ✔ |
| Release 类型 | `isPrerelease: false`，已成为 Latest；三个资产齐全 ✔ |
| **匿名下载 + 验签** | 经 latest 通道下载 **196,967,022 字节**，应用内置公钥验签通过 ✔ |
| 发布前护栏 | 运行时新鲜度（清单 `shell` 必须等于待发布版本）与载荷校验（12396 文件 / 26 关键文件 / 无外地平台文件）均在签名前通过 ✔ |

### 发布流程每次都会跑的四道关卡

1. **版本一致性**：`electron/package.json` 必须等于传入版本；
2. **运行时新鲜度**：`desktop-runtime.json.shell` 必须等于该版本，否则提示先跑 `pnpm runtime:prepare`——没有这道关卡，版本一升就会静默打进上一版运行时；
3. **载荷校验**：打包目录的文件数 / 关键文件哈希 / 无外地平台文件；
4. **签名自校验**：用 `tauri.conf.json` 里的公钥验证刚生成的签名，再上传。

## 后续发布：v0.3.8（2026-09-29）

| 项 | 值 |
|---|---|
| 版本 | **0.3.8**（Latest） |
| 安装包 | `DSH.Desktop_0.3.8_x64-setup.exe`，187.9 MiB |
| 清单 | `shell {minimum:"0.3.0", channel:"stable"}` |

内容：**自绘标题栏**（菜单并入标题行，原生菜单栏移除，窗口标题固定）、**迁移 profile 的克隆与一次性修复**（这是 0.3.6/0.3.7 迁移用户新建会话失败的修复）。

验证：`releases/latest` → 0.3.8 ✔；`isPrerelease: false` ✔；三个资产齐全 ✔；经 latest 通道匿名下载 **196,976,116 字节**、应用内置公钥验签通过 ✔。

### 这一版修的是一个真实的阻塞问题

用户用 0.3.7 迁移后**无法新建会话**：`agent-preset/not-found: Unknown agent preset: git-bash`。原因是迁移只复制了出厂模板（bundle 列表 + dependencies），而 `git-bash` 这个 preset 定义在用户的 `cordis.patch.yml` 用户层里（23 KB）——新 profile 只有 dsh 生成的骨架（622 字节）。

修法分两层，都在 0.3.8：

1. **首次运行改为完整克隆**用户的 `web` profile（用户层 patch、`node_modules`、插件管理器状态、workspace/lockfile），只改清单里的 name；克隆用「临时目录 → 改名 → 原子 rename」，符号链接原样保留。
2. **一次性修复**已被旧逻辑播种的 profile：判据是目标 patch 小于源的四分之一（骨架特征），补齐用户层并把 patch 点名但 `package.json` 未声明的 `link:` 插件用 `pnpm add` 补上；判定保守（真实修好后的 22991 vs 23036 判为「已配置，不动」）。

教训写在 `electron/README.md`：**迁移 profile 必须带上"用户层"**——`package.json` 的 bundle 列表只是模板，用户手写的配置和它解析所需的包才是他们真正的工作环境。

## 后续发布：v0.3.9（2026-09-29）——随包 dsh 升到 0.2.0-rc.1

| 项 | 值 |
|---|---|
| 版本 | **0.3.9**（Latest） |
| 安装包 | `DSH.Desktop_0.3.9_x64-setup.exe`，188.1 MiB |
| 随包运行时 | **dsh 0.2.0-rc.1**（0.1.7-rc.2 → 0.2.0-rc.1），12546 文件 / 359.4 MiB，关键文件 26 个 |
| Electron | 44.0.0（V8 `15.2.124.13-electron.0`，新 dsh 的原生插件白名单仍接受，`prepare-runtime` 校验通过） |

### 升级前的兼容性核查

| 检查 | 结果 |
|---|---|
| 依赖面 | 81 → 82 个依赖，**无移除、无主次版本变动**，仅新增 `@deepseek-ai/dsh-experimental-schedule-bundle` |
| 闸门 ① | `dsh --version` → `0.2.0-rc.1` ✔ |
| 闸门 ② | 顶层 `dsh --help` 仍含 `--patch`（3 处）✔ |
| profile 名保留 | `desktop` 仍被保留，壳用的 `dsh-desktop` 不受影响 ✔ |
| **随包运行时端到端**（开发态，`DSH_DESKTOP_BUNDLED_RUNTIME` 指向新树） | 闸门通过、DSH 界面 468 节点、**panelReady: true**（面板插件在新 dsh 下正常）、titleBar 36/36、窗口标题固定、tasks/session 正常 ✔ |
| **打包态**（`release/win-unpacked`） | `runtime: bundled 0.2.0-rc.1 (12546 文件, shell 0.3.9)`、界面 468 节点、panelReady ✔、标题栏文档自 asar 加载、**标题栏 logo 渲染**（`naturalWidth: 32`）、两个菜单条目正确 ✔ |
| 发布后 | `latest` → 0.3.9、`isPrerelease: false`、三资产齐全、经 latest 通道匿名下载 **197,283,991 字节**并验签通过 ✔ |

### 0.3.9 还修了两个用户可见问题

1. **标题栏 logo 空白**：标题栏是壳自己的网页，其 CSP 漏了 `img-src`，图片被**静默**拦掉。已补，并把「logo 是否真的渲染」并入长期保留的菜单冒烟（`DSH_DESKTOP_SMOKE_MENU=1`）。
2. **状态页是死胡同**：「应用 → 重新加载启动页」后只能靠菜单切回。现在服务就绪时该页显示「进入 DSH 界面」，实测点击后导航回 DSH 界面。

### 安装器不再按进程名关闭"运行中的程序"

0.3.8 的第一版用进程名匹配并终止（`taskkill /IM`），它会连**同一产品的其他安装**一起关掉——实测把用户正在使用的另一份安装杀了。现在应用通过 `/DSHPID=` 交出自身 PID，安装器只等待并只终止那一个进程；手工安装（无 PID）永不按名字终止。

真机验证（独立产品标识的安装包）：

| 场景 | 结果 |
|---|---|
| 静默安装、另一份安装正在运行、无 `/DSHPID` | 安装成功 12422 文件，**另一份安装毫发无损** |
| 带 `/DSHPID`，目标实例在运行 | 退出码 0、安装成功 12250+ 文件、**目标实例被关闭**、另一份安装不受影响 |

### 一条必须记住的教训

electron-builder 的安装器会**先运行旧版本的卸载器**再进入安装段。用静默安装测试时若中途中止，会出现「旧安装已被卸载、新安装没装上」的状态——用户的一份安装就是这样没的。**不要拿真实安装目录做静默安装实验**，要用独立的产品标识（本次用的就是 `DSH Scratch` 这类临时标识，装完即删）。


## 后续发布：v0.3.10（2026-09-29）——桌面端设置脱离 DSH

| 项 | 值 |
|---|---|
| 版本 | **0.3.10**（Latest） |
| 安装包 | `DSH.Desktop_0.3.10_x64-setup.exe`，188.1 MiB |
| 随包运行时 | dsh 0.2.0-rc.1（12546 文件 / 359.4 MiB，关键文件 26 个） |

### 桌面端设置改由壳自己实现

原来「桌面端」设置页是 DSH 面板插件渲染的：插件自己写 `shell-settings.json`，再通过面板桥通知壳重读——绕了 DSH、插件、HTTP 桥三圈。现在壳自己开一个设置窗口（`应用 → 设置…`）：

| 设置项 | 校验 |
|---|---|
| 服务端口 | 整数 1024–65535，越界拒绝；env > 设置 > 通道默认 |
| 关闭按钮行为 | `minimizeToTray` / `exit` |
| 代理 | 开关 + HTTP/HTTPS/no_proxy；**关掉开关时保留已填内容** |
| 更新检查 | 启动时检查桌面端 / DSH |

设计要点：校验与合并收在 `settings-shape.ts` 的 `mergeSettingsInput()`，**原生窗口与 DSH 面板共用一份**，两条写入路径不会分叉；写入是「读盘 → 合并保留未知字段 → 临时文件 + 原子 rename」，因为这份文件与 Tauri 壳的面板插件共用。窗口与标题栏一样跟随系统主题。

实测（开发态，临时钩子）：页面渲染端口 41733、6 项只读状态、关闭行为 `minimizeToTray`、主题浅色；提交 `80` 被拒（`端口必须是 1024–65535 之间的整数`）；提交 `42001` 落盘为 `{"service":{"port":42001},...}`。

### 菜单调整

`重新加载界面 / 显示状态页（诊断）/ 重启 DSH 服务（重启应用）/ 检查更新… / 导出诊断信息… / 设置… / 关于`。

- 「编辑」菜单删除：Windows 下 Ctrl+C/V/X/A/Z 在网页内容里本来就能用。
- 「重新加载启动页」→「显示状态页（诊断）」：它切到的是壳的诊断页（闸门、dsh 版本、端口、加载模式、日志），不是刷新。
- 「退出」从应用菜单移除：它离「重新加载界面」「设置…」只有一个点击的距离，误触就结束会话；退出保留在托盘菜单与窗口关闭按钮（按 `closeBehavior`）。
- 「重启 DSH 服务」是**重启整个应用**（文案已写明）：服务是启动时 spawn 的子进程，与托盘、IPC、面板桥一起建立，端口与代理也是启动时读取的参数；原地只重启子进程需要把这些拆开重注册，风险高于收益，故用重启应用换取干净的闸门、端口绑定与认证 cookie。

### 标题栏跟随系统主题

之前窗口底色、标题栏、caption overlay 三处都硬编码 `#0f1115`（浅色桌面也是黑条）。现按 `nativeTheme` 取色，并在主题变化时重绘；强制两种主题实测：浅色 `rgb(243,243,243)` / 深色 `rgb(15,17,21)`。测试同时断言标题栏 HTML 使用主题变量、不允许再出现硬编码。

### 发布后验证

`latest` → 0.3.10 ✔；`isPrerelease: false` ✔；三资产齐全 ✔；经 latest 通道匿名下载 **197,291,699 字节**并验签通过 ✔；打包态冒烟：bundled 0.2.0-rc.1（shell 0.3.10）、界面 468 节点、panelReady ✔、标题栏自 asar 加载 ✔；asar 内容核对含 `dist/settings/index.html` 等全部 11 个文件 ✔。

## 后续发布：v0.3.11（2026-09-30）——随包 DSH 升至 0.2.0-rc.2 + 侧边栏浏览器

| 项 | 值 |
|---|---|
| 版本 | **0.3.11**（Latest） |
| 安装包 | `DSH.Desktop_0.3.11_x64-setup.exe`，188.7 MiB（197,842,598 字节） |
| 随包运行时 | dsh **0.2.0-rc.2**（12446 文件 / 360.8 MiB，关键文件 26 个；打包载荷校验 12447 个文件） |
| pin 变更 | `electron/runtime-pin.json`：dsh 0.2.0-rc.1 → 0.2.0-rc.2（pnpm 10.34.2 不变） |

### 为什么 DSH 升级必须连着壳一起发

`runtime-pin.json` 的注释写明 shell / 随包 dsh / pnpm / 面板插件**作为一个整体发布**，而且
`prepare-runtime.mjs` 还要校验随包原生插件的 V8 指纹白名单（本次通过：Electron 44.0.0 → V8
`15.2.124.13-electron.0`，详见 README 硬约束 11）。所以升级顺序是：改 pin + 改壳版本 → 重跑
`runtime:prepare` → **先在隔离实例上验证** → 构建 → 发版。

### 升级前在隔离实例上的验证（41733，用 `DSH_DESKTOP_BUNDLED_RUNTIME` 指向新运行时）

| 环节 | 结果 |
|---|---|
| 运行时清单校验 | 通过：dsh 0.2.0-rc.2，12446 个文件 |
| 启动闸门 | 通过：`dsh 0.2.0-rc.2`，端口 41733 |
| **rc.1 建的 profile** | 直接复用成功（用户升级时会走的同一条路径） |
| 面板插件 | sessions 服务接入、内置技能、14 个原生工具、`/dsh-desktop-shell/v1/*` 路由全部就绪 |
| 浏览器工具 | `navigate` 142 ms（页面加载并上屏）、`snapshot` 20 ms、遮罩成对显示/撤下 |
| prepare 自身 | 安装 537 包 → 裁剪 13989 项 / 111.4 MiB（472.2 → 360.8 MiB）→ `dsh --version` 与 `web --help` 自证加载 → 随包 pnpm shim 可用 |

### 侧边栏浏览器（本次一并进入安装版）

桌面壳自己实现的浏览器，注册为 DSH 右侧栏的规范 tab 类型（不依赖 DSH 自带的
`ui-sidebar-browser`，后者通过 overlay 关掉）。一个侧边栏 tab = 一个独立浏览器组件实例：各自的
地址/历史/元素提取/设备模拟/遮罩/控制权；agent 通过 14 个工具操作，操作期间显示「助手正在操作」
遮罩（跟 agent 的回合显示、回合结束自动撤下）。设计与全部实测记录见
[sidebar-browser-integration.md](sidebar-browser-integration.md)。

### 发布后验证

`latest.json` → 0.3.11 ✔（版本/签名/URL 配套）；`isPrerelease: false`、`isLatest: true` ✔；三资产齐全
（exe + sig + latest.json）✔；安装包经 latest 通道匿名 HEAD **200** ✔；签名自校验通过 ✔；打包载荷
自证 **`dsh 0.2.0-rc.2（Electron 44.0.0）`、12447 个文件、关键文件 26 个** ✔。
