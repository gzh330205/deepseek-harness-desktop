/**
 * Guards for "the shell brings its own plugins".
 *
 * The dangerous parts are all in the user's profile: replacing a directory someone checked out,
 * editing package.json without a backup, or removing rows the shell does not actually own.
 */

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createDshConfigStore } from './dsh-config.ts'
import { backupFile, pluginRowId, provisionBundledPlugins, pruneProfileManifest, readShippedPlugins } from './plugin-provision.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-provision-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

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
  for (const plugin of ['dsh-git-panel', 'dsh-run-env-manager', 'dsh-sidebar-width', 'dsh-workspace-category-manager']) {
    makePlugin(join(pluginsRoot, plugin), plugin)
  }
  return { home, profileDir, pluginsRoot }
}

test('shipped plugins are linked into the profile, and only once', () => {
  const { home, profileDir, pluginsRoot } = fixture('link')
  const patch = createDshConfigStore({ home })
  const first = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(first.ok, true)
  assert.deepEqual([...first.linked].sort(), ['dsh-git-panel', 'dsh-run-env-manager', 'dsh-sidebar-width', 'dsh-workspace-category-manager'])
  // The fixture already has a git-panel row; the other three are added for a profile that had only
  // a subset installed.
  assert.equal(first.addedRows, 3)
  for (const plugin of first.linked) {
    const link = join(profileDir, 'node_modules', plugin)
    assert.equal(lstatSync(link).isSymbolicLink(), true, `${plugin} 必须是链接`)
    assert.equal(existsSync(join(link, 'index.js')), true, `${plugin} 通过链接可读`)
  }
  // Second run: nothing changes, and no duplicate links appear.
  const second = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(second.linked.length, 0)
  assert.equal(second.unchanged, 4)
  assert.equal(second.addedRows, 0)
})

test('a profile that never installed the plugins gets the rows the config is keyed by', () => {
  const home = join(root, 'fresh-home')
  const profileDir = join(home, 'profiles', 'dsh-desktop')
  const pluginsRoot = join(root, 'fresh-plugins')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# empty\n[]\n', 'utf8')
  for (const plugin of ['dsh-git-panel', 'dsh-run-env-manager', 'dsh-sidebar-width', 'dsh-workspace-category-manager']) {
    makePlugin(join(pluginsRoot, plugin), plugin)
  }
  const patch = createDshConfigStore({ home })
  const result = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(result.addedRows, 4)
  const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  for (const id of ['git-panel', 'run-env-manager', 'sidebar-width', 'workspace-category-manager']) {
    assert.match(text, new RegExp(`id: ${id}\\b`, 'u'))
  }
  assert.equal(provisionBundledPlugins({ pluginsRoot, profileDir, patch }).addedRows, 0)
})

test('plugin row ids match the market spelling', () => {
  assert.equal(pluginRowId('dsh-git-panel'), 'git-panel')
  assert.equal(pluginRowId('dsh-sidebar-width'), 'sidebar-width')
  assert.equal(pluginRowId('@scope/dsh-run-env-manager'), 'run-env-manager')
  assert.equal(pluginRowId('plain-package'), 'plain-package')
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

test('dsh-plugin-kit is removed from dependencies and bundles, with a backup', () => {
  const { profileDir } = fixture('manifest')
  const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
  const result = pruneProfileManifest(profileDir)
  assert.equal(result.dependencies, 1)
  assert.equal(result.bundles, 1)
  const document = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal('dsh-plugin-kit' in document.dependencies, false)
  assert.deepEqual(document.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  // Everything else survives.
  assert.equal(document.dependencies['@changfenhuang/dsh-genui'], '0.13.0')
  const backups = readdirSync(profileDir).filter((name) => name.startsWith('package.json.bak-shell-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(profileDir, backups[0] ?? ''), 'utf8'), before)
  // Idempotent: a second run writes nothing and creates no second backup.
  const again = pruneProfileManifest(profileDir)
  assert.equal(again.dependencies, 0)
  assert.equal(readdirSync(profileDir).filter((name) => name.startsWith('package.json.bak-shell-')).length, 1)
})

test('retired plugin rows are removed, the user\'s other rows survive', () => {
  const { home, profileDir, pluginsRoot } = fixture('rows')
  const patch = createDshConfigStore({ home })
  const result = provisionBundledPlugins({ pluginsRoot, profileDir, patch })
  assert.equal(result.removedRows, 2, 'ONE-WAY 与 MCP-Skills 的旧行必须移除')
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
  const backups = readdirSync(directory).filter((name) => name.startsWith('file.json.bak-shell-'))
  assert.equal(backups.length, 5, `实际保留 ${String(backups.length)} 份`)
})
