/**
 * The market window's IPC contract.
 *
 * The channel names live here rather than in `constants.ts` because exactly two modules speak them —
 * this window and the preload — and keeping them together makes it obvious that adding a channel
 * means touching both sides. The shapes below are what crosses the bridge; the window treats every
 * field as untrusted and the main process validates the sender before answering.
 */

import type { MarketFailure } from './market-install.ts'

/** Renderer → main: one market operation. */
export const MARKET_IPC = {
  /** Search the catalog. */
  search: 'market:search',
  /** List what the profile declares. */
  installed: 'market:installed',
  /** Install / update / uninstall. */
  act: 'market:act',
  /** Compare installed plugins against the registry. */
  updates: 'market:updates',
  /** The tail of the action log, plus where the file lives. */
  log: 'market:log',
  /** Contradictions this profile can be proven to have. */
  diagnose: 'market:diagnose',
  /** Main → renderer: switch the visible view (the 插件 menu opens the installed one). */
  view: 'market:view',
  /** The profile directory the actions run against (shown in the header). */
  profileDir: 'market:profile-dir',
  /** Put diagnostic text on the clipboard (the "复制诊断信息" button). */
  copyDiagnostics: 'market:copy-diagnostics',
  /** Close the window. */
  close: 'market:close',
} as const

/**
 * Which view the window shows.
 *
 * Both live in one window: they answer the same question about the same profile, and a second window
 * would only add another thing for the user to find.
 */
export type MarketView = 'market' | 'installed'

/** One installed plugin, as the installed view sees it. */
export interface MarketUpdateStatusResponse {
  readonly name: string
  /** What the profile declares. */
  readonly current: string
  /** Latest version the registry reports, when it could be determined. */
  readonly latest?: string
  readonly hasUpdate: boolean
  /** `registry` can be compared; anything else (link/file/git) cannot. */
  readonly source: 'registry' | 'other'
  readonly reason?: string
}

/** One proven contradiction, as the window shows it. */
export interface MarketDiagnosisFinding {
  readonly severity: 'error' | 'warn' | 'info'
  readonly code: string
  readonly subject: string
  readonly message: string
  readonly hint?: string
}

/** The action-log tail plus its file path. */
export interface MarketLogResponse {
  readonly entries: readonly {
    readonly at: string
    readonly action: string
    readonly name: string
    readonly spec: string
    readonly ok: boolean
    readonly code: number | null
    readonly kind?: string
    readonly message?: string
    readonly output?: string
    readonly ms?: number
  }[]
  readonly path: string
}

/** What the window asks for: a query plus the page it wants and how to narrow it. */
export interface MarketSearchRequest {
  readonly query: string
  /** Registry offset (page * size). */
  readonly from?: number
  /** Registry hits confirmed per request; the window asks for more when filling a page. */
  readonly pageSize?: number
  readonly sort?: 'relevance' | 'updated' | 'name'
  /** Only plugins that also inject a browser half (`dsh.client`). */
  readonly clientOnly?: boolean
}

/** One catalog entry as the renderer sees it. */
export interface MarketSearchResponse {
  readonly ok: boolean
  readonly packages: readonly {
    readonly name: string
    readonly version: string
    readonly description: string
    readonly published: string
    readonly keywords: readonly string[]
    readonly spec: string
    readonly client: boolean
  }[]
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
  /** Where this page sits in the catalog, so the window can offer a next/previous page. */
  readonly page?: { readonly from: number; readonly size: number; readonly hasMore: boolean; readonly scanned: number }
  /** Present when the query itself failed (network, registry); `packages` is then empty. */
  readonly failure?: MarketFailure
  readonly output?: string
}

/** What one action answers. */
export interface MarketActionResultResponse {
  readonly ok: boolean
  readonly action: 'install' | 'update' | 'uninstall'
  readonly name: string
  readonly spec: string
  readonly code: number | null
  readonly output: string
  readonly failure?: MarketFailure
  readonly bundleRegistered: boolean
}
