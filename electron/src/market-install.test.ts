/**
 * The install layer's contract: what pnpm is asked to do, what the profile looks like afterwards, and
 * — most importantly — what happens when pnpm fails. Nothing here needs pnpm, a network or a real
 * profile: the runner, the manifest access and the filesystem roots are all injected.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  classifyPnpmFailure,
  marketChildEnvironment,
  pnpmArgs,
  resolveMarketRuntime,
  runMarketAction,
  withBundleRegistration,
  type MarketInstallOptions,
  type ProfileManifest,
} from './market-install.ts'

test('every install pins the exact version; uninstall names the package only', () => {
  assert.deepEqual(pnpmArgs('install', 'dsh-git-panel', '0.1.20'), ['add', 'dsh-git-panel@0.1.20'])
  assert.deepEqual(pnpmArgs('update', '@changfenhuang/dsh-genui', '0.12.0'), ['add', '@changfenhuang/dsh-genui@0.12.0'])
  assert.deepEqual(pnpmArgs('uninstall', 'dsh-git-panel'), ['remove', 'dsh-git-panel'])
  assert.deepEqual(pnpmArgs('install', 'dsh-git-panel'), ['add', 'dsh-git-panel'])
})

test('a plugin must also be registered as a profile bundle, and registration is idempotent', () => {
  const base: ProfileManifest = { dependencies: { 'dsh-git-panel': '^0.1.20' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }
  const added = withBundleRegistration(base, 'dsh-git-panel', 'install')
  assert.equal(added.changed, true)
  assert.deepEqual((added.manifest.dsh?.profile as { bundles: string[] }).bundles, ['@deepseek-ai/dsh-base', 'dsh-git-panel'])
  // Other manifest fields survive.
  assert.deepEqual(added.manifest.dependencies, base.dependencies)

  const again = withBundleRegistration(added.manifest, 'dsh-git-panel', 'install')
  assert.equal(again.changed, false)
  assert.equal(again.manifest, added.manifest)

  const removed = withBundleRegistration(added.manifest, 'dsh-git-panel', 'uninstall')
  assert.equal(removed.changed, true)
  assert.deepEqual((removed.manifest.dsh?.profile as { bundles: string[] }).bundles, ['@deepseek-ai/dsh-base'])
})

test('registration survives a profile that never had a bundle list', () => {
  const { manifest, changed } = withBundleRegistration({ name: 'dsh-profile' }, 'dsh-cost-meter', 'install')
  assert.equal(changed, true)
  assert.deepEqual((manifest.dsh?.profile as { bundles: string[] }).bundles, ['dsh-cost-meter'])
  assert.equal(manifest.name, 'dsh-profile')
})

test('known pnpm failures get a name, a message and — where we know one — a way out', () => {
  assert.equal(classifyPnpmFailure('Done in 1.2s', 0), undefined)
  const store = classifyPnpmFailure(' ERR_PNPM_UNEXPECTED_STORE  The dependencies at "…" wants to use the store at "…"', 1)
  assert.equal(store?.kind, 'store-mismatch')
  assert.match(store?.hint ?? '', /重启应用/u)
  assert.equal(classifyPnpmFailure('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED …', 1)?.kind, 'build-permission')
  assert.equal(classifyPnpmFailure('request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND', 1)?.kind, 'network')
  assert.equal(classifyPnpmFailure('ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found', 1)?.kind, 'not-found')
  assert.equal(classifyPnpmFailure('pnpm-workspace.yaml claims this install', 1)?.kind, 'workspace')
})

test('a lockfile policy failure names the entry pnpm rejected, not the plugin the user asked for', () => {
  const output = [
    '✗ Lockfile failed supply-chain policy check (117 entries in 10.3s)',
    '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
    '  billion-context@0.1.205 was published at 2026-10-23T18:07:01.660Z, within the minimumReleaseAge cutoff (2026-10-23T00:53:47.142Z)',
  ].join('\n')
  const failure = classifyPnpmFailure(output, 1)
  assert.equal(failure?.kind, 'too-new')
  assert.match(failure?.message ?? '', /billion-context@0\.1\.205/u)
  assert.match(failure?.message ?? '', /锁文件/u)
  assert.match(failure?.hint ?? '', /trustLockfile: true/u)
  // 18:07Z + 8h + 24h = 次日 02:07 北京时间.
  assert.match(failure?.hint ?? '', /2026-10-25 02:07/u)
})

test('a generic too-new failure still suggests the lockfile escape hatch', () => {
  const failure = classifyPnpmFailure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION published too recently', 1)
  assert.equal(failure?.kind, 'too-new')
  assert.match(failure?.hint ?? '', /trustLockfile: true/u)
})

test('an unclassified failure still carries the first error line, not just an exit code', () => {
  const failure = classifyPnpmFailure('WARN something\n ERR_PNPM_SOMETHING_NEW  weird\nmore', 1)
  assert.equal(failure?.kind, 'unknown')
  assert.match(failure?.message ?? '', /退出码 1/u)
  assert.equal(failure?.hint, 'ERR_PNPM_SOMETHING_NEW  weird')
  assert.match(classifyPnpmFailure('', null)?.message ?? '', /没能启动/u)
})

/** A runner double that records the arguments and answers with a fixed result. */
function fakeRunner(code: number | null, output: string) {
  const calls: { args: readonly string[]; environment: NodeJS.ProcessEnv }[] = []
  return {
    calls,
    run: (args: readonly string[], environment: NodeJS.ProcessEnv) => {
      calls.push({ args, environment })
      return Promise.resolve({ code, output })
    },
  }
}

