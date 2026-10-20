/**
 * Unit tests for the MCP window's pure helpers.
 *
 * The task added two decisions that are easy to get subtly wrong and impossible to see in a static
 * page check: which Node executable the shell offers (bundled runtime first, environment second) and
 * when a stdio server's command is replaced. Both live in `mcp-window.ts`, so they are tested here.
 *
 * That module imports `electron` at the top for its window class. `node --test` has no Electron
 * main process, so a module hook answers exactly that specifier with a stub before the dynamic
 * import; the production file keeps its normal named imports.
 */

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'

import { IPC } from './constants.ts'
import type { DshConfigStore, McpServer, McpServerInput } from './dsh-config.ts'
import { MAX_IMPORT_ENTRIES, type McpImportResult } from './mcp-import.ts'
import type { McpProbeResult } from './mcp-probe.ts'
import type { McpImportApplyResult } from './mcp-window.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'electron') return nextResolve(specifier, context)
    return {
      // A real-enough electron surface for `McpWindow.install()`: `ipcMain.handle` records the
      // handlers so the tests can invoke them exactly as the renderer would.
      url: 'data:text/javascript,' + encodeURIComponent(
        'const ipcMain = { handlers: new Map(), handle(channel, handler) { this.handlers.set(channel, handler) } }\n'
        + 'globalThis.__mcpIpcMain = ipcMain\n'
        + 'export class BrowserWindow { static fromWebContents() { return null } }\n'
        + 'export const dialog = {}\n'
        + 'export { ipcMain }\n',
      ),
      shortCircuit: true,
    }
  },
})

// Imported after the hook: resolving `electron` inside the module would fail under plain Node.
const { McpWindow, resolveNodeExecutable, resolveStdioCommand } = await import('./mcp-window.ts')

const BUNDLED_BIN = join('C:', 'app', 'resources', 'runtime', 'dsh', 'bin')
const BUNDLED_NODE = join(BUNDLED_BIN, 'node.exe')
const ENV_NODE = join('D:', 'nodejs', 'node.exe')

function existsOnly(...present: readonly string[]): (path: string) => boolean {
  return (path: string) => present.includes(path)
}

