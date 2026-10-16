import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createPocketTunnel, parseTunnelUrl, tunnelCommand } from './pocket-tunnel.ts'

/**
 * The tunnel, tested against a script that behaves like cloudflared.
 *
 * The real binary needs the internet, so the lifecycle is exercised with a fake that prints what
 * cloudflared prints and then stays alive — which is enough to prove the parts that break: reading the
 * address out of the output, waiting for a named tunnel to register, giving up when the binary dies,
 * and actually killing the process instead of leaving an open door running.
 */

const directory = mkdtempSync(join(tmpdir(), 'pocket-tunnel-'))
const fake = join(directory, 'fake-cloudflared.mjs')
writeFileSync(fake, `
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), token: process.env.TUNNEL_TOKEN ?? null }))
const behaviour = process.env.FAKE_BEHAVIOUR
if (behaviour === 'quick') {
  console.error('+--------------------------------------------------------------------------------------------+')
  console.error('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |')
  console.error('|  https://random-words-here.trycloudflare.com                                               |')
  console.error('+--------------------------------------------------------------------------------------------+')
} else if (behaviour === 'named') {
  console.error('2026-10-16T00:00:00Z INF Registered tunnel connection connIndex=0')
} else if (behaviour === 'die') {
  console.error('failed to parse token: invalid')
  process.exit(1)
}
setInterval(() => {}, 1000)
`, 'utf8')

interface Fixture {
  readonly tunnel: ReturnType<typeof createPocketTunnel>
  readonly record: string
}

function startTunnel(behaviour: string, readyTimeoutMs = 5_000): Fixture {
  const record = join(directory, `${behaviour}-${String(Date.now())}.json`)
  const tunnel = createPocketTunnel({
    binary: 'cloudflared-not-used.exe',
    originPort: 41_736,
    log: () => {},
    readyTimeoutMs,
    command: () => ({
      file: process.execPath,
      args: [fake],
      env: { FAKE_RECORD: record, FAKE_BEHAVIOUR: behaviour },
    }),
  })
  return { tunnel, record }
}

/** Wait for a condition, for the things that settle a tick later. */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return check()
}

test('the address is read out of the banner cloudflared prints', () => {
  const output = [
    'INF Thank you for trying Cloudflare Tunnel. Doing so means...',
    '+--------------------------------------------------------------------------------------------+',
    '|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '|  https://random-words-here.trycloudflare.com                                               |',
    '+--------------------------------------------------------------------------------------------+',
  ].join('\n')
  assert.equal(parseTunnelUrl(output), 'https://random-words-here.trycloudflare.com')
  assert.equal(parseTunnelUrl('nothing to see'), undefined)
  assert.equal(parseTunnelUrl(''), undefined)
})

test('a named tunnel keeps its token off the command line', () => {
  const command = tunnelCommand({ binary: 'C:/x/cloudflared.exe', originPort: 41_736 }, {
    mode: 'named',
    token: 'secret-token-value',
    domain: 'pocket.example.com',
  })
  assert.deepEqual(command.args, ['tunnel', 'run'])
  assert.equal(command.env?.TUNNEL_TOKEN, 'secret-token-value')
  assert.equal(command.args.join(' ').includes('secret-token-value'), false, '命令行里不能出现 token')
})

test('a quick tunnel points at the loopback listener and never updates itself', () => {
  const command = tunnelCommand({ binary: 'C:/x/cloudflared.exe', originPort: 41_736 }, { mode: 'quick' })
  assert.deepEqual(command.args, ['tunnel', '--url', 'http://127.0.0.1:41736', '--no-autoupdate'])
  assert.equal(command.env, undefined)
})

test('a quick tunnel reports the address it was given, and stopping kills the process', async () => {
  const { tunnel } = startTunnel('quick')
  const status = await tunnel.start({ mode: 'quick' })
  assert.equal(status.running, true)
  assert.equal(status.url, 'https://random-words-here.trycloudflare.com')
  assert.deepEqual(tunnel.status(), status)

  await tunnel.stop()
  assert.equal(tunnel.status().running, false)
  assert.equal(tunnel.status().url, undefined)
})

test('a named tunnel waits until a connection registers, then reports the configured domain', async () => {
  const { tunnel } = startTunnel('named')
  const status = await tunnel.start({ mode: 'named', token: 'token', domain: 'pocket.example.com' })
  assert.equal(status.running, true)
  assert.equal(status.url, 'https://pocket.example.com/')
  await tunnel.stop()
})

test('a binary that exits is reported as a failure, not as a tunnel', async () => {
  const { tunnel } = startTunnel('die')
  const status = await tunnel.start({ mode: 'named', token: 'bad', domain: 'pocket.example.com' })
  assert.equal(status.running, false)
  assert.match(String(status.error), /命名隧道没有连上/u)
  assert.equal(tunnel.status().running, false)
})

test('a tunnel that never says anything fails on the deadline instead of pretending', async () => {
  const { tunnel } = startTunnel('silent', 600)
  const status = await tunnel.start({ mode: 'quick' })
  assert.equal(status.running, false)
  assert.match(String(status.error), /没有在预期时间内就绪/u)
})

test('starting again replaces the previous tunnel instead of leaving two open', async () => {
  const { tunnel } = startTunnel('quick')
  await tunnel.start({ mode: 'quick' })
  const second = await tunnel.start({ mode: 'quick' })
  assert.equal(second.running, true)
  await tunnel.stop()
  assert.equal(tunnel.status().running, false)
})

test('the fake recorded that it was started, for the record', async () => {
  const { tunnel, record } = startTunnel('quick')
  await tunnel.start({ mode: 'quick' })
  assert.equal(await waitFor(() => existsSync(record)), true, '假 cloudflared 应该留下了启动记录')
  const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; token: string | null }
  assert.equal(seen.token, null, '快速隧道不该带 TUNNEL_TOKEN')
  await tunnel.stop()
})
