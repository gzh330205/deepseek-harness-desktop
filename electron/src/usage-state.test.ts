/**
 * Guards for the usage window's local state.
 *
 * The state file is the only place the gateway session cookie is kept, so two things matter beyond
 * "it round-trips": a hand-edited file must never produce a bogus base URL, and a corrupt file must
 * degrade to defaults rather than break the window.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  DEFAULT_ONEWAY_BASE_URL,
  DEFAULT_USAGE_REFRESH_SECONDS,
  MAX_USAGE_REFRESH_SECONDS,
  MIN_USAGE_REFRESH_SECONDS,
} from './constants.ts'
import { clampRefreshSeconds, createUsageStore, normalizeBaseUrl } from './usage-state.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-usage-state-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

test('the gateway address must be an http(s) root, not a path or scheme', () => {
  assert.equal(normalizeBaseUrl('https://oneway.eportyun.com/'), 'https://oneway.eportyun.com')
  assert.equal(normalizeBaseUrl('  http://10.0.0.5:8080  '), 'http://10.0.0.5:8080')
  assert.equal(normalizeBaseUrl('https://oneway.eportyun.com/path'), undefined)
  assert.equal(normalizeBaseUrl('file:///etc/passwd'), undefined)
  assert.equal(normalizeBaseUrl('javascript:alert(1)'), undefined)
  assert.equal(normalizeBaseUrl(42), undefined)
  assert.equal(normalizeBaseUrl(''), undefined)
})

test('the refresh interval is clamped into the range the gateway can bear', () => {
  assert.equal(clampRefreshSeconds(120), 120)
  assert.equal(clampRefreshSeconds(1), MIN_USAGE_REFRESH_SECONDS)
  assert.equal(clampRefreshSeconds(999_999), MAX_USAGE_REFRESH_SECONDS)
  assert.equal(clampRefreshSeconds(Number.NaN), undefined)
  assert.equal(clampRefreshSeconds('60'), undefined)
})

test('state round-trips through oneway.json, including a new cookie', () => {
  const path = join(root, 'oneway.json')
  const store = createUsageStore(path)
  assert.deepEqual(store.get(), { baseUrl: DEFAULT_ONEWAY_BASE_URL, refreshSeconds: DEFAULT_USAGE_REFRESH_SECONDS, sessionCookie: '' })

  store.update({ sessionCookie: '[{"name":"a","value":"b"}]', baseUrl: 'http://10.0.0.5:8080' })
  const reread = createUsageStore(path)
  assert.equal(reread.get().sessionCookie, '[{"name":"a","value":"b"}]')
  assert.equal(reread.get().baseUrl, 'http://10.0.0.5:8080')
  assert.equal(reread.get().refreshSeconds, DEFAULT_USAGE_REFRESH_SECONDS)

  // The file is written 0600 and is valid JSON — the cookie must never be silently lost by a
  // half-written file.
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  assert.equal(raw.sessionCookie, '[{"name":"a","value":"b"}]')
  reread.update({ sessionCookie: '' })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).sessionCookie, '')
})

test('a corrupt state file degrades to defaults instead of breaking the window', () => {
  const path = join(root, 'broken.json')
  writeFileSync(path, '{ this is not json')
  const logged: string[] = []
  const store = createUsageStore(path, (line) => logged.push(line))
  assert.equal(store.get().baseUrl, DEFAULT_ONEWAY_BASE_URL)
  assert.equal(store.get().sessionCookie, '')
  assert.equal(logged.length, 1, 'corruption is reported once')
})

test('saveSettings rejects nonsense instead of writing it', () => {
  const path = join(root, 'settings.json')
  const store = createUsageStore(path)
  const bad = store.saveSettings({ baseUrl: 'not a url' })
  assert.equal(bad.ok, false)
  assert.equal(store.get().baseUrl, DEFAULT_ONEWAY_BASE_URL)

  const badInterval = store.saveSettings({ refreshSeconds: 5 })
  assert.equal(badInterval.ok, false)
  // Rejection must not have changed the stored value.
  assert.equal(store.get().refreshSeconds, DEFAULT_USAGE_REFRESH_SECONDS)

  const good = store.saveSettings({ baseUrl: 'https://example.com/', refreshSeconds: 300 })
  assert.equal(good.ok, true)
  assert.deepEqual(store.settings(), { baseUrl: 'https://example.com', refreshSeconds: 300 })
  assert.deepEqual(createUsageStore(path).settings(), { baseUrl: 'https://example.com', refreshSeconds: 300 })
})
