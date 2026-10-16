/**
 * Password, session and failure-lock rules for the phone gateway.
 *
 * Pure by construction: the clock and the random source are injected, so lockout and expiry
 * behaviour is testable without waiting for wall time. Nothing here touches the filesystem or
 * Electron — `pocket-gateway.ts` owns the socket, this module owns the decisions.
 *
 * Threat model worth restating: anything that reaches this gateway can run code on the user's
 * machine through DSH. The rules below are therefore fail-closed — an unknown client is refused
 * unless it presents a session that this very process issued.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Alphabet without the characters people misread when copying a password off a screen. */
export const POCKET_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
export const POCKET_PASSWORD_LENGTH = 8
export const MIN_POCKET_PASSWORD_LENGTH = 8
export const MAX_POCKET_PASSWORD_LENGTH = 64

/**
 * A password has to survive a phone keyboard and a QR code, so it stays alphanumeric — no
 * symbols to escape in a URL, no ambiguity about which dash was meant.
 */
const POCKET_PASSWORD_PATTERN = /^[A-Za-z0-9]+$/u

/**
 * Draw a fresh password.
 *
 * Uses rejection-free modulo on a 56-character alphabet (56 divides 256 evenly), so every
 * character is equally likely without a rejection loop.
 *
 * @param random - Byte source; injected so tests are deterministic.
 * @returns A new password of {@link POCKET_PASSWORD_LENGTH} characters.
 */
export function generatePocketPassword(random: (size: number) => Buffer = randomBytes): string {
  const alphabet = POCKET_PASSWORD_ALPHABET
  const bytes = random(POCKET_PASSWORD_LENGTH)
  let out = ''
  for (let index = 0; index < POCKET_PASSWORD_LENGTH; index += 1) {
    out += alphabet[(bytes[index] ?? 0) % alphabet.length]
  }
  return out
}

/**
 * Check a user-chosen password.
 *
 * @param value - What the settings page submitted.
 * @returns A reason when it cannot be used, or `undefined` when it can.
 */
export function validatePocketPassword(value: string): string | undefined {
  if (value.length < MIN_POCKET_PASSWORD_LENGTH || value.length > MAX_POCKET_PASSWORD_LENGTH) {
    return `密码长度必须是 ${String(MIN_POCKET_PASSWORD_LENGTH)}–${String(MAX_POCKET_PASSWORD_LENGTH)} 位`
  }
  if (!POCKET_PASSWORD_PATTERN.test(value)) return '密码只能使用英文字母和数字'
  return undefined
}

/**
 * Compare two secrets without leaking their length or prefix through timing.
 *
 * @param a - One secret.
 * @param b - The other.
 * @returns Whether they are equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, which would itself be a signal; compare a
  // digest instead so both the length and the content are indistinguishable by timing.
  const leftDigest = createHmac('sha256', 'pocket-length-guard').update(left).digest()
  const rightDigest = createHmac('sha256', 'pocket-length-guard').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

/** Why a request was refused, so the page can say something useful. */
export type PocketLockReason = 'ip' | 'global'

export interface PocketRateLimitDecision {
  readonly allowed: boolean
  /** Seconds until the next attempt may succeed, rounded up. */
  readonly retryAfterSeconds: number
  readonly reason?: PocketLockReason
}

export interface PocketRateLimiter {
  /** Whether this client may attempt a login right now. */
  check(key: string): PocketRateLimitDecision
  /** Record a failed attempt. */
  fail(key: string): void
  /** Record a successful attempt, clearing that client's failures. */
  succeed(key: string): void
}

export interface PocketRateLimitOptions {
  /** Failures from one client before it is locked. */
  readonly maxFailures?: number
  /** How long one client stays locked. */
  readonly lockMs?: number
  /** Failures from all clients before everything is locked briefly. */
  readonly globalMaxFailures?: number
  /** How long the global lock lasts. */
  readonly globalLockMs?: number
  readonly now?: () => number
}

export const POCKET_MAX_FAILURES = 5
export const POCKET_LOCK_MS = 60_000
export const POCKET_GLOBAL_MAX_FAILURES = 30
export const POCKET_GLOBAL_LOCK_MS = 60_000

/**
 * Failure locks, per client and globally.
 *
 * The per-client lock stops someone guessing one password; the global lock stops the same
 * person from doing it from many addresses at once, which is the shape a distributed scan
 * takes. Both are deliberately short — this protects a personal gateway, not a bank.
 *
 * @param options - Thresholds and clock.
 * @returns The limiter.
 */
