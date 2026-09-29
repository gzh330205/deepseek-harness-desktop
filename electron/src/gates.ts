/**
 * The three startup gates, ported from `src-tauri/src/lib.rs`.
 *
 * 1. `dsh --version` is at or above {@link MINIMUM_DSH_VERSION}
 * 2. `dsh --help` advertises `--patch`
 * 3. the fixed port is free
 *
 * Any failure keeps the launcher page visible with a reason and a way out, and no
 * dsh child is ever spawned.
 */

import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { DEFAULT_DSH_PORT, LOOPBACK, MINIMUM_DSH_VERSION, PORT_RETRY_INTERVAL_MS, PORT_WAIT_TIMEOUT_MS } from './constants.ts'
import { runDshOnce } from './dsh-runner.ts'

const execFileAsync = promisify(execFile)

export interface GateSuccess {
  readonly ok: true
  readonly version: string
  readonly port: number
}

export interface GateFailure {
  readonly ok: false
  readonly phase: 'updateRequired' | 'failed'
  readonly message: string
  readonly detail?: string
}

export type GateResult = GateSuccess | GateFailure

/**
 * Compare two DSH versions, including pre-release identifiers.
 * @returns negative when `left < right`, positive when `left > right`, 0 when equal.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { numbers: number[]; pre: (string | number)[] } => {
    const [core = '', pre = ''] = value.trim().split('-', 2)
    return {
      numbers: core.split('.').map(part => Number.parseInt(part, 10)).map(part => (Number.isNaN(part) ? 0 : part)),
      pre: pre === '' ? [] : pre.split('.').map(part => (/^\d+$/u.test(part) ? Number.parseInt(part, 10) : part)),
    }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  // A release outranks its own pre-releases: 0.1.2 > 0.1.2-alpha.2.
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftPart = a.pre[index]
    const rightPart = b.pre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return leftPart < rightPart ? -1 : 1
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** Port from the environment, then the settings file, then the default. */
/**
 * @param settingsPort - Port from the shell settings file, when the user set one.
 * @param fallback - Channel default; the debug channel must not take the release port.
 */
export function resolvePort(settingsPort: number | undefined, fallback: number = DEFAULT_DSH_PORT): number {
  const raw = process.env.DSH_DESKTOP_PORT
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) return parsed
    throw new Error(`DSH_DESKTOP_PORT 不是合法端口：${raw}`)
  }
  if (settingsPort !== undefined && Number.isInteger(settingsPort) && settingsPort >= 1 && settingsPort <= 65_535) {
    return settingsPort
  }
  return fallback
}

/** Whether the fixed port is free. Bound to loopback only, matching the Tauri shell. */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.once('listening', () => { server.close(() => { resolve(true) }) })
    server.listen(port, LOOPBACK)
  })
}

/**
 * Wait for the fixed port to come free, up to a bound.
 *
 * This exists for exactly one situation: the migration away from the Tauri shell. The
 * Electron installer launches the new app as its last step, and the outgoing Tauri process
 * then exits — which is what kills its `dsh` child (`taskkill /T`) and releases the port.
 * The new app is usually far slower to reach this gate than the old one is to die, but on a
 * slow machine it can lose the race and show a port error on the one launch that matters.
 *
 * A bounded wait, never a fallback: after the deadline the caller still reports the port as
 * occupied, with the owner named. The fixed-port rule is unchanged.
 *
 * @param port - The fixed port.
 * @param timeoutMs - How long to keep retrying.
 * @param onWait - Called once per failed attempt, for the log.
 */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  onWait?: (attempt: number, remainingMs: number) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  for (;;) {
    if (await isPortAvailable(port)) return true
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    attempt += 1
    onWait?.(attempt, remainingMs)
    await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(PORT_RETRY_INTERVAL_MS, remainingMs)) })
  }
}

/** Describe whoever holds the port: `netstat` for the PID, `tasklist` for the name. */
async function describePortOwner(port: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true })
    const line = stdout.split(/\r?\n/u).find(candidate => candidate.includes(`:${String(port)}`) && candidate.includes('LISTENING'))
    const pid = line?.trim().split(/\s+/u).at(-1)
    if (pid === undefined || pid === '') return ''
    try {
      const { stdout: tasks } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
      const name = tasks.split(',')[0]?.replaceAll('"', '').trim()
      return name === undefined || name === '' ? `PID ${pid}` : `${name}（PID ${pid}）`
    } catch {
      return `PID ${pid}`
    }
  } catch {
    return ''
  }
}

