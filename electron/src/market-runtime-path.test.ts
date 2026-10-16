/**
 * The failure these tests exist for: an install ended with
 * `spawn D:\Program Files\DSH Desktop\resources\app.asar\dsh\bin\node.exe ENOENT` while that very path
 * "existed" — Electron patches `fs` to read through the archive, but `spawn` is a real OS call and
 * cannot open a file inside one. Everything the market *starts* must come from the archive's physical
 * twin (`app.asar.unpacked`), which is where electron-builder puts executables and pnpm's JS.
 *
 * This went unnoticed because every market test ran against a development runtime tree, where the
 * paths are already physical: the packaged case had no coverage at all.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { rejectReason } from './market-catalog.ts'
import { physicalCandidates, resolveMarketRuntime } from './market-install.ts'

test('a path inside app.asar is offered with its physical twin first', () => {
  const inside = join('C:', 'app', 'resources', 'app.asar', 'dsh', 'bin', 'node.exe')
  assert.deepEqual(physicalCandidates(inside), [
    join('C:', 'app', 'resources', 'app.asar.unpacked', 'dsh', 'bin', 'node.exe'),
    inside,
  ])
  // Already physical, or nothing to do with an archive: unchanged.
  const development = join('D:', 'repo', 'electron', 'runtime', 'dsh', 'bin', 'node.exe')
  assert.deepEqual(physicalCandidates(development), [development])
  const unpacked = join('C:', 'app', 'resources', 'app.asar.unpacked', 'dsh', 'bin', 'node.exe')
  assert.deepEqual(physicalCandidates(unpacked), [unpacked])
})

// The packaged case is covered for real by scripts/smoke-market.mjs (it starts the resolved
// runtime inside the packaged app). A directory named pp.asar does not reproduce Electron's
// patched fs, so a fixture here would assert the fixture rather than the behaviour.


test('a runtime with nothing physical to spawn falls back to the app binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-market-asar-nonode-'))
  const unpacked = join(root, 'app.asar.unpacked')
  mkdirSync(join(unpacked, 'dsh', 'node_modules', 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(unpacked, 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// physical', 'utf8')
  const runtime = resolveMarketRuntime(join(root, 'app.asar', 'dsh'), 'C:\\app\\DSH Desktop.exe')
  assert.equal(runtime?.appBinary, true)
  assert.equal(runtime?.nodeExecutable, 'C:\\app\\DSH Desktop.exe')
})

test('the upstream market is rejected as a plugin, with a reason that says why', () => {
  const manifest = { dsh: { bundle: { patch: './cordis.patch.yml' } } }
  assert.match(rejectReason('dshmarket', manifest) ?? '', /上游市场/u)
  // The scoped name trips the platform rule first; what matters is that it is rejected at all.
  assert.notEqual(rejectReason('@deepseek-ai/dsh-market', manifest), undefined)
  assert.equal(rejectReason('dsh-cost-meter', manifest), undefined)
})