/**
 * Guards for "the shell brings its own plugins".
 *
 * The dangerous parts are all in the user's profile: replacing a directory someone checked out,
 * deleting the target a stale junction points at, editing package.json without a backup, or
 * removing rows the shell does not actually own. The injection itself is a profile *bundle*
 * registration — writing rows into the user's patch never mounted anything.
 */

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createDshConfigStore } from './dsh-config.ts'
import { backupFile, ensureProfileBundles, provisionBundledPlugins, pruneProfileManifest, readShippedPlugins } from './plugin-provision.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-provision-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const PLUGINS = ['dsh-git-panel', 'dsh-run-env-manager', 'dsh-sidebar-width', 'dsh-workspace-category-manager']

const PATCH = `# 用户补丁
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"

- id: oneway-usage-monitor
  name: dsh-oneway-usage-monitor
  config:
    baseUrl: https://oneway.test
  disabled: false

- id: mcp-skill-manager
  name: dsh-mcp-skill-manager
  disabled: false

- id: git-panel
  name: dsh-git-panel
  disabled: false
`

function makePlugin(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version: '0.1.0', main: './index.js', exports: { '.': './index.js' } }, null, 2)}\n`, 'utf8')
  writeFileSync(join(directory, 'index.js'), 'export const name = "plugin"\n', 'utf8')
  const dependency = join(directory, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(dependency, { recursive: true })
  writeFileSync(join(dependency, 'package.json'), '{"name":"@deepseek-ai/schemastery","version":"3.18.4"}\n', 'utf8')
}

function fixture(name: string): { home: string; profileDir: string; pluginsRoot: string } {
  const home = join(root, name)
  const profileDir = join(home, 'profiles', 'dsh-desktop')
  const pluginsRoot = join(root, `${name}-plugins`)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH, 'utf8')
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-dsh-desktop',
    dependencies: { '@changfenhuang/dsh-genui': '0.13.0', 'dsh-plugin-kit': 'link:D:/x/dsh-plugin-kit' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-kit', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }, null, 2)}\n`, 'utf8')
  for (const plugin of PLUGINS) makePlugin(join(pluginsRoot, plugin), plugin)
  return { home, profileDir, pluginsRoot }
}

function profileManifest(profileDir: string): { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown } } } {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown } } }
}

function shellBackups(directory: string, file: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith(`${file}.bak-shell-`))
}

test('shipped plugins are linked and registered as profile bundles, and only once', () => {
  const { home, profileDir, pluginsRoot } = fixture('link')
  const patch = createDshConfigStore({ home })
  const firstLines: string[] = []
  const first = provisionBundledPlugins({ pluginsRoot, profileDir, patch, log: (line) => firstLines.push(line) })
  assert.equal(first.ok, true)
  assert.deepEqual([...first.linked].sort(), [...PLUGINS].sort())
  // The packages themselves declare `dsh.bundle.patch`; registering them is what mounts the panels.
  assert.deepEqual([...first.addedBundles].sort(), [...PLUGINS].sort())
  const manifest = profileManifest(profileDir)
  const bundles = (manifest.dsh?.profile?.bundles ?? []) as string[]
  for (const plugin of PLUGINS) assert.equal(bundles.includes(plugin), true, `${plugin} 必须登记进 dsh.profile.bundles`)
  assert.deepEqual(bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], '原有顺序必须保留')
  assert.equal(bundles.includes('dsh-plugin-kit'), false, '退役的聚合包不能留在 bundle 列表里')
  assert.equal('dsh-plugin-kit' in (manifest.dependencies ?? {}), false, '退役的聚合包依赖也要移除')
  for (const plugin of first.linked) {
    const link = join(profileDir, 'node_modules', plugin)
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${plugin} 必须是链接`)
    assert.equal(existsSync(join(link, 'index.js')), true, `${plugin} 通过链接可读`)
  }
  assert.equal(firstLines.some((line) => line.includes('已把 4 个插件登记进 profile 的 bundle 列表')), true, '登记 bundle 必须有一行日志')
  // Second run: nothing changes, no duplicate links/bundles, no extra manifest rewrite.
  const backupsAfterFirst = shellBackups(profileDir, 'package.json').length
  const secondLines: string[] = []
  const second = provisionBundledPlugins({ pluginsRoot, profileDir, patch, log: (line) => secondLines.push(line) })
  assert.equal(second.linked.length, 0)
  assert.equal(second.unchanged, 4)
  assert.deepEqual(second.addedBundles, [])
  assert.equal(shellBackups(profileDir, 'package.json').length, backupsAfterFirst, '无变更时不再改写 package.json')
  assert.equal(secondLines.some((line) => line.includes('4 个已就绪（无变更）')), true, '无变更的启动也必须留下可诊断日志')
})

test('a profile that never installed the plugins gets them registered in its bundle list', () => {
  const home = join(root, 'fresh-home')
  const profileDir = join(home, 'profiles', 'dsh-desktop')
  const pluginsRoot = join(root, 'fresh-plugins')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# empty\n[]\n', 'utf8')
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-dsh-desktop',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2)}\n`, 'utf8')
  for (const plugin of PLUGINS) makePlugin(join(pluginsRoot, plugin), plugin)
  const patch = createDshConfigStore({ home })
  const result = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.deepEqual([...result.addedBundles].sort(), [...PLUGINS].sort())
  assert.deepEqual(profileManifest(profileDir).dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', ...PLUGINS])
  // The user's patch is only read for retired rows — the shell never invents loader rows for these.
  const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(text, /git-panel|sidebar-width/u)
  assert.deepEqual(provisionBundledPlugins({ pluginsRoot, profileDir, patch }).addedBundles, [])
})

