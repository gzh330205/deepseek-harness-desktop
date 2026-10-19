#!/usr/bin/env node
/**
 * Verify a packaged app directory actually contains the runtime it claims.
 *
 * The runtime now lives **inside** `resources/app.asar` (one file on disk instead of ~12,400, which
 * is what makes installation fast) with the files that cannot be loaded from an archive in
 * `resources/app.asar.unpacked/dsh`. Two failures this guards against, both of which used to be
 * silent:
 *
 *   1. the tree not being packed at all — electron-builder excludes a source directory's root
 *      `node_modules`, and still exits 0, so the app would fall back to a system dsh;
 *   2. a file that must be physical staying inside the archive — `.node`/`.exe` cannot be loaded
 *      from an ASAR, so the app refuses to start ("随包运行时文件损坏或不完整").
 *
 * Usage: node scripts/verify-package.mjs [--dir <unpackedDir>]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isForeignPlatformPath } from './runtime-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dirIndex = process.argv.indexOf('--dir')
const unpacked = dirIndex >= 0 && process.argv[dirIndex + 1] !== undefined
  ? resolve(process.argv[dirIndex + 1])
  : join(root, 'release', 'win-unpacked')
const resources = join(unpacked, 'resources')

function fail(message) {
  process.stderr.write(`打包校验失败：${message}\n`)
  process.exit(1)
}

const sourceManifestPath = join(root, 'runtime', 'dsh', 'desktop-runtime.json')
if (!existsSync(sourceManifestPath)) fail('缺少 runtime/dsh/desktop-runtime.json，先运行 prepare-runtime.mjs')
const expected = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
if (!Array.isArray(expected.physical) || expected.physical.length === 0) {
  fail('运行时的 desktop-runtime.json 里没有 physical 清单（先重新运行 prepare-runtime.mjs）')
}

const asarPath = join(resources, 'app.asar')
if (!existsSync(asarPath)) fail('缺少 app.asar')
const unpackedRoot = `${asarPath}.unpacked`
if (!existsSync(unpackedRoot)) fail(`缺少 ${unpackedRoot}（asarUnpack 未生效）`)

/** The ASAR reader electron-builder itself uses; resolved through it, since pnpm keeps
 * `app-builder-lib` out of this package's own `node_modules`. */
const { readAsar } = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json'))(
  'app-builder-lib/out/asar/asar.js',
)
const archive = await readAsar(asarPath)

// The market window is a shell surface. If its page, its bridge or its menu entry is missing from the
// archive, the menu item opens an empty window — the same class of silent packaging loss this script
// exists for (a source directory that electron-builder quietly left out, exit code still 0).
const marketPage = join('dist', 'market', 'index.html')
let marketHtml = ''
try {
  marketHtml = (await archive.readFile(marketPage)).toString('utf8')
} catch (error) {
  fail(`app.asar 里没有市场窗口页面 ${marketPage}：${String(error)}`)
}
if (!marketHtml.includes('__DSH_MARKET__')) fail('市场窗口页面没有引用 __DSH_MARKET__ 桥')

// The phone-access window is a shell surface too — and the one the DSH sidebar entry opens. A missing
// page means the entry opens an empty window, which is exactly the silent loss this script catches.
const pocketPage = join('dist', 'pocket', 'index.html')
let pocketHtml = ''
try {
  pocketHtml = (await archive.readFile(pocketPage)).toString('utf8')
} catch (error) {
  fail(`app.asar 里没有手机访问窗口页面 ${pocketPage}：${String(error)}`)
}
if (!pocketHtml.includes('__DSH_SETTINGS__')) fail('手机访问窗口页面没有引用 __DSH_SETTINGS__ 桥')

// The 用量 (ONE-WAY), MCP & Skills and hover-card pages are shell surfaces as well. Their pages must be
// in the archive *and* reference their preload bridges, or the entry opens an empty window.
for (const [name, pagePath, bridge] of [
  ['用量', join('dist', 'usage', 'index.html'), '__DSH_USAGE__'],
  ['MCP 与 Skills', join('dist', 'mcp', 'index.html'), '__DSH_MCP__'],
  // The 用量 button's hover card: a missing page here means hovering the button shows a blank sliver,
  // which no menu smoke would catch on a packaged build.
  ['用量浮窗', join('dist', 'usage-popover', 'index.html'), '__DSH_USAGE_POPOVER__'],
]) {
  let html = ''
  try {
    html = (await archive.readFile(pagePath)).toString('utf8')
  } catch (error) {
    fail(`app.asar 里没有${name}页面 ${pagePath}：${String(error)}`)
  }
  if (!html.includes(bridge)) fail(`${name}页面没有引用 ${bridge} 桥`)
}

