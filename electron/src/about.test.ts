/**
 * About-dialog tests.
 *
 * Two reasons this is tested rather than eyeballed once:
 *  - the first version leaked internal wording (`（Electron 壳）`) and a long user-data path
 *    into a dialog users open to see a version number;
 *  - the debug channel must be *visible as such*, otherwise a user running the debug build
 *    reports bugs against the released one.
 *
 * Run: node --test src/about.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildAbout, formatUptime } from '../src/about.ts'

const base = {
  productName: 'DSH Desktop',
  version: '0.3.7',
  channel: 'release',
  dshVersion: '0.1.7-rc.2',
  runtimeSource: 'bundled',
  port: 41729,
  electron: '44.0.0',
  chrome: '130.0.6723.58',
  node: '24.18.1',
  uptimeMs: 5 * 60_000,
  repository: 'github.com/gzh330205/deepseek-harness-desktop',
} as const

test('the dialog leads with the product and version', () => {
  const about = buildAbout(base)
  assert.equal(about.title, '关于 DSH Desktop')
  assert.equal(about.message, 'DSH Desktop 0.3.7')
})

test('the body answers the questions About is opened for', () => {
  const { detail } = buildAbout(base)
  assert.match(detail, /正式版/u)
  assert.match(detail, /DSH 0\.1\.7-rc\.2（随包）/u)
  assert.match(detail, /端口 41729/u)
  assert.match(detail, /已运行 5 分钟/u)
  // The very first launch is the most likely moment to open About.
  assert.match(buildAbout({ ...base, uptimeMs: 3_000 }).detail, /刚刚启动/u)
  assert.match(detail, /Electron 44\.0\.0 · Chromium 130\.0\.6723\.58 · Node 24\.18\.1/u)
  assert.match(detail, /github\.com\/gzh330205\/deepseek-harness-desktop/u)
})

test('internal details stay out of it', () => {
  const { detail, message } = buildAbout(base)
  for (const leaked of ['Electron 壳', '用户数据', 'C:\\Users', '加载模式', 'cookie', 'bridgeDir']) {
    assert.equal(`${message}\n${detail}`.includes(leaked), false, `不应出现：${leaked}`)
  }
})

test('the debug channel says so, so bugs are not reported against the wrong build', () => {
  const { detail } = buildAbout({ ...base, productName: 'DSH Desktop Debug', channel: 'debug', port: 41731 })
  assert.match(detail, /debug（独立安装，可与正式版共存）/u)
  assert.match(detail, /端口 41731/u)
})

test('a source run and a stopped DSH do not produce broken lines', () => {
  const dev = buildAbout({ ...base, channel: 'development', dshVersion: null, port: null })
  assert.match(dev.detail, /开发版（源码运行）/u)
  assert.match(dev.detail, /DSH 未运行/u)
  assert.equal(/undefined|null|NaN/u.test(dev.detail), false)
  assert.equal(dev.detail.includes('端口'), false, '没有端口时不应留下空标签')
  // The system-runtime case is distinguished from the bundled one.
  assert.match(buildAbout({ ...base, runtimeSource: 'system' }).detail, /DSH 0\.1\.7-rc\.2（系统安装）/u)
})

test('uptime reads like a sentence at every scale', () => {
  assert.equal(formatUptime(0), '不到 1 分钟')
  assert.equal(formatUptime(59_000), '不到 1 分钟')
  assert.equal(formatUptime(60_000), '1 分钟')
  assert.equal(formatUptime(59 * 60_000), '59 分钟')
  assert.equal(formatUptime(60 * 60_000), '1 小时')
  assert.equal(formatUptime(72 * 60_000), '1 小时 12 分钟')
  assert.equal(formatUptime(24 * 60 * 60_000), '1 天')
  assert.equal(formatUptime(50 * 60 * 60_000), '2 天 2 小时')
  assert.equal(formatUptime(-1), '不到 1 分钟')
})
