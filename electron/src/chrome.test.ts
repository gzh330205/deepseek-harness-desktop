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

/** The menu-name union, so a title-bar button can be checked against what main actually allows. */
const constantsSource = readFileSync(fileURLToPath(new URL('./constants.ts', import.meta.url)), 'utf8')
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

test('only the shell menus are offered, and every button maps to one', () => {
  // Ctrl+C/V/X/A/Z already work in web content on Windows; an 编辑 menu only duplicated the
  // keyboard and added a second button to a bar that should stay quiet.
  assert.match(titleBarHtml, /data-menu="app"/u)
  assert.doesNotMatch(titleBarHtml, /data-menu="edit"/u)

  // 手机访问 sits next to 应用/插件 (the user asked for exactly that spot).
  assert.match(titleBarHtml, /data-menu="pocket"[^>]*>手机访问</u)

  // A button whose name the main process does not allow is a *dead button*: the IPC handler filters
  // by name and answers `false`, so the click does nothing and nothing is logged. The names live in
  // one union type, so the two lists are compared here instead of being kept in sync by memory.
  const menuNames = /type ShellMenuName = ([^\n]+)/u.exec(constantsSource)?.[1] ?? ''
  const allowed = [...menuNames.matchAll(/'([a-z]+)'/gu)].map(match => match[1])
  const buttons = [...titleBarHtml.matchAll(/data-menu="([a-z]+)"/gu)].map(match => match[1])
  assert.ok(buttons.length >= 3, `标题栏按钮偏少：${buttons.join(', ')}`)
  for (const button of buttons) {
    assert.ok(allowed.includes(button), `标题栏有 ${button} 按钮，但 ShellMenuName 里没有它`)
  }
})
