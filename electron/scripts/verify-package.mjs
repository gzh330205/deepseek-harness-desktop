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

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
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

process.stdout.write(
  `打包校验通过：dsh ${packaged.dsh}（Electron ${packaged.electron}）、asar 内 ${String(archived.length)} 个文件、`
  + `关键文件 ${String(Object.keys(packaged.critical).length)} 个、物理落盘 ${String(packaged.physical.length)} 个、`
  + `node ${packagedNodeVersion}、pnpm ${shimVersion}（shim）/ ${unpackedPnpmVersion}（node 直跑）\n`,
)