function stdio(overrides: Partial<McpServerInput> = {}): McpServerInput {
  return {
    serverName: 'jenkins_dev',
    transport: 'stdio',
    enabled: true,
    failOnStartupError: false,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/* resolveNodeExecutable                                               */
/* ------------------------------------------------------------------ */

test('resolveNodeExecutable prefers the bundled runtime, then the environment, then missing', () => {
  assert.deepEqual(
    resolveNodeExecutable({ bundledBinDir: BUNDLED_BIN, environment: ENV_NODE, exists: existsOnly(BUNDLED_NODE, ENV_NODE) }),
    { path: BUNDLED_NODE, source: 'bundled' },
  )
  // A package that ships without the runtime tree still offers the environment's Node.
  assert.deepEqual(
    resolveNodeExecutable({ bundledBinDir: BUNDLED_BIN, environment: ENV_NODE, exists: existsOnly(ENV_NODE) }),
    { path: ENV_NODE, source: 'environment' },
  )
  assert.deepEqual(
    resolveNodeExecutable({ bundledBinDir: BUNDLED_BIN, environment: ENV_NODE, exists: existsOnly() }),
    { path: '', source: 'missing' },
  )
})

test('resolveNodeExecutable ignores absent inputs instead of probing them', () => {
  const failOnProbe = (path: string): boolean => {
    throw new Error(`不应探测：${path}`)
  }
  assert.deepEqual(resolveNodeExecutable({ exists: failOnProbe }), { path: '', source: 'missing' })
  assert.deepEqual(
    resolveNodeExecutable({ bundledBinDir: '', environment: '   ', exists: failOnProbe }),
    { path: '', source: 'missing' },
  )
  // No bundled bin directory, an existing environment path: still the environment fallback.
  assert.deepEqual(
    resolveNodeExecutable({ environment: ENV_NODE, exists: existsOnly(ENV_NODE) }),
    { path: ENV_NODE, source: 'environment' },
  )
  // The bundled path is derived as `<bin>/node.exe`, exactly what main.ts passes.
  assert.deepEqual(
    resolveNodeExecutable({ bundledBinDir: BUNDLED_BIN, exists: existsOnly(join(BUNDLED_BIN, 'node.exe')) }),
    { path: join(BUNDLED_BIN, 'node.exe'), source: 'bundled' },
  )
})

/* ------------------------------------------------------------------ */
/* resolveStdioCommand                                                 */
/* ------------------------------------------------------------------ */

test('resolveStdioCommand fills an empty command or a bare node with the detected path', () => {
  assert.equal(resolveStdioCommand(stdio(), BUNDLED_NODE).command, BUNDLED_NODE)
  assert.equal(resolveStdioCommand(stdio({ command: 'node' }), BUNDLED_NODE).command, BUNDLED_NODE)
  assert.equal(resolveStdioCommand(stdio({ command: 'NODE.EXE' }), BUNDLED_NODE).command, BUNDLED_NODE)
  assert.equal(resolveStdioCommand(stdio({ command: '  node  ' }), BUNDLED_NODE).command, BUNDLED_NODE)
  // Other fields survive the rewrite: only the command changes.
  const resolved = resolveStdioCommand(stdio({ command: 'node', args: ['server.js'], cwd: '/tmp' }), BUNDLED_NODE)
  assert.deepEqual(resolved.args, ['server.js'])
  assert.equal(resolved.cwd, '/tmp')
  assert.equal(resolved.serverName, 'jenkins_dev')
})

test('resolveStdioCommand never rewrites a real command or a non-stdio transport', () => {
  const custom = join('C:', 'tools', 'deno.exe')
  assert.equal(resolveStdioCommand(stdio({ command: custom }), BUNDLED_NODE).command, custom)
  // Without a detected Node a bare `node` stays: PATH may still resolve it at spawn time.
  assert.equal(resolveStdioCommand(stdio({ command: 'node' }), undefined).command, 'node')
  assert.equal(resolveStdioCommand(stdio({ command: 'node' }), '').command, 'node')
  assert.equal(resolveStdioCommand(stdio(), '').command, undefined)

  const http: McpServerInput = {
    serverName: 'remote',
    transport: 'streamable-http',
    enabled: true,
    failOnStartupError: false,
    url: 'https://example.test/mcp',
  }
  const untouched = resolveStdioCommand(http, BUNDLED_NODE)
  assert.equal(untouched.command, undefined)
  assert.equal(untouched.url, 'https://example.test/mcp')
})

/* ------------------------------------------------------------------ */
/* Window handlers: probe cache, dedupe and invalidation               */
/* ------------------------------------------------------------------ */

interface IpcMainStub {
  readonly handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
}

const ipcMainStub = (globalThis as unknown as { readonly __mcpIpcMain: IpcMainStub }).__mcpIpcMain
/** The URL the guard sees for a real MCP window. */
const MCP_EVENT = { senderFrame: { url: 'file:///D:/app/dist/mcp/index.html' } }

interface Harness {
  readonly servers: McpServer[]
  readonly saved: McpServerInput[]
  call(channel: string, ...args: unknown[]): Promise<unknown>
}

function mcpServer(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id,
    serverName: `server-${id}`,
    transport: 'stdio',
    command: 'node',
    enabled: true,
    failOnStartupError: false,
    ...overrides,
  }
}

/** A stdio row with no command at all, which is what `exactOptionalPropertyTypes` forbids in overrides. */
function mcpServerWithoutCommand(id: string): McpServer {
  return { id, serverName: `server-${id}`, transport: 'stdio', enabled: true, failOnStartupError: false }
}

/**
 * Install one window over an in-memory store. `servers` is the mutable state the fake store lists,
 * so a test can re-add a row and prove its old verdict is gone.
 */
function createHarness(
  servers: McpServer[],
  probe?: (server: McpServer) => Promise<McpProbeResult>,
  nodeExecutable?: string,
): Harness {
  const state = [...servers]
  const saved: McpServerInput[] = []
  const store = {
    patchPath: 'C:/home/profiles/dsh-desktop/cordis.patch.yml',
    skillsRoot: 'C:/home/skills',
    listMcpServers: () => state,
    saveMcpServer: (input: McpServerInput) => {
      saved.push(input)
      const existing = input.id === undefined ? undefined : state.find((server) => server.id === input.id)
      if (existing !== undefined) {
        state[state.indexOf(existing)] = {
          ...existing,
          ...input,
          id: existing.id,
          serverName: input.serverName,
          transport: input.transport,
          enabled: input.enabled !== false,
        }
      } else {
        state.push({
          ...input,
          id: `row-${String(state.length + 1)}-${String(saved.length)}`,
          serverName: input.serverName,
          transport: input.transport,
          enabled: input.enabled !== false,
          failOnStartupError: input.failOnStartupError === true,
        })
      }
      return { ok: true }
    },
    removeMcpServer: (id: string) => {
      const index = state.findIndex((server) => server.id === id)
      if (index >= 0) state.splice(index, 1)
      return { ok: true }
    },
    setMcpEnabled: (id: string, enabled: boolean) => {
      const index = state.findIndex((server) => server.id === id)
      if (index >= 0) state[index] = { ...(state[index] as McpServer), enabled }
      return { ok: true }
    },
    listSkills: () => [],
    addSkillLink: () => ({ ok: true }),
    removeSkillLink: () => ({ ok: true }),
    migrateLegacy: () => ({ ok: true, servers: 0, skills: 0, alreadyDone: true, repaired: 0 }),
    readLegacyUsageConfig: () => undefined,
    removeRows: () => ({ ok: true, removed: 0 }),
  } as unknown as DshConfigStore
  const window = new McpWindow({
    appRoot: 'C:/app',
    store,
    isShellDocument: () => true,
    restart: () => {},
    ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
    ...(probe === undefined ? {} : { probe }),
  })
  window.install()
  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = ipcMainStub.handlers.get(channel)
    assert.ok(handler !== undefined, `未注册的 IPC：${channel}`)
    return await handler(MCP_EVENT, ...args)
  }
  return { servers: state, saved, call }
}