/**
 * Extract the version from `dsh --version` output.
 *
 * Deliberately not "the last whitespace-separated token": a packaged run once produced
 * a trailing unrelated line, the last token became `received.`, and the version gate
 * rejected a perfectly good dsh. Match a SemVer-shaped token instead, preferring stdout.
 *
 * @param stdout - Standard output of the probe.
 * @param stderr - Standard error of the probe, consulted only when stdout has no match.
 */
export function parseDshVersion(stdout: string, stderr = ''): string | undefined {
  const pattern = /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?=\s|$)/u
  return pattern.exec(stdout)?.[1] ?? pattern.exec(stderr)?.[1]
}

/**
 * Run every gate before any child process is created.
 * @param entry - Resolved dsh entry file.
 * @param port - The fixed port chosen for this launch.
 */
export async function runGates(
  entry: string | undefined,
  port: number,
  onPortWait?: (attempt: number, remainingMs: number) => void,
): Promise<GateResult> {
  if (entry === undefined) {
    return {
      ok: false,
      phase: 'updateRequired',
      message: '未找到可用的 DSH：既没有随包运行时，PATH 中也没有 `@deepseek-ai/dsh`。',
      detail: '安装 DSH，或设置 DSH_DESKTOP_DSH_ENTRY 指向 .../@deepseek-ai/dsh/lib/bin.js。',
    }
  }

  let versionResult
  try {
    versionResult = await runDshOnce(entry, ['--version'], { timeoutMs: 30_000 })
  } catch (error) {
    return { ok: false, phase: 'failed', message: `无法运行 DSH（${entry}）`, detail: String(error) }
  }
  const version = parseDshVersion(versionResult.stdout, versionResult.stderr)
  if (version === undefined) {
    return {
      ok: false,
      phase: 'failed',
      message: '无法解析 `dsh --version` 的输出',
      detail: `stdout=${JSON.stringify(versionResult.stdout.trim().slice(0, 200))} stderr=${JSON.stringify(versionResult.stderr.trim().slice(0, 200))}`,
    }
  }
  if (compareVersions(version, MINIMUM_DSH_VERSION) < 0) {
    return {
      ok: false,
      phase: 'updateRequired',
      message: `当前 DSH ${version} 低于最低支持版本 ${MINIMUM_DSH_VERSION}`,
      detail: `该版本不提供浏览器会话认证，桌面端拒绝在无认证状态下暴露 Web 服务。请先更新 DSH。\n探测输出：${JSON.stringify(`${versionResult.stdout}${versionResult.stderr}`.trim().slice(0, 200))}`,
    }
  }

  let helpResult
  try {
    helpResult = await runDshOnce(entry, ['--help'], { timeoutMs: 30_000 })
  } catch (error) {
    return { ok: false, phase: 'failed', message: '无法读取 `dsh --help`', detail: String(error) }
  }
  if (!`${helpResult.stdout}${helpResult.stderr}`.includes('--patch')) {
    return {
      ok: false,
      phase: 'updateRequired',
      message: '当前 DSH 不支持 `--patch` 叠加层，桌面端无法注入设置面板。',
      detail: '请更新 DSH 后重试。',
    }
  }

  if (!await waitForPort(port, PORT_WAIT_TIMEOUT_MS, (attempt, remainingMs) => {
    onPortWait?.(attempt, remainingMs)
  })) {
    const owner = await describePortOwner(port)
    return {
      ok: false,
      phase: 'failed',
      message: `端口 ${String(port)} 已被占用${owner === '' ? '' : `：${owner}`}`,
      detail: `桌面端不退回随机端口。请关闭占用该端口的进程，或设置 DSH_DESKTOP_PORT 换一个端口。`,
    }
  }

  return { ok: true, version, port }
}

/** Whether `dsh web` accepts `--no-open`; older builds print the URL and open a browser. */
export async function supportsNoOpen(entry: string): Promise<boolean> {
  try {
    const result = await runDshOnce(entry, ['web', '--help'], { timeoutMs: 30_000 })
    return `${result.stdout}${result.stderr}`.includes('--no-open')
  } catch {
    return false
  }
}
