/**
 * Device emulation rules: presets, viewport clamping, and what the emulation ends up being.
 *
 * The panel's device row (preset / custom size / rotate) goes through these functions, and a
 * wrong viewport is visible only as a broken-looking page — so the rules are pinned here.
 *
 * Run: node --test src/browser-device.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEVICE_PRESETS,
  DEVICE_SPECS,
  FALLBACK_DEVICE_SIZE,
  MAX_DEVICE_HEIGHT,
  MAX_DEVICE_WIDTH,
  MIN_DEVICE_WIDTH,
  clampDeviceSize,
  chromeLikeUserAgent,
  effectiveDeviceSize,
  isDevicePreset,
  presetSize,
} from '../src/browser-device.ts'

test('every preset except desktop has a full spec, and desktop has none', () => {
  assert.deepEqual([...DEVICE_PRESETS], ['desktop', 'iphone', 'android'])
  for (const preset of DEVICE_PRESETS) {
    if (preset === 'desktop') continue
    const spec = DEVICE_SPECS[preset]
    assert.ok(spec.width > 0 && spec.height > 0, `${preset} has no size`)
    assert.ok(spec.deviceScaleFactor > 0, `${preset} has no scale factor`)
    assert.ok(spec.userAgent.includes('Mobile'), `${preset} UA should look like a phone`)
    assert.ok(spec.platform !== '', `${preset} has no platform`)
  }
})

test('preset detection rejects anything else', () => {
  assert.equal(isDevicePreset('iphone'), true)
  assert.equal(isDevicePreset('desktop'), true)
  assert.equal(isDevicePreset('ipad'), false)
  assert.equal(isDevicePreset(undefined), false)
  assert.equal(isDevicePreset(3), false)
})

test('the browser sends a Chrome User-Agent, without Electron in it', () => {
  // The real string Electron 44 hands us for this app (measured with `httpbin.org/user-agent`).
  const electronUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'DSHDesktop/0.3.12 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36'
  assert.equal(
    chromeLikeUserAgent(electronUa),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/152.0.0.0 Safari/537.36',
  )
  // Risk control reads these tokens as "not a real browser".
  assert.equal(chromeLikeUserAgent(electronUa).includes('Electron'), false)
  assert.equal(chromeLikeUserAgent(electronUa).includes('DSHDesktop'), false)
  // The platform tokens Electron computed are kept: Windows, macOS and Linux all stay plausible.
  const mac = chromeLikeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) DSHDesktop/0.3.12 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36')
  assert.ok(mac.startsWith('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'), mac)
  // A Safari-shaped UA (the iPhone preset) has no Chrome token: leave it exactly as it is.
  const safari = DEVICE_SPECS.iphone.userAgent
  assert.equal(chromeLikeUserAgent(safari), safari)
  assert.equal(chromeLikeUserAgent(''), '')
})

test('desktop means "no override" unless a custom size was chosen', () => {
  assert.deepEqual(effectiveDeviceSize('desktop', undefined, false), { width: 0, height: 0 })
  assert.deepEqual(effectiveDeviceSize('desktop', { width: 900, height: 600 }, false), { width: 900, height: 600 })
  // A preset size is its own size.
  assert.deepEqual(effectiveDeviceSize('iphone', undefined, false), {
    width: DEVICE_SPECS.iphone.width,
    height: DEVICE_SPECS.iphone.height,
  })
  assert.deepEqual(effectiveDeviceSize('iphone', undefined, true), {
    width: DEVICE_SPECS.iphone.height,
    height: DEVICE_SPECS.iphone.width,
  })
})

test('rotation swaps the axes, including for a custom viewport', () => {
  assert.deepEqual(effectiveDeviceSize('iphone', { width: 400, height: 900 }, false), { width: 400, height: 900 })
  assert.deepEqual(effectiveDeviceSize('iphone', { width: 400, height: 900 }, true), { width: 900, height: 400 })
})

test('a custom viewport is clamped instead of being rejected or trusted', () => {
  assert.deepEqual(clampDeviceSize(1000, 700), { width: 1000, height: 700 })
  assert.deepEqual(clampDeviceSize(10, 10), { width: MIN_DEVICE_WIDTH, height: 320 })
  assert.deepEqual(clampDeviceSize(99999, 99999), { width: MAX_DEVICE_WIDTH, height: MAX_DEVICE_HEIGHT })
  // Fractions are rounded rather than passed to CDP.
  assert.deepEqual(clampDeviceSize(390.4, 844.6), { width: 390, height: 845 })
  // Non-numbers are refused (the panel sends Number(input.value), which can be NaN).
  assert.equal(clampDeviceSize(Number.NaN, 700), undefined)
  assert.equal(clampDeviceSize('900', 700), undefined)
  assert.equal(clampDeviceSize(900, undefined), undefined)
})

test('the fallback size is what a custom viewport grows from', () => {
  assert.deepEqual(presetSize('desktop'), { ...FALLBACK_DEVICE_SIZE })
  assert.deepEqual(presetSize('android'), { width: DEVICE_SPECS.android.width, height: DEVICE_SPECS.android.height })
})
