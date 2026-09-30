/**
 * Device emulation: the presets, the custom-viewport bounds, and the effective viewport.
 *
 * Split out of `browser-view.ts` on purpose: that module imports the Electron runtime, and a
 * Node test cannot import it (the npm `electron` module is not the runtime API). Everything
 * here is pure, so the rules the panel's device row depends on are pinned by
 * `browser-device.test.ts` instead of only by hand.
 */

export const DEVICE_PRESETS = ['desktop', 'iphone', 'android'] as const
export type DevicePreset = (typeof DEVICE_PRESETS)[number]

export interface DeviceSpec {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
  readonly platform: string
  readonly userAgent: string
}

/**
 * Chromium device emulation per preset. `desktop` clears the override instead.
 *
 * The iPhone UA is Safari's on purpose: sites sniff the UA string, and an iOS page that
 * believes it is on Chromium desktop is the failure mode worth avoiding. The engine behind
 * it stays Blink, which is exactly what device emulation in a desktop shell can offer.
 */
export const DEVICE_SPECS: Readonly<Record<Exclude<DevicePreset, 'desktop'>, DeviceSpec>> = {
  iphone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    platform: 'iPhone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  android: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    platform: 'Linux armv8l',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
}

/** Bounds for a custom emulated viewport (below this a page is unusable, above it absurd). */
export const MIN_DEVICE_WIDTH = 240
export const MAX_DEVICE_WIDTH = 2560
export const MIN_DEVICE_HEIGHT = 320
export const MAX_DEVICE_HEIGHT = 2560

/** Size a custom viewport starts from when the panel has no size yet. */
export const FALLBACK_DEVICE_SIZE = { width: 1280, height: 800 } as const

export function isDevicePreset(value: unknown): value is DevicePreset {
  return typeof value === 'string' && (DEVICE_PRESETS as readonly string[]).includes(value)
}

/**
 * Clamp a requested custom viewport.
 * @returns the clamped size, or `undefined` when the input is not usable at all.
 */
export function clampDeviceSize(width: unknown, height: unknown): { width: number; height: number } | undefined {
  if (typeof width !== 'number' || typeof height !== 'number') return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
  const clampedWidth = Math.min(MAX_DEVICE_WIDTH, Math.max(MIN_DEVICE_WIDTH, Math.round(width)))
  const clampedHeight = Math.min(MAX_DEVICE_HEIGHT, Math.max(MIN_DEVICE_HEIGHT, Math.round(height)))
  return { width: clampedWidth, height: clampedHeight }
}

/** The preset's own size, or the fallback for `desktop`. */
export function presetSize(preset: DevicePreset): { width: number; height: number } {
  if (preset === 'desktop') return { ...FALLBACK_DEVICE_SIZE }
  const spec = DEVICE_SPECS[preset]
  return { width: spec.width, height: spec.height }
}

/**
 * The viewport the emulation should actually have (rotation swaps the axes).
 *
 * @returns `{width: 0, height: 0}` when nothing is emulated: the real window size applies.
 */
export function effectiveDeviceSize(
  preset: DevicePreset,
  custom: { width: number; height: number } | undefined,
  rotated: boolean,
): { width: number; height: number } {
  if (preset === 'desktop' && custom === undefined) return { width: 0, height: 0 }
  const base = custom ?? presetSize(preset)
  return rotated ? { width: base.height, height: base.width } : base
}
