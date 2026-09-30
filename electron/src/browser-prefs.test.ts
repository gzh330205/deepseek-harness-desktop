/**
 * Browser-owned preferences: homepage, bookmarks, bookmark-bar visibility.
 *
 * These live in the shell's own `browser-prefs.json` rather than `shell-settings.json`, so the
 * interesting properties are the ones that keep a hand-edited or stale file from breaking the
 * panel: unknown shapes fall back to defaults, only http(s) URLs survive, and a rejected patch
 * never half-applies.
 *
 * Run: node --test src/browser-prefs.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_BROWSER_PREFS,
  MAX_BOOKMARKS,
  isUsableBrowserUrl,
  mergeBrowserPrefs,
  parseBrowserPrefs,
} from '../src/browser-prefs.ts'

test('anything that is not a document reads as the defaults', () => {
  assert.deepEqual(parseBrowserPrefs(undefined), DEFAULT_BROWSER_PREFS)
  assert.deepEqual(parseBrowserPrefs(null), DEFAULT_BROWSER_PREFS)
  assert.deepEqual(parseBrowserPrefs('nope'), DEFAULT_BROWSER_PREFS)
  assert.deepEqual(parseBrowserPrefs([]), DEFAULT_BROWSER_PREFS)
})

test('only http(s) survives, for the homepage and for bookmarks', () => {
  assert.equal(isUsableBrowserUrl('https://example.com/'), true)
  assert.equal(isUsableBrowserUrl('http://127.0.0.1:8080/x'), true)
  // The browser view's own navigation policy allows nothing else, so a bookmark to one would
  // be a button that cannot work.
  assert.equal(isUsableBrowserUrl('file:///C:/x'), false)
  assert.equal(isUsableBrowserUrl('javascript:alert(1)'), false)
  assert.equal(isUsableBrowserUrl('例子'), false)

  const parsed = parseBrowserPrefs({
    homepage: 'file:///C:/x',
    bookmarks: [
      { url: 'https://ok.example/', title: 'ok', at: 1 },
      { url: 'javascript:alert(1)', title: 'bad' },
      { url: 'https://ok.example/', title: 'duplicate', at: 2 },
      { url: 'not a url' },
    ],
    bookmarkBarVisible: 'yes',
  })
  assert.equal(parsed.homepage, '')
  assert.deepEqual(parsed.bookmarks, [{ url: 'https://ok.example/', title: 'ok', at: 1 }])
  assert.equal(parsed.bookmarkBarVisible, false)
})

test('the bookmark list is bounded, and titles are trimmed and capped', () => {
  const many = Array.from({ length: MAX_BOOKMARKS + 5 }, (_, index) => ({
    url: `https://example.com/${String(index)}`,
    title: 'x'.repeat(500),
  }))
  const parsed = parseBrowserPrefs({ bookmarks: many })
  assert.equal(parsed.bookmarks.length, MAX_BOOKMARKS)
  assert.equal(parsed.bookmarks[0]?.title.length, 200)
})

test('a patch merges without touching what it does not mention', () => {
  const current = { homepage: 'https://home.example/', bookmarks: [{ url: 'https://a.example/', title: 'A', at: 1 }], bookmarkBarVisible: true }
  const merged = mergeBrowserPrefs(current, { bookmarkBarVisible: false })
  assert.equal(merged.ok, true)
  if (!merged.ok) return
  assert.equal(merged.prefs.homepage, current.homepage)
  assert.deepEqual(merged.prefs.bookmarks, current.bookmarks)
  assert.deepEqual(merged.changed, ['bookmarkBarVisible'])
})

test('an unknown key, a bad URL or a partly-bad bookmark list is rejected whole', () => {
  const current = DEFAULT_BROWSER_PREFS
  assert.equal(mergeBrowserPrefs(current, { nope: 1 }).ok, false)
  assert.equal(mergeBrowserPrefs(current, { homepage: 'not a url' }).ok, false)
  assert.equal(mergeBrowserPrefs(current, { bookmarks: 'nope' }).ok, false)
  // One unusable entry rejects the whole list rather than silently dropping it.
  const rejected = mergeBrowserPrefs(current, { bookmarks: [{ url: 'https://ok.example/' }, { url: 'bad' }] })
  assert.equal(rejected.ok, false)
  if (rejected.ok) return
  assert.match(rejected.reason, /收藏/u)
  // ...and the same list written by the parser (a file on disk) just loses the bad entry.
  assert.equal(parseBrowserPrefs({ bookmarks: [{ url: 'https://ok.example/' }, { url: 'bad' }] }).bookmarks.length, 1)
})

test('the bookmark list is replaced wholesale, in the order the panel sent it', () => {
  const merged = mergeBrowserPrefs(
    { homepage: '', bookmarks: [{ url: 'https://old.example/', title: 'old', at: 1 }], bookmarkBarVisible: false },
    { bookmarks: [{ url: 'https://b.example/', title: 'B', at: 2 }, { url: 'https://a.example/', title: 'A', at: 3 }] },
  )
  assert.equal(merged.ok, true)
  if (!merged.ok) return
  assert.deepEqual(merged.prefs.bookmarks.map((entry) => entry.url), ['https://b.example/', 'https://a.example/'])
  assert.deepEqual(merged.changed, ['bookmarks'])
})
