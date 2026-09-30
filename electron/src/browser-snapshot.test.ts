/**
 * The vendored page-injection scripts: they are strings, so a typo or an unescaped selector
 * would only show up as a broken browser tool at runtime. Two things are worth pinning:
 * every script is syntactically valid JavaScript, and a model-supplied selector/text cannot
 * break out of the JSON slot (the property the vendored file relies on).
 *
 * Run: node --test src/browser-snapshot.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SNAPSHOT_DISPLAY_CAP,
  SNAPSHOT_HTML_CAP,
  SNAPSHOT_INTERACTIVE_CAP,
  SNAPSHOT_SCRIPT,
  SNAPSHOT_TEXT_CAP,
  buildClickScript,
  buildElementCenterScript,
  buildFindScript,
  buildScrollScript,
  buildSelectScript,
  buildTypeScript,
  buildWaitScript,
} from '../src/browser-snapshot.ts'

/** Compiled as a function body: a syntax error throws here rather than in the page. */
function compiles(source: string): void {
  // eslint-disable-next-line no-new-func -- the script is the thing under test.
  new Function(source)
}

test('every vendored script is valid JavaScript after its slots are filled', () => {
  // Only the snapshot script is complete on its own; the rest carry `%…_JSON%` slots.
  compiles(SNAPSHOT_SCRIPT)
  compiles(buildClickScript('#a'))
  compiles(buildElementCenterScript('#a'))
  compiles(buildTypeScript('#a', 'x'))
  compiles(buildScrollScript({ direction: 'down', pages: 1 }))
  compiles(buildWaitScript({ text: 'x' }))
  compiles(buildSelectScript('#a', 'b'))
  compiles(buildFindScript({ selector: '#a' }))
})

test('hostile selectors and text stay inside their JSON slot', () => {
  const hostile = `'; console.log("pwned"); //`
  const quotes = `he said "hi" \\ and 'bye' \n </script>`
  for (const selector of [hostile, quotes, `"` + `'` + '`']) {
    compiles(buildClickScript(selector))
    compiles(buildElementCenterScript(selector))
    compiles(buildTypeScript(selector, quotes))
    compiles(buildSelectScript(selector, quotes))
    compiles(buildFindScript({ selector, text: quotes, attributes: [quotes] }))
  }
  // The slot is JSON.parse'd in-page, so the value must survive a round trip unchanged —
  // that is what makes a model-supplied selector or text unable to inject source.
  const injected = `'; alert(1); //`
  const script = buildTypeScript('#x', injected)
  assert.ok(script.includes(JSON.stringify(JSON.stringify(injected))))
})

test('the caps that protect the model context stay sane', () => {
  assert.equal(SNAPSHOT_HTML_CAP, 20_000)
  assert.equal(SNAPSHOT_TEXT_CAP, 8_000)
  assert.equal(SNAPSHOT_INTERACTIVE_CAP, 200)
  assert.equal(SNAPSHOT_DISPLAY_CAP, 80)
  assert.ok(SNAPSHOT_DISPLAY_CAP < SNAPSHOT_INTERACTIVE_CAP)
})
