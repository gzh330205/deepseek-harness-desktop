/**
 * Where the phone gateway keeps its password.
 *
 * Passwords live beside the shell's other state rather than in `shell-settings.json` on purpose:
 * the settings document is a user-editable config that the settings page rewrites wholesale, and a
 * secret the user never typed has no business round-tripping through a config merge. The file is
 * created on first read, so the settings page always has something real to show and the QR code
 * exists before anyone opens it.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { generatePocketPassword, validatePocketPassword } from './pocket-auth.ts'

export const POCKET_STATE_FILENAME = 'pocket.json'
export const POCKET_STATE_VERSION = 1

export interface PocketState {
  readonly version: number
  /** LAN password; regenerated when the file is missing or the value cannot be used. */
  readonly lan: {
    readonly password: string
  }
  /** Address the user picked when automatic selection was wrong, if any. */
  readonly address?: string
}

export interface PocketStateRead {
  readonly state: PocketState
  /** Whether the password in `state` was minted now, so the caller can log it once. */
  readonly generated: boolean
}

/**
 * Read the state file, minting a password when there is nothing usable.
 *
 * @param path - Absolute path of the state file.
 * @param generate - Password source; injected for tests.
 * @returns The state and whether it had to be created.
 */
export function readPocketState(path: string, generate: () => string = generatePocketPassword): PocketStateRead {
  // A missing file is the normal first run, not an error: that path mints the first password.
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = ''
  }
  const existing = parse(text)
  if (existing !== undefined) return { state: existing, generated: false }

  const state: PocketState = { version: POCKET_STATE_VERSION, lan: { password: generate() } }
  writePocketState(path, state)
  return { state, generated: true }
}

/**
 * Write the state file atomically.
 *
 * A half-written password file is worse than none: the next read would mint a *different*
 * password while the phone still holds the old one, and the user would have no way to tell which
 * of the two the settings page is showing.
 *
 * @param path - Absolute path of the state file.
 * @param state - State to persist.
 */
export function writePocketState(path: string, state: PocketState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Parse a state file.
 *
 * @param text - Raw file contents.
 * @returns The state, or `undefined` when the file is missing, broken, or holds no usable password.
 */
function parse(text: string): PocketState | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const lan = typeof record.lan === 'object' && record.lan !== null ? record.lan as Record<string, unknown> : {}
  const password = typeof lan.password === 'string' ? lan.password : ''
  // A hand-edited or truncated password is replaced rather than rejected: refusing to start would
  // leave the feature unusable with no way out from the settings page.
  if (password === '' || validatePocketPassword(password) !== undefined) return undefined
  return {
    version: POCKET_STATE_VERSION,
    lan: { password },
    ...(typeof record.address === 'string' && record.address !== '' ? { address: record.address } : {}),
  }
}
