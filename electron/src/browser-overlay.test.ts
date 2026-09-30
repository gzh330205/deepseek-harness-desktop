/**
 * The "the agent is driving" veil: when it appears, what it says, and how a takeover is seen.
 *
 * The visual half (a transparent native view over the browser) is verified by hand — see
 * `docs/sidebar-browser-integration.md` §6.4 — but the rules below are what decide whether the
 * user sees anything at all, so they are pinned here.
 *
 * Run: node --test src/browser-overlay.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MIN_VEIL_MS,
  OVERLAY_TAKEOVER_MARKER,
  VEIL_LABEL_ELEMENT_ID,
  VEIL_LINGER_MS,
  VEIL_SILENT_TOOLS,
  escapeHtml,
  isTakeoverMessage,
  overlayDocument,
  overlayUrl,
  shouldShowAgentVeil,
  veilLabel,
} from '../src/browser-overlay.ts'
import { BROWSER_TOOLS } from '../src/browser-tools.ts'

test('page-touching tools raise the veil, metadata lookups do not', () => {
  for (const tool of ['navigate', 'snapshot', 'find', 'click', 'type', 'keys', 'scroll', 'wait', 'select', 'screenshot', 'history']) {
    assert.equal(shouldShowAgentVeil(tool), true, `${tool} should raise the veil`)
  }
  for (const tool of VEIL_SILENT_TOOLS) {
    assert.equal(shouldShowAgentVeil(tool), false, `${tool} should stay silent`)
  }
  // The silent list must be a deliberate subset of the real catalog: a typo would silently
  // stop the veil from ever appearing for a tool that does change the page.
  const names = BROWSER_TOOLS.map((tool) => tool.name)
  for (const tool of VEIL_SILENT_TOOLS) assert.ok(names.includes(tool), `${tool} is not a real tool name`)
  const veilTools = names.filter((name) => shouldShowAgentVeil(name))
  assert.ok(veilTools.length >= 8, `expected most tools to raise the veil, got ${veilTools.join(', ')}`)
})

test('the veil says what the agent is doing', () => {
  assert.match(veilLabel('click'), /点击/u)
  assert.match(veilLabel('click'), /click/u)
  assert.match(veilLabel('navigate'), /打开网页/u)
  // An unknown tool still gets a usable label instead of "undefined".
  assert.match(veilLabel('mystery'), /正在操作页面/u)
  assert.match(veilLabel('mystery'), /mystery/u)
})

test('the veil document shows the label, the dot and the takeover hint', () => {
  const html = overlayDocument(veilLabel('snapshot'))
  assert.match(html, /助手正在操作 · 正在读取页面结构（snapshot）/u)
  assert.match(html, /点击页面任意位置即可接管/u)
  assert.match(html, /rgba\(15,17,20,0\.22\)/u, 'the veil must be a *light* dim: the page stays readable')
  // The text must not sit in the middle of the page — that is exactly where the user is looking.
  assert.match(html, /justify-content:flex-start/u)
  assert.equal(html.includes('justify-content:center'), false, 'the veil text must not be centred')
  // The click listener is what makes a takeover possible at all.
  assert.ok(html.includes(OVERLAY_TAKEOVER_MARKER))
  assert.match(html, /pointerdown/u)
  assert.match(html, /capture:true/u)
})

test('the label is rewritten in place, so a live veil never reloads', () => {
  const html = overlayDocument('x')
  // The pill text is its own element and the shell can rewrite it without reloading the document
  // (a reload is a visible flash, and it used to happen once per tool call).
  assert.match(html, new RegExp(`id="${VEIL_LABEL_ELEMENT_ID}"`, 'u'))
  assert.match(html, /window\.__dshVeilLabel=function\(t\)/u)
  // Both the initial document and the updater use the same prefix.
  const prefixCount = html.split('助手正在操作 · ').length - 1
  assert.equal(prefixCount, 2, 'the pill prefix must appear once in the markup and once in the updater')
})

test('the linger that covers an unknown turn status is sensible', () => {
  // Only used when DSH's session status is unavailable: long enough to cover a think-then-call gap
  // (otherwise a turn blinks), short enough not to outlive the turn badly.
  assert.ok(VEIL_LINGER_MS >= 2000 && VEIL_LINGER_MS <= 30000, `VEIL_LINGER_MS=${String(VEIL_LINGER_MS)} is not sensible`)
})

test('a labelled or hostile string cannot break out of the document', () => {
  const html = overlayDocument('<img src=x onerror=alert(1)>')
  assert.equal(html.includes('<img'), false)
  assert.match(html, /&lt;img/u)
  assert.equal(escapeHtml(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;')
})

test('the veil is a data URL, so nothing has to be shipped or allowed', () => {
  const url = overlayUrl('x')
  assert.ok(url.startsWith('data:text/html;charset=utf-8,'))
  assert.equal(decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length)).includes('<!doctype html>'), true)
})

test('only the takeover marker counts as a takeover', () => {
  assert.equal(isTakeoverMessage(OVERLAY_TAKEOVER_MARKER), true)
  assert.equal(isTakeoverMessage(`%c${OVERLAY_TAKEOVER_MARKER} color:red`), true)
  assert.equal(isTakeoverMessage('some page log'), false)
  assert.equal(isTakeoverMessage(undefined), false)
  assert.equal(isTakeoverMessage(42), false)
})

test('the veil never flashes for a shorter time than a blink', () => {
  assert.ok(MIN_VEIL_MS >= 300 && MIN_VEIL_MS <= 2000, `MIN_VEIL_MS=${String(MIN_VEIL_MS)} is not a sensible blink guard`)
})