test('ensureProfileBundles appends only missing names and keeps the existing order', () => {
  const directory = join(root, 'bundles')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'package.json')
  writeFileSync(path, `${JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a', 'b'] } } }, null, 2)}\n`, 'utf8')
  const first = ensureProfileBundles(directory, ['c', 'b', 'd'])
  assert.deepEqual(first.added, ['c', 'd'], '已在列表里的名字不重复追加')
  assert.deepEqual(profileManifest(directory).dsh?.profile?.bundles, ['a', 'b', 'c', 'd'])
  assert.equal(shellBackups(directory, 'package.json').length, 1)
  // Idempotent: nothing added, nothing written, no second backup.
  assert.deepEqual(ensureProfileBundles(directory, ['c', 'd']).added, [])
  assert.equal(shellBackups(directory, 'package.json').length, 1)
})

test('ensureProfileBundles leaves a missing, unparseable or bundle-less manifest alone', () => {
  const missing = join(root, 'no-manifest')
  mkdirSync(missing, { recursive: true })
  assert.deepEqual(ensureProfileBundles(missing, ['a']).added, [])
  const broken = join(root, 'broken-manifest')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'package.json'), '{ not json', 'utf8')
  assert.deepEqual(ensureProfileBundles(broken, ['a']).added, [])
  assert.equal(readFileSync(join(broken, 'package.json'), 'utf8'), '{ not json', '坏文件保持原样')
  // A manifest without `dsh.profile` is a normal case (fresh profile): it gets the list created.
  const bare = join(root, 'bare-manifest')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'package.json'), '{"name":"p"}\n', 'utf8')
  assert.deepEqual(ensureProfileBundles(bare, ['a']).added, ['a'])
  assert.deepEqual(profileManifest(bare).dsh?.profile?.bundles, ['a'])
})

test('a real node_modules directory is moved aside, not deleted, and the shipped copy wins', () => {
  const { home, profileDir, pluginsRoot } = fixture('real-dir')
  const real = join(profileDir, 'node_modules', 'dsh-git-panel')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'package.json'), '{"name":"dsh-git-panel","main":"./index.js"}\n', 'utf8')
  writeFileSync(join(real, 'index.js'), '// user checkout\n', 'utf8')
  const patch = createDshConfigStore({ home })
  const result = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(result.linked.includes('dsh-git-panel'), true)
  // The old directory still exists under a backup name with its content untouched…
  const backups = readdirSync(join(profileDir, 'node_modules')).filter((name) => name.startsWith('dsh-git-panel.bak-shell-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(profileDir, 'node_modules', backups[0] ?? '', 'index.js'), 'utf8'), '// user checkout\n')
  // …while the package name now resolves to the shipped copy.
  assert.equal(lstatSync(real).isSymbolicLink(), true)
  assert.equal(readFileSync(join(real, 'index.js'), 'utf8').includes('export const name'), true)
})