// The bundled plugins are separate packages the shell links into the profile, so they live in
// `resources/plugins` — not the archive. Losing them silently would mean the panels the user has
// always had simply stop existing after an update.
const pluginsRoot = join(resources, 'plugins')
const pluginsManifestPath = join(pluginsRoot, 'plugins.json')
if (!existsSync(pluginsManifestPath)) fail('resources/plugins 缺失（先运行 scripts/prepare-plugins.mjs）')
const pluginsManifest = JSON.parse(readFileSync(pluginsManifestPath, 'utf8'))
if (!Array.isArray(pluginsManifest.packages) || pluginsManifest.packages.length === 0) {
  fail('resources/plugins/plugins.json 没有 packages 清单')
}
for (const plugin of pluginsManifest.packages) {
  for (const file of ['package.json', 'index.js']) {
    if (!existsSync(join(pluginsRoot, plugin, file))) fail(`随壳插件 ${String(plugin)} 缺少 ${file}`)
  }
  const linkTarget = join(pluginsRoot, plugin, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json')
  if (!existsSync(linkTarget)) fail(`随壳插件 ${String(plugin)} 缺少运行时依赖 @deepseek-ai/schemastery`)
}

// `dist/main.js` is checked through the IPC channel names rather than the menu label: esbuild emits
// ASCII by default, so the Chinese label is written as `\uXXXX` escapes and a literal match would
// fail on a perfectly good build.
for (const [entry, needle] of [['dist/preload.cjs', '__DSH_MARKET__'], ['dist/main.js', 'market:search'], ['dist/main.js', 'market:profile-dir']]) {
  let text = ''
  try {
    text = (await archive.readFile(join(...entry.split('/')))).toString('utf8')
  } catch (error) {
    fail(`app.asar 里缺少 ${entry}：${String(error)}`)
  }
  if (!text.includes(needle)) fail(`${entry} 里没有 ${needle}（市场入口没进包）`)
}

const manifestInsideAsar = join('dsh', 'desktop-runtime.json')
let packaged
try {
  packaged = JSON.parse((await archive.readFile(manifestInsideAsar)).toString('utf8'))
} catch (error) {
  fail(`app.asar 里没有随包运行时清单 ${manifestInsideAsar}：${String(error)}`)
}
if (packaged.dsh !== expected.dsh || packaged.listDigest !== expected.listDigest) {
  fail(`随包运行时与源不一致（dsh ${String(packaged.dsh)} vs ${String(expected.dsh)}）`)
}

// Walk the archive the same way the runtime verification does: every file under `dsh/`.
const archived = []
const collect = (node, path) => {
  if (node.files !== undefined) {
    for (const [name, child] of Object.entries(node.files)) collect(child, `${path}/${name}`)
    return
  }
  if (node.link !== undefined) fail(`app.asar 里出现链接：${path}`)
  archived.push({ path, unpacked: node.unpacked === true })
}
collect(archive.getFile('dsh', false), 'dsh')
if (archived.length !== packaged.files + 1) {
  fail(`随包运行时文件数不符：app.asar 里 ${String(archived.length)} 个，清单声明 ${String(packaged.files)} + 1（清单自身）`)
}

for (const relativePath of Object.keys(packaged.critical)) {
  if (isForeignPlatformPath(relativePath, packaged.platform, packaged.arch)) {
    fail(`关键文件表里出现了其他平台/架构的文件：${relativePath}（应被 prepare-runtime 裁掉）`)
  }
  if (!archived.some(entry => entry.path === `dsh/${relativePath}`)) {
    fail(`app.asar 里缺少关键文件：dsh/${relativePath}`)
  }
}
if (!archived.some(entry => entry.path === `dsh/${packaged.entry}`)) {
  fail(`app.asar 里缺少入口：dsh/${packaged.entry}`)
}

// The real check: everything the manifest calls physical must be a physical file next to the ASAR.
// A missing entry here is not a slow install, it is an app that will not start.
const missing = []
for (const relativePath of packaged.physical) {
  const physical = join(unpackedRoot, 'dsh', relativePath)
  if (!existsSync(physical)) {
    missing.push(relativePath)
    continue
  }
  if (statSync(physical).size === 0) missing.push(`${relativePath}（空文件）`)
}
if (missing.length > 0) {
  fail(`asarUnpack 漏了 ${String(missing.length)} 个必须物理落盘的运行时文件，例如：${missing.slice(0, 5).join('、')}`)
}
const wronglyPacked = archived.filter(entry => entry.unpacked && !entry.path.startsWith('dsh/'))
if (wronglyPacked.length > 0) fail(`意外的 unpacked 条目：${wronglyPacked[0].path}`)

for (const required of ['dsh-desktop-shell/index.js', 'dsh-desktop-shell/client.js']) {
  if (!existsSync(join(resources, required))) fail(`缺少面板插件资源：resources/${required}`)
}

// The tunnel binary for phone access over the internet: it must be physically present (it is
// spawned, so an ASAR path would fail at the worst moment) and byte-identical to the pinned release.
// A wrong or missing binary here means the feature silently cannot work after installation.
{
  const pin = JSON.parse(readFileSync(join(root, 'cloudflared-pin.json'), 'utf8'))
  const pinned = pin.artifacts?.['win32-x64']
  const binary = join(resources, 'cloudflared', 'cloudflared.exe')
  if (!existsSync(binary)) {
    fail('缺少随包 cloudflared：resources/cloudflared/cloudflared.exe（先运行 pnpm cloudflared:prepare）')
  }
  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  if (pinned !== undefined && digest !== pinned.sha256) {
    fail(`随包 cloudflared 与 pin 不一致（${pin.version}）：实际 ${digest}`)
  }
  process.stdout.write(`cloudflared ${String(pin.version)} 已随包（${(statSync(binary).size / 1024 / 1024).toFixed(1)} MiB，哈希与 pin 一致）\n`)
}

// The plugin-management path: the shims must be physical, and pnpm's JS must be readable through
// the archive they point into.
for (const shim of ['pnpm.cmd', 'node.cmd']) {
  if (!existsSync(join(unpackedRoot, 'dsh', 'bin', shim))) fail(`缺少随包 shim：app.asar.unpacked/dsh/bin/${shim}`)
}
if (!archived.some(entry => entry.path === 'dsh/node_modules/pnpm/bin/pnpm.cjs')) {
  fail('app.asar 里缺少 pnpm 入口 node_modules/pnpm/bin/pnpm.cjs')
}

// Run the packaged shim the way DSH's plugin installer does: `pnpm` resolved from PATH with a
// **scrubbed** environment. `dsh-subprocess` drops every `DSH_`-prefixed variable before spawning a
// child, so the shell's hints are gone and the shim has to find its binaries by itself. Reproducing
// that stripped environment is the point of this check — with the variables present it passes even
// while "install plugin" fails with `cannot find the bundled pnpm` in the UI.
const appExecutable = join(unpacked, 'DSH Desktop.exe')
if (!existsSync(appExecutable)) fail('缺少 DSH Desktop.exe')
const scrubbed = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('DSH_')),
)

