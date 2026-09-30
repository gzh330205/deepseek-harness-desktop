/**
 * Control handover rules: the wait, the idle window, and what the agent is told.
 *
 * Run: node --test src/browser-control.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACTIVITY_MARKER,
  ACTIVITY_PROBE_SCRIPT,
  CONTROL_NOTE_SOURCE,
  CONTROL_WAIT_SECONDS,
  DEFAULT_AUTO_RELEASE_SECONDS,
  MAX_AUTO_RELEASE_SECONDS,
  MIN_AUTO_RELEASE_SECONDS,
  clampAutoReleaseSeconds,
  controlNote,
  isActivityMessage,
  isAutoReleaseDue,
  nextAutoReleaseAt,
  releasedPrefix,
  shouldWriteControlNote,
  waitTimeoutText,
} from '../src/browser-control.ts'

test('the idle window is clamped, and bad input falls back to the default', () => {
  assert.equal(clampAutoReleaseSeconds(30), 30)
  assert.equal(clampAutoReleaseSeconds(1), MIN_AUTO_RELEASE_SECONDS)
  assert.equal(clampAutoReleaseSeconds(99999), MAX_AUTO_RELEASE_SECONDS)
  assert.equal(clampAutoReleaseSeconds(29.6), 30)
  assert.equal(clampAutoReleaseSeconds(undefined), DEFAULT_AUTO_RELEASE_SECONDS)
  assert.equal(clampAutoReleaseSeconds(Number.NaN), DEFAULT_AUTO_RELEASE_SECONDS)
  assert.equal(clampAutoReleaseSeconds('60'), DEFAULT_AUTO_RELEASE_SECONDS)
})

test('every activity event moves the deadline forward', () => {
  const start = 1_000_000
  const deadline = nextAutoReleaseAt(start, 30)
  assert.equal(deadline, start + 30_000)
  // Activity at t+10s pushes the deadline to t+40s: the user keeps control while they keep working.
  const moved = nextAutoReleaseAt(start + 10_000, 30)
  assert.equal(moved, start + 40_000)
  assert.equal(isAutoReleaseDue(start + 39_999, moved), false)
  assert.equal(isAutoReleaseDue(start + 40_000, moved), true)
  // No deadline (never taken over) is never due.
  assert.equal(isAutoReleaseDue(start, 0), false)
})

test('the wait cap stays below the transport timeouts', () => {
  // MCP cuts a call at 120s and the native tool at 180s; a wait that outlives them would look
  // like a hung tool instead of an answerable outcome.
  assert.ok(CONTROL_WAIT_SECONDS < 120, `CONTROL_WAIT_SECONDS=${String(CONTROL_WAIT_SECONDS)} must fit inside 120s`)
  assert.ok(CONTROL_WAIT_SECONDS > DEFAULT_AUTO_RELEASE_SECONDS * 2, 'the cap should allow several idle windows')
})

test('a call that waited says so when it continues', () => {
  assert.match(releasedPrefix(12.4), /交还给了助手/u)
  assert.match(releasedPrefix(12.4), /12 秒/u)
  assert.match(releasedPrefix(12.4), /继续执行/u)
  // Sub-second waits do not pretend to have waited.
  assert.equal(releasedPrefix(0.2).includes('秒'), false)
})

test('a call that never got control back is told what to do instead', () => {
  const text = waitTimeoutText(100)
  assert.match(text, /仍在操作浏览器/u)
  assert.match(text, /100 秒/u)
  assert.match(text, /没有执行/u)
  assert.match(text, /自动交还/u)
  assert.match(text, /立即交还/u)
})

test('the session note names the state and the idle window', () => {
  const taken = controlNote('taken', 30)
  assert.match(taken, /^【浏览器·通知，无需动作】/u)
  assert.match(taken, /用户点了浏览器页面/u)
  assert.match(taken, /30 秒/u)
  assert.match(taken, /自动交还/u)
  assert.equal(controlNote('released', 30).includes('30 秒'), false)
  assert.match(controlNote('released', 30), /已把控制权交还/u)
  assert.match(controlNote('expired', 30), /自动交还/u)
})

test('a session note must never read like an instruction to stop', () => {
  // A real session read the older wording ("用户已接管…不要重复尝试操作页面") and answered
  // "我暂停所有页面操作，等控制权交还后再继续" — then ended its turn, and nothing ever resumed it.
  for (const state of ['taken', 'released', 'expired'] as const) {
    const note = controlNote(state, 30)
    assert.match(note, /无需动作/u, `${state} must say it needs no action`)
  }
  // The takeover note must forbid the two behaviours that ended that turn.
  assert.match(controlNote('taken', 30), /不要因此结束回合/u)
  assert.match(controlNote('taken', 30), /不要承诺稍后继续/u)
})

test('a note is only written when the hold cannot carry the news itself', () => {
  // A call in flight will be held, and its own result explains the wait.
  assert.equal(shouldWriteControlNote({ state: 'taken', agentActive: true }, false), false)
  // Nothing in flight: the agent would otherwise never hear about it.
  assert.equal(shouldWriteControlNote({ state: 'taken', agentActive: false }, false), true)
  // The hand-back note closes the takeover note; without one it is noise.
  assert.equal(shouldWriteControlNote({ state: 'released', agentActive: false }, true), true)
  assert.equal(shouldWriteControlNote({ state: 'released', agentActive: false }, false), false)
  assert.equal(shouldWriteControlNote({ state: 'released', agentActive: true }, false), false)
})

test('the session note can never be mistaken for the user speaking', () => {
  // DSH treats `source.kind === 'user'` as a real prompt; anything else is history the model
  // reads without a new turn being started. This constant is what keeps that guarantee.
  assert.notEqual(CONTROL_NOTE_SOURCE, 'user')
  assert.equal(typeof CONTROL_NOTE_SOURCE, 'string')
  assert.ok(CONTROL_NOTE_SOURCE.length > 0)
})

test('the page-side activity probe is passive, idempotent and quiet', () => {
  assert.ok(ACTIVITY_PROBE_SCRIPT.includes('__dshActivityProbe'))
  assert.ok(ACTIVITY_PROBE_SCRIPT.includes('already'), 'it must bail out when already installed')
  assert.ok(ACTIVITY_PROBE_SCRIPT.includes('passive: true'))
  assert.equal(ACTIVITY_PROBE_SCRIPT.includes('preventDefault'), false, 'it must never change page behaviour')
  assert.equal(ACTIVITY_PROBE_SCRIPT.includes('innerHTML'), false, 'it must not touch the DOM')
  assert.ok(ACTIVITY_PROBE_SCRIPT.includes(ACTIVITY_MARKER))
  assert.ok(ACTIVITY_PROBE_SCRIPT.includes('400'), 'reports are throttled')
  // Only our marker counts as activity traffic (page logs must keep flowing to diagnostics).
  assert.equal(isActivityMessage(ACTIVITY_MARKER), true)
  assert.equal(isActivityMessage(`[Violation] ${ACTIVITY_MARKER}`), true)
  assert.equal(isActivityMessage('Uncaught TypeError'), false)
  assert.equal(isActivityMessage(undefined), false)
})
