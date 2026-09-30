/**
 * Element picking: the injected script and the two transports it uses.
 *
 * The pick is the one place where page content flows *into* the shell, so the interesting
 * properties are the ones that keep a page from forging it (the nonce) and the ones that keep
 * a pick from navigating the user's tab.
 *
 * These tests exist because the first implementation shipped a bug that only showed up on
 * screen: the injected literals were double-encoded (`"\"dsh-pick:\""`), so both transports
 * failed and the resulting malformed URL was loaded by the window-open handler as an ordinary
 * `https:` URL — the user's tab navigated to a 404. The assertions below are written against
 * the *values the page ends up with*, not against the encoding helper's own output.
 *
 * Run: node --test src/browser-picker.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  PICKER_ALREADY_ACTIVE,
  PICKER_HTML_CAP,
  PICK_MARKER,
  PICK_OFF_MARKER,
  asPickedElement,
  buildPickerScript,
  describePickedElement,
  parseConsolePick,
  pickSignature,
} from '../src/browser-picker.ts'

const NONCE = 'a'.repeat(32)
const ELEMENT = { selector: '#login', outerHTML: '<button id="login">登录</button>', url: 'https://example.com/', preview: '#login' }

/** The literal a `var name = …;` line assigns, as the page would see it at runtime. */
function literalOf(script: string, name: string): unknown {
  const match = new RegExp(`var ${name} = (.*);`, 'u').exec(script)
  assert.ok(match !== null, `injected script has no ${name}`)
  return JSON.parse((match as RegExpExecArray)[1] as string)
}

test('the injected picker is valid JavaScript', () => {
  const script = buildPickerScript(NONCE)
  assert.doesNotThrow(() => { new Function(script) })
})

test('the page receives the nonce and markers as plain strings, not quoted ones', () => {
  const script = buildPickerScript(NONCE)
  assert.equal(literalOf(script, 'nonce'), NONCE)
  assert.equal(literalOf(script, 'marker'), PICK_MARKER)
  assert.equal(literalOf(script, 'offMarker'), PICK_OFF_MARKER)
  assert.equal(literalOf(script, 'cap'), PICKER_HTML_CAP)
})

test('a hostile nonce cannot break out of its string literal', () => {
  const hostile = `'; window.pwned = 1; //`
  const script = buildPickerScript(hostile)
  assert.doesNotThrow(() => { new Function(script) })
  assert.equal(literalOf(script, 'nonce'), hostile)
})

test('the picker never opens a window and never needs a preload bridge', () => {
  const script = buildPickerScript(NONCE)
  // `window.open` is what turned a malformed marker into a real navigation of the user's tab.
  assert.ok(!script.includes('window.open'))
  // OneCode forwards through `window.mcodeBridge`; we have no preload on browser views.
  assert.ok(!script.includes('mcodeBridge'))
})

test('the picker resolves a promise, so the shell gets the pick without a preload', () => {
  const script = buildPickerScript(NONCE)
  assert.match(script, /return new Promise\(/u)
  // Esc settles it with null rather than leaving the shell waiting forever.
  assert.match(script, /if \(settle\) \{ var done = settle; settle = null; done\(null\); \}/u)
  // Re-arming while armed returns a sentinel, not null: the shell must not read a no-op
  // arming as "the user pressed Esc" and un-arm itself.
  assert.ok(script.includes(`if (window.__dshPickerActive) return ${JSON.stringify(PICKER_ALREADY_ACTIVE)};`))
  assert.ok(!script.includes('if (window.__dshPickerActive) return null;'))
})

test('both transports carry the same pick, and only with the right nonce', () => {
  const payload = JSON.stringify({ nonce: NONCE, ...ELEMENT })
  assert.deepEqual(parseConsolePick(`${PICK_MARKER}${payload}`, NONCE), ELEMENT)
  assert.deepEqual(asPickedElement({ nonce: NONCE, ...ELEMENT }, NONCE), ELEMENT)
})

test('anything without the marker or the nonce is ignored', () => {
  const payload = JSON.stringify({ nonce: NONCE, ...ELEMENT })
  assert.equal(parseConsolePick(payload, NONCE), undefined)
  assert.equal(parseConsolePick(`${PICK_MARKER}${payload}`, 'b'.repeat(32)), undefined)
  assert.equal(parseConsolePick(`${PICK_MARKER}not json`, NONCE), undefined)
  assert.equal(asPickedElement({ nonce: NONCE, url: 'x' }, NONCE), undefined)
  assert.equal(asPickedElement(null, NONCE), undefined)
  assert.equal(asPickedElement({ nonce: 'b'.repeat(32), ...ELEMENT }, NONCE), undefined)
})

test('the duplicate a first pick produces over both transports shares one signature', () => {
  const fromPromise = asPickedElement({ nonce: NONCE, ...ELEMENT }, NONCE)
  const fromConsole = parseConsolePick(`${PICK_MARKER}${JSON.stringify({ nonce: NONCE, ...ELEMENT })}`, NONCE)
  assert.notEqual(fromPromise, undefined)
  assert.notEqual(fromConsole, undefined)
  assert.equal(pickSignature(fromPromise as typeof ELEMENT), pickSignature(fromConsole as typeof ELEMENT))
  // A different element on the same page stays a distinct pick (multi-pick still works).
  assert.notEqual(
    pickSignature(fromPromise as typeof ELEMENT),
    pickSignature({ ...ELEMENT, selector: '#other' }),
  )
})

test('a pick renders as text a conversation can carry', () => {
  const described = describePickedElement(ELEMENT)
  assert.match(described, /选择器: #login/u)
  assert.match(described, /https:\/\/example\.com\//u)
  assert.match(described, /<button id="login">登录<\/button>/u)
})
