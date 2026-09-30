/**
 * Settings-file defaulting tests.
 *
 * The DSH panel's client half defaults a missing `service.port` to the release port
 * (41729). A debug-channel user who saved anything on that page therefore dragged the
 * debug app onto the shipping app's port. The shell now writes its own channel default
 * first — but only ever when the user has not chosen a port.
 *
 * Run: node --test src/settings.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeSettingsInput, withServicePort } from '../src/settings-shape.ts'

test('a missing port gets the channel default', () => {
  const updated = withServicePort({ revision: 1, closeBehavior: 'minimizeToTray' }, 41731)
  assert.deepEqual(updated, {
    revision: 1,
    closeBehavior: 'minimizeToTray',
    service: { port: 41731 },
  })
})

test('an explicit port is a user decision and is never rewritten', () => {
  // Including the release port: if someone deliberately pointed the debug build at 41729,
  // the shell must not silently move it back.
  assert.equal(withServicePort({ service: { port: 41729 } }, 41731), undefined)
  assert.equal(withServicePort({ service: { port: 42500 } }, 41731), undefined)
})

test('other settings survive the rewrite', () => {
  const updated = withServicePort({
    version: '0.0.0',
    revision: 3,
    closeBehavior: 'exit',
    proxy: { enabled: true, httpsProxy: 'http://127.0.0.1:7890' },
    service: { note: 'kept' },
    updates: { checkDesktopOnStart: false },
  }, 41731)
  assert.deepEqual(updated, {
    version: '0.0.0',
    revision: 3,
    closeBehavior: 'exit',
    proxy: { enabled: true, httpsProxy: 'http://127.0.0.1:7890' },
    service: { note: 'kept', port: 41731 },
    updates: { checkDesktopOnStart: false },
  })
})

test('a file that is not an object is left alone', () => {
  assert.equal(withServicePort(null, 41731), undefined)
  assert.equal(withServicePort('nonsense', 41731), undefined)
  assert.equal(withServicePort([1, 2], 41731)?.service, undefined)
})

test('a settings submission merges into the document and preserves unknown keys', () => {
  const raw = { closeBehavior: 'exit', portal: { keep: true }, proxy: { enabled: false, httpProxy: 'http://old:1' } }
  const result = mergeSettingsInput(raw, { servicePort: 42000, proxyEnabled: true, httpProxy: ' http://new:2 ' }, 41729)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.document.portal, { keep: true })
  assert.deepEqual(result.document.service, { port: 42000 })
  assert.deepEqual(result.document.proxy, { enabled: true, httpProxy: 'http://new:2' })
  assert.deepEqual([...result.changed].sort(), ['proxy.enabled', 'proxy.httpProxy', 'service.port'])
})

test('a missing port falls back to the channel default, not to the shipping port', () => {
  const result = mergeSettingsInput({}, {}, 41731)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.document.service, { port: 41731 })
})

test('an out-of-range port is rejected instead of written', () => {
  for (const port of [80, 0, 70000, 1.5]) {
    const result = mergeSettingsInput({}, { servicePort: port }, 41729)
    assert.equal(result.ok, false, `port ${String(port)}`)
  }
})

test('an unknown close behaviour is rejected', () => {
  const result = mergeSettingsInput({}, { closeBehavior: 'hide' as 'exit' }, 41729)
  assert.equal(result.ok, false)
})

test('proxy URLs survive being switched off', () => {
  const result = mergeSettingsInput({ proxy: { enabled: true, httpProxy: 'http://p:1' } }, { proxyEnabled: false }, 41729)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.document.proxy, { enabled: false, httpProxy: 'http://p:1' })
})

test('nothing changed means nothing is reported as changed', () => {
  const raw = { service: { port: 41729 }, closeBehavior: 'exit', updates: { checkDesktopOnStart: false } }
  const result = mergeSettingsInput(raw, { servicePort: 41729, closeBehavior: 'exit', checkDesktopOnStart: false }, 41729)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.changed, [])
})

test('the browser switch is written as a nested section and only when it changes', () => {
  const base = { service: { port: 41729 } }

  // Turning it off is a change, and it is reported.
  const off = mergeSettingsInput({ ...base, browser: { enabled: true } }, { browserEnabled: false }, 41729)
  assert.equal(off.ok, true)
  if (!off.ok) return
  assert.deepEqual(off.document.browser, { enabled: false })
  assert.deepEqual(off.changed, ['browser.enabled'])

  // An absent field means "leave it", and an unchanged one is not reported.
  const untouched = mergeSettingsInput({ ...base, browser: { enabled: false } }, {}, 41729)
  assert.equal(untouched.ok, true)
  if (!untouched.ok) return
  assert.deepEqual(untouched.document.browser, { enabled: false })
  assert.deepEqual(untouched.changed, [])

  // A document that never had the section gains it without losing anything else, and
  // "on" needs no write at all because both readers default to on.
  const freshOff = mergeSettingsInput({ ...base, closeBehavior: 'exit' }, { browserEnabled: false }, 41729)
  assert.equal(freshOff.ok, true)
  if (!freshOff.ok) return
  assert.deepEqual(freshOff.document.browser, { enabled: false })
  assert.equal(freshOff.document.closeBehavior, 'exit')

  const freshOn = mergeSettingsInput({ ...base }, { browserEnabled: true }, 41729)
  assert.equal(freshOn.ok, true)
  if (!freshOn.ok) return
  const browser = freshOn.document.browser as Record<string, unknown>
  assert.notEqual(browser.enabled, false)
  assert.deepEqual(freshOn.changed, [])
})

test('an empty submission never invents the off state', () => {
  const result = mergeSettingsInput({}, {}, 41729)
  assert.equal(result.ok, true)
  if (!result.ok) return
  // An absent field means "leave it": the merge must not write `enabled: false`, because the
  // plugin's `withDefaults` is what materialises the default (`enabled !== false`).
  const browser = result.document.browser as Record<string, unknown>
  assert.notEqual(browser.enabled, false)
})