function probeOk(toolCount = 3): McpProbeResult {
  return {
    ok: true,
    transport: 'stdio',
    toolCount,
    toolNames: ['echo', 'ping', 'third'].slice(0, toolCount),
    durationMs: 12,
    checkedAt: 1_700_000_000_000,
  }
}

interface Listed {
  readonly servers: Array<McpServer & { readonly probe?: McpProbeResult }>
}

test('mcpList attaches the cached verdict and leaves unchecked servers without a probe field', async () => {
  const harness = createHarness(
    [mcpServer('a'), mcpServer('b', { transport: 'streamable-http', url: 'https://b.test/mcp' })],
    async () => probeOk(),
  )
  const checked = await harness.call(IPC.mcpCheck, 'a') as McpProbeResult
  assert.equal(checked.ok, true)

  const listed = await harness.call(IPC.mcpList) as Listed
  assert.equal(listed.servers[0]?.probe?.toolCount, 3)
  assert.equal(Object.hasOwn(listed.servers[0] ?? {}, 'probe'), true)
  assert.equal(Object.hasOwn(listed.servers[1] ?? {}, 'probe'), false)
})

test('concurrent checks for one id share a single probe run', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const harness = createHarness([mcpServer('a')], async () => {
    calls += 1
    await gate
    return probeOk(2)
  })
  const first = harness.call(IPC.mcpCheck, 'a')
  const second = harness.call(IPC.mcpCheck, 'a')
  release?.()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1, '双击只能触发一次探活')
  assert.deepEqual(a, b)
})

test('saving an existing server clears its cached verdict', async () => {
  const harness = createHarness([mcpServer('a')], async () => probeOk(), BUNDLED_NODE)
  await harness.call(IPC.mcpCheck, 'a')
  const saved = await harness.call(IPC.mcpSaveServer, {
    id: 'a',
    serverName: 'renamed',
    transport: 'stdio',
    command: 'node',
  }) as { ok: boolean }
  assert.equal(saved.ok, true)
  // The write path still normalizes a bare `node` to the detected executable.
  assert.equal(harness.saved[0]?.command, BUNDLED_NODE)
  const listed = await harness.call(IPC.mcpList) as Listed
  assert.equal(Object.hasOwn(listed.servers[0] ?? {}, 'probe'), false)
})

