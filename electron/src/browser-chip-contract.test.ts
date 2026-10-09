/**
 * Reference-chip contract for the browser panel's element picker.
 *
 * The panel plugin (`src-tauri/resources/dsh-desktop-shell/client.js`) is plain ESM loaded by
 * DSH, so this test runner cannot execute it. What it *can* do is pin the contract it depends
 * on, because every piece of that contract lives in DSH itself and was read out of DSH's
 * bundles (documented in `docs/sidebar-browser-integration.md` §4.1):
 *
 * 1. `ui-input-trigger` exposes `ctx.inputTriggers.registerSource(source)`, and a source's
 *    `name` is the chip's serialization routing key.
 * 2. At submit, `ui-conversation`'s `sinkSerialized` calls
 *    `inputTriggers.serializeReference(source, ref, signal)` → the source's `codec.serialize`.
 *    A missing/failed codec **rejects the whole send**, so our serializer must never throw.
 * 3. The chip node is built from `{source, ref, label, appearance, clipboardText}`.
 * 4. The insertion is the scoped event `slash/input-insert-reference` with
 *    `{reference, span}`, where `span` must carry `draftRev` (the shell CAS-checks
 *    `span.draftRev !== this.rev`) — exactly what `InputActions.captureInsertion()` returns.
 * 5. Events dispatch through scopes, and ui-conversation registers its listener on the
 *    **session** scope, so the emit must happen on `sessions.scope(sessionId)`.
 *
 * This is a drift guard, not a behaviour test: it fails when someone removes an integration
 * point, and it cannot prove DSH still accepts the payload.
 *
 * Run: node --test src/browser-chip-contract.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const client = readFileSync(new URL('../../src-tauri/resources/dsh-desktop-shell/client.js', import.meta.url), 'utf8')

test('the panel registers an element reference source with a codec', () => {
  assert.match(client, /inputTriggers\.registerSource\(source\)/u)
  assert.match(client, /const ELEMENT_REFERENCE_SOURCE = '/u)
  assert.match(client, /codec:\s*\{/u)
  assert.match(client, /serialize:\s*\(ref\)/u)
  // A throw here would reject the user's send, so the codec answers a string in every path.
  assert.match(client, /element === undefined \? String\(ref\) : elementBlock\(element\)/u)
})

test('the insertion event carries the chip payload and a revision-checked span', () => {
  assert.match(client, /scope\.bail\('slash\/input-insert-reference'/u)
  assert.match(client, /reference: elementInsertion\(element\)/u)
  // `captureInsertion()` is the only span source that carries `draftRev`.
  assert.match(client, /inputActions\.captureInsertion\(\)/u)
  // The emit must target the session scope: a root-scope emit would not reach the listener.
  assert.match(client, /services\.sessions\.scope\(sessionId\)/u)
})

test('the chip payload uses exactly the node fields DSH reads', () => {
  const insertion = /function elementInsertion\(element\)\s*\{([\s\S]*?)\n    \}/u.exec(client)
  assert.ok(insertion !== null, 'elementInsertion is missing')
  const body = (insertion as RegExpExecArray)[1] as string
  for (const field of ['source:', 'ref:', 'label:', 'clipboardText:']) {
    assert.ok(body.includes(field), `chip payload has no ${field}`)
  }
  // `appearance` is deliberately omitted: an unknown icon kind would depend on DSH's icon set.
  assert.ok(!body.includes('appearance:'), 'chip payload should keep appearance undefined')
})

test('the @ element source answers with a promise', async () => {
  // DSH's controller is written as `source.candidates(...).then(...)`, and the type says
  // `candidates(...): Promise<readonly InputTriggerCandidate[]>`. A synchronous array throws a
  // TypeError *inside* `for (const source of roster)`, so the sources after ours are never fetched
  // either: DSH's own file and session candidates stop settling and the `@` menu shows skeletons
  // forever. That shipped, and the reproducers are the two assertions below.
  //
  // The object is lifted out of the real bundle and called, instead of matching the word `async`,
  // because "returns something awaitable" is the actual contract.
  const block = /\n {6}const source = \{(?<body>[\s\S]*?)\n {6}\};/u.exec(client)
  const body = block?.groups?.body
  assert.ok(body !== undefined, 'the element reference source must stay extractable')
  const build = new Function(
    'recentPicks', 'elementInsertion', 'decodeElementRef', 'elementBlock', 'ELEMENT_REFERENCE_SOURCE',
    `return {${body}}`,
  ) as (
    picks: Map<string, { preview: string; selector: string }>,
    insertion: unknown, decode: unknown, block: unknown, sourceName: string,
  ) => { name: string; trigger: string; candidates: () => unknown }
  const picks = new Map([['picked-1', { preview: '登录按钮', selector: '#login' }]])
  const source = build(picks, () => ({}), () => undefined, () => '', 'browser-element')
  assert.equal(source.trigger, '@')
  const pending = source.candidates()
  assert.equal(typeof (pending as { then?: unknown }).then, 'function', 'candidates must be awaitable')
  assert.deepEqual(await pending, [
    { name: '登录按钮', description: '#login', section: '页面元素', value: 'picked-1' },
  ])
})

test('the ref is self-contained so a persisted draft still serializes after a reload', () => {
  assert.match(client, /function encodeElementRef\(element\)/u)
  assert.match(client, /function decodeElementRef\(ref\)/u)
  // A ref that only pointed into a live Map would break every reloaded chip (and reject sends).
  assert.match(client, /JSON\.stringify\(\{/u)
  assert.match(client, /function recentPicks|const recentPicks/u)
})

test('the pane tab receives the session id it needs to resolve that scope', () => {
  assert.match(client, /inject: \(sessionId\) => \(\{ sessionId \}\)/u)
})

test('a chip failure degrades instead of losing the pick', () => {
  // chip → plain text → copy to the clipboard (and say so).
  assert.match(client, /const chip = await resolveChipInsert\(/u)
  assert.match(client, /if \(insertIntoComposer\(elementBlock\(element\)\)\)/u)
  assert.match(client, /await copyToClipboard\(elementBlock\(element\)\)/u)
  assert.match(client, /t\('pickedNoInput'\)/u)
})

test('a successful pick shows nothing in the panel (the chip is the feedback)', () => {
  // The old panel echoed the pick back with a "picked elements" bar; OneCode does not, and the
  // user asked for it gone. Only the failure path may render a notice.
  assert.ok(!client.includes('dsb-picked'), 'the picked-elements bar markup is still present')
  assert.ok(!client.includes('dsb-chip'), 'the picked chip styles are still present')
  assert.match(client, /setPickNotice\(''\);/u)
})
