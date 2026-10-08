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

// The plugin-management path: the shims must be physical, and pnpm's JS must be readable through
// the archive they point into (the shell passes its path down as DSH_DESKTOP_PNPM_ENTRY).
for (const shim of ['pnpm.cmd', 'node.cmd']) {
  if (!existsSync(join(unpackedRoot, 'dsh', 'bin', shim))) fail(`缺少随包 shim：app.asar.unpacked/dsh/bin/${shim}`)
}
if (!archived.some(entry => entry.path === 'dsh/node_modules/pnpm/bin/pnpm.cjs')) {
  fail('app.asar 里缺少 pnpm 入口 node_modules/pnpm/bin/pnpm.cjs')
}

// Run the packaged shim the way an outside caller does — `pnpm` resolved from PATH with no
// DSH_DESKTOP_PNPM_ENTRY — because that is exactly how it took down an electron-builder run: the
// shim looked for pnpm in the unpacked tree, where JavaScript is not.
const appExecutable = join(unpacked, 'DSH Desktop.exe')
if (!existsSync(appExecutable)) fail('缺少 DSH Desktop.exe')
const shimVersion = execFileSync(`"${join(unpackedRoot, 'dsh', 'bin', 'pnpm.cmd')}" --version`, {
  env: { ...process.env, DSH_DESKTOP_NODE_EXECUTABLE: appExecutable, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_PNPM_ENTRY: '' },
  windowsHide: true,
  shell: true,
  encoding: 'utf8',
}).trim()
if (!/^\d+\.\d+\.\d+/u.test(shimVersion)) fail(`打包后的 pnpm shim 不可用（PATH 解析场景），输出：${shimVersion}`)

process.stdout.write(
  `打包校验通过：dsh ${packaged.dsh}（Electron ${packaged.electron}）、asar 内 ${String(archived.length)} 个文件、`
  + `关键文件 ${String(Object.keys(packaged.critical).length)} 个、物理落盘 ${String(packaged.physical.length)} 个、`
  + `pnpm shim ${shimVersion}\n`,
)
