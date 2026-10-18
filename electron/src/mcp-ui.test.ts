/**
 * Static guards for the MCP & Skills window.
 *
 * Same contract the pocket and usage pages carry: the page has no network, no innerHTML and talks
 * only through its one preload object. The extra guard here is method parity — the window grew a
 * handful of actions, and a name that the preload does not expose is a dead button that only a user
 * would notice.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(fileURLToPath(new URL('./mcp-ui/index.html', import.meta.url)), 'utf8')
const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] ?? ''
const markup = page.slice(0, page.indexOf('<script>'))

test('CSP allows no network, and the page has one style block', () => {
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/u)
  assert.match(page, /Content-Security-Policy[^>]*img-src 'self' data:/u)
  assert.equal((page.match(/<style\b/gu) ?? []).length, 1)
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|innerHTML|https?:\/\//u, '页面只通过壳的 API 说话')
})

test('every element the script looks up exists in the markup', () => {
  const ids = new Set([...markup.matchAll(/id="([A-Za-z0-9_-]+)"/gu)].map((match) => match[1]))
  const looked = new Set([...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/gu)].map((match) => match[1]))
  assert.ok(looked.size > 20, `页面元素偏少（${looked.size}）`)
  const missing = [...looked].filter((id) => !ids.has(id))
  assert.deepEqual(missing, [], `脚本查找了不存在的 id：${missing.join(', ')}`)
})

test('the bridge methods match the preload contract exactly', () => {
  const used = new Set([...script.matchAll(/api\.([A-Za-z]+)\(/gu)].map((match) => match[1]))
  const expected = ['addSkill', 'close', 'list', 'removeServer', 'removeSkill', 'restart', 'saveServer', 'setEnabled', 'skills']
  assert.deepEqual([...used].sort(), expected)
  assert.match(script, /window\.__DSH_MCP__/u)
  assert.doesNotMatch(script, /__DSH_SETTINGS__|__DSH_USAGE__|__DSH_MARKET__/u)
})

test('both tabs and their lists exist, with a status line and the two footer buttons', () => {
  for (const id of ['tabMcp', 'tabSkills', 'panelMcp', 'panelSkills', 'serverList', 'skillList', 'statusBar', 'restartButton', 'closeButton', 'patchPath', 'skillsRoot']) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'), `缺少 ${id}`)
  }
  assert.match(script, /switchTab\('skills'\)/u)
})

test('the MCP form switches between stdio and HTTP fields', () => {
  assert.match(markup, /id="serverTransport"/u)
  assert.match(markup, /id="stdioFields"/u)
  assert.match(markup, /id="httpFields"/u)
  assert.match(script, /syncTransportFields\(/u)
  // The legacy-source badge tells the user where migrated records came from.
  assert.match(script, /来自旧插件/u)
})

test('long-running writes are confirmed, and removing a skill link never deletes its target', () => {
  assert.match(script, /重启 DSH 服务会结束当前所有运行中的会话/u)
  assert.match(script, /只删除链接，不动原目录/u)
  assert.match(script, /window\.confirm\(/u)
})

test('the restart hint is visible: config changes need a DSH restart', () => {
  assert.match(markup, /配置保存后需要重启 DSH 才能生效/u)
  assert.match(script, /重启 DSH 服务后生效/u)
})