function harness(code: number | null, output: string, manifest: ProfileManifest = { dsh: { profile: { bundles: [] } } }) {
  const runner = fakeRunner(code, output)
  const writes: { manifest: ProfileManifest; previous: ProfileManifest }[] = []
  const options: MarketInstallOptions = {
    profileDir: 'C:\\profile',
    nodeExecutable: 'C:\\runtime\\bin\\node.exe',
    pnpmEntry: 'C:\\runtime\\node_modules\\pnpm\\bin\\pnpm.cjs',
    readManifest: () => manifest,
    writeManifest: (next, previous) => writes.push({ manifest: next, previous }),
    runPnpm: runner.run,
  }
  return { options, runner, writes }
}

test('a successful install registers the bundle and reports pnpm’s own output', async () => {
  const { options, runner, writes } = harness(0, 'Progress: resolved 1, reused 0, downloaded 1\nDone in 2.1s')
  const result = await runMarketAction('install', 'dsh-cost-meter', options, '1.8.26')
  assert.equal(result.ok, true)
  assert.equal(result.bundleRegistered, true)
  assert.equal(result.spec, 'dsh-cost-meter@1.8.26')
  assert.match(result.output, /Done in 2\.1s/u)
  assert.deepEqual(runner.calls[0]?.args, ['add', 'dsh-cost-meter@1.8.26'])
  assert.equal(writes.length, 1)
  // The bundled real node is spawned as itself: the environment is passed through unchanged (the
  // test runner's own env already carries ELECTRON_RUN_AS_NODE, which is exactly the point — we do
  // not add it, and we do not strip what the caller had).
  assert.deepEqual(runner.calls[0]?.environment, marketChildEnvironment(process.env, false))
})

test('a failed install leaves the profile untouched — a half-registered bundle is worse than none', async () => {
  const { options, writes } = harness(1, 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found')
  const result = await runMarketAction('install', 'nope', options, '1.0.0')
  assert.equal(result.ok, false)
  assert.equal(result.failure?.kind, 'not-found')
  assert.equal(result.bundleRegistered, false)
  assert.equal(writes.length, 0, 'pnpm failed, so the manifest must not be written')
})

test('a runner that throws is classified instead of escaping as an exception', async () => {
  const options: MarketInstallOptions = {
    profileDir: 'C:\\profile',
    nodeExecutable: 'C:\\runtime\\bin\\node.exe',
    pnpmEntry: 'C:\\runtime\\node_modules\\pnpm\\bin\\pnpm.cjs',
    readManifest: () => ({}),
    writeManifest: () => assert.fail('must not write'),
    runPnpm: () => Promise.reject(new Error('spawn C:\\runtime\\bin\\node.exe ENOENT')),
  }
  const result = await runMarketAction('install', 'dsh-git-panel', options, '0.1.20')
  assert.equal(result.ok, false)
  assert.equal(result.code, null)
  assert.match(result.output, /ENOENT/u)
})

test('uninstall drops the bundle entry', async () => {
  const { options } = harness(0, 'Done in 0.4s', { dsh: { profile: { bundles: ['dsh-cost-meter'] } } })
  const result = await runMarketAction('uninstall', 'dsh-cost-meter', options)
  assert.equal(result.ok, true)
  assert.equal(result.bundleRegistered, true)
})

test('the app binary is only used when the runtime has no real node', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-market-runtime-'))
  mkdirSync(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '', 'utf8')

  const fallback = resolveMarketRuntime(root, 'C:\\app\\DSH Desktop.exe')
  assert.deepEqual(fallback, { nodeExecutable: 'C:\\app\\DSH Desktop.exe', pnpmEntry: join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), appBinary: true })
  assert.equal(marketChildEnvironment({}, fallback?.appBinary).ELECTRON_RUN_AS_NODE, '1')

  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'node.exe'), '', 'utf8')
  const bundled = resolveMarketRuntime(root, 'C:\\app\\DSH Desktop.exe')
  assert.equal(bundled?.nodeExecutable, join(root, 'bin', 'node.exe'))
  assert.equal(bundled?.appBinary, false)
  assert.equal(marketChildEnvironment({}, bundled?.appBinary).ELECTRON_RUN_AS_NODE, undefined)

  assert.equal(resolveMarketRuntime(join(root, 'missing'), 'C:\\app\\DSH Desktop.exe'), undefined)
})
