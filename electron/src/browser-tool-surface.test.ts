/**
 * The native-vs-MCP decision, including the automatic fallback that keeps the tools alive
 * across a DSH upgrade.
 *
 * Run: node --test src/browser-tool-surface.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TOOL_SURFACE_MODES,
  decideToolSurface,
  isToolSurfaceSetting,
  parseRegistrationRecord,
} from '../src/browser-tool-surface.ts'

const EXPECTED = 14

test('the default is native tools, with no MCP row in the overlay', () => {
  const decision = decideToolSurface(undefined, undefined, EXPECTED)
  assert.equal(decision.mode, 'native')
  assert.equal(decision.injectMcp, false)
  assert.equal(decision.nativeTools, true)
})

test('a successful native registration keeps native', () => {
  const decision = decideToolSurface('auto', { ok: true, count: EXPECTED }, EXPECTED)
  assert.equal(decision.mode, 'native')
  assert.equal(decision.injectMcp, false)
})

test('a failed native registration falls back to MCP, and says why', () => {
  const decision = decideToolSurface('auto', { ok: false, count: 0, error: 'registry changed' }, EXPECTED)
  assert.equal(decision.mode, 'mcp')
  assert.equal(decision.injectMcp, true)
  assert.equal(decision.nativeTools, false)
  assert.match(decision.reason, /自动回退 MCP/u)
  assert.match(decision.reason, /registry changed/u)
})

test('a partial registration is a failure too', () => {
  const decision = decideToolSurface('auto', { ok: true, count: 9 }, EXPECTED)
  assert.equal(decision.mode, 'mcp')
  assert.match(decision.reason, /9\/14/u)
})

test('an explicit choice wins over the fallback', () => {
  const native = decideToolSurface('native', { ok: false, count: 0, error: 'boom' }, EXPECTED)
  assert.equal(native.mode, 'native')
  assert.equal(native.injectMcp, false)
  // ...and the reason records that it is a retry, so the log explains itself.
  assert.match(native.reason, /重试/u)

  const mcp = decideToolSurface('mcp', { ok: true, count: EXPECTED }, EXPECTED)
  assert.equal(mcp.mode, 'mcp')
  assert.equal(mcp.injectMcp, true)
  assert.equal(mcp.nativeTools, false)
})

test('an unknown setting is treated as auto rather than trusted', () => {
  const decision = decideToolSurface('yes please', { ok: false, count: 0 }, EXPECTED)
  assert.equal(decision.mode, 'mcp')
})

test('settings values are validated against the known set', () => {
  assert.deepEqual([...TOOL_SURFACE_MODES], ['auto', 'native', 'mcp'])
  assert.equal(isToolSurfaceSetting('native'), true)
  assert.equal(isToolSurfaceSetting('MCP'), false)
  assert.equal(isToolSurfaceSetting(undefined), false)
})

test('a malformed report is ignored instead of flipping the surface', () => {
  assert.equal(parseRegistrationRecord(null), undefined)
  assert.equal(parseRegistrationRecord('ok'), undefined)
  assert.equal(parseRegistrationRecord({ count: 14 }), undefined)
  // A report without a valid count is a zero-count report (a failure, not a pass).
  assert.deepEqual(parseRegistrationRecord({ ok: true }), { ok: true, count: 0 })
})

test('the fallback only engages when the record really is a failure', () => {
  // `ok: true` but a bogus count is the dangerous case: it must not be read as success.
  assert.equal(decideToolSurface('auto', { ok: true, count: Number.NaN }, EXPECTED).mode, 'mcp')
  assert.equal(decideToolSurface('auto', { ok: true, count: 0 }, 0).mode, 'native', 'an empty catalog is consistent')
})
