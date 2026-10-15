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
  /** The profile directory the actions run against (shown in the header). */
  profileDir: 'market:profile-dir',
  /** Put diagnostic text on the clipboard (the "复制诊断信息" button). */
  copyDiagnostics: 'market:copy-diagnostics',
  /** Close the window. */
  close: 'market:close',
} as const

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
