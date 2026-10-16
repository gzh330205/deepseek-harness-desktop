/**
 * The catalog is a 5 MB external document that grows daily, so the tests are mostly about surviving it:
 * one malformed entry must not empty the market, and an unknown field must not be invented into one.
 * The fetch test also pins the source URL, because "which list do we browse" is now a product decision
 * taken from the upstream market's own code (`CATALOG_OFFICIAL` in its `lib/regions.js`).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CATALOG_URL,
  fetchCatalog,
  filterByCategory,
  parseCatalog,
  searchCatalog,
  sortCatalog,
} from './market-catalog-source.ts'

const document = {
  name: 'awesome-dsh-plugin',
  updated: '2026-10-15T00:00:00.000Z',
  count: 2,
  categories: ['agi', 'ui', 'tools'],
  plugins: [
    {
      name: 'dsh-j-space',
      owner: 'AnonyJcy',
      url: 'https://github.com/AnonyJcy/dsh-j-space',
      page: 'https://awesome-dsh-plugin.com/p/AnonyJcy/dsh-j-space/',
      category: 'agi',
      description: { en: 'J-Space Cognition Suite', zh: 'J-Space 认知套件' },
      npm: '@anonyjcy/dsh-j-space',
      version: '1.2.3',
      stars: 4,
      downloads: 2053,
      capabilities: ['fs-write', 'fs-read', 'env'],
      added: '2026-09-20',
    },
    {
      name: 'dsh-cost-meter',
      owner: 'someone',
      category: 'ui',
      description: { en: 'Cost meter' },
      stars: 30,
      downloads: 900,
      capabilities: [],
      added: '2026-01-01',
    },
  ],
}

test('a real-shaped catalog parses into entries and a category vocabulary', () => {
  const catalog = parseCatalog(document)
  assert.equal(catalog.updated, '2026-10-15T00:00:00.000Z')
  assert.deepEqual(catalog.categories, ['agi', 'ui', 'tools'])
  assert.equal(catalog.entries.length, 2)
  const first = catalog.entries[0]
  assert.equal(first?.name, 'dsh-j-space')
  assert.equal(first?.owner, 'AnonyJcy')
  assert.equal(first?.category, 'agi')
  assert.equal(first?.npm, '@anonyjcy/dsh-j-space')
  assert.equal(first?.stars, 4)
  assert.equal(first?.downloads, 2053)
  assert.deepEqual(first?.capabilities, ['fs-write', 'fs-read', 'env'])
  assert.equal(first?.description?.zh, 'J-Space 认知套件')
  // A GitHub-only entry is still an entry: it has no npm mapping, which the UI must say out loud.
  assert.equal(catalog.entries[1]?.npm, undefined)
})

test('a malformed entry is dropped, never turned into a half-entry', () => {
  const catalog = parseCatalog({
    categories: ['agi'],
    plugins: [
      null,
      'not an object',
      { owner: 'nobody' },
      { name: '   ' },
      { name: 'ok', stars: 'many', downloads: -5, capabilities: ['fs-read', 42, ''], description: 'plain text' },
    ],
  })
  assert.equal(catalog.entries.length, 1)
  const entry = catalog.entries[0]
  assert.equal(entry?.name, 'ok')
  // Counts default to 0 rather than rejecting, and junk inside a list is skipped.
  assert.equal(entry?.stars, 0)
  assert.equal(entry?.downloads, 0)
  assert.deepEqual(entry?.capabilities, ['fs-read'])
  // A description that is not the shape we expect is simply absent.
  assert.equal(entry?.description, undefined)
})

test('a document that is not a catalog yields an empty one instead of throwing', () => {
  for (const input of [null, 42, 'text', [], { plugins: 'nope' }]) {
    const catalog = parseCatalog(input)
    assert.deepEqual(catalog.entries, [])
    assert.deepEqual(catalog.categories, [])
  }
})

test('one language of a description is enough', () => {
  const onlyChinese = parseCatalog({ plugins: [{ name: 'a', description: { zh: '中文' } }] }).entries[0]
  assert.deepEqual(onlyChinese?.description, { zh: '中文' })
  const onlyEnglish = parseCatalog({ plugins: [{ name: 'a', description: { en: 'english' } }] }).entries[0]
  assert.deepEqual(onlyEnglish?.description, { en: 'english' })
})

test('category filtering treats empty as "all", and ordering is ours', () => {
  const catalog = parseCatalog(document)
  assert.equal(filterByCategory(catalog.entries, undefined).length, 2)
  assert.equal(filterByCategory(catalog.entries, '').length, 2)
  assert.deepEqual(filterByCategory(catalog.entries, 'agi').map(entry => entry.name), ['dsh-j-space'])
  assert.deepEqual(sortCatalog(catalog.entries, 'stars').map(entry => entry.name), ['dsh-cost-meter', 'dsh-j-space'])
  assert.deepEqual(sortCatalog(catalog.entries, 'downloads').map(entry => entry.name), ['dsh-j-space', 'dsh-cost-meter'])
  assert.deepEqual(sortCatalog(catalog.entries, 'name').map(entry => entry.name), ['dsh-cost-meter', 'dsh-j-space'])
  assert.deepEqual(sortCatalog(catalog.entries, 'added').map(entry => entry.name), ['dsh-j-space', 'dsh-cost-meter'])
})

test('local search runs over name, owner, category, both descriptions and capabilities', () => {
  const catalog = parseCatalog(document)
  const names = (query: string) => searchCatalog(catalog.entries, query).map(entry => entry.name)
  assert.equal(searchCatalog(catalog.entries, '').length, 2, 'an empty query is the whole list')
  assert.deepEqual(names('j-space'), ['dsh-j-space'])
  assert.deepEqual(names('AnonyJcy'), ['dsh-j-space'])
  assert.deepEqual(names('认知'), ['dsh-j-space'])
  assert.deepEqual(names('cost meter'), ['dsh-cost-meter'])
  assert.deepEqual(names('FS-WRITE'), ['dsh-j-space'], 'matching is case-insensitive')
  assert.deepEqual(names('nothing here'), [])
})

test('fetching uses the upstream market own catalog address by default', async () => {
  const asked: string[] = []
  const catalog = await fetchCatalog(url => {
    asked.push(url)
    return Promise.resolve(document)
  })
  assert.deepEqual(asked, [CATALOG_URL])
  assert.equal(catalog.entries.length, 2)
  // A caller may point at a mirror (or a fixture) without changing the parsing contract.
  await fetchCatalog(url => {
    asked.push(url)
    return Promise.resolve({ plugins: [] })
  }, { url: 'https://mirror.invalid/plugins.json' })
  assert.equal(asked[1], 'https://mirror.invalid/plugins.json')
})
