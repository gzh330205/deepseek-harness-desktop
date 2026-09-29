#!/usr/bin/env node
/**
 * Build the debug channel.
 *
 * Runs the same pipeline as the release build, but with `DSH_DESKTOP_CHANNEL=debug`, which
 * gives the app its own appId, product name, install directory, shortcut, userData, DSH
 * profile and default port. That is what lets it be installed and run next to the shipping
 * Tauri app (which already holds port 41729) without either copy noticing the other.
 *
 * Cross-platform environment plumbing lives here so `package.json` stays a single command
 * per target and Windows users need no `cross-env`.
 *
 * Usage: node scripts/package-debug.mjs [--dir]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directoryOnly = process.argv.includes('--dir')
const environment = { ...process.env, DSH_DESKTOP_CHANNEL: 'debug' }

const run = (command, args) => {
  process.stdout.write(`\n==> ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: environment, windowsHide: false })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const node = process.execPath
run(node, [join(root, 'scripts', 'prepare-runtime.mjs')])
run(node, [join(root, 'build.mjs')])
run(node, [join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', ...directoryOnly ? ['--dir'] : ['nsis'], '--publish', 'never', '--config', join(root, 'electron-builder.config.mjs')])
run(node, [join(root, 'scripts', 'verify-package.mjs'), '--dir', join(root, 'release-debug', 'win-unpacked')])

process.stdout.write('\n==> debug 通道构建完成\n')
