#!/usr/bin/env node
/**
 * Run every `src/*.test.ts`.
 *
 * The list is built here rather than in the test script for two reasons, both of which bit
 * this repository: a hand-written file list silently stops running files added later, and a
 * shell glob is not expanded the same way by every shell npm may use (`node --test
 * "src/*.test.ts"` ran nothing and still exited 0 through npm's cmd shell). An empty match is
 * an error here, so "no tests ran" can never look like success.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(join(root, 'src'))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()

if (files.length === 0) {
  process.stderr.write('run-tests: src 下没有找到任何 *.test.ts\n')
  process.exit(1)
}

process.stdout.write(`run-tests: ${String(files.length)} 个测试文件\n`)
const result = spawnSync(process.execPath, ['--test', ...files.map((name) => join('src', name))], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
