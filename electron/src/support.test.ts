/**
 * Support-bundle tests.
 *
 * The bundle exists to be attached to a bug report, so the one thing that must not happen
 * is a credential inside it. Proxy settings routinely carry `user:password@`.
 *
 * Run: node --test src/support.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSupportBundle, redactProxyUrl, redactSettings, supportBundleFileName } from '../src/support.ts'

test('credentials are stripped from proxy URLs', () => {
  assert.equal(redactProxyUrl('http://user:secret@127.0.0.1:7890'), 'http://***@127.0.0.1:7890')
  assert.equal(redactProxyUrl('https://alice:hunter2@proxy.corp:8080'), 'https://***@proxy.corp:8080')
  // Nothing to hide: returned untouched.
  // Nothing to hide, and the value is not normalised either: a report must not look like
  // the app rewrote the user's configuration.
  assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(redactProxyUrl('socks5://proxy.corp:1080'), 'socks5://proxy.corp:1080')
  assert.equal(redactProxyUrl(''), '')
  assert.equal(redactProxyUrl(undefined), undefined)
  assert.equal(redactProxyUrl('not a url at all'), 'not a url at all')
  assert.equal(redactProxyUrl('127.0.0.1:7890'), '127.0.0.1:7890')
  // Ambiguous: userinfo without a scheme is thrown away rather than guessed at.
  assert.equal(redactProxyUrl('user:pass@proxy.corp:8080'), '***')
})

test('the settings copy keeps structure but loses every credential', () => {
  const redacted = redactSettings({
    closeBehavior: 'exit',
    service: { port: 41729 },
    proxy: {
      enabled: true,
      httpsProxy: 'http://user:secret@127.0.0.1:7890',
      httpProxy: 'http://user:secret@127.0.0.1:7890',
      noProxy: '',
    },
  }) as Record<string, any>
  assert.equal(redacted.closeBehavior, 'exit')
  assert.equal(redacted.service.port, 41729)
  assert.equal(redacted.proxy.enabled, true)
  assert.equal(redacted.proxy.httpsProxy, 'http://***@127.0.0.1:7890')
  assert.equal(redacted.proxy.httpProxy, 'http://***@127.0.0.1:7890')
  assert.equal(JSON.stringify(redacted).includes('secret'), false, '报告里不能出现密码')
})

test('a document without a proxy section is passed through', () => {
  const settings = { closeBehavior: 'exit' }
  assert.deepEqual(redactSettings(settings), settings)
  assert.equal(redactSettings(null), null)
  assert.equal(redactSettings('nonsense'), 'nonsense')
})

test('the bundle carries versions, state and the log tail', () => {
  const bundle = buildSupportBundle({
    desktopVersion: '0.3.7',
    channel: 'development',
    packaged: false,
    platform: 'win32',
    arch: 'x64',
    electron: '44.0.0',
    node: '24.18.1',
    v8: '15.2.124.13-electron.0',
    osRelease: '10.0.26200',
    userData: 'C:\\Users\\x\\AppData\\Roaming\\ai.deepseek.dsh-desktop.dev',
    dshHome: null,
    settings: { proxy: { httpsProxy: 'http://u:p@127.0.0.1:1' } },
    status: { phase: 'failed', message: '端口 41729 已被占用' },
    runtime: { source: 'system' },
    profile: { name: 'dsh-desktop-dev' },
    profileInstall: null,
    window: { restored: false },
    legacyInstalls: [],
    logs: ['闸门通过', '端口 41729 已被占用'],
  }, new Date('2026-09-29T01:02:03.456Z'))

  assert.equal(bundle.schema, 1)
  assert.equal(bundle.generatedAt, '2026-09-29T01:02:03.456Z')
  assert.equal(bundle.shell.desktopVersion, '0.3.7')
  assert.equal(bundle.shell.channel, 'development')
  assert.equal(bundle.paths.dshHome, null)
  assert.equal(bundle.logs.length, 2)
  assert.equal(JSON.stringify(bundle).includes('u:p@'), false, '整份报告里都不能有凭据')
  assert.equal(JSON.stringify(bundle).includes('p@127.0.0.1'), false)
})

test('the file name is sortable and Windows-safe', () => {
  const name = supportBundleFileName(new Date('2026-09-29T01:02:03.456Z'))
  assert.match(name, /^dsh-desktop-support-2026-09-29T01-02-03-456\.json$/u)
  assert.equal(/[:*?"<>|]/u.test(name), false)
})