// The bundled **real** node, and the reason it exists: it is a console-subsystem program, so the
// `cmd.exe` hops of a package script inherit the hidden console DSH created instead of allocating a
// new one (which Windows Terminal turns into a window). It can only do that job if pnpm's JS is on
// disk — a real node cannot read an ASAR — so both halves are asserted together, by running pnpm on
// the bundled node with no Electron, no `ELECTRON_RUN_AS_NODE` and no `DSH_*` hints.
const packagedNode = join(unpackedRoot, 'dsh', 'bin', 'node.exe')
if (!existsSync(packagedNode)) fail('缺少随包 node：app.asar.unpacked/dsh/bin/node.exe')
if (typeof packaged.nodeRuntime !== 'string' || packaged.nodeRuntime === '') fail('运行时清单没有 nodeRuntime')
const packagedNodeVersion = execFileSync(packagedNode, ['--version'], { windowsHide: true, encoding: 'utf8' }).trim()
if (packagedNodeVersion !== `v${packaged.nodeRuntime}`) {
  fail(`随包 node 版本与清单不符：清单 ${packaged.nodeRuntime}，实际 ${packagedNodeVersion}`)
}
const unpackedPnpm = join(unpackedRoot, 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
if (!existsSync(unpackedPnpm)) {
  fail('pnpm 的 JS 没有解包：真实 node 读不了 app.asar，打包态下 pnpm 会直接失败')
}
const unpackedPnpmVersion = execFileSync(packagedNode, [unpackedPnpm, '--version'], {
  env: scrubbed,
  windowsHide: true,
  encoding: 'utf8',
}).trim()
if (!/^\d+\.\d+\.\d+/u.test(unpackedPnpmVersion)) fail(`随包 node 无法直接运行随包 pnpm，输出：${unpackedPnpmVersion}`)
if (unpackedPnpmVersion !== packaged.pnpm) {
  fail(`解包后的 pnpm 版本与清单不符：清单 ${String(packaged.pnpm)}，实际 ${unpackedPnpmVersion}`)
}

const shimVersion = execFileSync(`"${join(unpackedRoot, 'dsh', 'bin', 'pnpm.cmd')}" --version`, {
  env: scrubbed,
  windowsHide: true,
  shell: true,
  encoding: 'utf8',
}).trim()
if (!/^\d+\.\d+\.\d+/u.test(shimVersion)) fail(`打包后的 pnpm shim 不可用（PATH 解析场景），输出：${shimVersion}`)

/** Bind an ephemeral loopback port and release it, so the smoke boot does not fight a running app. */
function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolvePromise(port) })
    })
  })
}

