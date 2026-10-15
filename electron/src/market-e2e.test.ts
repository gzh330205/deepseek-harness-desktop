/**
 * End-to-end: the market's install path against a real profile and the real bundled runtime.
 *
 * Offline by default — this reaches the registry, so it is gated behind
 * `DSH_DESKTOP_MARKET_E2E=1` and skipped everywhere else. What it proves that the unit tests cannot:
 * that the pnpm path we chose actually installs into a profile, writes the dependency, registers the
 * bundle, reports pnpm's own output, and reverses all of it on uninstall.
 *
 * Run it by hand with:
 *   $env:DSH_DESKTOP_MARKET_E2E='1'; electron scripts/run-tests.mjs src/market-e2e.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { MarketService } from './market-service.ts'

/** Smallest real plugin we can name: a host half with one patch file, no client, no native build. */
const PLUGIN = 'dsh-win-notify'
const VERSION = '0.1.0'

const enabled = process.env.DSH_DESKTOP_MARKET_E2E === '1'
const runtimeRoot = fileURLToPath(new URL('../runtime/dsh', import.meta.url))
const appExecutable = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url))

function freshProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-e2e-'))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-market-e2e',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`, 'utf8')
  return dir
}

test('the real runtime installs a plugin into a profile and uninstalls it again', { skip: enabled ? false : 'set DSH_DESKTOP_MARKET_E2E=1 to run' }, async () => {
  const profileDir = freshProfile()
  const service = new MarketService({ profileDir, runtimeRoot, appExecutable, log: () => {} })
  try {
    const installed = await service.install(PLUGIN, VERSION)
    assert.equal(installed.ok, true, installed.output)
    assert.equal(installed.bundleRegistered, true, 'the bundle list is what makes the plugin load')
    assert.equal(installed.spec, `${PLUGIN}@${VERSION}`)

    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    assert.ok(manifest.dependencies?.[PLUGIN] !== undefined, 'pnpm must record the dependency')
    assert.deepEqual(manifest.dsh?.profile?.bundles, [PLUGIN], 'the profile must load it as a bundle')
    assert.deepEqual(service.installed().map(entry => entry.name), [PLUGIN])

    const removed = await service.uninstall(PLUGIN)
    assert.equal(removed.ok, true, removed.output)
    const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    assert.equal(after.dependencies?.[PLUGIN], undefined, 'the dependency must be gone')
    assert.deepEqual(after.dsh?.profile?.bundles, [], 'and so must the bundle registration')
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('the live registry answers a search and admission still applies', { skip: enabled ? false : 'set DSH_DESKTOP_MARKET_E2E=1 to run' }, async () => {
  const profileDir = freshProfile()
  const service = new MarketService({ profileDir, runtimeRoot, appExecutable, log: () => {} })
  try {
    // A specific name, so the assertion does not depend on registry ranking or on how many plugins
    // exist today: it must come back, and it must come back carrying the admitted spec.
    const result = await service.search({ query: PLUGIN })
    const entry = result.packages.find(item => item.name === PLUGIN)
    assert.ok(entry !== undefined, `live search did not return ${PLUGIN}: ${JSON.stringify(result.packages.map(item => item.name))}`)
    assert.equal(entry.spec, `${PLUGIN}@${entry.version}`)
    assert.ok(entry.version !== '', 'an admitted entry must carry a version')
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('a version that does not exist fails with a classified reason and no profile change', { skip: enabled ? false : 'set DSH_DESKTOP_MARKET_E2E=1 to run' }, async () => {
  const profileDir = freshProfile()
  const service = new MarketService({ profileDir, runtimeRoot, appExecutable, log: () => {} })
  try {
    const result = await service.install(PLUGIN, '0.0.0-does-not-exist')
    assert.equal(result.ok, false)
    assert.ok(result.failure !== undefined, 'a failure must be classified')
    assert.equal(result.bundleRegistered, false)
    assert.match(result.output, /0\.0\.0-does-not-exist|No matching version|not found/u)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    assert.deepEqual(manifest.dsh?.profile?.bundles, [], 'a failed install must not register anything')
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})
