/**
 * Runtime packaging policy tests.
 *
 * These names are the whole point: a real install failed because `win10-arm64` did not
 * match a regex written for `win32-arm64`, so two ARM64 conpty files shipped, entered the
 * integrity set, and did not survive installation.
 *
 * Run: node --test src/runtime-policy.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isForeignPlatformPath } from '../scripts/runtime-policy.mjs'

const foreign = (path: string): boolean => isForeignPlatformPath(path, 'win32', 'x64')

test('the two ARM64 files that broke a real install are foreign', () => {
  assert.equal(foreign('node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64/OpenConsole.exe'), true)
  assert.equal(foreign('node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64/conpty.dll'), true)
})

test('the x64 counterparts are kept', () => {
  assert.equal(foreign('node_modules/node-pty/third_party/conpty/1.25.260303002/win10-x64/OpenConsole.exe'), false)
  assert.equal(foreign('node_modules/node-pty/third_party/conpty/1.25.260303002/win10-x64/conpty.dll'), false)
  assert.equal(foreign('node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe'), false)
  assert.equal(foreign('node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node'), false)
  assert.equal(foreign('node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilds/x.node'), false)
})

test('pnpm reflink builds follow the same rule', () => {
  assert.equal(foreign('node_modules/pnpm/dist/reflink.darwin-arm64-2HJ4WGO6.node'), true)
  assert.equal(foreign('node_modules/pnpm/dist/reflink.win32-arm64-msvc-Q6BARPPB.node'), true)
  assert.equal(foreign('node_modules/pnpm/dist/reflink.win32-x64-msvc-XXXXXXXX.node'), false)
})

test('foreign operating systems are foreign whatever the architecture', () => {
  for (const path of [
    'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
    'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node',
    'node_modules/@esbuild/linux-x64/bin/esbuild',
    'node_modules/koffi/build/koffi/linux_x64/koffi.node',
    'node_modules/koffi/src/koffi/src/abi/arm64.cc',
  ]) {
    assert.equal(foreign(path), true, path)
  }
})

test('ordinary runtime files are never touched', () => {
  for (const path of [
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js',
    'bin/pnpm.cmd',
    'bin/node.cmd',
    'desktop-runtime.json',
    'node_modules/@koromix/koffi/win32_x64/koffi.node',
  ]) {
    assert.equal(foreign(path), false, path)
  }
})

test('the target platform/arch is never pruned, on any host', () => {
  // Windows paths use backslashes in the wild.
  assert.equal(isForeignPlatformPath('node_modules/x/win32-x64/a.node'.replace(/\//gu, '\\'), 'win32', 'x64'), false)
  // A macOS build must keep darwin and prune win32.
  assert.equal(isForeignPlatformPath('node_modules/@img/sharp-darwin-arm64/lib/x.node', 'darwin', 'arm64'), false)
  assert.equal(isForeignPlatformPath('node_modules/@img/sharp-win32-x64/lib/x.node', 'darwin', 'arm64'), true)
})
