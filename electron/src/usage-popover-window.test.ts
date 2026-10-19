/**
 * Tests for the 用量 button's hover card.
 *
 * Two halves, because the feature has two failure modes that no single test would catch:
 *
 * 1. **Placement is pure arithmetic** — the part that breaks on a second monitor, a maximised window, a
 *    taskbar, or a window dragged past the right edge. It is exported as a function precisely so these
 *    cases can be exercised without a real display (there is no way to unit-test `screen`).
 * 2. **The page and its bridge are only strings** — `did-finish-load` fires happily for a page whose
 *    preload never loaded or whose CSP blocks its own inline script. The static guards pin the page ids,
 *    the CSP, the absence of network/innerHTML, and the window flags that keep the card from stealing
 *    the mouse or appearing in the taskbar.
 *
 * Run: node --test src/usage-popover-window.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { USAGE_POPOVER_HEIGHT, USAGE_POPOVER_WIDTH } from '../src/constants.ts'
import {
  isUsagePopoverUrl,
  parseUsagePopoverAnchor,
  toUsagePopoverState,
  usagePopoverPosition,
} from '../src/usage-popover-window.ts'

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const secondMonitor = { x: 1920, y: 0, width: 2560, height: 1400 }
const content = { x: 100, y: 50, width: 1280, height: 860 }

test('the card hangs under the button, aligned with its left edge', () => {
  // Anchor coordinates are relative to the title bar view, so the content origin must be added.
  const position = usagePopoverPosition({
    anchor: { x: 300, y: 0, height: 36 },
    contentBounds: content,
    workArea: primary,
  })
  assert.deepEqual(position, { x: 400, y: 86 })
})

test('a button at the top-left corner opens the card at the window origin', () => {
  assert.deepEqual(usagePopoverPosition({
    anchor: { x: 0, y: 0, height: 36 },
    contentBounds: { x: 0, y: 0, width: 1280, height: 860 },
    workArea: primary,
  }), { x: 0, y: 36 })
})

test('a button near the right edge pulls the card back inside the work area', () => {
  const position = usagePopoverPosition({
    anchor: { x: 1900, y: 0, height: 36 },
    contentBounds: { x: 0, y: 0, width: 1920, height: 860 },
    workArea: primary,
  })
  assert.equal(position.x, primary.width - USAGE_POPOVER_WIDTH)
})

test('the clamp uses the display the window is on, not the primary display', () => {
  const position = usagePopoverPosition({
    anchor: { x: 2500, y: 0, height: 36 },
    contentBounds: { x: 1920, y: 0, width: 2560, height: 1400 },
    workArea: secondMonitor,
  })
  assert.deepEqual(position, {
    x: secondMonitor.x + secondMonitor.width - USAGE_POPOVER_WIDTH,
    y: 36,
  })
})

test('a window near the bottom edge lifts the card above the taskbar', () => {
  const position = usagePopoverPosition({
    anchor: { x: 40, y: 0, height: 36 },
    contentBounds: { x: 0, y: 900, width: 1280, height: 300 },
    workArea: primary,
  })
  assert.deepEqual(position, {
    x: 40,
    y: primary.height - USAGE_POPOVER_HEIGHT,
  })
})

test('negative window coordinates are clamped onto the work area', () => {
  const position = usagePopoverPosition({
    anchor: { x: 0, y: 0, height: 36 },
    contentBounds: { x: -100, y: -40, width: 1280, height: 860 },
    workArea: primary,
  })
  assert.deepEqual(position, { x: 0, y: 0 })
})

test('the size is a parameter, so the clamp is not tied to this one window', () => {
  const position = usagePopoverPosition({
    anchor: { x: 1900, y: 0, height: 36 },
    contentBounds: { x: 0, y: 900, width: 1920, height: 300 },
    workArea: primary,
    size: { width: 400, height: 200 },
  })
  assert.deepEqual(position, { x: 1520, y: 840 })
})

test('an anchor with a non-finite coordinate is rejected instead of moving a window off-screen', () => {
  assert.deepEqual(parseUsagePopoverAnchor({ x: 10, y: 0, height: 36 }), { x: 10, y: 0, height: 36 })
  for (const rejected of [
    null,
    undefined,
    'usage',
    { x: 10, y: 0 },
    { x: Number.NaN, y: 0, height: 36 },
    { x: 10, y: Number.POSITIVE_INFINITY, height: 36 },
    { x: 10, y: 0, height: 0 },
    { x: 10, y: 0, height: -1 },
  ]) {
    assert.equal(parseUsagePopoverAnchor(rejected), undefined, `应拒绝 ${JSON.stringify(rejected)}`)
  }
})

test('only the popover document URL may call the read bridge', () => {
  assert.equal(isUsagePopoverUrl('file:///D:/app/dist/usage-popover/index.html'), true)
  assert.equal(isUsagePopoverUrl('file:///D:/app/dist/usage-popover/index.html?x=1'), true)
  assert.equal(isUsagePopoverUrl('file:///D:/app/dist/usage/index.html'), false)
  // The product page is a different origin on purpose: its preload has no popover bridge.
  assert.equal(isUsagePopoverUrl('http://127.0.0.1:41729/usage-popover/index.html'), false)
  assert.equal(isUsagePopoverUrl('not a url'), false)
})

test('the state keeps the three numbers and drops everything else', () => {
  // A full snapshot carries channels/logs/settings too; only the glance is forwarded.
  const snapshot = {
    loggedIn: true,
    needsLogin: false,
    fetchedAt: 1_700_000_000_000,
    user: '张三',
    tokens: { h5: 12_345, today: 2_000_000, week: 300_000_000 },
    channels: [{ channel: 'secret' }],
  }
  const state = toUsagePopoverState(snapshot)
  assert.deepEqual(state, {
    loggedIn: true,
    needsLogin: false,
    fetchedAt: 1_700_000_000_000,
    user: '张三',
    tokens: { h5: 12_345, today: 2_000_000, week: 300_000_000 },
  })
})

test('missing, null and non-numeric numbers are all rendered as no value', () => {
  const state = toUsagePopoverState({
    loggedIn: false,
    needsLogin: true,
    error: '尚未登录。',
    tokens: { h5: null, week: Number.NaN },
  })
  assert.deepEqual(state.tokens, { h5: null, today: null, week: null })
  assert.equal(state.needsLogin, true)
  assert.equal(state.error, '尚未登录。')
  // No fetchedAt: the page must not invent a "更新于" line.
  assert.equal(state.fetchedAt, undefined)
})

/* ------------------------- static guards ------------------------- */

