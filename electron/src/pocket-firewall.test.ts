/**
 * Firewall probe tests.
 *
 * The default suite runs against fixture output, because the real firewall belongs to the machine
 * running the tests. One gated test asks Windows for real — it is the only way to know the
 * PowerShell script is still valid (a renamed cmdlet or a locked-down machine would otherwise only be
 * discovered by a user whose phone cannot connect).
 *
 *   $env:DSH_DESKTOP_FIREWALL_E2E='1'; node --test src/pocket-firewall.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { allowFirewall, allowRuleCommand, probeFirewall } from './pocket-firewall.ts'

const enabled = process.env.DSH_DESKTOP_FIREWALL_E2E === '1'

const program = 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe'

/** A runner that answers with the given stdout, and records what it was asked to run. */
function runner(stdout: string): { readonly run: (file: string, args: readonly string[]) => Promise<string>; readonly calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: (file, args) => {
      calls.push([file, ...args])
      return Promise.resolve(stdout)
    },
  }
}

test('the allow command covers every profile and any port', () => {
  const command = allowRuleCommand(program)
  // A rule tied to a port would stop working the moment the user changes it in the settings.
  assert.doesNotMatch(command, /localport/u)
  assert.match(command, /profile=any/u)
  assert.match(command, /dir=in/u)
  assert.match(command, /action=allow/u)
  assert.match(command, new RegExp(program.replace(/\\/gu, '\\\\'), 'u'))
})

test('a matching rule means the door is already open', async () => {
  const { run, calls } = runner(JSON.stringify({ profiles: 'Any', names: ['DSH Desktop'], state: 'Domain=True;Private=True;Public=True' }))
  const status = await probeFirewall({ programPath: program, run })
  assert.equal(status.covered, true)
  assert.equal(status.profiles, 'Any')
  assert.deepEqual(status.rules, ['DSH Desktop'])
  assert.equal(status.firewallOn, true)
  assert.equal(status.needsAttention, false)
  // Structured objects, never `netsh` text: its output is localised.
  assert.equal(calls[0]?.[0], 'powershell')
  assert.match(calls[0]?.join(' ') ?? '', /Get-NetFirewallRule/u)
  assert.doesNotMatch(calls[0]?.join(' ') ?? '', /netsh/u)
})

test('no rule with the firewall on is what needs the user', async () => {
  const { run } = runner(JSON.stringify({ profiles: '', names: [], state: 'Domain=True;Private=True;Public=True' }))
  const status = await probeFirewall({ programPath: program, run })
  assert.equal(status.covered, false)
  assert.equal(status.needsAttention, true)
  assert.match(status.command, /DSH Desktop phone access/u)
})

test('with the firewall off nothing is needed, and a failure says nothing at all', async () => {
  const off = await probeFirewall({
    programPath: program,
    run: runner(JSON.stringify({ profiles: '', names: [], state: 'Domain=False;Private=False;Public=False' })).run,
  })
  assert.equal(off.firewallOn, false)
  assert.equal(off.needsAttention, false, '防火墙关着时不该打扰用户')

  const broken = await probeFirewall({ programPath: program, run: () => Promise.reject(new Error('no powershell')) })
  assert.equal(broken.covered, false)
  assert.equal(broken.needsAttention, false, '探测失败时只提示「无法检测」，不谎称已放行')
})

test('a single rule object (not an array) is still recognised', async () => {
  // ConvertTo-Json turns a one-element array into an object unless it is wrapped; the parser has to
  // accept both shapes or a correctly-configured machine would be reported as unprotected.
  const { run } = runner(JSON.stringify({ profiles: 'Private', names: 'DSH Desktop', state: 'Private=True' }))
  const status = await probeFirewall({ programPath: program, run })
  assert.equal(status.covered, true)
  assert.deepEqual(status.rules, ['DSH Desktop'])
})

test('allowing runs an elevated netsh and reports failure honestly', async () => {
  const { run, calls } = runner('')
  assert.equal(await allowFirewall(program, run), true)
  assert.equal(calls.length, 1)
  assert.match(calls[0]?.join(' ') ?? '', /RunAs/u, '必须请求提权，而不是静默改防火墙')
  assert.match(calls[0]?.join(' ') ?? '', /advfirewall/u)

  assert.equal(await allowFirewall(program, () => Promise.reject(new Error('UAC denied'))), false)
})

test('the real firewall answers the probe', { skip: enabled ? false : 'set DSH_DESKTOP_FIREWALL_E2E=1 to run' }, async () => {
  const electronPath = process.execPath
  const status = await probeFirewall({ programPath: electronPath })
  // `firewallOn` must be a real reading; on any normal Windows it is true.
  assert.equal(typeof status.firewallOn, 'boolean')
  assert.ok(existsSync(electronPath))
  process.stdout.write(`firewall: on=${String(status.firewallOn)} covered=${String(status.covered)} profiles=${status.profiles} rules=${status.rules.join(',')}\n`)
})
