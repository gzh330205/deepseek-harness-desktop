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

  // 用量 is an action, not a menu: clicking it opens the usage window directly. Refresh/logout
  // already exist inside that window, so the old 打开面板/立即刷新/退出登录 dropdown was one click
  // of pure friction.
  assert.match(titleBarHtml, /data-action="usage"[^>]*>用量</u)
  assert.match(titleBarHtml, /api\.openUsage\(\)/u)
  assert.doesNotMatch(titleBarHtml, /data-menu="usage"/u)
  assert.doesNotMatch(titleBarHtml, /menu\('usage'/u)

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
  assert.ok(!allowed.includes('usage'), '用量已改为直接打开窗口，不应再出现在菜单名里')
})

test('the preload bridge and the IPC guard read one page list', () => {
  // Regression with a real cost: the phone-access window was added to the main-process guard but not to
  // the preload's, so its bridge never appeared and *every* control in it was dead (the page said
  // "preload 未加载" and the static page guards could not see it). One list, both readers.
  const preload = readFileSync(fileURLToPath(new URL('./preload.ts', import.meta.url)), 'utf8')
  const window_ = readFileSync(fileURLToPath(new URL('./settings-window.ts', import.meta.url)), 'utf8')
  assert.match(preload, /SHELL_PAGE_DOCUMENTS/u)
  assert.match(window_, /SHELL_PAGE_DOCUMENTS/u)
  assert.doesNotMatch(preload, /endsWith\('\/settings\/index\.html'\)/u, '不能写死单个页面')
  assert.doesNotMatch(window_, /includes\('\/settings\/'\)/u, '不能写死单个页面')
  // Both pages the shell opens must be listed, or the next one repeats the bug.
  assert.match(constantsSource, /SHELL_PAGE_DOCUMENTS = \['\/settings\/index\.html', '\/pocket\/index\.html', '\/usage\/index\.html', '\/mcp\/index\.html'\]/u)
  // The usage window's bridge (token usage / ONE-WAY) reads the same list.
  const usageWindow = readFileSync(fileURLToPath(new URL('./usage-window.ts', import.meta.url)), 'utf8')
  assert.match(usageWindow, /SHELL_PAGE_DOCUMENTS/u)
  assert.doesNotMatch(usageWindow, /endsWith\('\/settings\/index\.html'\)/u, '不能写死别的页面')
  // …and so does the MCP & Skills window.
  const mcpWindow = readFileSync(fileURLToPath(new URL('./mcp-window.ts', import.meta.url)), 'utf8')
  assert.match(mcpWindow, /SHELL_PAGE_DOCUMENTS/u)
})

test('the 用量 button reaches the window through its own guarded channel', () => {
  // The button no longer goes through titlebarMenu, so the channel has to exist end to end:
  // constants name it, the preload exposes it, and main both handles it and owns the sender.
  const preload = readFileSync(fileURLToPath(new URL('./preload.ts', import.meta.url)), 'utf8')
  const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8')
  assert.match(constantsSource, /usageOpen: 'shell:usage-open'/u)
  assert.match(preload, /IPC\.usageOpen/u)
  assert.match(preload, /openUsage:/u)
  assert.match(main, /ipcMain\.handle\(IPC\.usageOpen/u)
  assert.match(main, /event\.sender !== titleBarView\?\.webContents/u)
  assert.match(main, /openUsageWindow\(\)/u)
  // No 用量 dropdown anymore: the template table only carries real menus.
  assert.doesNotMatch(main, /usageMenuTemplate/u)
  assert.doesNotMatch(main, /usage: usageMenuTemplate/u)
})
