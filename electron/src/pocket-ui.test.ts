/**
 * Static guards for the phone-access window.
 *
 * Same class of bug the settings page and the market page were guarded against: nothing else in the
 * repo sees this markup, its CSS and its script together, and a page whose script throws before its
 * first paint still fires `did-finish-load`. Two of the guards below pin decisions the user asked for
 * explicitly, because they are the kind of layout that silently regresses:
 *
 *   - the **same-WiFi connect code is the default**, and the App download is hidden until asked for;
 *   - the connect block is `display: grid`, so it needs its own `[hidden]` rule or "nothing to show"
 *     renders as a broken image.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(fileURLToPath(new URL('./pocket-ui/index.html', import.meta.url)), 'utf8')
const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] ?? ''
const markup = page.slice(0, page.indexOf('<script>'))

test('one style block in the head, and a CSP that allows no network', () => {
  assert.equal((page.match(/<style\b/gu) ?? []).length, 1)
  assert.ok(page.indexOf('<style') < page.indexOf('</head>'))
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/u)
  assert.match(page, /Content-Security-Policy[^>]*img-src 'self' data:/u)
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|innerHTML/u, '页面只通过壳的 API 说话')
})

test('every element the script looks up actually exists in the markup', () => {
  const ids = new Set([...markup.matchAll(/id="([A-Za-z0-9_-]+)"/gu)].map(match => match[1]))
  // The page looks elements up through `$('…')` (a one-line helper), so both spellings count.
  const looked = new Set([
    ...[...script.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/gu)].map(match => match[1]),
    ...[...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/gu)].map(match => match[1]),
  ])
  assert.ok(looked.size > 15, `sanity: 页面元素偏少（${looked.size}）`)
  const missing = [...looked].filter(id => !ids.has(id))
  assert.deepEqual(missing, [], `脚本查找了不存在的 id：${missing.join(', ')}`)
})

test('a hidden connect block really disappears, grid and all', () => {
  // `display: grid` beats the UA `[hidden]` rule: without this the "no address yet" state shows a
  // broken image frame instead of nothing.
  assert.match(page, /\.connect\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/u)
  assert.match(page, /#apkBox\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/u)
})

test('the same-WiFi code is what you see first, and the App download stays hidden', () => {
  // Requested explicitly: the default view is the quick-connect code for the current network, and the
  // APK download appears only after the user asks for it.
  // The connect block ships hidden and the script unhides it when a listener is up.
  assert.match(markup, /class="connect" id="lanConnect" hidden/u)
  assert.match(page, /id="lanQr"/u)
  assert.match(page, /id="apkBox" hidden/u)
  assert.match(script, /apkToggle'\)\.addEventListener\('click', \(\) => \{ \$\('apkBox'\)\.hidden = !\$\('apkBox'\)\.hidden \}\)/u)
  // The LAN section comes before the public one, and the App section last.
  assert.ok(markup.indexOf('局域网（同一 WiFi）') < markup.indexOf('公网（不在同一 WiFi 时）'))
  assert.ok(markup.indexOf('公网（不在同一 WiFi 时）') < markup.indexOf('手机 App'))
})

test('the connect code can be refreshed without touching the password', () => {
  assert.match(page, /id="lanRefreshQr"/u)
  const handler = /lanRefreshQr'\)\.addEventListener\('click',[\s\S]{0,120}/u.exec(script)?.[0] ?? ''
  assert.match(handler, /load\(\)/u, '刷新二维码只重新读状态')
  assert.doesNotMatch(handler, /rotate|setPassword/u, '刷新二维码不该换密码')
})

test('public access still needs a fresh acknowledgement, and the token never enters the settings document', () => {
  assert.match(script, /window\.confirm\(/u)
  assert.match(script, /acceptedDisclaimer: true/u)
  // The token travels as its own action, not through `save(...)`.
  assert.match(script, /kind: 'setTunnelToken'/u)
  const saver = /async function save\(patch, note\)[\s\S]*?\n    \}/u.exec(script)?.[0] ?? ''
  assert.notEqual(saver, '')
  assert.doesNotMatch(script, /save\(\{[^}]*token/iu, 'token 不能走设置保存')
})

test('a blocked firewall is explained, and lifted only by a button', () => {
  // The LAN listener is the only thing other devices connect *to*, and Windows blocks it. The hint
  // must carry the manual command too, because the elevated path can be refused (or managed by group
  // policy) and a dead-end hint would leave the user with a phone that pings but cannot open a page.
  assert.match(markup, /id="firewallBox" hidden/u)
  assert.match(markup, /id="firewallCommand"/u)
  assert.match(markup, /id="firewallAllow"/u)
  assert.match(script, /kind: 'firewallAllow'/u)
  assert.match(script, /kind: 'firewallCheck'/u)
  const render = /function renderFirewall\(pocket\)[\s\S]*?\n    \}/u.exec(script)?.[0] ?? ''
  assert.notEqual(render, '')
  assert.match(render, /needsAttention === true/u, '只在真的需要时才提示')
  assert.match(render, /netsh /u)
})

test('the connect code hands the phone the password too, and the page says so', () => {
  // The desktop puts a `dshpocket://connect?…` deep link in the QR image, so one scan fills both the
  // address and the password. The page must not reduce that to "type the password" again.
  assert.match(markup, /扫码打开 Pocket App 会自动填入地址和密码（未安装 App 时也可手动输入上面的地址与密码）/u)
  // Both codes are produced by the main process; the page only displays the PNG it is given, so
  // there is one implementation of the payload rather than two that drift.
  assert.match(script, /\$\('lanQr'\)\.src = pocket\.qr \|\| ''/u)
  assert.match(script, /\$\('wanQr'\)\.src = wan\.qr \|\| ''/u)
})

test('the page tells the user how to connect on the phone, for both doors', () => {
  const howto = [...markup.matchAll(/<ol class="howto">[\s\S]*?<\/ol>/gu)].map(match => match[0])
  assert.ok(howto.length >= 3, `应该有三段「手机上怎么连」：局域网、公网、App（实际 ${howto.length}）`)
  assert.match(page, /DSH 口袋/u)
  assert.match(page, /浏览器打开这个地址/u, '没有 App 时也要能用')
})
