/**
 * Update-controller tests.
 *
 * The controller owns the phases the update window renders, and two of them exist purely because of
 * user-visible reports: `installing` must be published **before** the installer handoff (the NSIS run
 * is silent and the app quits, so without it the window just vanished and looked like a failure), and
 * a dismissal must come back to a state the window can offer again.
 *
 * `download()` needs the network and the signature fixture, which `update.test.ts` already covers at
 * the level below; this file pins the orchestration around it.
 *
 * Run: node --test src/update-controller.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UpdateState } from '../src/constants.ts'
import { UpdateController } from '../src/update-controller.ts'

function harness(): {
  controller: UpdateController
  states: UpdateState[]
  installs: string[]
  /** Reach in: the verified installer is private state the download step would have set. */
  markVerified: (controller: UpdateController, path: string) => void
} {
  const states: UpdateState[] = []
  const installs: string[] = []
  const controller = new UpdateController({
    currentVersion: '0.3.16',
    updatesDir: () => 'C:\\updates',
    onState: (state) => { states.push(state) },
    onAvailable: () => {},
    onInstall: (path) => { installs.push(path) },
  })
  return {
    controller,
    states,
    installs,
    markVerified: (target, path) => {
      (target as unknown as { verifiedInstaller?: string }).verifiedInstaller = path
    },
  }
}

test('nothing is installed before something was verified', () => {
  const { controller, installs, states } = harness()
  assert.equal(controller.install(), false)
  assert.deepEqual(installs, [])
  assert.deepEqual(states, [])
})

test('an installation announces itself before the handoff', () => {
  const { controller, installs, states, markVerified } = harness()
  markVerified(controller, 'C:\\updates\\DSH.Desktop_0.3.17_x64-setup.exe')
  assert.equal(controller.install(), true)
  // The window has to render this while the process is still alive.
  assert.equal(states.at(-1)?.phase, 'installing')
  assert.match(states.at(-1)?.message ?? '', /安装/u)
  assert.match(states.at(-1)?.message ?? '', /自动/u)
  assert.deepEqual(installs, ['C:\\updates\\DSH.Desktop_0.3.17_x64-setup.exe'])
})

test('dismissing offers the update again instead of dropping it', () => {
  const { controller } = harness()
  // No manifest read yet: there is nothing to offer.
  controller.dismiss()
  assert.equal(controller.current.phase, 'idle')

  // Reaching in for state the download step would own. Kept as a named local: a statement starting
  // with `(` would be glued to the previous call by automatic semicolon insertion.
  const internals = controller as unknown as { manifest?: unknown; verifiedInstaller?: string }
  internals.manifest = { version: '0.3.17', entry: { url: '', signature: '' } }
  controller.dismiss()
  assert.equal(controller.current.phase, 'available')
  assert.equal(controller.current.version, '0.3.17')

  // Once verified, dismissing returns to the installable state, not to the download offer.
  internals.verifiedInstaller = 'C:\\updates\\x.exe'
  controller.dismiss()
  assert.equal(controller.current.phase, 'ready')
})
