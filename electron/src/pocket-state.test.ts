import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readPocketState, writePocketState } from './pocket-state.ts'

const directory = (): string => mkdtempSync(join(tmpdir(), 'pocket-state-'))

test('a missing state file gets a password, and the file is written', () => {
  const dir = directory()
  const path = join(dir, 'pocket.json')
  const { state, generated } = readPocketState(path, () => 'Abcd1234')
  assert.equal(generated, true)
  assert.equal(state.lan.password, 'Abcd1234')

  // Persisted immediately: the settings page and the QR code must describe the same password even
  // before the user has opened anything.
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { lan: { password: string } }
  assert.equal(onDisk.lan.password, 'Abcd1234')
})

test('an existing password is reused rather than replaced', () => {
  const dir = directory()
  const path = join(dir, 'pocket.json')
  writePocketState(path, { version: 1, lan: { password: 'Keep1234' }, address: '192.168.1.7' })
  const { state, generated } = readPocketState(path, () => 'Fresh999')
  assert.equal(generated, false)
  assert.equal(state.lan.password, 'Keep1234')
  assert.equal(state.address, '192.168.1.7')
})

test('a broken or unusable file is replaced instead of blocking the feature', () => {
  for (const content of ['{ not json', '{}', '{"lan":{"password":"short"}}', '{"lan":{"password":"has-dash"}}']) {
    const dir = directory()
    const path = join(dir, 'pocket.json')
    writeFileSync(path, content, 'utf8')
    const { state, generated } = readPocketState(path, () => 'New12345')
    assert.equal(generated, true, content)
    assert.equal(state.lan.password, 'New12345', content)
    // The replacement is written back, so the next read is stable.
    assert.equal(readPocketState(path, () => 'Other999').state.lan.password, 'New12345')
  }
})

test('writing leaves no temporary file behind', () => {
  const dir = directory()
  const path = join(dir, 'pocket.json')
  writePocketState(path, { version: 1, lan: { password: 'Abcd1234' } })
  assert.deepEqual(readdirSync(dir), ['pocket.json'])
})
