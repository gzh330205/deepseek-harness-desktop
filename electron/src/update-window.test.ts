/**
 * Update-window drift guards.
 *
 * The window is a plain document plus a preload API, so the test runner cannot execute it. What it
 * can do is pin the two things users reported directly:
 *
 * 1. "稍后" did nothing. The document did post `dismiss`; the shell reset the state and republished
 *    the same content to the very same open window, so the button looked dead. The window must close.
 * 2. Starting an installation showed nothing. The silent NSIS run reports no progress and the app
 *    quits, so the phase before the handoff has to say what is happening, and the shell has to keep
 *    the window (and a system notification) up long enough to be seen.
 *
 * This is a drift guard, not a behaviour test: it fails when an integration point disappears, and it
 * cannot prove the window still renders correctly.
 *
 * Run: node --test src/update-window.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const document = readFileSync(new URL('./update/index.html', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

test('the installing phase is rendered instead of a frozen window', () => {
  // A label for the phase, an animated bar (NSIS gives no percentage), and no button left clickable
  // once the installer owns the job.
  assert.match(document, /installing: '正在安装…'/u)
  assert.match(document, /installing = state\.phase === 'installing'/u)
  assert.match(document, /classList\.toggle\('busy', installing\)/u)
  assert.match(document, /\.bar\.busy > i \{[^}]*animation/u)
  assert.match(document, /primaryEl\.disabled = busy \|\| installing/u)
  assert.match(document, /laterEl\.disabled = busy \|\| installing/u)
})

test('the two buttons still mean dismiss and the phase action', () => {
  assert.match(document, /laterEl\.addEventListener\('click',[\s\S]{0,120}?'dismiss'/u)
  assert.match(document, /primaryEl\.addEventListener\('click',[\s\S]{0,140}?actionFor\(state\.phase\)/u)
  assert.match(document, /if \(phase === 'available'\) return 'download'/u)
  assert.match(document, /if \(phase === 'ready'\) return 'install'/u)
})

test('the shell closes the window when the user defers', () => {
  // The original bug: `dismiss()` reset state and published it back to the same window, so the
  // button appeared to do nothing.
  const dismiss = /else \{\s*\/\/ "稍后"[\s\S]{0,500}?updateWindow\?\.close\(\)/u.exec(shell)
  assert.ok(dismiss !== null, 'deferring must close the update window, not just republish state')
})

test('starting an installation announces itself before quitting', () => {
  const onInstall = /onInstall: \(installer\) => \{[\s\S]*?\n {4}\},/u.exec(shell)
  assert.ok(onInstall !== null, 'the install handoff is missing')
  const body = (onInstall as RegExpExecArray)[0] as string
  assert.match(body, /showNotification\(/u, 'a notification survives the process and says what is happening')
  assert.match(body, /INSTALL_HANDOFF_MS/u, 'the window needs a moment to render the installing phase')
})