/**
 * The composition gate: what the shell injects must actually mount in a profile.
 *
 * 0.4.5 shipped with the four panels and every MCP server written in ways the DSH loader only
 * *warns* about (`patch: entry "…" not found`): the four plugin rows were plain top-level patch
 * entries (the loader treats a `name` there as an assertion, never an insert) and the MCP rows had
 * the same spelling, so nothing mounted. Every check above this one passed — the installer had the
 * plugin files, the runtime was intact — and the user still lost the features. This gate boots the
 * packaged shell on a throwaway home (the first-install path) that already contains one MCP row in
 * the old broken spelling, then asks the same packaged dsh to compose the result:
 *
 *  - the shell must link the four shipped packages into the profile and register them in
 *    `dsh.profile.bundles` (what actually mounts them);
 *  - the old MCP row must be repaired into an `insert` container and compose without warnings;
 *  - the user's existing plugin config (`sidebarWidth`) must still apply to the mounted row.
 *
 * A profile is the one place a packaged build can still lose this silently, so it is checked on the
 * artifact that is about to be signed, not in a unit test.
 */
async function verifyProfileComposition() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-composition-'))
  try {
    const home = join(tempRoot, 'home')
    const userData = join(tempRoot, 'user-data')
    const profileDir = join(home, 'profiles', 'dsh-desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-dsh-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
    }, null, 2)}\n`, 'utf8')
    // The two shapes 0.4.5 left behind: a top-level MCP row (never mounts) and a plugin config
    // override that only works once the package is registered as a bundle.
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '# 用户自己的补丁：组合校验',
      '- id: mcp-composition_check',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  config:',
      '    serverName: composition_check',
      '    transport: streamable-http',
      '    url: http://127.0.0.1:9/mcp',
      '',
      '- id: sidebar-width',
      '  name: dsh-sidebar-width',
      '  config:',
      '    sidebarWidth: 301',
      '    rightbarWidth: 300',
      '',
    ].join('\n'), 'utf8')

    const port = await freePort()
    const smokeEnvironment = {
      ...process.env,
      DSH_DESKTOP_SMOKE: '1',
      DSH_DESKTOP_DSH_HOME: home,
      DSH_DESKTOP_USER_DATA_DIR: userData,
      DSH_DESKTOP_PORT: String(port),
      DSH_DESKTOP_SKIP_LEGACY_CLEANUP: '1',
    }
    // The GUI app must start as Electron, not as Node: this script itself may be run from a
    // DSH-hosted terminal, which exports ELECTRON_RUN_AS_NODE=1.
    delete smokeEnvironment.ELECTRON_RUN_AS_NODE
    try {
      execFileSync(appExecutable, [], { env: smokeEnvironment, cwd: unpacked, windowsHide: true, timeout: 240_000, stdio: 'pipe' })
    } catch {
      // The report below is the source of truth: a failed smoke still writes it (and exits 1).
    }

    const resultPath = join(userData, 'smoke-result.json')
    if (!existsSync(resultPath)) throw new Error('打包壳冒烟没有写出 smoke-result.json')
    const smoke = JSON.parse(readFileSync(resultPath, 'utf8'))
    if (smoke.ok !== true) throw new Error(`打包壳冒烟失败（${String(smoke.stage ?? 'unknown')}：${String(smoke.message ?? '')}）`)
    const shellLog = readFileSync(join(userData, 'shell.log'), 'utf8')
    if (!shellLog.includes('已把 4 个插件登记进 profile 的 bundle 列表')) {
      throw new Error('随壳插件没有登记进 profile 的 dsh.profile.bundles（shell.log 里没有登记日志）')
    }
    // Mounting is not enough: the packaged copy has to be importable by its own entry point. A
    // plugin missing a directory it imports (`src/host/*` was dropped from the copy) mounts, warns
    // `entries did not activate`, and its panels stay absent with the same user-visible result.
    const activationFailures = shellLog.split(/\r?\n/u)
      .filter(line => line.includes('did not activate') || line.includes('failed to import'))
    if (activationFailures.length > 0) {
      throw new Error(`随壳插件在打包 dsh 里没有激活：${activationFailures.slice(0, 3).join('；')}`)
    }

    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    for (const plugin of pluginsManifest.packages) {
      if (!bundles.includes(plugin)) throw new Error(`profile 的 bundle 列表缺少 ${String(plugin)}`)
      if (!existsSync(join(profileDir, 'node_modules', plugin, 'package.json'))) {
        throw new Error(`随壳插件没有链接进 profile：${String(plugin)}`)
      }
    }

    const dshEntry = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const dump = spawnSync(appExecutable, [dshEntry, '--profile', 'dsh-desktop', '--dump-config'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
    })
    if (dump.status !== 0) throw new Error(`打包 dsh --dump-config 退出码 ${String(dump.status)}：${String(dump.stderr).trim().slice(-500)}`)
    const composed = String(dump.stdout)
    const warnings = String(dump.stderr)
    const notFound = warnings.split(/\r?\n/u).filter(line => line.includes('not found'))
    if (notFound.length > 0) throw new Error(`profile 仍有未挂载的 patch 行：${notFound.slice(0, 3).join('；')}`)
    for (const id of ['git-panel', 'run-env-manager', 'sidebar-width', 'workspace-category-manager', 'mcp-composition_check']) {
      if (!new RegExp(`id: ${id}\\b`, 'u').test(composed)) throw new Error(`组合结果里没有挂载的 ${id} 行`)
    }
    if (!/name: '?@deepseek-ai\/dsh-mcp-client'?/u.test(composed)) throw new Error('组合结果里没有 MCP 客户端行')
    if (!/sidebarWidth: 301/u.test(composed)) throw new Error('用户补丁里的插件配置没有作用到挂载行（sidebarWidth: 301）')
    process.stdout.write('==> 组合校验：4 个随壳插件与 MCP 行在打包 dsh 里真实挂载，用户配置生效\n')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

try {
  await verifyProfileComposition()
} catch (error) {
  fail(`组合校验失败：${error instanceof Error ? error.message : String(error)}`)
}

process.stdout.write(
  `打包校验通过：dsh ${packaged.dsh}（Electron ${packaged.electron}）、asar 内 ${String(archived.length)} 个文件、`
  + `关键文件 ${String(Object.keys(packaged.critical).length)} 个、物理落盘 ${String(packaged.physical.length)} 个、`
  + `node ${packagedNodeVersion}、pnpm ${shimVersion}（shim）/ ${unpackedPnpmVersion}（node 直跑）\n`,
)
