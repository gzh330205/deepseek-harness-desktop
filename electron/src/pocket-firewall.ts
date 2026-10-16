/**
 * Windows Firewall, for the one thing phone access needs from it: an inbound rule.
 *
 * The LAN listener is the only part of this product that another device connects *to*, and Windows
 * blocks that by default. Nothing in the product created the rule — the one on the developer machine
 * was left over from a Windows prompt years ago, and it covers a single profile and a single program
 * path. The consequence is brutal to debug: the phone and the PC ping each other, the gateway reports
 * itself running, and the phone simply cannot open the page. Testing from the same machine can never
 * see it, which is exactly how it survived a "verified on the real network" claim.
 *
 * Two halves:
 *
 * - **Checking** goes through PowerShell's structured objects, never through `netsh` text: `netsh`
 *   output is localised (rule/program/action are translated), so parsing it would break on any
 *   non-English Windows.
 * - **Allowing** is a single `netsh` command run elevated. It needs a UAC prompt, so it is a user
 *   action with a button, not something the app does behind their back.
 */

import { execFile } from 'node:child_process'

/** How long the firewall probe may take; PowerShell start-up dominates this. */
const PROBE_TIMEOUT_MS = 25_000

export interface PocketFirewallOptions {
  /** Absolute path of the shell executable whose inbound traffic matters. */
  readonly programPath: string
  /** Runs a command and returns its stdout; injected by tests. */
  readonly run?: (file: string, args: readonly string[]) => Promise<string>
}

export interface PocketFirewallStatus {
  /** An enabled inbound allow rule covers this program. */
  readonly covered: boolean
  /** The profiles that rule applies to, as PowerShell reports them (`Any`, `Domain, Private`, …). */
  readonly profiles: string
  /** Names of the matching rules; useful in the log and in the hint. */
  readonly rules: readonly string[]
  /** Whether the firewall is on for at least one profile. */
  readonly firewallOn: boolean
  /** Whether the user should be offered the one-click allow. */
  readonly needsAttention: boolean
  /** The command the button runs (also printable, for users who prefer a terminal). */
  readonly command: string
}

/**
 * The command that opens the door, quoted for `netsh`.
 *
 * `protocol=any` and no port on purpose: the LAN port is configurable, and a rule tied to a number
 * would silently stop working the moment someone changes it in the settings.
 *
 * @param programPath - Absolute path of the shell executable.
 * @returns The `netsh` arguments, as one string.
 */
export function allowRuleCommand(programPath: string): string {
  return `advfirewall firewall add rule name="DSH Desktop phone access" dir=in action=allow `
    + `program="${programPath}" protocol=any profile=any enable=yes`
}

/**
 * Read the firewall state and whether an enabled inbound rule covers this program.
 *
 * @param options - Program path and an optional command runner.
 * @returns The status the settings page shows.
 */
export async function probeFirewall(options: PocketFirewallOptions): Promise<PocketFirewallStatus> {
  const command = allowRuleCommand(options.programPath)
  const base: PocketFirewallStatus = {
    covered: false,
    profiles: '',
    rules: [],
    firewallOn: false,
    needsAttention: false,
    command,
  }
  if (process.platform !== 'win32') return base
  const run = options.run ?? runCommand
  // `-EncodedCommand` would dodge quoting entirely, but the script is short and ASCII; passing it
  // inline keeps the code (and its tests) readable.
  const script = probeScript(options.programPath)
  try {
    const raw = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'))) as {
      readonly profiles?: unknown
      readonly names?: unknown
      readonly state?: unknown
    }
    const profiles = typeof parsed.profiles === 'string' ? parsed.profiles : ''
    // `ConvertTo-Json` collapses a one-element array into a bare value, so both shapes have to be
    // accepted — otherwise a correctly configured machine reports itself unprotected.
    const rawNames: readonly unknown[] = Array.isArray(parsed.names) ? parsed.names : [parsed.names]
    const rules = rawNames.filter((name): name is string => typeof name === 'string' && name !== '')
    const firewallOn = typeof parsed.state === 'string' && /True/iu.test(parsed.state)
    return {
      ...base,
      covered: rules.length > 0,
      profiles,
      rules,
      firewallOn,
      // Only worth interrupting the user when the firewall is actually on: with it off, the phone
      // reaches the gateway without any rule at all.
      needsAttention: firewallOn && rules.length === 0,
    }
  } catch (error) {
    // No PowerShell, no permission, a timeout: stay quiet rather than claim the door is open. The
    // hint then says "could not check", and the button is still there.
    return { ...base, needsAttention: false }
  }
}

/** The PowerShell script the probe runs, so a test can pin its shape without a real firewall. */
export function firewallProbeScript(programPath: string): string {
  return probeScript(programPath)
}

/** Run a command and return its stdout. */
function runCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Ask for elevation and add the rule.
 *
 * `Start-Process -Verb RunAs` is what raises the UAC prompt; `-Wait` keeps the promise until the user
 * has answered, and the exit code says whether the rule went in. Nothing is silent: an app that
 * quietly punches a hole through the firewall is not a thing this product should do.
 *
 * @param programPath - Absolute path of the shell executable.
 * @param run - Command runner; injected by tests.
 * @returns Whether the prompt was answered with a successful rule creation.
 */
export async function allowFirewall(programPath: string, run: (file: string, args: readonly string[]) => Promise<string> = runCommand): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const netshArgs = allowRuleCommand(programPath)
  // PowerShell needs the arguments as a single quoted string; the rule name and program path are the
  // only values, and the path is quoted for netsh itself.
  const script = `$p = Start-Process -FilePath 'netsh.exe' -ArgumentList '${netshArgs.replace(/'/gu, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
  try {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    return true
  } catch {
    return false
  }
}

/**
 * The probe script.
 *
 * @param programPath - Absolute path of the shell executable.
 * @returns The PowerShell command text.
 */
function probeScript(programPath: string): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue";',
    // A single-quoted PowerShell literal, not `JSON.stringify`: JSON doubles every backslash, so the
    // script compared against `D:\\Program Files\\...` and matched nothing — a silent "no rule here"
    // for every machine, including correctly configured ones.
    `$program = '${programPath.replace(/'/gu, "''")}';`,
    '$state = ((Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.Enabled)" }) -join ";");',
    // Filter by program *first*: `Get-NetFirewallRule` returns hundreds of rules and each
    // `Get-NetFirewallApplicationFilter` is its own CIM call, so the naive direction (all rules, then
    // look at each program) takes minutes and times out — which reads as "could not check" and hides
    // the real state. Measured: this way is a few hundred milliseconds.
    //
    // `-Program` on the cmdlet itself is a case-SENSITIVE literal match, and Windows stores these paths
    // in whatever case the rule was created with (`d:\program files\...` in practice) while this app
    // knows its own path as `D:\Program Files\...`. Measured: the exact-match form found 0 rules where
    // a case-insensitive comparison finds 2 — it would have told every correctly configured user that
    // their firewall was still in the way.
    '$rules = @(Get-NetFirewallApplicationFilter |',
    '  Where-Object { $_.Program -and $_.Program -ne "Any" -and $_.Program -ieq $program } |',
    '  Get-NetFirewallRule |',
    '  Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" });',
    'ConvertTo-Json -Compress -Depth 3 @{',
    '  profiles = (@($rules | ForEach-Object { $_.Profile }) -join ",");',
    '  names = @($rules | ForEach-Object { $_.Name });',
    '  state = $state',
    '}',
  ].join(' ')
}
