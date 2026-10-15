/**
 * The catalog's decisions are the market's safety boundary: what gets offered for installation, and
 * what gets refused. These tests pin that boundary without touching the network — the transport is
 * injected, so the same code the window runs is exercised with fixed registry answers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  displayKeywords,
  hasClientHalf,
  isPlatformPackage,
  packumentUrl,
  rejectReason,
  searchMarketPackages,
  searchUrl,
  toMarketPackage,
} from './market-catalog.ts'

test('the harness itself is never offered as a plugin', () => {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']) {
    assert.equal(isPlatformPackage(name), true, name)
  }
  // Every `@deepseek-ai/dsh*` package is the harness's own surface (base bundles, feature bundles
  // such as the voice-input one, SDK apps). Those arrive with the bundled runtime; offering them for
  // installation would let a user fight the runtime they are running on.
  for (const name of ['dsh-git-panel', '@changfenhuang/dsh-genui', '@michengai/dsh-skills-manager']) {
    assert.equal(isPlatformPackage(name), false, name)
  }
})

test('admission requires the dsh.bundle.patch field every real plugin declares', () => {
  assert.match(String(rejectReason('random-package', { name: 'random-package' })), /没有声明 dsh 字段/u)
  assert.match(String(rejectReason('half-plugin', { dsh: { client: { platform: 'web' } } })), /没有 dsh\.bundle\.patch/u)
  assert.equal(rejectReason('dsh-git-panel', { dsh: { bundle: { patch: './cordis.patch.yml' } } }), undefined)
  assert.match(String(rejectReason('@deepseek-ai/dsh-base', { dsh: { bundle: { patch: './p.yml' } } })), /平台自身/u)
  assert.match(String(rejectReason('broken', null)), /不可读/u)
})

test('a plugin that ships a browser half is marked as such', () => {
  assert.equal(hasClientHalf({ dsh: { client: { platform: 'web' } } }), true)
  assert.equal(hasClientHalf({ dsh: { bundle: { patch: './p.yml' } } }), false)
  assert.equal(hasClientHalf(null), false)
})

test('generic keywords are dropped and the rest is capped', () => {
  assert.deepEqual(
    displayKeywords(['dsh', 'plugin', 'deepseek-harness', 'git', 'diff', 'merge-conflict', 'extra'], 3),
    ['git', 'diff', 'merge-conflict'],
  )
  assert.deepEqual(displayKeywords('not-an-array'), [])
})

test('the install spec is pinned to the exact version', () => {
  const entry = toMarketPackage(
    '@changfenhuang/dsh-genui',
    '0.12.0',
    { description: 'x'.repeat(300), keywords: ['dsh', 'generative-ui'], date: '2026-10-14T00:00:00.000Z' },
    { dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } },
  )
  assert.equal(entry.spec, '@changfenhuang/dsh-genui@0.12.0')
  assert.equal(entry.client, true)
  assert.equal(entry.description.length, 158)
  assert.match(entry.description, /…$/u)
  assert.deepEqual(entry.keywords, ['generative-ui'])
  assert.equal(entry.published, '2026-10-14T00:00:00.000Z')
})

test('registry URLs survive scoped names', () => {
  assert.equal(packumentUrl('@scope/name'), 'https://registry.npmjs.org/@scope%2Fname')
  assert.equal(packumentUrl('plain'), 'https://registry.npmjs.org/plain')
  assert.equal(searchUrl('a b', 5), 'https://registry.npmjs.org/-/v1/search?text=a%20b&size=5')
})

/** A registry double: search hits, plus one packument per name. */
function fakeRegistry(hits: readonly { name: string; description?: string }[], manifests: Record<string, unknown>) {
  const asked: string[] = []
  return {
    asked,
    getJson: (url: string) => {
      asked.push(url)
      if (url.includes('/-/v1/search')) {
        return Promise.resolve({ objects: hits.map(hit => ({ package: { name: hit.name, description: hit.description ?? '', keywords: ['dsh', 'plugin'] } })) })
      }
      const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
      return Promise.resolve(manifests[name] ?? null)
    },
  }
}

test('a search hit is only offered after its own manifest confirms it', async () => {
  const registry = fakeRegistry(
    [
      { name: 'dsh-git-panel', description: 'git panel' },
      { name: '@deepseek-ai/dsh-base', description: 'platform' },
      { name: 'some-random-package', description: 'not a plugin' },
    ],
    {
      'dsh-git-panel': { 'dist-tags': { latest: '0.1.20' }, versions: { '0.1.20': { dsh: { bundle: { patch: './cordis.patch.yml' } } } } },
      'some-random-package': { 'dist-tags': { latest: '9.9.9' }, versions: { '9.9.9': { name: 'some-random-package' } } },
    },
  )
  const result = await searchMarketPackages('keywords:dsh-plugin', { getJson: registry.getJson })
  assert.deepEqual(result.packages.map(entry => entry.spec), ['dsh-git-panel@0.1.20'])
  assert.equal(result.skipped.length, 2)
  assert.match(result.skipped.map(entry => entry.reason).join(' '), /不是 DSH 插件/u)
  assert.match(result.skipped.map(entry => entry.reason).join(' '), /平台自身/u)
  // The platform package is refused before its packument is ever fetched.
  assert.equal(registry.asked.some(url => url.includes('dsh-base')), false)
})

test('an empty query falls back to the plugin keyword instead of searching everything', async () => {
  const registry = fakeRegistry([], {})
  const result = await searchMarketPackages('   ', { getJson: registry.getJson })
  assert.equal(result.query, 'keywords:dsh-plugin')
  assert.match(registry.asked[0] ?? '', /keywords%3Adsh-plugin/u)
  assert.deepEqual(result.packages, [])
})

test('a package without a latest version is reported, not silently dropped', async () => {
  const registry = fakeRegistry([{ name: 'dsh-weird' }], { 'dsh-weird': { versions: {} } })
  const result = await searchMarketPackages('dsh', { getJson: registry.getJson })
  assert.deepEqual(result.packages, [])
  assert.deepEqual(result.skipped, [{ name: 'dsh-weird', reason: 'registry 没有可用的 latest 版本' }])
})