const page = readFileSync(fileURLToPath(new URL('./usage-popover/index.html', import.meta.url)), 'utf8')
const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] ?? ''
const markup = page.slice(0, page.indexOf('<script>'))
const source = readFileSync(fileURLToPath(new URL('./usage-popover-window.ts', import.meta.url)), 'utf8')
const titleBar = readFileSync(fileURLToPath(new URL('./titlebar/index.html', import.meta.url)), 'utf8')
const preload = readFileSync(fileURLToPath(new URL('./preload.ts', import.meta.url)), 'utf8')

test('the page has one style block and a CSP that permits no network', () => {
  assert.equal((page.match(/<style\b/gu) ?? []).length, 1, 'a second style block would silently override the layout')
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/u)
  assert.match(page, /Content-Security-Policy[^>]*img-src 'self' data:/u)
  assert.match(page, /Content-Security-Policy[^>]*style-src 'unsafe-inline'/u)
  assert.match(page, /Content-Security-Policy[^>]*script-src 'unsafe-inline'/u)
})

test('the page never fetches, writes markup or loads an external resource', () => {
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|innerHTML|WebSocket/u, '卡片只能通过桌面壳桥拿数据')
  assert.doesNotMatch(page, /<link\b/iu)
  assert.doesNotMatch(page, /<script[^>]*\bsrc=/iu)
  assert.doesNotMatch(page, /@import/iu)
  assert.doesNotMatch(page, /\bsrc="https?:/iu)
})

