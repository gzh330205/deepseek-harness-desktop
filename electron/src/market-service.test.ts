/**
 * The adapters' tests. The interesting ones are the two that could silently rot: `fetchJson`'s
 * non-2xx contract (a registry 404 must not look like an empty catalog) and `runPnpm` against the
 * **real** bundled runtime — the path the shell proved by hand, re-proved here on every run.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  MarketService,
  fetchJson,
  readProfileManifest,
  runPnpm,
  writeProfileManifest,
} from './market-service.ts'

/** A `fetch` double: fixed status/body, and it records the request. */
function fakeFetch(status: number, body: unknown, statusText = '') {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: () => Promise.resolve(body),
    } as Response)
  }
  return { calls, impl: impl as unknown as typeof fetch }
}

test('fetchJson returns parsed JSON and identifies itself to the registry', async () => {
  const fetcher = fakeFetch(200, { objects: [] })
  assert.deepEqual(await fetchJson('https://registry.npmjs.org/-/v1/search?text=x', { fetchImpl: fetcher.impl }), { objects: [] })
  assert.match(fetcher.calls[0]?.headers['user-agent'] ?? '', /dsh-desktop-market/u)
})

test('an HTTP error is an error, never an empty result', async () => {
  const fetcher = fakeFetch(429, {}, 'Too Many Requests')
  await assert.rejects(fetchJson('https://registry.npmjs.org/x', { fetchImpl: fetcher.impl }), /registry 429 Too Many Requests/u)
})

test('a request that outlives its timeout is aborted', async () => {
  const hanging = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
  })) as unknown as typeof fetch
  await assert.rejects(fetchJson('https://registry.npmjs.org/slow', { fetchImpl: hanging, timeoutMs: 30 }), /aborted/u)
})

test('the profile manifest round-trips, and a broken file reads as empty instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  assert.deepEqual(readProfileManifest(dir), {}, 'no package.json yet')
  writeProfileManifest(dir, { name: 'dsh-profile-dsh-desktop', dependencies: { a: '1' }, dsh: { profile: { bundles: ['a'] } } })
  assert.deepEqual(readProfileManifest(dir).dependencies, { a: '1' })
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /\n$/u, 'trailing newline, like every other file we write')
  writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8')
  assert.deepEqual(readProfileManifest(dir), {})
})

test('a runtime without pnpm reports an actionable failure instead of throwing', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  const service = new MarketService({ profileDir, runtimeRoot: join(profileDir, 'no-runtime'), appExecutable: 'C:\\app\\DSH Desktop.exe' })
  const result = await service.install('dsh-git-panel', '0.1.20')
  assert.equal(result.ok, false)
  assert.equal(result.failure?.message, '随包运行时不可用')
  assert.match(result.output, /pnpm\.cjs/u)
  assert.match(result.failure?.hint ?? '', /重新安装/u)
})

test('installed() lists what the profile declares', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  writeProfileManifest(dir, { dependencies: { 'dsh-cost-meter': '^1.8.26', '@scope/other': 'link:../x' } })
  const service = new MarketService({ profileDir: dir, runtimeRoot: dir, appExecutable: 'x' })
  assert.deepEqual(service.installed(), [
    { name: 'dsh-cost-meter', spec: '^1.8.26' },
    { name: '@scope/other', spec: 'link:../x' },
  ])
})

/** The prepared runtime in this checkout; skipped on a fresh clone where it has not been built. */
const runtimeRoot = fileURLToPath(new URL('../runtime/dsh', import.meta.url))
const bundledNode = join(runtimeRoot, 'bin', 'node.exe')
const pnpmEntry = join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

test('the real bundled runtime runs pnpm with no shell and no window', { skip: !existsSyncSafe(bundledNode) ? 'runtime not prepared' : false }, async () => {
  const result = await runPnpm({
    nodeExecutable: bundledNode,
    pnpmEntry,
    args: ['--version'],
    cwd: runtimeRoot,
    environment: marketEnvironment(),
    timeoutMs: 120_000,
  })
  assert.equal(result.code, 0, result.output)
  assert.match(result.output.trim(), /^\d+\.\d+\.\d+/u)
})

test('a node executable that does not exist is reported, not thrown', async () => {
  const result = await runPnpm({
    nodeExecutable: join(runtimeRoot, 'bin', 'definitely-missing.exe'),
    pnpmEntry,
    args: ['--version'],
    cwd: runtimeRoot,
    environment: marketEnvironment(),
    timeoutMs: 30_000,
  })
  assert.equal(result.code, null)
  assert.match(result.output, /ENOENT/u)
})

function existsSyncSafe(path: string): boolean {
  try {
    return readFileSync(path) !== undefined
  } catch {
    return false
  }
}

/** A copy of the environment with our own variables removed, as a fresh child would see it. */
function marketEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
}

// Keep mkdirSync referenced: the temp helpers above create nested paths in some environments.
void mkdirSync
