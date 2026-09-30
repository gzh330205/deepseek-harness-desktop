/**
 * Every tool schema must be acceptable to *both* surfaces that publish it.
 *
 * The same catalog (`browser-tools.ts`) is sent over MCP as JSON Schema and, when the DSH
 * plugin registers the tools natively, passed to `ctx.tools.register`. DSH's native registry
 * accepts only a subset — `type/oneOf/properties/required/additionalProperties/items/enum/const`
 * plus `description/title/default/examples` — and *throws* on anything else. A stray `minimum`
 * would therefore break the native surface at load time, on a user's machine, with the tools
 * simply missing.
 *
 * So the subset is asserted here, before release. This test is the reason the release checklist
 * can say "run the suite, then ship".
 *
 * Run: node --test src/browser-tool-schema.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BROWSER_TOOLS } from '../src/browser-tools.ts'

/** Mirrors `CONSTRAINT_KEYWORDS` in `@deepseek-ai/dsh-tools`. */
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/** Mirrors `ANNOTATION_KEYWORDS` in `@deepseek-ai/dsh-tools`. */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function collectViolations(node: unknown, path: string, violations: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  const schema = node as Record<string, unknown>
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(`${path}.${key} is outside the native keyword subset`)
  }
  if (typeof schema.type === 'string' && !SCHEMA_TYPES.has(schema.type)) {
    violations.push(`${path}.type "${schema.type}" is not a JSON Schema type`)
  }
  if (schema.properties !== undefined) {
    const properties = schema.properties
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      violations.push(`${path}.properties must be an object`)
    } else {
      for (const [name, child] of Object.entries(properties)) {
        collectViolations(child, `${path}.properties.${name}`, violations)
      }
    }
  }
  if (schema.items !== undefined) collectViolations(schema.items, `${path}.items`, violations)
  for (const key of ['oneOf'] as const) {
    const branches = schema[key]
    if (branches === undefined) continue
    if (!Array.isArray(branches)) {
      violations.push(`${path}.${key} must be an array`)
      continue
    }
    branches.forEach((branch, index) => {
      collectViolations(branch, `${path}.${key}[${String(index)}]`, violations)
    })
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    violations.push(`${path}.required must be an array`)
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
}

test('every tool schema stays inside the keyword subset the native registry accepts', () => {
  const violations: string[] = []
  for (const tool of BROWSER_TOOLS) {
    assert.equal(typeof tool.name, 'string')
    assert.notEqual(tool.description.trim(), '', `${tool.name} needs a description`)
    collectViolations(tool.inputSchema, tool.name, violations)
  }
  assert.deepEqual(violations, [], `tools/list and ctx.tools.register must accept these schemas:\n${violations.join('\n')}`)
})

test('tool names are unique, lowercase and underscore-separated', () => {
  const seen = new Set<string>()
  for (const tool of BROWSER_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/u, `${tool.name} is not a valid tool name`)
    assert.equal(seen.has(tool.name), false, `${tool.name} is declared twice`)
    seen.add(tool.name)
  }
})

test('the catalog is plain JSON, so it can be handed to the plugin through a file', () => {
  // The shell writes this catalog to `browser-tools.json`; the plugin reads it back. Anything
  // non-JSON (a function, undefined, a Date) would silently become a registration failure.
  const roundTripped: unknown = JSON.parse(JSON.stringify(BROWSER_TOOLS))
  assert.deepEqual(roundTripped, BROWSER_TOOLS)
})

test('an object schema declares no properties when it takes no arguments', () => {
  for (const tool of BROWSER_TOOLS) {
    const schema = tool.inputSchema
    assert.equal(schema.type, 'object', `${tool.name} must take an object argument`)
    // A tool with neither properties nor oneOf is "no arguments" — keep it explicit so the
    // model is not asked for fields that do not exist.
    if (schema.oneOf === undefined) {
      const properties = schema.properties
      assert.ok(properties !== null && typeof properties === 'object', `${tool.name} needs properties`)
      if (Object.keys(properties).length === 0) {
        assert.equal(schema.additionalProperties, false, `${tool.name} should close its argument object`)
      }
    }
  }
})
