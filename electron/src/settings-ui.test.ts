/**
 * Static guards for the settings page.
 *
 * The same class of bug the market page hit four times lives here too: nothing else in the repo sees
 * the interaction between this markup, its CSS and its script, and the window-level smoke cannot
 * either — `did-finish-load` fires happily for a page whose script throws before its first paint.
 *
 * Phone access used to live here; it moved to its own window (`pocket-ui`, guarded by
 * `pocket-ui.test.ts`) so one setting never grows two screens. This file also pins that the *settings*
 * form can no longer carry phone-access values: a save from here must not silently reset the gateway.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(fileURLToPath(new URL('./settings-ui/index.html', import.meta.url)), 'utf8')
const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] ?? ''
const markup = page.slice(0, page.indexOf('<script>'))

test('the page carries exactly one style block, and it is in the head', () => {
  const styles = page.match(/<style\b/gu) ?? []
  assert.equal(styles.length, 1, 'a second style block can silently override the layout')
  assert.ok(page.indexOf('<style') < page.indexOf('</head>'), 'styles belong in the head')
})

test('every element the script looks up actually exists in the markup', () => {
  const ids = new Set([...markup.matchAll(/id="([A-Za-z0-9_-]+)"/gu)].map(match => match[1]))
  const looked = new Set([...script.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/gu)].map(match => match[1]))
  // A floor on the count so a botched edit that deletes the lookups cannot pass this test trivially.
  assert.ok(looked.size > 12, `sanity: the script should look up a lot of elements（实际 ${looked.size}）`)
  const missing = [...looked].filter(id => !ids.has(id))
  assert.deepEqual(missing, [], `the script looks up ids that do not exist: ${missing.join(', ')}`)
})

test('the QR image is the only thing that may come from data:, and the page fetches nothing itself', () => {
  // The code is rendered in the main process and arrives as a PNG data URL; `img-src data:` is what
  // lets the page show it without ever accepting markup.
  assert.match(page, /Content-Security-Policy[^>]*img-src 'self' data:/u)
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/u)
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|innerHTML/u, 'phone access goes through the shell API')
})

test('phone access is gone from this page, and the form cannot clobber it', () => {
  // One setting, one screen: the phone-access window owns these values now. If this form still
  // submitted them, saving an unrelated setting here would quietly reset the gateway.
  assert.match(page, /手机访问已移到/u)
  assert.doesNotMatch(script, /pocketEnabled:|pocketPort:|pocketTunnel/u)
  assert.doesNotMatch(script, /api\.pocket\(/u, '设置页不再直接操作手机访问')
})
