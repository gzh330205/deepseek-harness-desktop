/**
 * The market's action log: what was asked for, what pnpm answered, and how it ended.
 *
 * One JSON object per line, appended next to the shell's own logs. It exists because the useful
 * question after a failed install is never "did it fail" (the window says so) but "what exactly was
 * run, and what did pnpm print" — and that answer has to survive the window being closed. The window
 * shows the tail; the file is what a user can paste into a report.
 *
 * Deliberately append-only and never fatal: a log that cannot be written must not fail an install.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { MarketFailure } from './market-install.ts'

/** File name, inside the shell's log directory. */
export const MARKET_LOG_FILENAME = 'market.log'
/** Rotate once the file passes this size; a log that grows forever is a liability. */
export const MARKET_LOG_MAX_BYTES = 512 * 1024
/** How much of pnpm's output is kept per entry. Enough to see the error, not the whole progress bar. */
export const MARKET_LOG_OUTPUT_LIMIT = 8 * 1024

/** One logged action. */
export interface MarketLogEntry {
  /** ISO timestamp. */
  readonly at: string
  readonly action: 'install' | 'update' | 'uninstall' | 'search' | 'check'
  readonly name: string
  /** The spec handed to pnpm (`name@version`), empty for non-pnpm actions. */
  readonly spec: string
  readonly ok: boolean
  /** pnpm's exit code, `null` when the process never started. */
  readonly code: number | null
  /** Failure category, when the action failed. */
  readonly kind?: MarketFailure['kind']
  readonly message?: string
  /** Tail of pnpm's own output. */
  readonly output?: string
  /** Milliseconds the action took, when the caller measured it. */
  readonly ms?: number
}

/** Trim a value to the log's limits; keeps the end, which is where errors are. */
function tail(text: string, limit = MARKET_LOG_OUTPUT_LIMIT): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`
}

/**
 * Append one entry.
 *
 * @param logDir - Directory the shell keeps its logs in; created if missing.
 * @param entry - The action to record.
 * @returns The file written, or `undefined` when logging failed (never throws).
 */
export function appendMarketLog(logDir: string, entry: MarketLogEntry): string | undefined {
  const path = join(logDir, MARKET_LOG_FILENAME)
  const line = `${JSON.stringify({ ...entry, output: entry.output === undefined ? undefined : tail(entry.output) })}\n`
  try {
    mkdirSync(logDir, { recursive: true })
    rotateIfLarge(path)
    appendFileSync(path, line, 'utf8')
    return path
  } catch {
    return undefined
  }
}

/** Keep one previous generation, so a runaway install cannot make the log unopenable. */
function rotateIfLarge(path: string): void {
  if (!existsSync(path)) return
  if (statSync(path).size < MARKET_LOG_MAX_BYTES) return
  renameSync(path, `${path}.1`)
}

/**
 * Read the most recent entries, newest last.
 *
 * A malformed line (a partially written entry after a crash) is skipped rather than failing the read:
 * the log's job is to be available precisely when something went wrong.
 *
 * @param logDir - Directory holding the log.
 * @param limit - Maximum entries to return (the tail).
 */
export function readMarketLog(logDir: string, limit = 50): readonly MarketLogEntry[] {
  const path = join(logDir, MARKET_LOG_FILENAME)
  if (!existsSync(path)) return []
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries: MarketLogEntry[] = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as MarketLogEntry).at === 'string') {
        entries.push(parsed as MarketLogEntry)
      }
    } catch {
      // A truncated line: ignore it, keep the rest.
    }
  }
  return entries.slice(-Math.max(1, limit))
}

/** The log file's path, for the window's "在哪里" line. */
export function marketLogPath(logDir: string): string {
  return join(logDir, MARKET_LOG_FILENAME)
}
