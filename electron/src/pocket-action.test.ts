/**
 * Regression guards for the phone-access bridge.
 *
 * Two bugs shipped in 0.4.2 that looked like "the buttons are dead":
 *
 *   1. the bridge forwarded only the three LAN-era actions and turned everything else into
 *      `refresh`, so 「开启公网访问」/「关闭公网访问」/防火墙按钮 all silently did nothing;
 *   2. 关闭 closed the settings window (the instance that installed the handlers) instead of the
 *      phone-access window that asked, so the pocket window could not be closed with its button.
 *
 * Both were invisible to the existing smoke: it probes that the page *paints* and that the bridge
 * object exists, never that a click reaches `handlePocketAction`. These tests pin the contract in
 * the direction the bugs happened: every action name the page can send must survive the bridge, and
 * the close handler must resolve the requesting window rather than a singleton.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { POCKET_ACTION_KINDS, parsePocketAction, type PocketAction } from './pocket-action.ts'

const pocketPage = readFileSync(fileURLToPath(new URL('./pocket-ui/index.html', import.meta.url)), 'utf8')
const settingsWindowSource = readFileSync(fileURLToPath(new URL('./settings-window.ts', import.meta.url)), 'utf8')

/** One representative instance of every action the page sends. */
const ACTIONS: readonly PocketAction[] = [
  { kind: 'refresh' },
  { kind: 'rotate' },
  { kind: 'setPassword', value: 'lan-password-1' },
  { kind: 'select', address: '192.168.1.20' },
  { kind: 'startTunnel', acceptedDisclaimer: true },
  { kind: 'stopTunnel' },
  { kind: 'rotatePublicPassword' },
  { kind: 'setPublicPassword', value: 'wan-password-1' },
  { kind: 'setTunnelToken', value: 'eyJ-token' },
  { kind: 'firewallCheck' },
  { kind: 'firewallAllow' },
]

test('every action kind the bridge advertises is parsed without being downgraded', () => {
  assert.deepEqual(
    [...POCKET_ACTION_KINDS].sort(),
    ACTIONS.map(action => action.kind).sort(),
    'POCKET_ACTION_KINDS 与这里的动作清单必须一致（新增动作要同时改两处）',
  )
  for (const action of ACTIONS) {
    assert.deepEqual(parsePocketAction(action), action, `动作被桥丢弃或改写：${action.kind}`)
  }
})

test('public access and the firewall pair really reach the main process', () => {
  // The exact regression: these four used to fall through to `refresh` and the page showed the old
  // state back, which looks like a dead button.
  for (const kind of ['startTunnel', 'stopTunnel', 'firewallCheck', 'firewallAllow'] as const) {
    const parsed = parsePocketAction({ kind })
    assert.equal(parsed.kind, kind, `${kind} 被降级成了 ${parsed.kind}`)
  }
  assert.deepEqual(parsePocketAction({ kind: 'startTunnel', acceptedDisclaimer: true }), {
    kind: 'startTunnel',
    acceptedDisclaimer: true,
  })
})

test('the renderer cannot smuggle values through the bridge', () => {
  assert.deepEqual(parsePocketAction({ kind: 'setPassword', value: 42 }), { kind: 'setPassword', value: '' })
  assert.deepEqual(parsePocketAction({ kind: 'select' }), { kind: 'select', address: '' })
  // Truthy is not consent: only a literal `true` opens the public door.
  assert.deepEqual(parsePocketAction({ kind: 'startTunnel', acceptedDisclaimer: 'yes' }), {
    kind: 'startTunnel',
    acceptedDisclaimer: false,
  })
  // Unknown / malformed messages may only re-read status, never trigger a side effect.
  for (const value of [undefined, null, 'startTunnel', 42, {}, { kind: 'startAllTheThings' }, { kind: 7 }]) {
    assert.deepEqual(parsePocketAction(value), { kind: 'refresh' })
  }
})

test('every action kind written in the pocket page is known to the bridge', () => {
  // Static guard in the direction the bug happened: the page grew actions for months while the bridge
  // kept the old whitelist. Adding `kind: '…'` to the page without adding it to POCKET_ACTION_KINDS
  // now fails here instead of shipping a dead button.
  const kinds = new Set([...pocketPage.matchAll(/kind:\s*'([A-Za-z]+)'/gu)].map(match => match[1]))
  assert.ok(kinds.size >= 8, `页面上的动作偏少（${kinds.size}），正则可能失效了`)
  const unknown = [...kinds].filter(kind => !(POCKET_ACTION_KINDS as readonly string[]).includes(kind ?? ''))
  assert.deepEqual(unknown, [], `页面发送了桥不认识的动作：${unknown.join(', ')}`)
})

test('the close IPC closes the window that asked, and the pocket bridge forwards every action', () => {
  const closeHandler = /ipcMain\.handle\(IPC\.settingsClose[\s\S]*?\n    \}\)/u.exec(settingsWindowSource)?.[0] ?? ''
  assert.notEqual(closeHandler, '', '找不到 settingsClose 的处理器')
  assert.match(closeHandler, /BrowserWindow\.fromWebContents\(event\.sender\)/u)
  // The requesting window is what gets closed, after the invoke reply has a chance to settle (closing
  // the sender inline leaves the page's `await api.close()` pending forever — the smoke rehearsal hung
  // on exactly that). The comment above the code mentions `this.close()`, so assert on the call.
  assert.match(closeHandler, /setImmediate\(/u)
  assert.match(closeHandler, /requesting\.close\(\)/u)

  const actionHandler = /ipcMain\.handle\(IPC\.pocketAction[\s\S]*?\n    \}\)/u.exec(settingsWindowSource)?.[0] ?? ''
  assert.notEqual(actionHandler, '', '找不到 pocketAction 的处理器')
  assert.match(actionHandler, /parsePocketAction\(/u)
  assert.doesNotMatch(actionHandler, /case '/u, '桥里不能再手写动作白名单（那正是 0.4.2 两个按钮失效的原因）')
})
