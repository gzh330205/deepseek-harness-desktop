/**
 * Panel event-name contract tests.
 *
 * The preload refuses any emit whose name is not in {@link PANEL_EMIT_EVENTS}, and the notification
 * plugin's `emit` resolves either way — so a name that drifts does not error anywhere: the plugin
 * assumes the shell showed the notification, never falls back to a browser notification, and the
 * user sees nothing. The plugin's event name is its own `tauriEventName` setting, documented as
 * `dsh-notify`; this list once carried the package name `dsh-win-notify` instead, which cost exactly
 * that silent failure. Pin the names here so a rename cannot pass unnoticed again.
 *
 * Run: node --test src/panel-events.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { IPC, PANEL_EMIT_EVENTS, PANEL_LISTEN_EVENTS } from '../src/constants.ts'

test('the notification plugin event name is accepted, in both spellings', () => {
  const accepted = PANEL_EMIT_EVENTS as readonly string[]
  // `dsh-win-notify`'s client half emits `config.tauriEventName`, whose default the plugin's README
  // documents as `dsh-notify` for shell integration.
  assert.ok(accepted.includes('dsh-notify'), 'the plugin default event name must be accepted')
  // Older configurations may still carry the package-name spelling.
  assert.ok(accepted.includes('dsh-win-notify'))
})

test('the panel plugin event name is accepted', () => {
  assert.ok((PANEL_EMIT_EVENTS as readonly string[]).includes('dsh-desktop-shell'))
})

test('nothing else is accepted, and the shell only pushes its own state event', () => {
  assert.deepEqual([...(PANEL_EMIT_EVENTS as readonly string[])].sort(), [
    'dsh-desktop-shell',
    'dsh-notify',
    'dsh-win-notify',
  ])
  assert.deepEqual([...PANEL_LISTEN_EVENTS], ['dsh-desktop-state'])
})

test('a refused emit is reported on its own channel', () => {
  // Diagnostics only: the shell logs refused names so "the plugin emitted and nothing happened" is
  // visible in shell.log. It must not be the channel that carries real events.
  assert.notEqual(IPC.panelDropped, IPC.panelEvent)
  assert.equal(IPC.panelDropped, 'dsh-desktop:panel-dropped')
})
