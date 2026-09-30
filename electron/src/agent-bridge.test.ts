/**
 * The agent bridge: the MCP surface the model's browser tools arrive through.
 *
 * This is the one part of the browser feature that is *not* Electron-specific, so it is
 * exercised end to end here with the SDK's own client: the real wire protocol, the real
 * capability path, the real bearer check. A fake tool handler stands in for the browser so
 * the test says nothing about Electron and everything about the contract DSH depends on.
 *
 * Run: node --test src/agent-bridge.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { startAgentBridge } from '../src/agent-bridge.ts'

const TOOLS = [
  {
    name: 'snapshot',
    description: '读取页面结构',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'navigate',
    description: '打开网址',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
] as const

async function withBridge(
  run: (endpoint: { url: string; token: string }, calls: Array<{ name: string; args: unknown }>) => Promise<void>,
  call?: (name: string, args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
): Promise<void> {
  const calls: Array<{ name: string; args: unknown }> = []
  const bridge = await startAgentBridge({
    serverName: 'desktop_browser',
    tools: [...TOOLS],
    call: async (name, args) => {
      calls.push({ name, args })
      if (call !== undefined) return await call(name, args)
      return { content: [{ type: 'text', text: `called ${name}` }] }
    },
  })
  try {
    await run({ url: bridge.url, token: bridge.token }, calls)
  } finally {
    await bridge.close()
  }
}

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  // Same `exactOptionalPropertyTypes` friction as the server side: the SDK types its
  // optional transport members as `T | undefined`. The cast is local to this call.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
  return client
}

test('the capability path and the bearer token are both required', async () => {
  await withBridge(async ({ url, token }) => {
    const wrongPath = `${url.slice(0, -8)}deadbeef`
    assert.equal((await fetch(wrongPath, { method: 'POST' })).status, 404)
    assert.equal((await fetch(url, { method: 'GET' })).status, 405)
    assert.equal((await fetch(url, { method: 'POST' })).status, 401)
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status, 401)
    // A browser page always sends Origin; an MCP client never does.
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'http://127.0.0.1:41729', Authorization: `Bearer ${token}` } })).status, 403)
    assert.notEqual(token, '')
  })
})

test('an MCP client can list and call the tools', async () => {
  await withBridge(async ({ url, token }, calls) => {
    const client = await connect(url, token)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['snapshot', 'navigate'])
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true)

    const result = await client.callTool({ name: 'navigate', arguments: { url: 'example.com' } })
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.content, [{ type: 'text', text: 'called navigate' }])
    assert.deepEqual(calls, [{ name: 'navigate', args: { url: 'example.com' } }])
    await client.close()
  })
})

test('a failing tool comes back as an error result, not a protocol failure', async () => {
  await withBridge(
    async ({ url, token }) => {
      const client = await connect(url, token)
      const result = await client.callTool({ name: 'navigate', arguments: { url: 'nope' } })
      assert.equal(result.isError, true)
      assert.deepEqual(result.content, [{ type: 'text', text: '打开失败' }])
      // The session survives the failure: tools/list still answers.
      const listed = await client.listTools()
      assert.equal(listed.tools.length, 2)
      await client.close()
    },
    async () => ({ content: [{ type: 'text', text: '打开失败' }], isError: true }),
  )
})
