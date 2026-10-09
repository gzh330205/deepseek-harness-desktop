/**
 * Sidebar-browser geometry and address rules.
 *
 * These are the parts of the browser panel that can be tested without Electron: the rect a
 * remote renderer hands over must be validated and clamped (it can move a native surface),
 * and the address bar must never produce a URL the view is not allowed to load.
 *
 * Run: node --test src/browser-geometry.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BROWSER_HIDDEN_RECT,
  clampBrowserRect,
  describeLoadFailure,
  isAllowedBrowserNavigation,
  isUsableBrowserRect,
  mayPlaceSurface,
  normalizeAddress,
  parseBrowserRect,
  shouldReportLoadFailure,
  toWindowRect,
} from '../src/browser-geometry.ts'

test('only the panel may place the view while the panel is not visible', () => {
  // The panel measured itself, so its own show is always legitimate.
  assert.equal(mayPlaceSurface('panel', true), true)
  assert.equal(mayPlaceSurface('panel', false), true)
  // The agent has no idea whether the sidebar is open, so it may only place the view when it is.
  assert.equal(mayPlaceSurface('agent', true), true)
  assert.equal(mayPlaceSurface('agent', false), false)
})

test('a reported rect must be four finite numbers', () => {
  assert.deepEqual(parseBrowserRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 })
  assert.equal(parseBrowserRect(undefined), undefined)
  assert.equal(parseBrowserRect(null), undefined)
  assert.equal(parseBrowserRect('120x600'), undefined)
  assert.equal(parseBrowserRect({ x: 0, y: 0, width: Number.NaN, height: 10 }), undefined)
  assert.equal(parseBrowserRect({ x: 0, y: 0, width: '100', height: 10 }), undefined)
})

test('a rect never escapes the window content area', () => {
  const content = { width: 1000, height: 800 }
  assert.deepEqual(clampBrowserRect({ x: -50, y: -20, width: 300, height: 200 }, content), { x: 0, y: 0, width: 300, height: 200 })
  // Anchored near the corner: the top-left is authoritative, the size shrinks to fit.
  assert.deepEqual(clampBrowserRect({ x: 900, y: 700, width: 300, height: 200 }, content), { x: 900, y: 700, width: 100, height: 100 })
  // A rect larger than the window must not push the other view out of the way.
  assert.deepEqual(clampBrowserRect({ x: 0, y: 0, width: 5000, height: 5000 }, content), { x: 0, y: 0, width: 1000, height: 800 })
})

test('viewport rects are shifted below the shell title strip', () => {
  const content = { width: 1200, height: 900 }
  assert.deepEqual(toWindowRect({ x: 40, y: 0, width: 300, height: 500 }, 36, content), { x: 40, y: 36, width: 300, height: 500 })
  // The bottom of the page's viewport coincides with the bottom of the window.
  assert.deepEqual(toWindowRect({ x: 0, y: 500, width: 1200, height: 400 }, 36, content), { x: 0, y: 536, width: 1200, height: 364 })
})

test('a collapsed panel parks the view instead of showing a sliver', () => {
  assert.equal(isUsableBrowserRect({ x: 0, y: 0, width: 300, height: 500 }), true)
  assert.equal(isUsableBrowserRect({ x: 0, y: 0, width: 10, height: 500 }), false)
  assert.equal(isUsableBrowserRect({ x: 0, y: 0, width: 300, height: 0 }), false)
  assert.ok(BROWSER_HIDDEN_RECT.x < -1000)
})

test('a bare host means HTTPS and HTTP(S) is accepted', () => {
  assert.deepEqual(normalizeAddress('example.com'), { ok: true, url: 'https://example.com/' })
  assert.deepEqual(normalizeAddress('  http://example.com/a?b=1  '), { ok: true, url: 'http://example.com/a?b=1' })
  assert.deepEqual(normalizeAddress('https://127.0.0.1:8080/x'), { ok: true, url: 'https://127.0.0.1:8080/x' })
})

test('local pages open, as a file URL or as the path tools print', () => {
  // Generated pages (HTML explainers, saved reports) are handed around as paths, and their names
  // contain spaces and `#` — the parser has to encode those, not choke on them.
  assert.deepEqual(
    normalizeAddress('file:///C:/Users/gzh33/.answer-me-with-html/pages/report.html'),
    { ok: true, url: 'file:///C:/Users/gzh33/.answer-me-with-html/pages/report.html' },
  )
  assert.deepEqual(
    normalizeAddress('C:\\Users\\gzh33\\.answer-me-with-html\\pages\\报告 v2#1.html'),
    { ok: true, url: 'file:///C:/Users/gzh33/.answer-me-with-html/pages/%E6%8A%A5%E5%91%8A%20v2%231.html' },
  )
  assert.deepEqual(
    normalizeAddress('c:/tmp/page.html'),
    { ok: true, url: 'file:///c:/tmp/page.html' },
  )
  // A share is a network read, not a local file.
  const share = normalizeAddress('file://server/share/page.html')
  assert.equal(share.ok, false)
  if (!share.ok) assert.match(share.reason, /网络共享/u)
})

test('dangerous or ambiguous input is refused with a reason', () => {
  for (const raw of ['', '   ', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'about:blank', 'chrome://settings', 'dsh-app://app/']) {
    const result = normalizeAddress(raw)
    assert.equal(result.ok, false, `expected ${raw} to be refused`)
    if (!result.ok) assert.ok(result.reason.length > 0)
  }
  const credentials = normalizeAddress('https://user:pass@example.com/')
  assert.equal(credentials.ok, false)
  const self = normalizeAddress('http://127.0.0.1:41729/', 'http://127.0.0.1:41729')
  assert.equal(self.ok, false)
})

test('navigation policy allows HTTP(S) and local files, nothing else', () => {
  assert.equal(isAllowedBrowserNavigation('https://example.com/'), true)
  assert.equal(isAllowedBrowserNavigation('http://example.com/'), true)
  assert.equal(isAllowedBrowserNavigation('file:///C:/page.html'), true)
  assert.equal(isAllowedBrowserNavigation('file://server/share/page.html'), false)
  assert.equal(isAllowedBrowserNavigation('dsh-app://app/'), false)
  assert.equal(isAllowedBrowserNavigation('javascript:alert(1)'), false)
  assert.equal(isAllowedBrowserNavigation('not a url'), false)
})

test('aborted and sub-frame failures are not shown as page errors', () => {
  assert.equal(shouldReportLoadFailure(-3, true), false)
  assert.equal(shouldReportLoadFailure(-105, false), false)
  assert.equal(shouldReportLoadFailure(-105, true), true)
  assert.equal(describeLoadFailure(-105, 'ERR_NAME_NOT_RESOLVED'), '无法解析这个域名')
  assert.equal(describeLoadFailure(-2, 'ERR_FAILED'), 'ERR_FAILED（-2）')
  assert.equal(describeLoadFailure(-2, ''), '加载失败（-2）')
})
