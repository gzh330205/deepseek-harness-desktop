/**
 * Window-geometry tests.
 *
 * The rule that matters: a stored position is only reused when it still lands on a display.
 * Undocking a laptop, or changing resolution, must not open the window where nobody can
 * reach it — the Tauri shell had this, and losing it is the kind of regression a user
 * notices immediately and cannot fix without deleting a file.
 *
 * Run: node --test src/window-state.test.ts
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  MIN_VISIBLE_HEIGHT,
  MIN_VISIBLE_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  fitBounds,
  readWindowState,
  writeWindowState,
} from '../src/window-state.ts'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-window-state-'))
after(() => { rmSync(workDir, { recursive: true, force: true }) })

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondaryRight = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }

test('a position that is still on screen is reused as-is', () => {
  const bounds = { x: 200, y: 120, width: 1280, height: 860 }
  assert.deepEqual(fitBounds(bounds, [primary]), bounds)
  assert.deepEqual(fitBounds({ x: 2100, y: 100, width: 1200, height: 800 }, [primary, secondaryRight]),
    { x: 2100, y: 100, width: 1200, height: 800 })
})

test('a window from a monitor that is gone falls back to the default', () => {
  // Saved on the second display yesterday; today only the laptop panel is attached.
  assert.equal(fitBounds({ x: 2400, y: 300, width: 1200, height: 800 }, [primary]), undefined)
})

test('a mostly off-screen window keeps only a grabable strip', () => {
  const fitted = fitBounds({ x: -1200, y: 0, width: 1280, height: 860 }, [primary])
  assert.notEqual(fitted, undefined)
  assert.equal((fitted?.x ?? 0) + (fitted?.width ?? 0) >= MIN_VISIBLE_WIDTH, true)
  assert.equal(fitted?.width, 1280, '不应改变用户设定的尺寸')
})

test('a title bar hidden above the work area is pulled back down', () => {
  const fitted = fitBounds({ x: 100, y: -200, width: 1280, height: 860 }, [primary])
  assert.equal(fitted?.y, 0)
})

test('degenerate geometry is rejected instead of producing a broken window', () => {
  assert.equal(fitBounds(undefined, [primary]), undefined)
  assert.equal(fitBounds({ x: Number.NaN, y: 0, width: 100, height: 100 }, [primary]), undefined)
  assert.equal(fitBounds({ x: 0, y: 0, width: 100, height: 100 }, []), undefined, '没有显示器时不应复用')
  assert.equal(fitBounds({ x: 0, y: 0, width: 99_999, height: 99_999 }, [primary]), undefined)
})

test('a size below the minimum is raised to the minimum', () => {
  const fitted = fitBounds({ x: 10, y: 10, width: 100, height: 100 }, [primary])
  assert.equal(fitted?.width, WINDOW_MIN_WIDTH)
  assert.equal(fitted?.height, WINDOW_MIN_HEIGHT)
})

test('the stored maximized flag survives a round trip, and a corrupt file does not', () => {
  const directory = join(workDir, 'round')
  writeWindowState(directory, { bounds: { x: 5, y: 6, width: 1000, height: 700 }, maximized: true })
  assert.deepEqual(readWindowState(directory), {
    bounds: { x: 5, y: 6, width: 1000, height: 700 },
    maximized: true,
  })

  const broken = join(workDir, 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'window-state.json'), '{ not json', 'utf8')
  assert.deepEqual(readWindowState(broken), {})

  const partial = join(workDir, 'partial')
  mkdirSync(partial, { recursive: true })
  writeFileSync(join(partial, 'window-state.json'), JSON.stringify({ maximized: true, bounds: { x: 'a' } }), 'utf8')
  assert.deepEqual(readWindowState(partial), { maximized: true })

  assert.deepEqual(readWindowState(join(workDir, 'missing')), {})
})

test('the visible-strip constants stay sane', () => {
  assert.ok(MIN_VISIBLE_WIDTH < WINDOW_MIN_WIDTH)
  assert.ok(MIN_VISIBLE_HEIGHT < WINDOW_MIN_HEIGHT)
})
