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
