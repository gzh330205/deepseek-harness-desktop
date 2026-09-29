/**
 * Runtime-tree verification tests.
 *
 * The bundled runtime is the executable half of the product now, so a tampered or
 * incomplete tree must be refused before any child process starts. A synthetic tree is
 * used rather than the real 400 MB one.
 *
 * Run: node --test src/runtime-tree.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  RUNTIME_MANIFEST_FILENAME,
  describeRuntimeFailure,
  readRuntimeManifest,
  verifyRuntime,
} from '../src/runtime-tree.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-runtime-test-'))
after(() => { rmSync(workDir, { recursive: true, force: true }) })

const ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const NATIVE = 'node_modules/@deepseek-ai/dsh/node_modules/@koromix/koffi/win32_x64/koffi.node'
const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

let counter = 0
function makeTree(mutate?: (root: string, manifest: Record<string, unknown>) => void): string {
  counter += 1
  const root = join(workDir, `tree-${String(counter)}`)
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh/node_modules/@koromix/koffi/win32_x64'), { recursive: true })
  writeFileSync(join(root, ENTRY), 'console.log("dsh")\n', 'utf8')
  writeFileSync(join(root, NATIVE), 'ELF-ish bytes', 'utf8')
  const manifest: Record<string, unknown> = {
    schema: 1,
    shell: '0.3.2',
    dsh: '0.1.7-rc.2',
    electron: '44.0.0',
    v8: '15.2.124.13-electron.0',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    entry: ENTRY,
    files: 2,
    bytes: 32,
    listDigest: 'unused',
    critical: { [ENTRY]: sha256('console.log("dsh")\n'), [NATIVE]: sha256('ELF-ish bytes') },
  }
  mutate?.(root, manifest)
  writeFileSync(join(root, RUNTIME_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return root
}

const verify = (root: string) => verifyRuntime({
  root,
  electron: '44.0.0',
  platform: process.platform,
  arch: process.arch,
})

test('a matching tree verifies and yields the entry point', () => {
  const root = makeTree()
  const result = verify(root)
  assert.equal(result.ok, true)
  if (result.ok !== true) return
  assert.equal(result.manifest.dsh, '0.1.7-rc.2')
  assert.equal(result.entryPath, join(root, ENTRY))
})

test('a tampered entry point is refused', () => {
  const root = makeTree()
  writeFileSync(join(root, ENTRY), 'console.log("evil")\n', 'utf8')
  const result = verify(root)
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.reason, 'hash-mismatch')
    assert.match(describeRuntimeFailure(result), /重新安装/u)
  }
})

test('a tampered native module is refused', () => {
  const root = makeTree()
  writeFileSync(join(root, NATIVE), 'tampered', 'utf8')
  const result = verify(root)
  assert.equal(result.ok, false)
  if (result.ok === false) assert.equal(result.reason, 'hash-mismatch')
})

test('a different Electron is refused before anything runs', () => {
  const root = makeTree()
  const result = verifyRuntime({ root, electron: '45.0.0', platform: process.platform, arch: process.arch })
  assert.equal(result.ok, false)
  if (result.ok === false) assert.equal(result.reason, 'electron-mismatch')
})

test('a missing critical file is reported, not ignored', () => {
  const root = makeTree()
  rmSync(join(root, NATIVE))
  const result = verify(root)
  assert.equal(result.ok, false)
  if (result.ok === false) assert.equal(result.reason, 'file-missing')
})

test('an unreadable or unsupported manifest is reported as text', () => {
  const root = makeTree()
  writeFileSync(join(root, RUNTIME_MANIFEST_FILENAME), '{ not json', 'utf8')
  assert.match(String(readRuntimeManifest(root)), /无法解析/u)

  const other = makeTree((_root, manifest) => { manifest.schema = 99 })
  assert.match(String(readRuntimeManifest(other)), /schema/u)
  assert.equal(verify(other).ok, false)
})

test('a platform mismatch is refused', () => {
  const root = makeTree()
  const result = verifyRuntime({ root, electron: '44.0.0', platform: 'darwin', arch: 'arm64' })
  assert.equal(result.ok, false)
  if (result.ok === false) assert.equal(result.reason, 'platform-mismatch')
})
