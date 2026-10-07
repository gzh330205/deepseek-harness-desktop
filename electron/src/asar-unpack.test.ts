/**
 * `asarUnpack` patterns for the runtime inside the app ASAR.
 *
 * A pattern that fails to match is not a slow install — the `.node`/`.exe` stays inside the archive
 * and the app refuses to start, so the escaping rules are pinned here and the packaged build
 * re-asserts them end to end (`scripts/verify-package.mjs`).
 *
 * Run: node --test src/asar-unpack.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asarUnpackPatterns, escapeAsarPattern } from '../scripts/asar-unpack.mjs'

test('an ordinary path is left alone', () => {
  assert.equal(escapeAsarPattern('dsh/node_modules/node-pty/Release/conpty.node'), 'dsh/node_modules/node-pty/Release/conpty.node')
})

test('the characters electron-builder treats as special are neutralised', () => {
  // Scoped packages are the common case here: every `@deepseek-ai/...` path has one.
  assert.equal(escapeAsarPattern('dsh/node_modules/@deepseek-ai/dsh/bin.js'), 'dsh/node_modules/[@]deepseek-ai/dsh/bin.js')
  // `+` and parentheses appear in real package paths (`node-addon-require-builtin` neighbours).
  assert.equal(escapeAsarPattern('a/+b/(c).exe'), 'a/[+]b/[(]c[)].exe')
  // Braces become a single-character wildcard: builder's brace expansion ignores `[...]`.
  assert.equal(escapeAsarPattern('a/{b}.exe'), 'a/?b?.exe')
  // A leading negation marker would turn the whole entry inside out.
  assert.equal(escapeAsarPattern('!weird.exe'), '@(!)weird.exe')
})

test('every runtime file gets a pattern under the source-relative prefix', () => {
  // `runtime/dsh` is the on-disk path; inside the archive the same tree is `dsh/...` and its
  // unpacked twin is `app.asar.unpacked/dsh/...`. electron-builder matches `asarUnpack` against the
  // source path, so the pattern must use that one.
  const patterns = asarUnpackPatterns([
    'bin/node.cmd',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ], 'runtime/dsh')
  assert.deepEqual(patterns, [
    'runtime/dsh/bin/node.cmd',
    'runtime/dsh/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])
})

test('the pattern list is a copy: the manifest is not mutated', () => {
  const physical = ['a.exe']
  asarUnpackPatterns(physical)
  assert.deepEqual(physical, ['a.exe'])
})
