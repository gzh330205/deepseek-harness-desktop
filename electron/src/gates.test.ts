/**
 * Version-gate tests.
 *
 * The gate is the only thing standing between a user and an unauthenticated web
 * server on loopback, so its comparison rules are pinned here rather than trusted to
 * a semver dependency: pre-releases must sort below their release, and the numeric
 * comparison must be position-wise.
 *
 * Run: node --test src/gates.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServer } from 'node:http'
import type { Server } from 'node:http'

import { compareVersions, parseDshVersion, resolvePort, waitForPort } from '../src/gates.ts'
import { DEFAULT_DSH_PORT } from '../src/constants.ts'

test('the version probe survives trailing noise', () => {
  assert.equal(parseDshVersion('0.1.7-rc.2\n'), '0.1.7-rc.2')
  assert.equal(parseDshVersion('  0.1.7-rc.2  '), '0.1.7-rc.2')
  // A packaged run once ended with an unrelated trailing line; taking the last
  // whitespace token made the gate reject a good dsh (`received.`).
  assert.equal(parseDshVersion('0.1.7-rc.2\nnotice: response received.'), '0.1.7-rc.2')
  // stdout wins; stderr is only a fallback.
  assert.equal(parseDshVersion('noise', '0.2.0'), '0.2.0')
  assert.equal(parseDshVersion('', ''), undefined)
  assert.equal(parseDshVersion('version unknown'), undefined)
})

test('numeric versions compare position-wise', () => {
  assert.ok(compareVersions('0.1.2', '0.1.3') < 0)
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
  assert.equal(compareVersions('0.1.2', '0.1.2'), 0)
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0)
})

test('a release outranks its own pre-releases', () => {
  assert.ok(compareVersions('0.1.2-alpha.2', '0.1.2') < 0)
  assert.ok(compareVersions('0.1.2', '0.1.2-alpha.2') > 0)
  assert.ok(compareVersions('0.1.2-alpha.2', '0.1.2-alpha.10') < 0)
  assert.ok(compareVersions('0.1.2-beta.1', '0.1.2-alpha.9') > 0)
})

test('the shipped dsh version clears the minimum', () => {
  assert.ok(compareVersions('0.1.7-rc.2', '0.1.2-alpha.2') > 0)
  // The exact minimum is accepted, not rejected.
  assert.equal(compareVersions('0.1.2-alpha.2', '0.1.2-alpha.2'), 0)
})

test('port resolution prefers the environment, then settings, then the default', () => {
  const previous = process.env.DSH_DESKTOP_PORT
  try {
    delete process.env.DSH_DESKTOP_PORT
    assert.equal(resolvePort(undefined), DEFAULT_DSH_PORT)
    assert.equal(resolvePort(41800), 41800)
    process.env.DSH_DESKTOP_PORT = '41999'
    assert.equal(resolvePort(41800), 41999)
    process.env.DSH_DESKTOP_PORT = 'not-a-port'
    assert.throws(() => resolvePort(41800), /不是合法端口/u)
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_PORT
    else process.env.DSH_DESKTOP_PORT = previous
  }
})

/** A port that was free a moment ago (ephemeral bind, then released). */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

function occupy(port: number): Promise<Server> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { resolve(server) })
  })
}

test('a free port is taken immediately', async () => {
  const port = await freePort()
  const waits: number[] = []
  assert.equal(await waitForPort(port, 1_000, attempt => waits.push(attempt)), true)
  assert.deepEqual(waits, [])
})

test('the migration race is covered: waiting for the outgoing process to release the port', async () => {
  const port = await freePort()
  const server = await occupy(port)
  const waits: number[] = []
  // What the dying Tauri shell does: its dsh child holds the port, then it is killed.
  setTimeout(() => { server.close() }, 400)
  const started = Date.now()
  assert.equal(await waitForPort(port, 8_000, (attempt, remaining) => {
    waits.push(attempt)
    assert.ok(remaining > 0)
  }), true)
  assert.ok(waits.length >= 1, '应当至少等待一次')
  assert.ok(Date.now() - started >= 300, '不应在端口仍被占用时就返回')
})

test('a port that never frees is still reported occupied — never a fallback port', async () => {
  const port = await freePort()
  const server = await occupy(port)
  try {
    const started = Date.now()
    const waits: number[] = []
    assert.equal(await waitForPort(port, 500, attempt => waits.push(attempt)), false)
    assert.ok(waits.length >= 1)
    // Bounded: it must give up rather than hang the launch page.
    assert.ok(Date.now() - started < 3_000, `等待时间应受控，实际 ${String(Date.now() - started)}ms`)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
