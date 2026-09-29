/**
 * Remember where the main window was, and where it may safely reappear.
 *
 * The Tauri shell kept this in `.window-state.json`; the Electron shell has to do it
 * itself. The interesting part is not saving a rectangle but *refusing* one: a stored
 * position is only meaningful for the monitor layout that produced it, and a laptop that
 * was docked to a second screen yesterday must not open its window off-screen today.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const WINDOW_STATE_FILENAME = 'window-state.json'

/** Same minimums the window is created with. */
export const WINDOW_MIN_WIDTH = 920
export const WINDOW_MIN_HEIGHT = 620
/** How much of the window must land on a display for its position to be reused. */
export const MIN_VISIBLE_WIDTH = 160
export const MIN_VISIBLE_HEIGHT = 80

export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The parts of Electron's `Display` this module needs. */
export interface DisplayLike {
  readonly workArea: WindowBounds
}

export interface StoredWindowState {
  readonly bounds?: WindowBounds
  readonly maximized?: boolean
}

/** Normalise to finite integers within sane limits, or reject. */
function normalize(bounds: WindowBounds): WindowBounds | undefined {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(value => Number.isFinite(value))) return undefined
  const width = Math.max(WINDOW_MIN_WIDTH, Math.round(bounds.width))
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.round(bounds.height))
  // A window larger than any monitor is a symptom of stale state, not a preference.
  if (width > 20_000 || height > 20_000) return undefined
  return { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height }
}

function overlap(a: WindowBounds, b: WindowBounds): { readonly x: number; readonly y: number } {
  return {
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

/**
 * Decide whether a stored rectangle may be reused, and where.
 *
 * @param bounds - Rectangle from the state file.
 * @param displays - Current displays' work areas.
 * @returns Usable geometry, or `undefined` to fall back to the default window.
 */
export function fitBounds(bounds: WindowBounds | undefined, displays: readonly DisplayLike[]): WindowBounds | undefined {
  if (bounds === undefined || displays.length === 0) return undefined
  const rect = normalize(bounds)
  if (rect === undefined) return undefined

  // Any positive overlap means the window is still (partly) on a real display, and the
  // clamp below guarantees a grabable strip. No overlap at all means the display this
  // position belonged to is gone, and the default placement is the right answer.
  const host = displays.find((display) => {
    const { x, y } = overlap(rect, display.workArea)
    return x > 0 && y > 0
  })
  if (host === undefined) return undefined

  const { workArea } = host
  // Keep the size, but guarantee a grabable strip stays inside the work area (a taskbar
  // or a change of resolution can otherwise hide the title bar).
  const x = Math.min(
    Math.max(rect.x, workArea.x - rect.width + MIN_VISIBLE_WIDTH),
    workArea.x + workArea.width - MIN_VISIBLE_WIDTH,
  )
  const y = Math.min(Math.max(rect.y, workArea.y), workArea.y + workArea.height - MIN_VISIBLE_HEIGHT)
  return { x, y, width: rect.width, height: rect.height }
}

export function readWindowState(directory: string): StoredWindowState {
  const path = join(directory, WINDOW_STATE_FILENAME)
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const bounds = raw.bounds
    const maximized = raw.maximized === true
    if (typeof bounds !== 'object' || bounds === null) return { maximized }
    const candidate = bounds as Record<string, unknown>
    if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number'
      || typeof candidate.width !== 'number' || typeof candidate.height !== 'number') {
      return { maximized }
    }
    return {
      bounds: { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height },
      maximized,
    }
  } catch {
    // A corrupt state file must never stop the app from opening a window.
    return {}
  }
}

export function writeWindowState(directory: string, state: StoredWindowState): void {
  const path = join(directory, WINDOW_STATE_FILENAME)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only: losing a window position is not worth an error dialog.
  }
}
