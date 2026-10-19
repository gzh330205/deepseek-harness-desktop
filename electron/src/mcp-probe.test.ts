/**
 * Tests for the real MCP availability check.
 *
 * These are deliberately end-to-end at the process boundary: a tiny JSON-RPC server written to a
 * temporary directory is spawned through the official SDK, so the test proves what the feature
 * promises — a real connect + `tools/list`, stderr captured on failure, and a hard timeout that
 * also kills the child process. No third-party packages are involved in the fixture itself.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { McpServer } from './dsh-config.ts'
import { probeEnvironment, probeMcpServer } from './mcp-probe.ts'

const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-probe-'))
after(() => { rmSync(fixtureDir, { recursive: true, force: true }) })

const fixturePath = join(fixtureDir, 'mcp-fixture.cjs')

/**
 * A minimal MCP stdio server: newline-delimited JSON-RPC. Modes:
 * - default: initialize / tools/list (two tools);
 * - `--hang`: never answers (the timeout case), writes its PID so the test can prove it was killed;
 * - `--fail`: writes a secret-looking line to stderr and exits non-zero.
 */
writeFileSync(fixturePath, String.raw`'use strict'
const fs = require('node:fs')
const mode = process.argv[2] || 'ok'
const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'ping', description: 'Ping the server', inputSchema: { type: 'object', properties: {} } },
]
function send(message) { process.stdout.write(JSON.stringify(message) + '\n') }

if (mode === '--hang') {
  // Keep the event loop alive and ignore every request: the shell must time out and kill us.
  if (process.argv[3]) fs.writeFileSync(process.argv[3], String(process.pid))
  setInterval(() => {}, 1000)
  process.stdin.resume()
} else if (mode === '--fail') {
  process.stderr.write('fixture failure: missing API_TOKEN for upstream\n')
  process.exit(1)
} else {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line === '') continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.method === undefined) continue
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-fixture', version: '1.0.0' },
        } })
      } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools } })
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: {} })
      }
    }
  })
}
`)

function stdioServer(args: readonly string[], overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: `fixture-${args.join('-') || 'ok'}`,
    serverName: 'dsh-fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [...args],
    enabled: true,
    failOnStartupError: false,
    ...overrides,
  }
}

function httpServer(url: string): McpServer {
  return {
    id: 'fixture-http',
    serverName: 'dsh-fixture-http',
    transport: 'streamable-http',
    url,
    enabled: true,
    failOnStartupError: false,
  }
}

const sleep = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

test('probeMcpServer connects to a real stdio server and lists its tools', async () => {
  const result = await probeMcpServer(stdioServer([fixturePath]))
  assert.equal(result.ok, true)
  assert.equal(result.transport, 'stdio')
  assert.equal(result.toolCount, 2)
  assert.deepEqual(result.toolNames, ['echo', 'ping'])
  assert.equal(result.error, undefined)
  assert.ok(result.durationMs >= 0)
  assert.ok(result.checkedAt > 0)
  assert.ok(Math.abs(Date.now() - result.checkedAt) < 30_000, 'checkedAt 应是调用时刻')
})

test('probeMcpServer reports an empty or missing command instead of throwing', async () => {
  const empty = await probeMcpServer({ ...stdioServer([]), command: '' }, { timeoutMs: 5_000 })
  assert.equal(empty.ok, false)
  // The spawner rejects it; the message is the SDK/spawn one, not a crash.
  assert.ok(typeof empty.error === 'string' && empty.error !== '')

  const missing = await probeMcpServer({
    ...stdioServer([]),
    command: join(fixtureDir, 'definitely-not-an-executable.exe'),
  }, { timeoutMs: 8_000 })
  assert.equal(missing.ok, false)
  assert.equal(missing.transport, 'stdio')
  assert.match(missing.error ?? '', /ENOENT|spawn|not recognized|cannot find|not found|找不到/iu)
})

test('probeMcpServer includes the child stderr tail when startup fails', async () => {
  const result = await probeMcpServer(stdioServer([fixturePath, '--fail']), { timeoutMs: 8_000 })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /fixture failure: missing API_TOKEN for upstream/u)
})

test('probeMcpServer treats a closed HTTP port as unavailable, not as a crash', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })

  const result = await probeMcpServer(httpServer(`http://127.0.0.1:${String(port)}/mcp`), { timeoutMs: 8_000 })
  assert.equal(result.ok, false)
  assert.equal(result.transport, 'streamable-http')
  assert.match(result.error ?? '', /ECONNREFUSED|fetch failed|连接|refused/iu)
})

test('probeMcpServer rejects an invalid HTTP URL with a readable message', async () => {
  const result = await probeMcpServer(httpServer('not a url'), { timeoutMs: 2_000 })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /URL 不合法/u)
})

test('probeMcpServer times out and kills the child process', async () => {
  const pidFile = join(fixtureDir, 'hang.pid')
  const result = await probeMcpServer(stdioServer([fixturePath, '--hang', pidFile]), { timeoutMs: 250 })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /检查超时（250 毫秒）/u)

  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(Number.isInteger(pid) && pid > 0, 'fixture 应报告自己的 PID')
  let alive = true
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0)
      await sleep(100)
    } catch {
      alive = false
      break
    }
  }
  assert.equal(alive, false, '超时后子进程必须被关闭')
})

test('probeEnvironment strips credentials and DSH_* while keeping the rest', () => {
  const previous = {
    DSH_TEST_ONLY: process.env.DSH_TEST_ONLY,
    PROBE_TEST_API_KEY: process.env.PROBE_TEST_API_KEY,
  }
  process.env.DSH_TEST_ONLY = 'dsh'
  process.env.PROBE_TEST_API_KEY = 'secret'
  try {
    const env = probeEnvironment({ CUSTOM_TOKEN: 'configured-token' })
    assert.equal(env.DSH_TEST_ONLY, undefined)
    assert.equal(env.PROBE_TEST_API_KEY, undefined)
    // The user's explicitly configured env is not filtered: they asked for it.
    assert.equal(env.CUSTOM_TOKEN, 'configured-token')
    assert.ok(Object.keys(env).some((name) => name.toUpperCase() === 'PATH'), 'PATH 要保留，否则 node 子进程起不来')
  } finally {
    if (previous.DSH_TEST_ONLY === undefined) delete process.env.DSH_TEST_ONLY
    else process.env.DSH_TEST_ONLY = previous.DSH_TEST_ONLY
    if (previous.PROBE_TEST_API_KEY === undefined) delete process.env.PROBE_TEST_API_KEY
    else process.env.PROBE_TEST_API_KEY = previous.PROBE_TEST_API_KEY
  }
})
