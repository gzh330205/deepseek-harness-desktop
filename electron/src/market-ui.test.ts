/**
 * Static guards for the market page, written after four real bugs shipped from this file.
 *
 * All four were invisible to every other test in the repo, because they only exist in the interaction
 * between the markup, the CSS and the script:
 *
 *  1. The categories vocabulary is an object map (`{ui: {en, zh}}`), and parsing it as a string array
 *     produced **zero** chips — the market looked like it had no categories at all.
 *  2. A second `<style>` block inside `<body>` re-declared `.chips` with `flex-wrap: wrap`, overriding
 *     the head's single-row rule: twenty-three categories wrapped into four rows and ate the list.
 *  3. `[hidden]` (a UA rule) lost to author `display: flex`, so the installed view kept the market's
 *     sort/filter/pager rows on screen while claiming to hide them.
 *  4. The page had no way to say what it rendered, so "loads fine, paints nothing" was undetectable.
 *
 * These checks are cheap and deterministic; the visual ones live in `scripts/preview-market.mjs`,
 * which renders this same page with a stub bridge and real catalog data.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(fileURLToPath(new URL('./market-ui/index.html', import.meta.url)), 'utf8')
const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] ?? ''
const markup = page.slice(0, page.indexOf('<script>'))

test('the page carries exactly one style block, and it is in the head', () => {
  const styles = page.match(/<style\b/gu) ?? []
  assert.equal(styles.length, 1, 'a second style block can silently override the layout (see .chips)')
  const headEnd = page.indexOf('</head>')
  assert.ok(page.indexOf('<style') < headEnd, 'styles belong in the head')
})

test('`hidden` beats author display rules', () => {
  // Without this, `node.hidden = true` does nothing to a `display: flex` toolbar: the installed view
  // kept the market's controls, which is exactly what the user reported.
  assert.match(page, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/u)
})

test('the category bar is a single scrolling row, never a wrapping block', () => {
  const rule = /\.catbar\s*\{([^}]*)\}/u.exec(page)?.[1] ?? ''
  assert.match(rule, /overflow-x:\s*auto/u, '.catbar must scroll horizontally')
  assert.doesNotMatch(rule, /flex-wrap:\s*wrap/u, '.catbar must not wrap: it would eat the list area')
})

test('every element the script looks up actually exists in the markup', () => {
  const ids = new Set([...markup.matchAll(/id="([A-Za-z0-9_-]+)"/gu)].map(match => match[1]))
  const looked = new Set([...script.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/gu)].map(match => match[1]))
  assert.ok(looked.size > 20, 'sanity: the script should look up a lot of elements')
  const missing = [...looked].filter(id => !ids.has(id))
  assert.deepEqual(missing, [], `the script looks up ids that do not exist: ${missing.join(', ')}`)
})

test('the market chrome is switched as blocks, so a view never keeps another view controls', () => {
  assert.match(script, /querySelectorAll\('\.market-only'\)/u, 'switchView must toggle .market-only blocks')
  const blocks = page.match(/class="[^"]*market-only/gu) ?? []
  assert.ok(blocks.length >= 4, `expected the toolbar, chips, status and skipped blocks marked: found ${String(blocks.length)}`)
})

test('the page reports what it rendered', () => {
  assert.match(script, /api\.note\(/u, 'the page must report its render, so a blank market is detectable')
  assert.match(script, /rendered \$\{catalog\.entries\.length\} cards of \$\{catalog\.total\}/u)
  assert.match(script, /typeof api\.note === 'function'/u, 'the report must be guarded for older preloads')
})

test('the page still refuses to fetch or frame anything itself', () => {
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/u)
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|innerHTML/u, 'every registry call goes through the shell')
})
