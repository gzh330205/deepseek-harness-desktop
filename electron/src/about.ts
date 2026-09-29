/**
 * Content of the About dialog.
 *
 * Deliberately a pure function: a native Windows message box can only be styled through
 * what goes into it, so the things worth pinning are the ones that made the first version
 * look careless — a generic info icon, `（Electron 壳）` as a subtitle, a raw
 * `用户数据：C:\Users\…` path, and a button labelled 「好」.
 *
 * What belongs here is what a user opens About for: which build this is, which version of
 * DSH it is running, and where to file an issue. Deep diagnostics live in the support
 * bundle (`导出诊断信息…`), not in this dialog.
 */

export interface AboutInput {
  readonly productName: string
  readonly version: string
  readonly channel: string
  readonly dshVersion: string | null
  /** `bundled` means the runtime ships with the app; `system` means it was found on PATH. */
  readonly runtimeSource: 'bundled' | 'system'
  readonly port: number | null
  readonly electron: string
  readonly chrome: string
  readonly node: string
  readonly uptimeMs: number
  readonly repository: string
}

export interface AboutContent {
  readonly title: string
  /** Rendered by the OS in the dialog's larger font. */
  readonly message: string
  readonly detail: string
}

/** Human duration, at most two units: "5 分钟", "1 小时 12 分钟", "2 天". */
export function formatUptime(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000))
  if (totalMinutes < 1) return '不到 1 分钟'
  if (totalMinutes < 60) return `${String(totalMinutes)} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return minutes === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(minutes)} 分钟`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${String(days)} 天` : `${String(days)} 天 ${String(restHours)} 小时`
}

/** Channel wording a user can act on, rather than the internal channel id. */
function describeChannel(channel: string): string {
  if (channel === 'debug') return 'debug（独立安装，可与正式版共存）'
  if (channel === 'development') return '开发版（源码运行）'
  return '正式版'
}

export function buildAbout(input: AboutInput): AboutContent {
  const dsh = input.dshVersion === null
    ? 'DSH 未运行'
    : `DSH ${input.dshVersion}${input.runtimeSource === 'bundled' ? '（随包）' : '（系统安装）'}`

  // "刚刚启动" reads better than "已运行 不到 1 分钟" on the launch the user is most
  // likely to open About from.
  const uptime = input.uptimeMs < 60_000 ? '刚刚启动' : `已运行 ${formatUptime(input.uptimeMs)}`
  const running = [
    dsh,
    input.port === null ? null : `端口 ${String(input.port)}`,
    uptime,
  ].filter((part): part is string => part !== null).join(' · ')

  return {
    title: `关于 ${input.productName}`,
    message: `${input.productName} ${input.version}`,
    detail: [
      describeChannel(input.channel),
      '',
      running,
      `Electron ${input.electron} · Chromium ${input.chrome} · Node ${input.node}`,
      '',
      input.repository,
    ].join('\n'),
  }
}
