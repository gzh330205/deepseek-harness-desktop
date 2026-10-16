/**
 * Run the diagnosis against a **real** profile, when one is pointed at.
 *
 * This is the only test that can catch the false positives a user actually reported, because they are
 * about the files this machine has:
 *
 *  - the profile's own `pnpm-workspace.yaml` was reported as a fatal workspace takeover — but pnpm 11
 *    keeps its settings in exactly that file, and the profile owning one is normal;
 *  - the packages the harness seeds into every profile (`@deepseek-ai/dsh-base`, `dsh-web-app`, the
 *    experimental profiles) were reported as "leftovers", which buried the real findings under
 *    thirteen warnings.
 *
 * Skipped unless `DSH_DESKTOP_MARKET_PROFILE` points at a profile directory, because it reads paths
 * that only exist on a machine that has run the app.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { diagnoseConflicts, readConflictWorld, type ConflictFinding } from './market-conflict.ts'

const profile = process.env.DSH_DESKTOP_MARKET_PROFILE
const skip = profile === undefined || profile === '' ? 'set DSH_DESKTOP_MARKET_PROFILE to a profile directory' : false

test('a real profile is quiet about the things that are normal', { skip }, () => {
  const directory = profile as string
  assert.ok(existsSync(directory), `profile not found: ${directory}`)
  const findings: readonly ConflictFinding[] = diagnoseConflicts(readConflictWorld(directory))
  // Printed so a human can read exactly what the market would show for this profile.
  const lines = findings.map(finding => `    ${finding.severity} ${finding.code} ${finding.subject} — ${finding.message}`)
  process.stdout.write(`\n  [diagnose] ${directory}\n${lines.length === 0 ? '    (nothing to report)' : lines.join('\n')}\n`)

  assert.equal(
    findings.filter(finding => finding.code === 'workspace-takeover' && finding.severity === 'error').length,
    0,
    'a profile that owns its own pnpm-workspace.yaml is not a workspace takeover',
  )
  assert.equal(
    findings.filter(finding => finding.code === 'orphan-install' && finding.subject.startsWith('@deepseek-ai/dsh')).length,
    0,
    'the packages the harness seeds are not leftovers',
  )
  // Real profiles showed a whole family of plugins "patched the same hook", because their patch files
  // are written as lists (`- insert:`) and a list item was being read as a top-level service key.
  assert.equal(
    findings.filter(finding => finding.code === 'capability-overlap' && finding.subject.startsWith('-')).length,
    0,
    'list-form patch entries are not service keys',
  )
  assert.equal(
    findings.filter(finding => finding.code === 'workspace-takeover' && finding.subject.endsWith('pnpm-workspace.yaml') && finding.subject.startsWith(directory.replace(/[\\/]$/u, ''))).length,
    0,
    'the profile owns its settings file',
  )
})
