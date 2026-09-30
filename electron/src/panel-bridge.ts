/**
 * The shell's client for the bundled DSH panel plugin (`dsh-desktop-shell`).
 *
 * The plugin registers authenticated HTTP routes inside the DSH host. The shell holds
 * the session cookie in memory, so it can ask two questions the shell cannot answer
 * itself:
 *
 * - is the plugin loaded (`/ready`), instead of inferring it from stdout text;
 * - what would stopping DSH now interrupt (`/tasks`), which the plugin answers from
 *   DSH's own `workspace/session-activity` event.
 *
 * Failures are reported, never guessed: an unanswerable task query is `unknown`, and
 * callers must treat that as "may have work".
 */

import { PANEL_ROUTE, type TaskReport } from './constants.ts'

export interface PanelBridgeOptions {
  /** Loopback origin of the managed host, once authenticated. */
  readonly origin: () => string | undefined
  /** `name=value` session cookie held by the main process. */
  readonly cookie: () => string | undefined
  readonly timeoutMs?: number
}

const UNKNOWN = (reason: string): TaskReport => ({ answer: 'unknown', reason, families: [] })

export class PanelBridge {
  private readonly options: PanelBridgeOptions

  // Written out rather than a parameter property: Node's type-stripping mode (`--test`
  // on `.ts`) rejects parameter properties, and this module must stay unit-testable.
  constructor(options: PanelBridgeOptions) {
    this.options = options
  }

  private async request(path: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    return this.raw(path, timeoutMs)
  }

