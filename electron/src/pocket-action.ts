/**
 * The phone-access action vocabulary, shared by the pocket page, the settings bridge and the main
 * process.
 *
 * The page posts action objects through the preload; `settings-window.ts` forwards them to
 * `handlePocketAction` in `main.ts`. Forwarding is a **pass-through by design**: when the page grew
 * public-access and firewall actions, the bridge still carried a hand-written whitelist from the
 * first LAN-only version and silently turned every one of them into a `refresh` — so every click on
 * 「开启公网访问」 did nothing and closed no tunnel. Keeping the vocabulary in one place lets a static
 * test prove that no `kind` the page can send is unknown to the bridge.
 *
 * The parsed action is normalized field by field: the renderer is only trusted as far as this
 * module validates it, never with arbitrary objects crossing into the main process.
 */

import type { PocketFirewallStatus } from './pocket-firewall.ts'
import type { PocketStatus } from './pocket-service.ts'

/** Phone access, as the settings page renders it: live status plus the code to scan. */
export interface PocketSnapshot extends PocketStatus {
  /**
   * PNG data URL of the QR code for {@link PocketStatus.url}, when a listener is up.
   *
   * The payload is a `dshpocket://connect` deep link carrying the address **and** the password
   * (built by `pocketConnectLink`), so one scan is enough for the app; a plain address made the user
   * retype the password on the phone.
   */
  readonly qr?: string
  /**
   * Public access, with the same kind of code.
   *
   * The payload is a `dshpocket://connect?url=…&password=…` deep link (built by `pocketConnectLink`),
   * so one scan hands the phone both the address and the password — the token/user never has to read
   * a password off the desktop screen.
   */
  readonly publicAccess: PocketStatus['publicAccess'] & { readonly qr?: string }
  /** Where the phone app comes from, and its QR code: scanning it installs the client. */
  readonly apkUrl?: string
  readonly apkQr?: string
  /**
   * Whether Windows Firewall lets other devices reach the LAN listener.
   *
   * The product does not create this rule on a fresh machine, and a blocked port looks exactly like a
   * broken gateway from the phone's side — pings work, the app reports itself running, the page never
   * opens. Cached rather than probed per render: the query costs a PowerShell start-up.
   */
  readonly firewall?: PocketFirewallStatus
}

/** What the settings page may ask phone access to do. */
export type PocketAction =
  | { readonly kind: 'refresh' }
  | { readonly kind: 'rotate' }
  | { readonly kind: 'setPassword'; readonly value: string }
  | { readonly kind: 'select'; readonly address: string }
  // Public access. `acceptedDisclaimer` travels from the page because the confirmation is shown
  // there; the service refuses the start without it.
  | { readonly kind: 'startTunnel'; readonly acceptedDisclaimer: boolean }
  | { readonly kind: 'stopTunnel' }
  | { readonly kind: 'rotatePublicPassword' }
  | { readonly kind: 'setPublicPassword'; readonly value: string }
  | { readonly kind: 'setTunnelToken'; readonly value: string }
  // Windows Firewall: check whether the LAN listener is reachable from another device, and ask for
  // elevation to add the rule. Never silent — the second one raises a UAC prompt.
  | { readonly kind: 'firewallCheck' }
  | { readonly kind: 'firewallAllow' }

/** Every action the bridge forwards. A kind the page sends but this list lacks is a dead button. */
export const POCKET_ACTION_KINDS = [
  'refresh',
  'rotate',
  'setPassword',
  'select',
  'startTunnel',
  'stopTunnel',
  'rotatePublicPassword',
  'setPublicPassword',
  'setTunnelToken',
  'firewallCheck',
  'firewallAllow',
] as const

export type PocketActionKind = (typeof POCKET_ACTION_KINDS)[number]

/** Whether `value` is one of {@link POCKET_ACTION_KINDS}. */
export function isPocketActionKind(value: string): value is PocketActionKind {
  return (POCKET_ACTION_KINDS as readonly string[]).includes(value)
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Validate and normalize one renderer-supplied action.
 *
 * @param value - Untrusted value from `ipcRenderer.invoke`.
 * @returns The normalized action; `refresh` for anything unrecognizable (the page only ever uses
 *   this to re-read status, so an unknown message must not be able to trigger anything else).
 */
export function parsePocketAction(value: unknown): PocketAction {
  if (typeof value !== 'object' || value === null) return { kind: 'refresh' }
  const request = value as Record<string, unknown>
  const kind = request.kind
  if (typeof kind !== 'string' || !isPocketActionKind(kind)) return { kind: 'refresh' }
  switch (kind) {
    case 'setPassword':
    case 'setPublicPassword':
    case 'setTunnelToken':
      return { kind, value: text(request.value) }
    case 'select':
      return { kind, address: text(request.address) }
    case 'startTunnel':
      // Only a literal `true` counts as consent; the service checks again, but never let a truthy
      // string through this one.
      return { kind, acceptedDisclaimer: request.acceptedDisclaimer === true }
    case 'refresh':
    case 'rotate':
    case 'stopTunnel':
    case 'rotatePublicPassword':
    case 'firewallCheck':
    case 'firewallAllow':
      return { kind }
  }
}
