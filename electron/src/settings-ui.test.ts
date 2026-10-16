/**
 * Static guards for the settings page.
 *
 * The same class of bug the market page hit four times lives here too: nothing else in the repo sees
 * the interaction between this markup, its CSS and its script, and the window-level smoke cannot
 * either — `did-finish-load` fires happily for a page whose script throws before its first paint.
 *
 * The `.pocket[hidden]` rule below is the specific trap this section would fall into: the phone block
 * is a `display: grid`, and a UA `[hidden]` rule loses to that, so "no QR to show" would render as a
 * broken image in a 148px box instead of nothing at all.
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

test('the phone block hides completely when there is nothing to scan', () => {
  assert.match(page, /\.pocket\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/u)
})

test('every element the script looks up actually exists in the markup', () => {
  const ids = new Set([...markup.matchAll(/id="([A-Za-z0-9_-]+)"/gu)].map(match => match[1]))
  const looked = new Set([...script.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/gu)].map(match => match[1]))
  assert.ok(looked.size > 20, 'sanity: the script should look up a lot of elements')
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

test('phone-access controls go through the exposed API rather than editing the document', () => {
  // Everything funnels through one helper, so every answer is rendered the same way and the page
  // never guesses at the shell's state.
  assert.match(script, /pocketAction\(\{\s*kind:\s*'rotate'\s*\}\)/u)
  assert.match(script, /pocketAction\(\{\s*kind:\s*'setPassword'/u)
  assert.match(script, /pocketAction\(\{\s*kind:\s*'select'/u)
  assert.match(script, /const pocket = await api\.pocket\(action\)/u)
})

test('the form submits the two phone-access values the shell expects', () => {
  assert.match(script, /pocketEnabled:\s*pocketEnabledEl\.checked/u)
  assert.match(script, /pocketPort:\s*pocketPortEl\.value/u)
  assert.match(markup, /data-testid="pocket-port"/u)
  assert.match(markup, /data-testid="pocket-enabled"/u)
})

test('the public section warns every time, and the form cannot switch it on', () => {
  // The gate is the whole point of the public switch: DSH executes code for whoever reaches it.
  assert.match(page, /开启公网访问前|开启后，互联网上的任何人/u)
  assert.match(page, /window\.confirm\(/u)
  assert.match(page, /acceptedDisclaimer: true/u)
  // A form save must never carry the switch: only the confirmed button may open the door.
  const collect = /function collect\(\)[\s\S]*?\n    \}/u.exec(page)?.[0] ?? ''
  assert.notEqual(collect, '')
  assert.equal(collect.includes('pocketTunnelEnabled'), false, '表单不能直接打开公网访问')
  assert.match(collect, /pocketTunnelMode/u)
})

test('the public section can be closed and its password can be fixed', () => {
  assert.match(page, /kind: 'stopTunnel'/u)
  assert.match(page, /kind: 'rotatePublicPassword'/u)
  assert.match(page, /kind: 'setPublicPassword'/u)
  assert.match(page, /kind: 'setTunnelToken'/u)
  // The token is entered as a secret and must not be echoed back into the page.
  assert.match(page, /id="pocketTunnelToken" type="password"/u)
})

test('the phone app download is offered before anything else', () => {
  // The client has to be installed before the address means anything, so its QR is not hidden behind
  // "a listener is running".
  assert.match(page, /id="pocketAppQr"/u)
  assert.match(page, /id="pocketAppUrl"/u)
  const render = /function renderPocket\(pocket\)[\s\S]*?\n    \}/u.exec(page)?.[0] ?? ''
  assert.notEqual(render, '')
  assert.match(render, /pocketAppBox/u)
  assert.equal(render.includes('pocketBoxEl.hidden = pocket.url === undefined'), true)
})
