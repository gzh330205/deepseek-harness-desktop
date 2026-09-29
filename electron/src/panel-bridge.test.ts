/**
 * Panel-bridge tests.
 *
 * The bridge is the only path by which the DSH settings page reaches the shell, so the
 * mapping from the plugin's answers to UI decisions is pinned here — including the
 * `active` branch, which a live host only produces while an agent is genuinely running.
 *
 * A local HTTP server stands in for the plugin's authenticated route prefix.
 *
 * Run: node --test src/panel-bridge.test.ts
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'

import { PANEL_ROUTE } from '../src/constants.ts'
import { PanelBridge, checkSettingsRoundTrip, describeTasks } from '../src/panel-bridge.ts'

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => void

async function withBridge(
  handler: Handler,
  run: (bridge: PanelBridge, origin: string) => Promise<void>,
  options: { readonly withCookie?: boolean } = {},
): Promise<void> {
  const server = createServer((request, response) => {
    handler(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.notEqual(address, null)
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const origin = `http://127.0.0.1:${String(port)}`
  const bridge = new PanelBridge({
    origin: () => origin,
    cookie: () => (options.withCookie === false ? undefined : 'dsh-auth-probe=1'),
    timeoutMs: 1_000,
  })
  try {
    await run(bridge, origin)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

test('readiness reflects the plugin answering its own route', async () => {
  await withBridge((_request, response, url) => {
    if (url.pathname === `${PANEL_ROUTE}/ready`) json(response, 200, { ok: true, plugin: 'dsh-desktop-shell' })
    else json(response, 404, { ok: false })
  }, async (bridge) => {
    assert.equal(await bridge.ready(), true)
  })

  await withBridge((_request, response) => { json(response, 200, { ok: true, plugin: 'something-else' }) }, async (bridge) => {
    assert.equal(await bridge.ready(), false)
  })
})

test('an idle answer is trustworthy and needs no dialog', async () => {
  await withBridge((_request, response, url) => {
    if (url.pathname === `${PANEL_ROUTE}/tasks`) json(response, 200, { ok: true, answer: 'idle', families: [], sessions: 1 })
    else json(response, 404, { ok: false })
  }, async (bridge) => {
    const report = await bridge.tasks()
    assert.equal(report.answer, 'idle')
    assert.equal(describeTasks(report), '')
  })
})

test('an active answer names what would be interrupted', async () => {
  await withBridge((_request, response, url) => {
    if (url.pathname !== `${PANEL_ROUTE}/tasks`) { json(response, 404, { ok: false }); return }
    json(response, 200, {
      ok: true,
      answer: 'active',
      sessions: 2,
      families: [
        { sessionId: 's1', kind: 'job', count: 2, labels: ['npm build', 'watch'] },
        { sessionId: 's1', kind: 'job', count: 2, labels: ['npm build', 'watch'] },
        { sessionId: 's2', kind: 'agent', count: 1, labels: [] },
      ],
    })
  }, async (bridge) => {
    const report = await bridge.tasks()
    assert.equal(report.answer, 'active')
    assert.equal(report.families.length, 3)
    const text = describeTasks(report)
    assert.match(text, /后台任务 2 项/u)
    assert.match(text, /npm build/u)
    assert.match(text, /运行中的回合 1 项/u)
    // The duplicate family collapses into one line.
    assert.equal(text.split('\n').length, 2)
  })
})

test('every failure mode is unknown, never idle', async () => {
  // A non-200 answer.
  await withBridge((_request, response) => { json(response, 500, { ok: false, error: 'boom' }) }, async (bridge) => {
    assert.equal((await bridge.tasks()).answer, 'unknown')
  })
  // An unexpected answer value.
  await withBridge((_request, response) => { json(response, 200, { ok: true, answer: 'maybe', families: [] }) }, async (bridge) => {
    assert.equal((await bridge.tasks()).answer, 'unknown')
  })
  // No session cookie: the shell has not authenticated yet.
  await withBridge((_request, response) => { json(response, 200, { ok: true, answer: 'idle', families: [] }) }, async (bridge) => {
    assert.equal((await bridge.tasks()).answer, 'unknown')
  }, { withCookie: false })
  // Unknown always asks, and says why.
  assert.match(describeTasks({ answer: 'unknown', families: [] }), /无法确认/u)
})

test('the settings round trip mirrors what the DSH page does', async () => {
  let putBody = ''
  await withBridge((request, response, url) => {
    if (url.pathname === `${PANEL_ROUTE}/state`) {
      json(response, 200, { ok: true, settings: { revision: 7 }, revision: 7 })
      return
    }
    if (url.pathname === `${PANEL_ROUTE}/bootstrap`) {
      json(response, 200, { ok: true, token: 'one-time', expiresInMs: 600_000 })
      return
    }
    if (url.pathname === `${PANEL_ROUTE}/settings` && request.method === 'PUT') {
      if (request.headers['x-dsh-desktop-shell-token'] !== 'one-time') {
        json(response, 403, { ok: false, error: 'invalid-token' })
        return
      }
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { putBody += chunk })
      request.on('end', () => { json(response, 200, { ok: true, revision: 8 }) })
      return
    }
    json(response, 404, { ok: false })
  }, async (bridge) => {
    const result = await checkSettingsRoundTrip(bridge)
    assert.deepEqual(result, { read: true, write: true, revision: 7 })
    assert.match(putBody, /"revision":7/u)
    assert.match(putBody, /"patch":\{\}/u)
  })
})

test('a rejected write is reported instead of being treated as saved', async () => {
  await withBridge((request, response, url) => {
    if (url.pathname === `${PANEL_ROUTE}/state`) { json(response, 200, { ok: true, revision: 3 }); return }
    if (url.pathname === `${PANEL_ROUTE}/bootstrap`) { json(response, 200, { ok: true, token: 'stale' }); return }
    if (url.pathname === `${PANEL_ROUTE}/settings` && request.method === 'PUT') {
      json(response, 409, { ok: false, error: 'revision-conflict' })
      return
    }
    json(response, 404, { ok: false })
  }, async (bridge) => {
    const result = await checkSettingsRoundTrip(bridge)
    assert.equal(result.read, true)
    assert.equal(result.write, false)
    assert.equal(result.error, 'revision-conflict')
  })
})
