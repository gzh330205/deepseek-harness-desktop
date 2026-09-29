/**
 * Running the dsh entry without a shell.
 *
 * The Tauri shell spawned `dsh.cmd`, which on Windows needs cmd.exe and therefore
 * `CREATE_NO_WINDOW` to stay invisible. Running the resolved JS entry through
 * Electron's own Node mode removes the shell layer entirely: no cmd.exe, no quoting,
 * no console flash, and no dependency on a system Node install.
 */

import { spawn } from 'node:child_process'

export interface DshRunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Environment for an Electron Node-mode child (`ELECTRON_RUN_AS_NODE`). */
export function nodeModeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extra }
}

/**
 * Run the dsh entry once and collect its output.
 * @param entry - Absolute path to `@deepseek-ai/dsh/lib/bin.js`.
 * @param args - dsh arguments.
 * @param options - Timeout and extra environment.
 */
export function runDshOnce(entry: string, args: readonly string[], options: {
  readonly timeoutMs?: number
  readonly environment?: NodeJS.ProcessEnv
  readonly cwd?: string
} = {}): Promise<DshRunResult> {
  const timeoutMs = options.timeoutMs ?? 20_000
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd,
      env: nodeModeEnvironment(options.environment ?? {}),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`\`dsh ${args.join(' ')}\` 超时（${String(timeoutMs)} ms）`))
    }, timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
