/**
 * Downloads started inside the sidebar browser.
 *
 * Without a `will-download` handler Electron falls back to its own save dialog, which floats an
 * OS dialog over the shell and tells the panel nothing. Instead every download is written to the
 * user's Downloads folder under a non-colliding name, tracked here, and pushed to the panel so it
 * can show a download bar with progress and "open / reveal" — the same shape OneCode's
 * `DownloadBar` has.
 *
 * The tracking is deliberately session-level (one browser partition, many tabs): a download's
 * owning tab can be closed mid-flight, and the file must keep downloading.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DownloadItem, Session } from 'electron'

export type BrowserDownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface BrowserDownloadItem {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly path: string
  readonly state: BrowserDownloadState
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Unix ms when the download started. */
  readonly startedAt: number
}

export interface BrowserDownloadsOptions {
  readonly log: (line: string) => void
  /** Push the current list to the panel (called on progress, coalesced). */
  readonly notify: (items: readonly BrowserDownloadItem[]) => void
  /** Where finished files land (usually `app.getPath('downloads')`). */
  readonly saveDir: () => string
  /** Injected so the name-collision logic is testable without touching a real disk. */
  readonly exists?: (path: string) => boolean
  /** Coalescing window for progress pushes. */
  readonly flushMs?: number
  /**
   * `shell.openPath` / `shell.showItemInFolder`, injected rather than imported: importing the
   * `electron` runtime here would make this module un-importable from a Node test.
   */
  readonly openPath?: (path: string) => Promise<string>
  readonly revealPath?: (path: string) => void
}

/**
 * Pick a file name that does not shadow an existing file: `report.pdf`, `report (1).pdf`, …
 *
 * `stem`/`extension` are split on the last dot, so dotfiles keep their name intact.
 */
export function uniqueFileName(name: string, exists: (path: string) => boolean, dir: string): string {
  const safe = name.trim() === '' || name.includes('/') || name.includes('\\') ? 'download' : name.trim()
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const extension = dot > 0 ? safe.slice(dot) : ''
  let candidate = join(dir, safe)
  let index = 1
  while (exists(candidate)) {
    candidate = join(dir, `${stem} (${String(index)})${extension}`)
    index += 1
    if (index > 1000) break
  }
  return candidate
}

/** Human-readable size for the panel (kept here so both sides agree). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit] ?? 'B'}`
}

export class BrowserDownloads {
  private readonly items: BrowserDownloadItem[] = []
  private readonly tracked = new Map<string, DownloadItem>()
  private nextId = 1
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly exists: (path: string) => boolean
  private readonly flushMs: number
  private attached = false
  /** Assigned in the body, not as a parameter property: Node's strip-only TS rejects those. */
  private readonly options: BrowserDownloadsOptions

  constructor(options: BrowserDownloadsOptions) {
    this.options = options
    this.exists = options.exists ?? ((path: string) => existsSync(path))
    this.flushMs = options.flushMs ?? 300
  }

  /** Track every download this browser partition starts. Safe to call once per session. */
  attach(session: Session): void {
    if (this.attached) return
    this.attached = true
    session.on('will-download', (_event, item) => {
      this.track(item)
    })
  }

  /** Current list, newest last. */
  list(): readonly BrowserDownloadItem[] {
    return [...this.items]
  }

  /**
   * Start tracking one item, assigning its save path.
   *
   * Exposed separately from {@link attach} so tests can drive a fake `DownloadItem`.
   */
  track(item: DownloadItem): BrowserDownloadItem {
    const id = `dl-${String(this.nextId)}`
    this.nextId += 1
    const path = uniqueFileName(item.getFilename(), this.exists, this.options.saveDir())
    try {
      item.setSavePath(path)
    } catch (error) {
      this.options.log(`浏览器下载无法设置保存路径：${error instanceof Error ? error.message : String(error)}`)
    }
    const record: BrowserDownloadItem = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      path,
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    }
    this.items.push(record)
    this.tracked.set(id, item)
    item.on('updated', (_event, state) => {
      this.update(id, {
        state: state === 'interrupted' ? 'interrupted' : 'progressing',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      })
    })
    item.once('done', (_event, state) => {
      this.update(id, {
        state: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        path: item.getSavePath() === '' ? path : item.getSavePath(),
      })
      this.tracked.delete(id)
      this.flush()
    })
    this.options.log(`浏览器开始下载：${record.filename} → ${path}`)
    this.flush()
    return record
  }

  /** Open a finished download with the OS default application. */
  open(id: string): { ok: boolean; reason?: string } {
    const record = this.items.find((entry) => entry.id === id)
    if (record === undefined) return { ok: false, reason: '没有这个下载' }
    if (record.state !== 'completed') return { ok: false, reason: '下载尚未完成' }
    const openPath = this.options.openPath
    if (openPath === undefined) return { ok: false, reason: '打开文件的能力未接入' }
    void openPath(record.path).then((error) => {
      if (error !== '') this.options.log(`打开下载文件失败：${error}`)
    })
    return { ok: true }
  }

  /** Reveal a finished download in its folder. */
  reveal(id: string): { ok: boolean; reason?: string } {
    const record = this.items.find((entry) => entry.id === id)
    if (record === undefined) return { ok: false, reason: '没有这个下载' }
    const revealPath = this.options.revealPath
    if (revealPath === undefined) return { ok: false, reason: '定位文件的能力未接入' }
    try {
      revealPath(record.path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Drop the finished rows; anything still running stays. */
  clear(): void {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.state !== 'progressing') this.items.splice(index, 1)
    }
    this.flush()
  }

  /** Stop the progress timer (shutdown). */
  dispose(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.tracked.clear()
  }

  private update(id: string, patch: Partial<BrowserDownloadItem>): void {
    const index = this.items.findIndex((entry) => entry.id === id)
    if (index < 0) return
    const current = this.items[index]
    if (current === undefined) return
    this.items[index] = { ...current, ...patch }
    this.flush()
  }

  /** Progress arrives in bursts; push at most every {@link BrowserDownloadsOptions.flushMs}. */
  private flush(): void {
    if (this.flushMs <= 0) {
      this.options.notify(this.list())
      return
    }
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.options.notify(this.list())
    }, this.flushMs)
  }
}
