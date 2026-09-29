/**
 * Window chrome tests: the strip and the caption overlay must follow the OS theme.
 *
 * Run: node --test src/chrome.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TITLEBAR_THEME, titleBarPalette } from '../src/constants.ts'

const titleBarHtml = readFileSync(fileURLToPath(new URL('./titlebar/index.html', import.meta.url)), 'utf8')

test('the palette follows the OS theme, and the two differ', () => {
  const light = titleBarPalette(false)
  const dark = titleBarPalette(true)
  assert.equal(light, TITLEBAR_THEME.light)
  assert.equal(dark, TITLEBAR_THEME.dark)
  assert.notEqual(light.background, dark.background)
  assert.notEqual(light.symbol, dark.symbol)
  for (const value of [light.background, light.symbol, dark.background, dark.symbol]) {
    assert.match(value, /^#[0-9a-f]{6}$/u)
  }
})

test('the title bar styles itself from the theme, not from a hardcoded colour', () => {
  // Regression: the first version painted the strip `#0f1115` unconditionally, so a light
  // desktop got a black bar instead of the white a native title bar would use.
  assert.match(titleBarHtml, /prefers-color-scheme: light/u)
  assert.match(titleBarHtml, /background: var\(--bg\)/u)
  assert.match(titleBarHtml, /color: var\(--fg\)/u)
  assert.doesNotMatch(titleBarHtml, /color-scheme: dark;/u)
})

test('only the 应用 menu is offered', () => {
  // Ctrl+C/V/X/A/Z already work in web content on Windows; an 编辑 menu only duplicated the
  // keyboard and added a second button to a bar that should stay quiet.
  assert.match(titleBarHtml, /data-menu="app"/u)
  assert.doesNotMatch(titleBarHtml, /data-menu="edit"/u)
})
