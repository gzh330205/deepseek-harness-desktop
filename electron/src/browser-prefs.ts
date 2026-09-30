/**
 * Browser-owned preferences: homepage, bookmarks, bookmark-bar visibility.
 *
 * Deliberately **not** part of `shell-settings.json`. That document is shared with the DSH
 * settings page (three schemas that must stay in step, guarded by `settings-parity.test.ts`),
 * and these are browser-local gizmos the panel owns: they change while you browse, not while
 * you configure the app. Keeping them in their own file avoids widening that contract.
 *
 * The file lives in the shell's userData next to `shell-settings.json`, so it survives restarts
 * and is independent of the DSH page's origin (the dev channel and the shipping app run on
 * different ports, and localStorage would not carry over).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface BrowserBookmark {
  readonly url: string
  readonly title: string
  /** Unix ms, for stable ordering and display. */
  readonly at: number
}

export interface BrowserPrefs {
  /** Empty means "about:blank" (the home button then opens a blank page). */
  readonly homepage: string
  readonly bookmarks: readonly BrowserBookmark[]
  readonly bookmarkBarVisible: boolean
}

export const BROWSER_PREFS_FILENAME = 'browser-prefs.json'
export const DEFAULT_BROWSER_PREFS: BrowserPrefs = { homepage: '', bookmarks: [], bookmarkBarVisible: false }

/** One bookmark list is bounded: this is a convenience list, not a library. */
export const MAX_BOOKMARKS = 200
const MAX_TITLE = 200
const MAX_URL = 2048

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Only the two schemes the browser will actually load; anything else is dropped. */
export function isUsableBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function parseBookmark(raw: unknown): BrowserBookmark | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  if (url === '' || url.length > MAX_URL || !isUsableBrowserUrl(url)) return undefined
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_TITLE) : ''
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now()
  return { url, title, at }
}

/** Read the document, tolerating every failure: a broken file must not block browsing. */
export function parseBrowserPrefs(raw: unknown): BrowserPrefs {
  const record = asRecord(raw)
  if (record === undefined) return DEFAULT_BROWSER_PREFS
  const homepage = typeof record.homepage === 'string' ? record.homepage.trim() : ''
  const bookmarks: BrowserBookmark[] = []
  const seen = new Set<string>()
  if (Array.isArray(record.bookmarks)) {
    for (const entry of record.bookmarks) {
      const bookmark = parseBookmark(entry)
      if (bookmark === undefined || seen.has(bookmark.url)) continue
      seen.add(bookmark.url)
      bookmarks.push(bookmark)
      if (bookmarks.length >= MAX_BOOKMARKS) break
    }
  }
  return {
    homepage: homepage === '' || isUsableBrowserUrl(homepage) ? homepage : '',
    bookmarks,
    bookmarkBarVisible: record.bookmarkBarVisible === true,
  }
}

export type BrowserPrefsPatchResult =
  | { readonly ok: true; readonly prefs: BrowserPrefs; readonly changed: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Merge a panel submission. `bookmarks` (when present) replaces the whole list: the panel is
 * the only writer and always sends what it shows, which keeps add/remove/rename from racing.
 */
export function mergeBrowserPrefs(current: BrowserPrefs, patch: unknown): BrowserPrefsPatchResult {
  const record = asRecord(patch)
  if (record === undefined) return { ok: false, reason: '设置必须是对象' }
  for (const key of Object.keys(record)) {
    if (!['homepage', 'bookmarks', 'bookmarkBarVisible'].includes(key)) {
      return { ok: false, reason: `未知设置项：${key}` }
    }
  }
  const changed: string[] = []
  let homepage = current.homepage
  if (record.homepage !== undefined) {
    if (typeof record.homepage !== 'string') return { ok: false, reason: 'homepage 必须是字符串' }
    const next = record.homepage.trim()
    if (next.length > MAX_URL) return { ok: false, reason: 'homepage 过长' }
    if (next !== '' && !isUsableBrowserUrl(next)) return { ok: false, reason: 'homepage 必须是 http(s) 地址' }
    if (next !== homepage) {
      homepage = next
      changed.push('homepage')
    }
  }
  let bookmarks: readonly BrowserBookmark[] = current.bookmarks
  if (record.bookmarks !== undefined) {
    if (!Array.isArray(record.bookmarks)) return { ok: false, reason: 'bookmarks 必须是数组' }
    if (record.bookmarks.length > MAX_BOOKMARKS) return { ok: false, reason: `收藏最多 ${String(MAX_BOOKMARKS)} 条` }
    const parsed = parseBrowserPrefs({ bookmarks: record.bookmarks }).bookmarks
    // A list that silently loses entries (bad URL, duplicate) is usually a bug on the sending
    // side; say so instead of dropping them quietly.
    if (parsed.length !== record.bookmarks.length) return { ok: false, reason: '收藏里有无法识别的条目（URL 必须是 http(s)、且不重复）' }
    if (JSON.stringify(parsed) !== JSON.stringify(current.bookmarks)) changed.push('bookmarks')
    bookmarks = parsed
  }
  let bookmarkBarVisible = current.bookmarkBarVisible
  if (record.bookmarkBarVisible !== undefined) {
    if (typeof record.bookmarkBarVisible !== 'boolean') return { ok: false, reason: 'bookmarkBarVisible 必须是布尔值' }
    if (record.bookmarkBarVisible !== bookmarkBarVisible) {
      bookmarkBarVisible = record.bookmarkBarVisible
      changed.push('bookmarkBarVisible')
    }
  }
  return { ok: true, prefs: { homepage, bookmarks, bookmarkBarVisible }, changed }
}

/** Read from disk; every failure falls back to the defaults. */
export function readBrowserPrefs(bridgeDir: string): BrowserPrefs {
  try {
    return parseBrowserPrefs(JSON.parse(readFileSync(join(bridgeDir, BROWSER_PREFS_FILENAME), 'utf8')))
  } catch {
    return DEFAULT_BROWSER_PREFS
  }
}

/** Write to disk; failures are reported to the caller (which logs them). */
export function writeBrowserPrefs(bridgeDir: string, prefs: BrowserPrefs): void {
  const path = join(bridgeDir, BROWSER_PREFS_FILENAME)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
}
