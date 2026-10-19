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

import type { McpServerInput } from './dsh-config.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'electron') return nextResolve(specifier, context)
    return {
      url: 'data:text/javascript,' + encodeURIComponent(
        'export class BrowserWindow {}\nexport const dialog = {}\nexport const ipcMain = {}\n',
      ),
      shortCircuit: true,
    }
  },
})

// Imported after the hook: resolving `electron` inside the module would fail under plain Node.
const { resolveNodeExecutable, resolveStdioCommand } = await import('./mcp-window.ts')

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