test('a stale junction is re-pointed at the shipped copy, and the old target is untouched', () => {
  const { home, profileDir, pluginsRoot } = fixture('stale-link')
  const oldTarget = join(root, 'stale-link-old-target')
  makePlugin(oldTarget, 'dsh-git-panel')
  writeFileSync(join(oldTarget, 'index.js'), '// old shipped copy\n', 'utf8')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const link = join(profileDir, 'node_modules', 'dsh-git-panel')
  symlinkSync(oldTarget, link, 'junction')
  const patch = createDshConfigStore({ home })
  const result = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(result.linked.includes('dsh-git-panel'), true, '旧链接必须被重新指向随壳版本')
  assert.equal(readlinkSync(link).toLowerCase().includes('stale-link-plugins'), true)
  // A recursive remove would have followed the junction and emptied the old target; the old bytes
  // must still be there (and the old directory must be usable, not renamed).
  assert.equal(existsSync(join(oldTarget, 'index.js')), true)
  assert.equal(readFileSync(join(oldTarget, 'index.js'), 'utf8'), '// old shipped copy\n')
})

test('dsh-plugin-kit is removed from dependencies and bundles, with a backup', () => {
  const { profileDir } = fixture('manifest')
  const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
  const result = pruneProfileManifest(profileDir)
  assert.equal(result.dependencies, 1)
  assert.equal(result.bundles, 1)
  const document = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, unknown>; dsh: { profile: { bundles: string[] } } }
  assert.equal('dsh-plugin-kit' in document.dependencies, false)
  assert.deepEqual(document.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  // Everything else survives.
  assert.equal(document.dependencies['@changfenhuang/dsh-genui'], '0.13.0')
  const backups = shellBackups(profileDir, 'package.json')
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(profileDir, backups[0] ?? ''), 'utf8'), before)
  // Idempotent: a second run writes nothing and creates no second backup.
  const again = pruneProfileManifest(profileDir)
  assert.equal(again.dependencies, 0)
  assert.equal(shellBackups(profileDir, 'package.json').length, 1)
})

test('retired plugin rows are removed, the user\'s other rows survive', () => {
  const { home, profileDir, pluginsRoot } = fixture('rows')
  const patch = createDshConfigStore({ home })
  const result = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(result.removedRows, 2, 'ONE-WAY 与 MCP-Skills 的旧行必须移除')
  assert.deepEqual([...result.addedBundles].sort(), [...PLUGINS].sort())
  const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(text, /oneway-usage-monitor|mcp-skill-manager/u)
  assert.match(text, /id: git-panel/u)
  assert.match(text, /# 用户补丁/u)
})

test('shipped packages without an entry point are skipped instead of breaking the next start', () => {
  const pluginsRoot = join(root, 'broken-plugins')
  makePlugin(join(pluginsRoot, 'good'), 'good-plugin')
  mkdirSync(join(pluginsRoot, 'no-main'), { recursive: true })
  writeFileSync(join(pluginsRoot, 'no-main', 'package.json'), '{"name":"no-main","main":"./missing.js"}\n', 'utf8')
  const shipped = readShippedPlugins(pluginsRoot)
  assert.deepEqual([...shipped.keys()], ['good-plugin'])
})

test('backups keep only the five newest shell copies', () => {
  const directory = join(root, 'backups')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'file.json')
  writeFileSync(path, '{"v":1}\n', 'utf8')
  for (let index = 0; index < 7; index += 1) backupFile(path)
  const backups = shellBackups(directory, 'file.json')
  assert.equal(backups.length, 5, `实际保留 ${String(backups.length)} 份`)
})

/**
 * Static regression guard for the Electron filesystem trap (2026-10-19).
 *
 * In the Electron main process `rmSync(<junction>, { force: true })` throws `ERR_FS_EISDIR`; the
 * error was swallowed, so all four links stayed stale with no log line. `{ recursive: true }` is
 * worse — it follows the junction and deletes the target's contents. Plain Node cannot reproduce
 * either failure (`rmSync` just removes the junction), so the trap is pinned in the source text.
 */
test('linkPackage removes a junction with unlinkSync, never with rmSync', () => {
  const source = readFileSync(new URL('./plugin-provision.ts', import.meta.url), 'utf8')
  assert.match(source, /unlinkSync\(destination\)/u, '必须先 unlinkSync 删链接本身')
  assert.match(source, /rmdirSync\(destination\)/u, 'unlinkSync 失败时要回退到 rmdirSync')
  assert.doesNotMatch(source, /rmSync\(\s*destination/u, 'Electron 主进程里 rmSync 删 junction 会 ERR_FS_EISDIR（recursive 还会跟随链接删目标），禁止使用')
})
