/**
 * Downloads: name collisions, state transitions, and the panel payload.
 *
 * A fake `DownloadItem` drives the real class, so the parts worth pinning — "never overwrite an
 * existing file", "a cancelled download is not 'completed'", "finished rows can be cleared while
 * a running one survives" — are tested without downloading anything.
 *
 * Run: node --test src/browser-downloads.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DownloadItem, Session } from 'electron'
import { BrowserDownloads, formatBytes, uniqueFileName, type BrowserDownloadItem } from '../src/browser-downloads.ts'

/** Minimal `DownloadItem` stand-in with the surface `BrowserDownloads` uses. */
function fakeDownload(filename: string, url = 'https://example.com/file'): {
  item: DownloadItem
  emit: (event: 'updated' | 'done', state: 'progressing' | 'completed' | 'cancelled' | 'interrupted') => void
  savedPath: () => string
  setProgress: (received: number, total: number) => void
} {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  let path = ''
  let received = 0
  let total = 1024
  const item = {
    getFilename: () => filename,
    getURL: () => url,
    getSavePath: () => path,
    setSavePath: (next: string) => { path = next },
    getReceivedBytes: () => received,
    getTotalBytes: () => total,
    on: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, [...handlers.get(event) ?? [], handler]) },
    once: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, [...handlers.get(event) ?? [], handler]) },
  } as unknown as DownloadItem
  return {
    item,
    emit: (event, state) => { for (const handler of handlers.get(event) ?? []) handler({}, state) },
    savedPath: () => path,
    setProgress: (nextReceived, nextTotal) => { received = nextReceived; total = nextTotal },
  }
}

function harness(existing: readonly string[] = [], flushMs = 0): {
  downloads: BrowserDownloads
  pushed: BrowserDownloadItem[][]
  logs: string[]
} {
  const pushed: BrowserDownloadItem[][] = []
  const logs: string[] = []
  const present = new Set(existing)
  const downloads = new BrowserDownloads({
    log: (line) => logs.push(line),
    notify: (items) => pushed.push([...items]),
    saveDir: () => 'C:\\Users\\me\\Downloads',
    exists: (path) => present.has(path),
    flushMs,
  })
  return { downloads, pushed, logs }
}

test('a downloaded file never overwrites one that is already there', () => {
  const exists = (path: string): boolean => path === 'C:\\d\\report.pdf' || path === 'C:\\d\\report (1).pdf'
  assert.equal(uniqueFileName('report.pdf', exists, 'C:\\d'), 'C:\\d\\report (2).pdf')
  assert.equal(uniqueFileName('fresh.pdf', exists, 'C:\\d'), 'C:\\d\\fresh.pdf')
  // A name that is not a usable file name falls back instead of escaping the directory.
  assert.equal(uniqueFileName('..\\evil', () => false, 'C:\\d'), 'C:\\d\\download')
  // Dotfiles keep their name (the last dot is not an extension separator here).
  assert.equal(uniqueFileName('.gitignore', () => false, 'C:\\d'), 'C:\\d\\.gitignore')
})

test('the save path is assigned and progress is reported', () => {
  const { downloads, pushed } = harness()
  const fake = fakeDownload('report.pdf')
  downloads.track(fake.item)
  assert.equal(fake.savedPath(), 'C:\\Users\\me\\Downloads\\report.pdf')
  fake.setProgress(512, 1024)
  fake.emit('updated', 'progressing')
  const last = pushed.at(-1)?.[0]
  assert.equal(last?.state, 'progressing')
  assert.equal(last?.receivedBytes, 512)
  assert.equal(last?.totalBytes, 1024)
  assert.equal(last?.filename, 'report.pdf')
})

test('a cancelled download is not reported as completed', () => {
  const { downloads, pushed } = harness()
  const fake = fakeDownload('big.iso')
  downloads.track(fake.item)
  fake.emit('done', 'cancelled')
  assert.equal(pushed.at(-1)?.[0]?.state, 'cancelled')
  assert.equal(downloads.list().length, 1)
})

test('an interrupted download keeps its row and stays openable only when completed', () => {
  const { downloads } = harness()
  const fake = fakeDownload('broken.zip')
  const record = downloads.track(fake.item)
  fake.emit('done', 'interrupted')
  assert.equal(downloads.list()[0]?.state, 'interrupted')
  const opened = downloads.open(record.id)
  assert.equal(opened.ok, false)
  assert.match(String(opened.reason), /尚未完成/u)
})

test('clearing drops finished rows but keeps a running download', () => {
  const { downloads } = harness()
  const finished = fakeDownload('a.txt')
  downloads.track(finished.item)
  finished.emit('done', 'completed')
  const running = fakeDownload('b.txt')
  downloads.track(running.item)
  assert.equal(downloads.list().length, 2)

  downloads.clear()
  assert.deepEqual(downloads.list().map((entry) => entry.filename), ['b.txt'])
})

test('attach listens once and tracks what the session reports', () => {
  const { downloads } = harness()
  const handlers: ((event: unknown, item: DownloadItem) => void)[] = []
  const session = {
    on: (event: string, handler: (event: unknown, item: DownloadItem) => void) => {
      if (event === 'will-download') handlers.push(handler)
    },
  } as unknown as Session
  downloads.attach(session)
  downloads.attach(session)
  assert.equal(handlers.length, 1, 'attaching twice must not double-track')

  const fake = fakeDownload('from-session.pdf')
  for (const handler of handlers) handler({}, fake.item)
  assert.deepEqual(downloads.list().map((entry) => entry.filename), ['from-session.pdf'])
})

test('sizes are rendered the way the bar shows them', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024 * 12), '12 GB')
})
