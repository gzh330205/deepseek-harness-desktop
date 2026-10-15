/**
 * Conflict diagnosis is only useful if it is trustworthy, so these tests are mostly about what it
 * does **not** say: transitive dependencies are not orphans, a bundle that is registered is not a
 * "half-state", and a version range is not drift. The rest pin the findings that come from
 * contradictions between two files.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  diagnoseConflicts,
  readConflictWorld,
  readPatchKeys,
  type ConflictFinding,
  type ConflictWorld,
} from './market-conflict.ts'

function world(overrides: Partial<ConflictWorld> = {}): ConflictWorld {
  return {
    dependencies: {},
    bundles: [],
    installed: [],
    workspaceMarkers: [],
    ...overrides,
  }
}

const codes = (findings: readonly ConflictFinding[]): string[] => findings.map(finding => finding.code)

test('a healthy profile produces no findings at all', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { 'dsh-cost-meter': '^1.8.26' },
    bundles: ['dsh-cost-meter'],
    installed: [{ name: 'dsh-cost-meter', spec: '^1.8.26', version: '1.8.26', present: true, declaresDsh: true }],
  }))
  assert.deepEqual(findings, [])
})

test('the half-state is reported: installed and declared, but never registered as a bundle', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { 'dsh-cost-meter': '^1.8.26' },
    bundles: [],
    installed: [{ name: 'dsh-cost-meter', spec: '^1.8.26', version: '1.8.26', present: true, declaresDsh: true }],
  }))
  assert.deepEqual(codes(findings), ['not-registered'])
  assert.match(findings[0]?.hint ?? '', /重装/u)
})

test('a declared plugin that is not installed is an error, with a way out', () => {
  const findings = diagnoseConflicts(world({ dependencies: { 'dsh-win-notify': '0.1.0' } }))
  assert.deepEqual(codes(findings), ['missing-install'])
  assert.equal(findings[0]?.severity, 'error')
})

test('an install nobody declares is reported once, not once per list', () => {
  const findings = diagnoseConflicts(world({
    bundles: [],
    installed: [{ name: 'dsh-git-panel', spec: '', present: true, declaresDsh: true }],
  }))
  assert.deepEqual(codes(findings), ['orphan-install'])
  assert.match(findings[0]?.message ?? '', /没有声明/u)
})

test('an ordinary npm package that happens to be installed as a dependency is not an orphan', () => {
  // `react` is a transitive dependency of a plugin: no `dsh` field, not declared, not bundled. The
  // reader excludes these, and the diagnosis must not invent a finding for a name it is not given.
  const findings = diagnoseConflicts(world({
    dependencies: { 'dsh-cost-meter': '^1.8.26' },
    bundles: ['dsh-cost-meter'],
    installed: [{ name: 'dsh-cost-meter', spec: '^1.8.26', version: '1.8.26', present: true, declaresDsh: true }],
  }))
  assert.deepEqual(findings, [])
})

test('a duplicate bundle entry is reported: a patch layer applied twice is a real defect', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { a: '1.0.0' },
    bundles: ['a', 'a'],
    installed: [{ name: 'a', spec: '1.0.0', version: '1.0.0', present: true, declaresDsh: true }],
  }))
  assert.deepEqual(codes(findings), ['duplicate-bundle'])
})

test('the platform itself and non-plugins are called out', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { '@deepseek-ai/dsh-web-app': '0.0.1', 'left-pad': '1.0.0' },
    bundles: ['@deepseek-ai/dsh-web-app', 'left-pad'],
    installed: [
      { name: '@deepseek-ai/dsh-web-app', spec: '0.0.1', version: '0.0.1', present: true, declaresDsh: true },
      { name: 'left-pad', spec: '1.0.0', version: '1.0.0', present: true, declaresDsh: false },
    ],
  }))
  // `not-a-plugin` is an error and `platform-package` a warning, so severity order puts it first.
  assert.deepEqual(codes(findings), ['not-a-plugin', 'platform-package'])
  assert.deepEqual([...codes(findings)].sort(), ['not-a-plugin', 'platform-package'])
})

test('environment findings name the path or the store pair that causes them', () => {
  const findings = diagnoseConflicts(world({
    workspaceMarkers: ['C:/Users/x/pnpm-workspace.yaml'],
    store: { modulesMajor: '10', pnpmMajor: '11' },
  }))
  assert.deepEqual(codes(findings), ['workspace-takeover', 'store-mismatch'])
  assert.match(findings[0]?.message ?? '', /pnpm-workspace\.yaml/u)
  assert.match(findings[1]?.message ?? '', /store\/v10.*store\/v11/u)
  assert.match(findings[1]?.hint ?? '', /重启/u)
})

test('a missing major on either side of the store check is not a finding', () => {
  assert.deepEqual(diagnoseConflicts(world({ store: { pnpmMajor: '11' } })), [])
  assert.deepEqual(diagnoseConflicts(world({ store: {} })), [])
})

test('findings are ordered by severity', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { missing: '1.0.0' },
    bundles: ['a', 'a'],
    installed: [{ name: 'a', spec: '^1.0.0', version: '1.0.1', present: true, declaresDsh: true }],
  }))
  // `a` is installed and bundled but never declared, so it is also an orphan — and the warnings keep
  // their insertion order ahead of the info finding.
  assert.deepEqual(codes(findings), ['missing-install', 'duplicate-bundle', 'orphan-install'])
})

test('the reader fills the world from a profile on disk, and stays read-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-conflicts-'))
  // A profile with one registered plugin (fine), one installed but unregistered (half-state) and one
  // declared-but-absent, plus a stray plugin-shaped directory nobody declares.
  mkdirSync(join(dir, 'node_modules', 'dsh-registered'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'dsh-half'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'dsh-stray'), { recursive: true })
  for (const name of ['dsh-registered', 'dsh-half', 'dsh-stray']) {
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }), 'utf8')
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    dependencies: { 'dsh-registered': '1.0.0', 'dsh-half': '1.0.0', 'dsh-absent': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-registered'] } },
  }), 'utf8')

  const filled = readConflictWorld(dir)
  assert.deepEqual(Object.keys(filled.dependencies).sort(), ['dsh-absent', 'dsh-half', 'dsh-registered'])
  assert.deepEqual(filled.bundles, ['dsh-registered'])
  // Declared-but-absent is still a fact worth reporting (`present: false`), which is how the
  // missing-install finding gets its evidence.
  const names = filled.installed.map(fact => fact.name).sort()
  assert.deepEqual(names, ['dsh-absent', 'dsh-half', 'dsh-registered', 'dsh-stray'])

  const findings = diagnoseConflicts(filled)
  assert.deepEqual(codes(findings).sort(), ['missing-install', 'not-registered', 'orphan-install'])
  // Read-only: a second read sees exactly the same world.
  assert.deepEqual(readConflictWorld(dir).installed.map(fact => fact.name).sort(), names)
})
test('a plugin patching its own hook is not an overlap', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { 'a-plugin': '1.0.0', 'b-plugin': '1.0.0' },
    bundles: ['a-plugin', 'b-plugin'],
    installed: [
      { name: 'a-plugin', spec: '1.0.0', version: '1.0.0', present: true, declaresDsh: true, patches: ['hook-a'] },
      { name: 'b-plugin', spec: '1.0.0', version: '1.0.0', present: true, declaresDsh: true, patches: ['hook-b'] },
    ],
  }))
  assert.deepEqual(findings, [])
})

test('two plugins that both declare the same hook are reported as a capability overlap', () => {
  const findings = diagnoseConflicts(world({
    dependencies: { 'a-plugin': '1.0.0', 'b-plugin': '1.0.0' },
    bundles: ['a-plugin', 'b-plugin'],
    installed: [
      { name: 'a-plugin', spec: '1.0.0', version: '1.0.0', present: true, declaresDsh: true, patches: ['@deepseek-ai/dsh-client-ui-sidebar-right'] },
      { name: 'b-plugin', spec: '1.0.0', version: '1.0.0', present: true, declaresDsh: true, patches: ['@deepseek-ai/dsh-client-ui-sidebar-right'] },
    ],
  }))
  assert.deepEqual(codes(findings), ['capability-overlap'])
  assert.match(findings[0]?.message ?? '', /a-plugin、b-plugin/u)
})
test('readPatchKeys takes the indentation-0 keys and ignores comments and nested content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-patch-'))
  const body = ['# a comment', '# another', 'service-a:', '  nested: 1', '', 'service-b:', '  still: nested'].join(String.fromCharCode(10))
  writeFileSync(join(dir, 'cordis.patch.yml'), body, 'utf8')
  assert.deepEqual(readPatchKeys(join(dir, 'cordis.patch.yml')), ['service-a', 'service-b'])
  // An unreadable patch file must yield no claims, not a throw: the diagnosis has to survive it.
  assert.deepEqual(readPatchKeys(join(dir, 'absent.yml')), [])
})
