/**
 * Tests for the Codex / Claude Code MCP import parser.
 *
 * The fixtures are the two shapes users actually paste: a Codex `config.toml` fragment (with fields
 * DSH has no home for) and a Claude `.mcp.json` whose servers use stdio, HTTP and the deprecated SSE
 * transport. The parser is pure and must stay that way — no Electron, no filesystem.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { McpServerInput } from './dsh-config.ts'
import { MAX_IMPORT_ENTRIES, parseMcpImport } from './mcp-import.ts'

const CODEX_EXAMPLE = [
  '[mcp_servers.xterminal]',
  'url = "http://127.0.0.1:12335/mcp"',
  'http_headers = { Authorization = "Bearer xtmcp_super_secret" }',
  'default_tools_approval_mode = "prompt"',
  'tool_timeout_sec = 120',
  '',
].join('\n')

const CLAUDE_EXAMPLE = JSON.stringify({
  mcpServers: {
    name: { command: 'npx', args: ['-y', 'pkg'], env: { K: 'V' } },
    remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer claude_secret' } },
    legacy: { type: 'sse', url: 'https://example.test/sse' },
    off: { command: 'node', disabled: true },
  },
})

function expectInput(entry: { readonly input: McpServerInput }): McpServerInput {
  return entry.input
}

test('parses the user\'s Codex TOML example into one streamable-http server', () => {
  const result = parseMcpImport(CODEX_EXAMPLE, [])
  assert.equal(result.format, 'codex')
  assert.deepEqual(result.errors, [])
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.name, 'xterminal')
  assert.equal(entry.input.transport, 'streamable-http')
  assert.equal(entry.input.url, 'http://127.0.0.1:12335/mcp')
  assert.equal(entry.input.headers?.['Authorization'], 'Bearer xtmcp_super_secret')
  // Fields DSH has no equivalent for are reported by name…
  assert.ok(entry.warnings.some((warning) => warning.includes('已忽略字段') && warning.includes('default_tools_approval_mode')))
  assert.ok(entry.warnings.some((warning) => warning.includes('tool_timeout_sec')))
  // …and no warning may leak the header value.
  const allWarnings = [...result.warnings, ...entry.warnings].join('\n')
  assert.doesNotMatch(allWarnings, /xtmcp_super_secret|Bearer/u)
})

test('parses a Codex stdio server, converting env scalars and quoted table names', () => {
  const text = [
    '[mcp_servers."local tool"]',
    'command = "node"',
    'args = ["server.js", "--flag"]',
    'cwd = "/tmp/work"',
    'env = { TOKEN = "abc", PORT = 8080, DEBUG = true }',
    'enabled = false',
    '',
  ].join('\n')
  const result = parseMcpImport(text, [])
  assert.equal(result.format, 'codex')
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.name, 'local tool')
  const input = expectInput(entry)
  assert.equal(input.transport, 'stdio')
  assert.equal(input.command, 'node')
  assert.deepEqual(input.args, ['server.js', '--flag'])
  assert.equal(input.cwd, '/tmp/work')
  assert.deepEqual(input.env, { TOKEN: 'abc', PORT: '8080', DEBUG: 'true' })
  assert.equal(input.enabled, false)
  assert.deepEqual(entry.warnings, [])
})

test('parses Claude stdio + HTTP + SSE + disabled servers, warning about SSE', () => {
  const result = parseMcpImport(CLAUDE_EXAMPLE, [{ id: 'row-name', serverName: 'name' }])
  assert.equal(result.format, 'claude')
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.entries.map((entry) => entry.name), ['name', 'remote', 'legacy', 'off'])

  const name = result.entries[0]
  const remote = result.entries[1]
  const legacy = result.entries[2]
  const off = result.entries[3]
  assert.ok(name !== undefined && remote !== undefined && legacy !== undefined && off !== undefined)
  assert.equal(name.input.transport, 'stdio')
  assert.equal(name.input.command, 'npx')
  assert.deepEqual(name.input.args, ['-y', 'pkg'])
  assert.deepEqual(name.input.env, { K: 'V' })
  // Existing server with the same name is flagged with the row id the UI may overwrite.
  assert.deepEqual(name.conflict, { id: 'row-name' })
  assert.equal(name.input.enabled, true)

  assert.equal(remote.input.transport, 'streamable-http')
  assert.equal(remote.input.url, 'https://example.test/mcp')
  assert.equal(remote.input.headers?.['Authorization'], 'Bearer claude_secret')
  assert.equal(remote.conflict, undefined)

  assert.equal(legacy.input.transport, 'streamable-http', 'SSE 也按 streamable-http 导入')
  assert.ok(legacy.warnings.some((warning) => warning.includes('DSH 只支持 streamable-http，SSE 配置可能连不上')))
  assert.equal(off.input.enabled, false, 'disabled: true 映射为未启用')
})

test('warns about Claude fields DSH cannot represent without echoing their values', () => {
  const result = parseMcpImport(JSON.stringify({
    mcpServers: {
      tool: { command: 'node', alwaysAllow: ['*'], timeout: 30, oauth: { clientId: 'id', clientSecret: 'shh-secret' } },
    },
  }), [])
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.ok(entry !== undefined)
  const warnings = entry.warnings.join('\n')
  assert.match(warnings, /已忽略字段/u)
  assert.match(warnings, /alwaysAllow/u)
  assert.match(warnings, /timeout/u)
  assert.match(warnings, /oauth/u)
  assert.doesNotMatch([...result.warnings, ...entry.warnings].join('\n'), /shh-secret/u)
})

test('rejects an entry with both command and url, and one with neither', () => {
  const both = parseMcpImport(JSON.stringify({
    mcpServers: { confused: { command: 'node', url: 'https://example.test/mcp' } },
  }), [])
  assert.equal(both.entries.length, 0)
  assert.ok(both.errors.some((error) => error.includes('confused') && error.includes('同时配置了 command 与 url')))

  const neither = parseMcpImport('[mcp_servers.empty]\nenabled = true\n', [])
  assert.equal(neither.entries.length, 0)
  assert.ok(neither.errors.some((error) => error.includes('既没有 command 也没有 url')))
})

test('reports unreadable JSON and TOML instead of throwing', () => {
  const badJson = parseMcpImport('{"mcpServers": ', [])
  assert.equal(badJson.format, 'unknown')
  assert.equal(badJson.entries.length, 0)
  assert.ok(badJson.errors.some((error) => error.includes('JSON 解析失败')))

  const badToml = parseMcpImport('[mcp_servers.x\nurl = 1', [])
  assert.equal(badToml.format, 'unknown')
  assert.ok(badToml.errors.some((error) => error.includes('TOML 解析失败')))

  const empty = parseMcpImport('   ', [])
  assert.equal(empty.format, 'unknown')
  assert.deepEqual(empty.errors, ['导入内容为空。'])
})

test('reports a missing server section and a non-object top level', () => {
  const missing = parseMcpImport('{"other": {}}', [])
  assert.equal(missing.format, 'claude')
  assert.ok(missing.errors.some((error) => error.includes('未找到 mcpServers')))

  const array = parseMcpImport('{"mcpServers": []}', [])
  assert.ok(array.errors.some((error) => error.includes('未找到 mcpServers')))

  const scalar = parseMcpImport('"just a string"', [])
  assert.equal(scalar.format, 'claude', '合法 JSON 但顶层不是对象')
  assert.ok(scalar.errors.some((error) => error.includes('配置顶层必须是对象')))
})

test('trims names, rejects over-long ones, and lets a later duplicate win', () => {
  const result = parseMcpImport(JSON.stringify({
    mcpServers: { '  spaced  ': { command: 'node', args: ['first.js'] } },
    mcp_servers: { spaced: { command: 'node', args: ['second.js'] } },
  }), [])
  assert.equal(result.entries.length, 1)
  const entry = result.entries[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.name, 'spaced')
  assert.deepEqual(entry.input.args, ['second.js'], '后一条覆盖前一条')
  assert.ok(result.warnings.some((warning) => warning.includes('重复定义')))

  const longName = 'x'.repeat(81)
  const tooLong = parseMcpImport(JSON.stringify({ mcpServers: { [longName]: { command: 'node' } } }), [])
  assert.equal(tooLong.entries.length, 0)
  assert.ok(tooLong.errors.some((error) => error.includes('超过 80 字符')))
})

test(`caps one import at ${String(MAX_IMPORT_ENTRIES)} entries with a warning`, () => {
  const servers: Record<string, unknown> = {}
  for (let index = 0; index < MAX_IMPORT_ENTRIES + 3; index += 1) {
    servers[`s${String(index)}`] = { command: 'node', args: [`${String(index)}.js`] }
  }
  const result = parseMcpImport(JSON.stringify({ mcpServers: servers }), [])
  assert.equal(result.entries.length, MAX_IMPORT_ENTRIES)
  assert.ok(result.warnings.some((warning) => warning.includes('一次最多导入')))
})
