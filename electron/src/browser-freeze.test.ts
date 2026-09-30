/**
 * Freeze/thaw versus hide: the transition that shipped a blank panel twice.
 *
 * The first version cleared the freeze flag inside `hide()`, and `freeze()` called `hide()` to
 * park the surface — so freezing immediately un-froze itself, `unfreeze` believed there was
 * nothing to restore, and closing a menu left the page hidden forever.
 *
 * Run: node --test src/browser-freeze.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FREEZE_IDLE, beginFreeze, blocksSurfaceShow, clearFreeze, endFreeze } from '../src/browser-freeze.ts'

test('a menu over a visible page restores it when it closes', () => {
  const frozen = beginFreeze(true)
  assert.equal(frozen.frozen, true)
  assert.equal(blocksSurfaceShow(frozen), true)
  const ended = endFreeze(frozen)
  assert.equal(ended.restore, true)
  assert.deepEqual(ended.next, FREEZE_IDLE)
})

test('a menu over an already hidden tab must not show it when it closes', () => {
  // The panel keeps a hidden tab's body mounted: opening a menu there freezes a surface that was
  // not on screen, and thawing must not put it back on screen.
  const ended = endFreeze(beginFreeze(false))
  assert.equal(ended.restore, false)
  assert.deepEqual(ended.next, FREEZE_IDLE)
})

test('a plain hide clears the freeze, so a later show() is not mistaken for a menu', () => {
  // This is the regression: park-for-menu, then the tab is hidden, then the panel shows it again.
  const frozen = beginFreeze(true)
  const hidden = clearFreeze()
  assert.equal(blocksSurfaceShow(hidden), false)
  // ...and thawing after that hide must not resurrect anything.
  assert.equal(endFreeze(hidden).restore, false)
  assert.equal(endFreeze(frozen).restore, true, 'the freeze itself still restores when no hide intervened')
})

test('thawing twice is harmless', () => {
  const once = endFreeze(beginFreeze(true))
  const twice = endFreeze(once.next)
  assert.equal(twice.restore, false)
  assert.deepEqual(twice.next, FREEZE_IDLE)
})

test('idle state never blocks showing and never restores', () => {
  assert.equal(blocksSurfaceShow(FREEZE_IDLE), false)
  assert.equal(endFreeze(FREEZE_IDLE).restore, false)
})
