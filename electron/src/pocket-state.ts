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

export interface PocketTunnelRecord {
  readonly mode: 'quick' | 'named'
  /** The user's own hostname, in named mode. */
  readonly domain?: string
  /** Cloudflare Tunnel token; a credential, which is why it lives here and not in the settings file. */
  readonly token?: string
  /**
   * Whether the disclaimer was accepted for this configuration.
   *
   * Written only when the user turns public access on themselves, and cleared when they turn it off —
   * so a restart can restore a tunnel they opened, and can never open one they did not.
   */
  readonly accepted: boolean
}

export interface PocketState {
  readonly version: number
  /** LAN password; regenerated when the file is missing or the value cannot be used. */
  readonly lan: {
    readonly password: string
  }
  /**
   * Public password.
   *
   * Rotated on every start unless the user set a fixed one: a random `*.trycloudflare.com` hostname
   * already changes every time, and a password that changes with it means a leaked address is useless
   * as soon as the tunnel is restarted.
   */
  readonly public?: {
    readonly password: string
    readonly custom: boolean
  }
  readonly tunnel?: PocketTunnelRecord
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
  const publicRecord = typeof record.public === 'object' && record.public !== null ? record.public as Record<string, unknown> : {}
  const publicPassword = typeof publicRecord.password === 'string' ? publicRecord.password : ''
  const tunnelRecord = typeof record.tunnel === 'object' && record.tunnel !== null ? record.tunnel as Record<string, unknown> : {}
  return {
    version: POCKET_STATE_VERSION,
    lan: { password },
    // A broken public password is simply dropped: it is regenerated at the next start, and an
    // unusable value here must not stop the LAN side from working.
    ...(validatePocketPassword(publicPassword) === undefined && publicPassword !== ''
      ? { public: { password: publicPassword, custom: publicRecord.custom === true } }
      : {}),
    ...(tunnelRecord.mode === 'quick' || tunnelRecord.mode === 'named'
      ? {
          tunnel: {
            mode: tunnelRecord.mode,
            accepted: tunnelRecord.accepted === true,
            ...(typeof tunnelRecord.domain === 'string' && tunnelRecord.domain !== '' ? { domain: tunnelRecord.domain } : {}),
            ...(typeof tunnelRecord.token === 'string' && tunnelRecord.token !== '' ? { token: tunnelRecord.token } : {}),
          },
        }
      : {}),
    ...(typeof record.address === 'string' && record.address !== '' ? { address: record.address } : {}),
  }
}

/**
 * Write the tunnel record, keeping the rest of the state as it is.
 *
 * @param path - Absolute path of the state file.
 * @param record - The record to store, or `undefined` to forget it.
 */
export function writePocketTunnelRecord(path: string, record: PocketTunnelRecord | undefined): void {
  const current = readPocketState(path).state
  const next: PocketState = record === undefined
    ? {
        version: current.version,
        lan: current.lan,
        ...(current.public === undefined ? {} : { public: current.public }),
        ...(current.address === undefined ? {} : { address: current.address }),
      }
    : { ...current, tunnel: record }
  writePocketState(path, next)
}
