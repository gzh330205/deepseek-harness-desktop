/**
 * Which surface publishes the browser tools: DSH-native tools registered by our plugin, or the
 * MCP row in the overlay.
 *
 * Both surfaces call the same shell bridge and are generated from the same catalog, so this is
 * only a routing decision — but it is the one that decides whether the agent sees the tools at
 * all. It has to survive a DSH upgrade that changes `ctx.tools.register`'s expected shape:
 *
 * - `auto` (default): native, unless the plugin reported a failed registration last launch — in
 *   which case MCP is used instead, so the tools never silently disappear.
 * - `native` / `mcp`: an explicit user choice, honoured even if the last attempt failed (that is
 *   how a "retry native" works: pick `native`, restart, watch the log).
 *
 * Keeping the rule here (pure, no Electron, no filesystem) is what makes the fallback testable.
 */

export const TOOL_SURFACE_MODES = ['auto', 'native', 'mcp'] as const
export type ToolSurfaceSetting = (typeof TOOL_SURFACE_MODES)[number]

/** What the plugin reported about its native registration attempt. */
export interface ToolRegistrationRecord {
  readonly ok: boolean
  readonly count: number
  readonly error?: string
  /** Unix ms of the report. */
  readonly at?: number
}

export interface ToolSurfaceDecision {
  /** Which surface is active this launch. */
  readonly mode: 'native' | 'mcp'
  /** Whether the overlay should carry the `dsh-mcp-client` row. */
  readonly injectMcp: boolean
  /** Whether the plugin should be told to register native tools. */
  readonly nativeTools: boolean
  /** Why — goes to `shell.log` and the facts file. */
  readonly reason: string
}

export function isToolSurfaceSetting(value: unknown): value is ToolSurfaceSetting {
  return typeof value === 'string' && (TOOL_SURFACE_MODES as readonly string[]).includes(value)
}

/** Accept only a well-formed report; anything else is treated as "no report". */
export function parseRegistrationRecord(value: unknown): ToolRegistrationRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { ok?: unknown; count?: unknown; error?: unknown; at?: unknown }
  if (typeof record.ok !== 'boolean') return undefined
  const count = typeof record.count === 'number' && Number.isFinite(record.count) ? record.count : 0
  return {
    ok: record.ok,
    count,
    ...typeof record.error === 'string' && record.error !== '' ? { error: record.error } : {},
    ...typeof record.at === 'number' && Number.isFinite(record.at) ? { at: record.at } : {},
  }
}

/**
 * Decide the surface.
 *
 * @param configured - the `browser.agentTools` setting (unknown/absent means `auto`).
 * @param lastRecord - the plugin's report from the previous launch, if any.
 * @param expectedCount - how many tools the catalog holds; a mismatch is a failed registration.
 */
export function decideToolSurface(
  configured: unknown,
  lastRecord: unknown,
  expectedCount: number,
): ToolSurfaceDecision {
  const setting: ToolSurfaceSetting = isToolSurfaceSetting(configured) ? configured : 'auto'
  const record = parseRegistrationRecord(lastRecord)
  const complete = record !== undefined && record.ok && record.count === expectedCount

  if (setting === 'mcp') {
    return { mode: 'mcp', injectMcp: true, nativeTools: false, reason: '设置要求使用 MCP 工具' }
  }
  if (setting === 'native') {
    return {
      mode: 'native',
      injectMcp: false,
      nativeTools: true,
      reason: record !== undefined && !complete
        ? `设置要求原生工具（上次注册未成功${record.error === undefined ? '' : `：${record.error}`}，本次重试）`
        : '设置要求原生工具',
    }
  }
  // auto
  if (record === undefined) {
    return { mode: 'native', injectMcp: false, nativeTools: true, reason: '默认使用原生工具' }
  }
  if (complete) {
    return { mode: 'native', injectMcp: false, nativeTools: true, reason: `默认使用原生工具（上次注册 ${String(record.count)} 个）` }
  }
  const detail = record.error ?? (record.ok ? `上次只注册了 ${String(record.count)}/${String(expectedCount)} 个` : '上次注册失败')
  return {
    mode: 'mcp',
    injectMcp: true,
    nativeTools: false,
    reason: `自动回退 MCP：${detail}（在桌面设置里选「原生工具」可重试）`,
  }
}