test('removing a server clears its cached verdict', async () => {
  const harness = createHarness([mcpServer('a'), mcpServer('b')], async () => probeOk())
  await harness.call(IPC.mcpCheck, 'a')
  await harness.call(IPC.mcpRemoveServer, 'a')
  // A later row reusing the id must not inherit the deleted server's verdict.
  harness.servers.push(mcpServer('a', { serverName: 'recreated' }))
  const listed = await harness.call(IPC.mcpList) as Listed
  const recreated = listed.servers.find((server) => server.id === 'a')
  assert.notEqual(recreated, undefined)
  assert.equal(Object.hasOwn(recreated ?? {}, 'probe'), false)
})

test('disabling a server keeps its cached verdict, and the row stays checkable', async () => {
  const harness = createHarness([mcpServer('a')], async () => probeOk())
  await harness.call(IPC.mcpCheck, 'a')
  await harness.call(IPC.mcpSetEnabled, 'a', false)
  const listed = await harness.call(IPC.mcpList) as Listed
  assert.equal(listed.servers[0]?.enabled, false)
  assert.equal(listed.servers[0]?.probe?.ok, true)
})

test('checking an unknown or malformed id reports a readable error', async () => {
  const harness = createHarness([mcpServer('a')])
  assert.deepEqual(await harness.call(IPC.mcpCheck, 'missing'), { ok: false, error: '找不到这个 MCP 服务' })
  assert.deepEqual(await harness.call(IPC.mcpCheck, 42), { ok: false, error: '找不到这个 MCP 服务' })
})

test('a check probes the detected Node without rewriting the stored command', async () => {
  const probed: McpServer[] = []
  const harness = createHarness(
    [mcpServer('bare', { command: 'node' }), mcpServerWithoutCommand('empty')],
    async (server) => {
      probed.push(server)
      return probeOk(1)
    },
    BUNDLED_NODE,
  )
  await harness.call(IPC.mcpCheck, 'bare')
  await harness.call(IPC.mcpCheck, 'empty')
  assert.deepEqual(probed.map((server) => server.command), [BUNDLED_NODE, BUNDLED_NODE])
  assert.equal(harness.servers[0]?.command, 'node', '探活不能改磁盘上的配置')
  assert.equal(harness.servers[1]?.command, undefined)
})

test('a probe that throws becomes a failed result instead of a rejected IPC call', async () => {
  const harness = createHarness([mcpServer('a')], async () => { throw new Error('boom') })
  const result = await harness.call(IPC.mcpCheck, 'a') as McpProbeResult
  assert.equal(result.ok, false)
  assert.equal(result.error, 'boom')
  assert.equal(result.transport, 'stdio')
})

/* ------------------------------------------------------------------ */
/* Import: parse against the live list, then apply with conflicts      */
/* ------------------------------------------------------------------ */

test('mcpImportParse flags name conflicts against the live store', async () => {
  const harness = createHarness([mcpServer('a', { serverName: 'existing' })])
  const result = await harness.call(IPC.mcpImportParse, JSON.stringify({
    mcpServers: {
      existing: { command: 'node' },
      fresh: { type: 'http', url: 'https://fresh.test/mcp' },
    },
  })) as McpImportResult
  assert.equal(result.format, 'claude')
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.entries.map((entry) => entry.name), ['existing', 'fresh'])
  assert.deepEqual(result.entries[0]?.conflict, { id: 'a' })
  assert.equal(result.entries[1]?.conflict, undefined)
})

test('mcpImportParse rejects non-text and over-2 MB input without throwing', async () => {
  const harness = createHarness([])
  const notText = await harness.call(IPC.mcpImportParse, 42) as McpImportResult
  assert.deepEqual(notText.errors, ['导入内容必须是文本。'])

  const tooBig = await harness.call(IPC.mcpImportParse, 'x'.repeat(2 * 1024 * 1024 + 16)) as McpImportResult
  assert.ok(tooBig.errors.some((error) => error.includes('超过 2 MB')))
})

