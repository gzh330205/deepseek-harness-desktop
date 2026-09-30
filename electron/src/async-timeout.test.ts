/**
 * The bound that turns "the renderer never answered" into an actionable tool error.
 *
 * Run: node --test src/async-timeout.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withTimeout } from '../src/async-timeout.ts'

test('a fast promise resolves untouched', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'never'), 'ok')
})

test('a hanging promise rejects with the caller-supplied message', async () => {
  await assert.rejects(
    withTimeout(new Promise<string>(() => {}), 20, '页面脚本执行超时'),
    /页面脚本执行超时/u,
  )
})

test('a rejected promise keeps its own error, not the timeout message', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('renderer gone')), 1000, 'timeout'), /renderer gone/u)
  // A non-Error rejection is normalised.
  await assert.rejects(withTimeout(Promise.reject('boom'), 1000, 'timeout'), /boom/u)
})

test('a non-positive timeout disables the bound', async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 0, 'never'), 1)
  assert.equal(await withTimeout(Promise.resolve(2), Number.NaN, 'never'), 2)
})

test('a rejected promise does not leave a pending timer behind', async () => {
  // If the timer were not cleared, the test process would stay alive for the full timeout.
  const started = Date.now()
  await assert.rejects(withTimeout(Promise.reject(new Error('early')), 5000, 'never'), /early/u)
  assert.ok(Date.now() - started < 1000, 'should not wait for the timeout to fire')
})
