/**
 * Installing straight from GitHub.
 *
 * The property that matters most here is ordering: the repository's manifest is read and vetted
 * **before** pnpm is started, so a repository that is not a plugin leaves the profile exactly as it
 * was. Installing first and cleaning up afterwards would change the profile in between, and a
 * half-registered bundle is worse than no plugin at all.
 *
 * The second property is the name. Three of the eight GitHub entries sampled from the real catalog
 * declare a package name that differs from the catalog's entry name
 * (`portable-dsh-multi-agent-plugin` → `portable-dsh-multi-agent`), and the harness looks bundles up by
 * the declared name — so registering the catalog's name would install a plugin that never loads.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { classifyPnpmFailure, pnpmArgs } from './market-install.ts'
import { MarketService, readProfileManifest } from './market-service.ts'

/** A runtime skeleton: `resolveMarketRuntime` only checks that the pieces exist, and the runner is injected. */
function fakeRuntime(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-market-gh-runtime-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'node.exe'), '', 'utf8')
  writeFileSync(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// stub', 'utf8')
  return root
}

test('a GitHub spec goes to pnpm verbatim, never as name@version', () => {
  assert.deepEqual(pnpmArgs('install', 'portable-dsh-multi-agent', undefined, 'github:a/b#v1'), ['add', 'github:a/b#v1'])
  assert.deepEqual(
    pnpmArgs('install', 'x', '1.0.0', 'https://github.com/a/b/releases/latest/download/b.tgz'),
    ['add', 'https://github.com/a/b/releases/latest/download/b.tgz'],
    'a tarball URL is not something to append a version to',
  )
  assert.deepEqual(pnpmArgs('install', 'x', '1.0.0'), ['add', 'x@1.0.0'], 'the registry path is unchanged')
  assert.deepEqual(pnpmArgs('uninstall', 'x'), ['remove', 'x'])
})

test('a repository that is not a plugin is refused before pnpm is ever started', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-gh-profile-'))
  const calls: string[][] = []
  const service = new MarketService({
    profileDir,
    runtimeRoot: fakeRuntime(),
    appExecutable: 'x',
    fetchJsonImpl: () => Promise.resolve({ name: 'left-pad', version: '1.0.0' }),
    runPnpmImpl: args => { calls.push([...args]); return Promise.resolve({ code: 0, output: '' }) },
  })
  const result = await service.installFromGithub('some/left-pad')
  assert.equal(result.ok, false)
  assert.equal(result.failure?.kind, 'not-a-plugin')
  assert.match(result.failure?.message ?? '', /没有声明 dsh/u)
  assert.deepEqual(calls, [], 'nothing may be installed when the repository is not a plugin')
  assert.equal(readProfileManifest(profileDir).dependencies, undefined, 'the profile is untouched')
})

test('a private or missing repository is reported as such, not as "not a plugin"', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-gh-profile-'))
  const calls: string[][] = []
  const service = new MarketService({
    profileDir,
    runtimeRoot: fakeRuntime(),
    appExecutable: 'x',
    fetchJsonImpl: () => Promise.reject(new Error('获取失败：HTTP 404')),
    runPnpmImpl: args => { calls.push([...args]); return Promise.resolve({ code: 0, output: '' }) },
  })
  const result = await service.installFromGithub('owner/private-repo')
  assert.equal(result.ok, false)
  assert.equal(result.failure?.kind, 'github')
  assert.match(result.failure?.message ?? '', /仓库不存在、是私有的/u)
  assert.deepEqual(calls, [])
})

test('a GitHub install registers the name the repository declares', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-gh-profile-'))
  const asked: string[][] = []
  const service = new MarketService({
    profileDir,
    runtimeRoot: fakeRuntime(),
    appExecutable: 'x',
    fetchJsonImpl: () => Promise.resolve({
      name: 'portable-dsh-multi-agent',
      version: '0.3.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      scripts: { postinstall: 'node ./setup.js' },
    }),
    runPnpmImpl: args => { asked.push([...args]); return Promise.resolve({ code: 0, output: 'Done in 3s' }) },
  })
  const result = await service.installFromGithub('some/portable-dsh-multi-agent-plugin')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(asked, [['add', 'github:some/portable-dsh-multi-agent-plugin']])
  assert.equal(result.name, 'portable-dsh-multi-agent')
  assert.deepEqual(
    readProfileManifest(profileDir).dsh?.profile?.bundles,
    ['portable-dsh-multi-agent'],
    'the harness looks bundles up by the declared name',
  )
})

test('inspection reports the install scripts without installing anything', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-gh-profile-'))
  const service = new MarketService({
    profileDir,
    runtimeRoot: fakeRuntime(),
    appExecutable: 'x',
    fetchJsonImpl: () => Promise.resolve({ name: 'a-plugin', dsh: { bundle: { patch: './p.yml' } }, scripts: { prepare: 'npm run build' } }),
    runPnpmImpl: () => { throw new Error('pnpm must not run during an inspection') },
  })
  const inspected = await service.inspectGithub('a/b')
  assert.equal(inspected.ok, true)
  assert.equal(inspected.name, 'a-plugin')
  assert.equal(inspected.spec, 'github:a/b')
  assert.deepEqual(inspected.scripts, ['prepare'], 'the window has to be able to warn before the click')
})

test('the failures GitHub sources actually produce have their own categories', () => {
  assert.equal(classifyPnpmFailure('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED', 1)?.kind, 'build-permission')
  assert.equal(classifyPnpmFailure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION', 1)?.kind, 'too-new')
  assert.equal(classifyPnpmFailure('ERROR  published too recently', 1)?.kind, 'too-new')
  assert.equal(classifyPnpmFailure('ERR_PNPM_GIT_UNKNOWN_ERROR  Command failed with exit code 128', 1)?.kind, 'github')
  assert.equal(classifyPnpmFailure('Failed to fetch tarball https://github.com/a/b/releases/latest/download/b.tgz', 1)?.kind, 'github')
  assert.match(classifyPnpmFailure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION', 1)?.hint ?? '', /24 小时/u)
})