test('mcpImportApply imports new servers through the same validation and Node normalization', async () => {
  const harness = createHarness([], undefined, BUNDLED_NODE)
  const result = await harness.call(IPC.mcpImportApply, [
    { input: { serverName: 'fresh', transport: 'stdio', command: 'node', args: ['server.js'] } },
  ]) as McpImportApplyResult
  assert.deepEqual(result, { ok: true, imported: 1, skipped: 0, failed: [] })
  assert.equal(harness.servers.length, 1)
  assert.equal(harness.servers[0]?.serverName, 'fresh')
  assert.equal(harness.servers[0]?.command, BUNDLED_NODE, '导入也要归一裸 node')
  assert.deepEqual(harness.saved[0]?.args, ['server.js'])
})

test('mcpImportApply skips a name conflict unless the item asks to overwrite', async () => {
  const harness = createHarness(
    [mcpServer('a', { serverName: 'existing', command: 'C:/custom/node.exe' })],
    undefined,
    BUNDLED_NODE,
  )
  const skipped = await harness.call(IPC.mcpImportApply, [
    { input: { serverName: 'existing', transport: 'stdio', command: 'node' }, overwrite: false },
  ]) as McpImportApplyResult
  assert.deepEqual(skipped, { ok: true, imported: 0, skipped: 1, failed: [] })
  assert.equal(harness.servers[0]?.command, 'C:/custom/node.exe', '未勾选覆盖时原有配置不动')

  const overwritten = await harness.call(IPC.mcpImportApply, [
    { input: { serverName: 'existing', transport: 'stdio', command: 'node', args: ['new.js'] }, overwrite: true },
  ]) as McpImportApplyResult
  assert.deepEqual(overwritten, { ok: true, imported: 1, skipped: 0, failed: [] })
  assert.equal(harness.servers.length, 1, '覆盖是原地更新，不新增一行')
  assert.equal(harness.servers[0]?.id, 'a', '沿用已有 id')
  assert.equal(harness.servers[0]?.command, BUNDLED_NODE)
  assert.ok(harness.saved.some((input) => input.id === 'a'))
})

test('mcpImportApply clears the cached probe of overwritten servers', async () => {
  const harness = createHarness([mcpServer('a', { serverName: 'existing' })], async () => probeOk())
  await harness.call(IPC.mcpCheck, 'a')
  assert.equal((await harness.call(IPC.mcpList) as Listed).servers[0]?.probe?.ok, true)

  await harness.call(IPC.mcpImportApply, [
    { input: { serverName: 'existing', transport: 'stdio', command: 'node' }, overwrite: true },
  ])
  assert.equal(Object.hasOwn((await harness.call(IPC.mcpList) as Listed).servers[0] ?? {}, 'probe'), false)
})

test('mcpImportApply reports invalid items without throwing and rejects bad batches', async () => {
  const harness = createHarness([])
  const partial = await harness.call(IPC.mcpImportApply, [
    { input: { serverName: '', transport: 'stdio' } },
    'not-an-item',
    { input: { serverName: 'ok', transport: 'streamable-http', url: 'https://ok.test/mcp' } },
  ]) as McpImportApplyResult
  assert.equal(partial.ok, true)
  assert.equal(partial.imported, 1)
  assert.equal(partial.failed.length, 2)
  assert.ok(partial.failed.some((failure) => failure.reason.includes('服务名不能为空')))
  assert.ok(partial.failed.some((failure) => failure.reason.includes('MCP 记录格式无效')))

  assert.deepEqual(
    await harness.call(IPC.mcpImportApply, 'nope') as McpImportApplyResult,
    { ok: false, imported: 0, skipped: 0, failed: [{ name: '', reason: '导入列表格式无效。' }] },
  )
  assert.deepEqual(
    await harness.call(IPC.mcpImportApply, []) as McpImportApplyResult,
    { ok: false, imported: 0, skipped: 0, failed: [{ name: '', reason: '没有选中要导入的服务。' }] },
  )
  const tooMany = await harness.call(IPC.mcpImportApply, Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, () => ({ input: {} }))) as McpImportApplyResult
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.failed[0]?.reason.includes('一次最多导入'))
})