  /** One authenticated GET against the plugin's route prefix. */
  async raw(path: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    const origin = this.options.origin()
    const cookie = this.options.cookie()
    if (origin === undefined || cookie === undefined) return undefined
    try {
      const response = await fetch(`${origin}${PANEL_ROUTE}${path}`, {
        headers: { cookie },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return undefined
      const payload = await response.json() as unknown
      return typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /** The settings page's write path: token-authenticated JSON PUT at a revision. */
  async putSettings(
    token: string,
    revision: number | undefined,
    patch: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly error?: string }> {
    const origin = this.options.origin()
    const cookie = this.options.cookie()
    if (origin === undefined || cookie === undefined) return { ok: false, error: 'bridge-unavailable' }
    try {
      const response = await fetch(`${origin}${PANEL_ROUTE}/settings`, {
        method: 'PUT',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-dsh-desktop-shell-token': token,
        },
        body: JSON.stringify({ revision, patch }),
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      })
      if (response.ok) return { ok: true }
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      return { ok: false, error: typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Whether the panel plugin answered its readiness route. */
  async ready(): Promise<boolean> {
    const payload = await this.request('/ready', this.options.timeoutMs ?? 4_000)
    return payload?.ok === true && payload.plugin === 'dsh-desktop-shell'
  }

  /**
   * Append a browser-control note to a DSH session.
   *
   * The plugin writes it as a `user/message` with its own `source.kind`, so the model reads it as
   * history without it being taken for a user prompt.
   *
   * Returns the reason when it cannot be delivered — the caller logs it, because "the agent was
   * not told" is exactly the kind of silent failure this feature must not have. `unknown-session`
   * is expected whenever the panel's session has no live turn yet: DSH's `sessions.get()` only
   * resolves *live* sessions, and the plugin cannot resurrect a persisted one.
   */
  async sessionNote(sessionId: string, text: string): Promise<{ readonly ok: boolean; readonly error?: string }> {
    const origin = this.options.origin()
    const cookie = this.options.cookie()
    if (origin === undefined) return { ok: false, error: 'no-origin' }
    if (cookie === undefined) return { ok: false, error: 'no-cookie' }
    if (sessionId === '') return { ok: false, error: 'no-session-id' }
    if (text === '') return { ok: false, error: 'no-text' }
    try {
      const token = await this.bootstrapToken()
      if (token === undefined) return { ok: false, error: 'no-bootstrap-token' }
      const response = await fetch(`${origin}${PANEL_ROUTE}/session-note`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-dsh-desktop-shell-token': token,
        },
        body: JSON.stringify({ sessionId, text }),
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      })
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      if (response.ok && payload.ok === true) return { ok: true }
      const pluginError = typeof payload.error === 'string' ? payload.error : 'unknown'
      const live = Array.isArray(payload.liveSessions) ? payload.liveSessions.map(String).slice(0, 5) : []
      return {
        ok: false,
        error: `HTTP ${String(response.status)} ${pluginError}${live.length === 0 ? '' : `（活动会话：${live.join(', ')}）`}`,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** One-time write token from the plugin (same flow the settings PUT uses). */
  private async bootstrapToken(): Promise<string | undefined> {
    const payload = await this.request('/bootstrap', this.options.timeoutMs ?? 4_000)
    const token = payload?.token
    return typeof token === 'string' && token !== '' ? token : undefined
  }

  /**
   * The session that most recently drove the browser, as the plugin saw it.
   *
   * Used when the shell has to open the sidebar browser before the panel has ever reported a
   * session id (the panel may never have been opened). `undefined` when the host is unreachable.
   */
  async driverSession(): Promise<string | undefined> {
    const payload = await this.request('/state', this.options.timeoutMs ?? 4_000)
    const sessionId = payload?.driverSessionId
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  }

  /**
   * Ask what quitting or restarting DSH would interrupt.
   *
   * A short deadline on purpose: the answer gates a dialog, and a slow host must not
   * hold the shell hostage. Timeout yields `unknown`, which callers treat as "ask".
   */
  async tasks(): Promise<TaskReport> {
    const payload = await this.request('/tasks', this.options.timeoutMs ?? 5_000)
    if (payload === undefined) return UNKNOWN('panel-unreachable')
    if (payload.ok !== true) return UNKNOWN('panel-error')
    const answer = payload.answer
    if (answer !== 'idle' && answer !== 'active' && answer !== 'unknown') return UNKNOWN('unexpected-answer')
    const families = Array.isArray(payload.families)
      ? payload.families.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as Record<string, unknown>
        return [{
          sessionId: String(record.sessionId ?? ''),
          kind: String(record.kind ?? 'unknown'),
          count: typeof record.count === 'number' ? record.count : 0,
          labels: Array.isArray(record.labels) ? record.labels.map(label => String(label)) : [],
        }]
      })
      : []
    return {
      answer,
      families,
      ...(typeof payload.sessions === 'number' ? { sessions: payload.sessions } : {}),
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    }
  }
}

/**
 * Exercise the settings page's own HTTP contract: read `/state`, mint a one-time
 * bootstrap token, then write an empty patch back at the current revision.
 *
 * The DSH settings page depends on exactly these three calls, and a broken bridge
 * otherwise only shows up as an error rendered inside the DSH UI. Used by the smoke
 * run and by diagnostics; the empty patch changes no setting, only the revision.
 */
export async function checkSettingsRoundTrip(bridge: PanelBridge): Promise<{
  readonly read: boolean
  readonly write: boolean
  readonly revision?: number
  readonly error?: string
}> {
  const state = await bridge.raw('/state', 4_000)
  if (state?.ok !== true) return { read: false, write: false, error: 'state-unreadable' }
  const bootstrap = await bridge.raw('/bootstrap', 4_000)
  const token = typeof bootstrap?.token === 'string' ? bootstrap.token : undefined
  if (token === undefined) return { read: true, write: false, error: 'no-bootstrap-token' }
  const revision = typeof state.revision === 'number' ? state.revision : undefined
  const result = await bridge.putSettings(token, revision, {})
  return {
    read: true,
    write: result.ok,
    ...(revision === undefined ? {} : { revision }),
    ...(result.ok ? {} : { error: result.error }),
  }
}

/** One-line summary for a confirmation dialog; empty when there is nothing to report. */
export function describeTasks(report: TaskReport): string {
  if (report.answer === 'unknown') {
    return '无法确认当前是否有任务在运行（按「可能有」处理）。'
  }
  if (report.families.length === 0) return ''
  const kindLabels: Record<string, string> = {
    job: '后台任务',
    agent: '运行中的回合',
    schedule: '已挂定时器',
    subagent: '子代理',
    workspace: '工作区活动',
  }
  const lines = report.families.map((family) => {
    const label = kindLabels[family.kind] ?? family.kind
    const detail = family.labels.filter(entry => entry !== '').slice(0, 3).join('、')
    return `· ${label} ${String(family.count)} 项${detail === '' ? '' : `（${detail}）`}`
  })
  return [...new Set(lines)].join('\n')
}