test('the card shows the three periods the user asked for, with a week-referenced bar each', () => {
  const periods: ReadonlyArray<readonly [string, string, string, string]> = [
    ['metricH5', '近 5 小时', 'pctH5', 'barH5'],
    ['metricToday', '今日', 'pctToday', 'barToday'],
    ['metricWeek', '本周', 'pctWeek', 'barWeek'],
  ]
  for (const [id, label, pct, bar] of periods) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'))
    assert.match(markup, new RegExp(`id="${pct}"`, 'u'))
    assert.match(markup, new RegExp(`id="${bar}"`, 'u'))
    assert.match(markup, new RegExp(label.replace(/ /gu, '\\s*'), 'u'))
  }
  assert.match(script, /tokens\[metric\.key\]/u)
  assert.match(script, /fmtTokens\(/u)
  // The bar and percentage share one reference (the week), the same as the usage window's cards.
  assert.match(script, /tokens\.week/u)
  assert.match(script, /style\.width/u)
  // The units the usage window uses must stay in step here.
  assert.match(script, /'亿'/u)
  assert.match(script, /'万'/u)
  assert.match(script, /'M'/u)
  assert.match(script, /'K'/u)
  assert.match(markup, /id="updatedAt"/u)
  assert.match(script, /更新于 /u)
})

test('the page only speaks through __DSH_USAGE_POPOVER__, and only its two methods', () => {
  assert.match(script, /window\.__DSH_USAGE_POPOVER__/u)
  const bridges = new Set([...script.matchAll(/window\.__DSH_([A-Z_]+)__/gu)].map(match => match[1]))
  assert.deepEqual([...bridges], ['USAGE_POPOVER'], '这张卡片只该用 __DSH_USAGE_POPOVER__ 桥')
  const used = new Set([...script.matchAll(/api\.([A-Za-z]+)\(/gu)].map(match => match[1]))
  assert.deepEqual([...used].sort(), ['get', 'onState'], '方法名必须与 preload 契约一致')
  // The login state has one instruction the user can act on.
  assert.match(script, /未登录 · 点击打开用量面板/u)
  // Without the bridge the card explains itself instead of painting a blank strip.
  assert.match(markup, /id="apiMissing"/u)
  assert.match(script, /if \(!api\)/u)
})

test('the window flags keep the card out of the taskbar and away from the mouse', () => {
  // Not testable through Electron without a display; pinned here because every one of these flags is
  // what stops a glance from becoming a window that steals focus.
  assert.match(source, /frame: false/u)
  assert.match(source, /resizable: false/u)
  assert.match(source, /skipTaskbar: true/u)
  assert.match(source, /alwaysOnTop: true/u)
  assert.match(source, /focusable: false/u)
  assert.match(source, /show: false/u)
  assert.match(source, /hasShadow: true/u)
  assert.match(source, /setAlwaysOnTop\(true, 'pop-up-menu'\)/u)
  assert.match(source, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/u)
  assert.match(source, /showInactive\(\)/u)
  assert.match(source, /USAGE_POPOVER_WIDTH/u)
  assert.match(source, /USAGE_POPOVER_HEIGHT/u)
  assert.match(source, /USAGE_POPOVER_PAGE/u)
})

test('the title bar reports hover with a 180 ms leave delay, and the preload exposes it', () => {
  assert.match(titleBar, /hoverUsage/u)
  assert.match(titleBar, /mouseenter/u)
  assert.match(titleBar, /mouseleave/u)
  assert.match(titleBar, /180/u)
  // Clicking still opens the menu, and the card is taken down first.
  assert.match(titleBar, /name === 'usage' && typeof api\.hoverUsage === 'function'/u)
  assert.match(preload, /hoverUsage/u)
  assert.match(preload, /__DSH_USAGE_POPOVER__/u)
  assert.match(preload, /USAGE_POPOVER_PAGE/u)
})
