/**
 * Channel tests.
 *
 * The debug channel exists so the new shell can be installed next to the shipping Tauri
 * app. The port is the part that decides whether it can start at all — the Tauri app
 * already holds 41729 — so that is pinned here, along with the identity fields that keep
 * the two copies from sharing settings or profiles.
 *
 * Run: node --test src/channel.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHANNELS, CHANNEL_ENV, channelConfig, resolveChannel } from '../src/constants.ts'
import { resolvePort } from '../src/gates.ts'

test('the channel comes from the environment, then from the packaged metadata', () => {
  assert.equal(resolveChannel({ [CHANNEL_ENV]: 'debug' }), 'debug')
  assert.equal(resolveChannel({}, 'debug'), 'debug')
  assert.equal(resolveChannel({ [CHANNEL_ENV]: 'release' }, 'debug'), 'release')
  assert.equal(resolveChannel({}), 'release')
  assert.equal(resolveChannel({}, 'something-else'), 'release')
})

test('running from source never shares the installed app\'s state', () => {
  // `pnpm dev` must not write shell-settings.json / desktop-facts.json / window-state.json
  // into the directory an installed release build is using.
  assert.equal(resolveChannel({}, undefined, false), 'development')
  assert.equal(resolveChannel({}, 'something-else', false), 'development')
  // An explicit choice, or a channel baked at package time, still wins.
  assert.equal(resolveChannel({ [CHANNEL_ENV]: 'release' }, undefined, false), 'release')
  assert.equal(resolveChannel({}, 'debug', false), 'debug')
  // Packaged builds stay on release when the baked value is missing.
  assert.equal(resolveChannel({}, undefined, true), 'release')
})

test('the debug channel can never take the release port', () => {
  // The shipping desktop app listens on 41729; the debug build would fail its port gate.
  assert.equal(CHANNELS.release.defaultPort, 41729)
  assert.notEqual(CHANNELS.debug.defaultPort, CHANNELS.release.defaultPort)
  assert.equal(resolvePort(undefined, CHANNELS.debug.defaultPort), CHANNELS.debug.defaultPort)
})

test('no two channels share state', () => {
  const release = channelConfig('release')
  const debug = channelConfig('debug')
  const development = channelConfig('development')
  const channels = [release, debug, development]
  for (const key of ['productName', 'userDataDirName', 'defaultPort', 'profileName'] as const) {
    const values = channels.map(channel => channel[key])
    assert.equal(new Set(values).size, channels.length, `${key} 在各通道间必须互不相同`)
  }
  assert.match(debug.productName, /Debug/u)
  assert.match(debug.userDataDirName, /\.debug$/u)
  assert.match(debug.profileName, /-debug$/u)
  // Only the shipped app offers to uninstall a leftover Tauri install; the debug channel
  // must not talk the user into removing their working copy.
  assert.equal(release.legacyCleanup, true)
  assert.equal(debug.legacyCleanup, false)
})

test('an explicit port still wins in either channel', () => {
  const previous = process.env.DSH_DESKTOP_PORT
  process.env.DSH_DESKTOP_PORT = '41999'
  try {
    assert.equal(resolvePort(undefined, CHANNELS.debug.defaultPort), 41999)
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_PORT
    else process.env.DSH_DESKTOP_PORT = previous
  }
  // The settings file is consulted before the channel default.
  assert.equal(resolvePort(41800, CHANNELS.debug.defaultPort), 41800)
})