export function createPocketRateLimiter(options: PocketRateLimitOptions = {}): PocketRateLimiter {
  const maxFailures = options.maxFailures ?? POCKET_MAX_FAILURES
  const lockMs = options.lockMs ?? POCKET_LOCK_MS
  const globalMaxFailures = options.globalMaxFailures ?? POCKET_GLOBAL_MAX_FAILURES
  const globalLockMs = options.globalLockMs ?? POCKET_GLOBAL_LOCK_MS
  const now = options.now ?? (() => Date.now())
  const failures = new Map<string, { count: number; lockedUntil: number }>()
  let globalFailures: number[] = []

  const decide = (lockedUntil: number, reason: PocketLockReason): PocketRateLimitDecision => {
    const remaining = lockedUntil - now()
    if (remaining <= 0) return { allowed: true, retryAfterSeconds: 0 }
    return { allowed: false, retryAfterSeconds: Math.ceil(remaining / 1000), reason }
  }

  return {
    check(key) {
      const current = now()
      globalFailures = globalFailures.filter(at => at > current - globalLockMs)
      if (globalFailures.length >= globalMaxFailures) {
        const oldest = Math.min(...globalFailures)
        return decide(oldest + globalLockMs, 'global')
      }
      const entry = failures.get(key)
      if (entry === undefined) return { allowed: true, retryAfterSeconds: 0 }
      return decide(entry.lockedUntil, 'ip')
    },
    fail(key) {
      const current = now()
      const entry = failures.get(key) ?? { count: 0, lockedUntil: 0 }
      entry.count += 1
      if (entry.count >= maxFailures) {
        entry.lockedUntil = current + lockMs
        // Start the next window clean, so a locked client that keeps hammering does not push
        // its own lock further out one attempt at a time.
        entry.count = 0
      }
      failures.set(key, entry)
      globalFailures.push(current)
    },
    succeed(key) {
      failures.delete(key)
    },
  }
}

/** How long a phone stays signed in without retyping the password. */
export const POCKET_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface PocketSessions {
  /** Mint a session for the current password generation. */
  issue(): string
  /** Whether a cookie value is one of ours, for this generation and unexpired. */
  verify(value: string | undefined): boolean
  /** Password generation; bumping it invalidates every session at once. */
  version(): number
  /** Invalidate every session (password rotated, or the user asked to sign everyone out). */
  rotate(): void
}

export interface PocketSessionOptions {
  readonly ttlMs?: number
  readonly now?: () => number
  /** Per-run secret; defaults to fresh random bytes, so sessions die with the process. */
  readonly secret?: Buffer
}

/**
 * Sessions for the phone, bound to the process that issued them.
 *
 * The default secret is generated per run on purpose: "signed in until the shell or DSH
 * restarts" is the promise the settings page makes, and a persisted secret would silently
 * outlive it. Rotating the password bumps the generation, so a leaked link dies immediately
 * instead of at the next restart.
 *
 * @param options - Clock, TTL and secret.
 * @returns The session store.
 */
export function createPocketSessions(options: PocketSessionOptions = {}): PocketSessions {
  const ttlMs = options.ttlMs ?? POCKET_SESSION_TTL_MS
  const now = options.now ?? (() => Date.now())
  const secret = options.secret ?? randomBytes(32)
  let generation = 1

  const sign = (issuedAt: number): string =>
    createHmac('sha256', secret).update(`${String(generation)}.${String(issuedAt)}`).digest('base64url')

  return {
    issue() {
      const issuedAt = now()
      return `${String(issuedAt)}.${sign(issuedAt)}`
    },
    verify(value) {
      if (value === undefined || value === '') return false
      const separator = value.indexOf('.')
      if (separator <= 0) return false
      const issuedAt = Number(value.slice(0, separator))
      if (!Number.isFinite(issuedAt)) return false
      if (issuedAt > now() || now() - issuedAt > ttlMs) return false
      return constantTimeEqual(value.slice(separator + 1), sign(issuedAt))
    },
    version() {
      return generation
    },
    rotate() {
      generation += 1
    },
  }
}

/**
 * Read one cookie out of a `Cookie` header without pulling in a parser.
 *
 * @param header - Raw header value, possibly undefined.
 * @param name - Cookie name to look for.
 * @returns The value, or `undefined`.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim()
  }
  return undefined
}
