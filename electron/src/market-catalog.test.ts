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
  sortPackages,
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
  assert.equal(searchUrl('a b', 5), 'https://registry.npmjs.org/-/v1/search?text=a%20b&size=5&from=0')
  assert.match(searchUrl('a', 5, undefined, 60), /&from=60$/u)
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

/** A registry double that serves search hits in pages and one packument per plugin name. */
function pagedRegistry(pages: readonly (readonly string[])[], manifests: Record<string, unknown>) {
  const asked: string[] = []
  return {
    asked,
    getJson: (url: string) => {
      asked.push(url)
      if (url.includes('/-/v1/search')) {
        const from = Number(/[?&]from=(\d+)/u.exec(url)?.[1] ?? '0')
        const size = Number(/[?&]size=(\d+)/u.exec(url)?.[1] ?? '20')
        const flat = pages.flat()
        const slice = flat.slice(from, from + size)
        return Promise.resolve({ objects: slice.map(name => ({ package: { name, description: '', keywords: ['dsh'] } })) })
      }
      const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
      return Promise.resolve(manifests[name] ?? null)
    },
  }
}

const PLUGIN_MANIFEST = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dsh: { bundle: { patch: './p.yml' } } } } }

test('a page keeps walking the registry until it is full, because most hits are not plugins', async () => {
  // Page one is mostly noise; only the third hit is a plugin. Asking for two plugins must reach into
  // the next registry page rather than showing one entry and calling it a page.
  const registry = pagedRegistry([['noise-1', 'noise-2'], ['dsh-real', 'noise-3', 'dsh-second']], {
    'dsh-real': PLUGIN_MANIFEST,
    'dsh-second': PLUGIN_MANIFEST,
  })
  const result = await searchMarketPackages('dsh', { getJson: registry.getJson, limit: 2, candidates: 2, fillPages: 3 })
  assert.deepEqual(result.packages.map(entry => entry.name), ['dsh-real', 'dsh-second'])
  assert.equal(result.page.scanned, 5, 'it consumed both registry pages')
  assert.equal(result.page.size, 2)
  assert.equal(result.page.from, 0)
  assert.equal(result.page.hasMore, false, 'the registry ran out of hits, so no further page may exist')
})

test('paging continues from the requested offset and reports registry bookkeeping', async () => {
  const registry = pagedRegistry([['a-plugin', 'b-plugin', 'c-plugin']], { 'a-plugin': PLUGIN_MANIFEST, 'b-plugin': PLUGIN_MANIFEST, 'c-plugin': PLUGIN_MANIFEST })
  const first = await searchMarketPackages('dsh', { getJson: registry.getJson, limit: 2, candidates: 3, fillPages: 1 })
  assert.deepEqual(first.packages.map(entry => entry.name), ['a-plugin', 'b-plugin'])
  assert.equal(first.page.hasMore, true, 'the registry page was full, so another page may exist')
  const second = await searchMarketPackages('dsh', { getJson: registry.getJson, limit: 2, candidates: 3, from: 2, fillPages: 1 })
  assert.deepEqual(second.packages.map(entry => entry.name), ['c-plugin'])
  assert.equal(second.page.from, 2)
  assert.equal(second.page.hasMore, false, 'nothing left after the last hit')
})

test('name and client filters narrow what is confirmed at all', async () => {
  const registry = pagedRegistry([['dsh-real', 'dsh-other', 'dsh-client']], {
    'dsh-real': PLUGIN_MANIFEST,
    'dsh-other': PLUGIN_MANIFEST,
    'dsh-client': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dsh: { bundle: { patch: './p.yml' }, client: { platform: 'web' } } } } },
  })
  const byName = await searchMarketPackages('dsh', { getJson: registry.getJson, limit: 5, filter: { names: ['dsh-real'] } })
  assert.deepEqual(byName.packages.map(entry => entry.name), ['dsh-real'])
  assert.equal(registry.asked.some(url => url.includes('dsh-other')), false, 'unrequested names are not even confirmed')

  const clientOnly = await searchMarketPackages('dsh', { getJson: registry.getJson, limit: 5, filter: { clientOnly: true } })
  assert.deepEqual(clientOnly.packages.map(entry => entry.name), ['dsh-client'])
})

test('sorting is ours, not the registry order', () => {
  const entry = (name: string, published: string) => ({ name, version: '1.0.0', description: '', published, keywords: [], spec: name + '@1.0.0', client: false })
  const packages = [entry('b-plugin', '2026-01-01T00:00:00.000Z'), entry('a-plugin', '2026-05-01T00:00:00.000Z')]
  assert.deepEqual(sortPackages(packages, 'name').map(item => item.name), ['a-plugin', 'b-plugin'])
  assert.deepEqual(sortPackages(packages, 'updated').map(item => item.name), ['a-plugin', 'b-plugin'])
  assert.deepEqual(sortPackages(packages, undefined).map(item => item.name), ['b-plugin', 'a-plugin'])
})