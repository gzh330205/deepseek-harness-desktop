/**
 * Which addresses the phone gateway listens on, and which requests it will answer.
 *
 * Two separate jobs live here:
 *
 * 1. **Choosing an address to advertise.** A Windows machine has a dozen interfaces
 *    (`vEthernet`, VPN taps, WSL, Hyper-V) and picking the wrong one produces a QR code that
 *    cannot possibly work on the phone.
 * 2. **Refusing requests that were not aimed at us.** The LAN listener answers on a private
 *    address, and a browser that a user was tricked into opening on `evil.example` can still
 *    have that name resolve to our address (DNS rebinding) — so the `Host` header must name an
 *    address we actually serve, or the request is refused. This is a real defence, not
 *    hygiene: the LAN password can be switched off, and without this check a rebinding page
 *    would read DSH with the user's own session cookie.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/** An address the gateway could advertise to the phone. */
export interface LanCandidate {
  readonly address: string
  /** Interface name, for the settings page when automatic choice is wrong. */
  readonly name: string
  /** Virtual adapters work but are rarely the one the phone can reach. */
  readonly virtual: boolean
}

/**
 * Interface names that are real but almost never the phone's route.
 *
 * Kept as a list rather than a heuristic because guessing wrong here is a support burden:
 * "the QR code does not work" is the symptom, and the user cannot see why.
 */
const VIRTUAL_INTERFACE = /(virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|tailscale|zerotier|radmin|loopback|bluetooth|tap|tun|npcap|nordlynx|wireguard)/iu

/**
 * Every IPv4 address a phone on the same network could reach.
 *
 * @param interfaces - Interface table; injected for tests.
 * @returns Candidates, best first.
 */
export function listLanCandidates(
  interfaces: NodeJS.Dict<readonly NetworkInterfaceInfo[]> = networkInterfaces(),
): readonly LanCandidate[] {
  const candidates: LanCandidate[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      if (!isPrivateIpv4(entry.address)) continue
      candidates.push({ address: entry.address, name, virtual: VIRTUAL_INTERFACE.test(name) })
    }
  }
  return rankLanCandidates(candidates)
}

/**
 * Order candidates by how likely they are to be the phone's route.
 *
 * @param candidates - Candidates in any order.
 * @returns A new array, best first.
 */
export function rankLanCandidates(candidates: readonly LanCandidate[]): readonly LanCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.virtual !== right.virtual) return left.virtual ? 1 : -1
    const rank = (address: string): number => {
      if (address.startsWith('192.168.')) return 0
      if (address.startsWith('10.')) return 1
      if (address.startsWith('172.')) return 2
      // Link-local: what a machine falls back to when DHCP failed. Reachable in theory,
      // useless in practice.
      return 3
    }
    if (rank(left.address) !== rank(right.address)) return rank(left.address) - rank(right.address)
    // Stable within a class, so the same machine keeps advertising the same address.
    return left.address.localeCompare(right.address)
  })
}

/**
 * Whether an IPv4 address is inside a range that cannot be routed from the internet.
 *
 * @param address - Dotted quad.
 * @returns Whether it is private or link-local.
 */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first = 0, second = 0] = parts
  if (first === 10) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  return false
}

/**
 * Whether a hostname refers to this machine's own loopback.
 *
 * @param hostname - Bare hostname (no port, brackets already removed).
 * @returns Whether it is a loopback name.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const lowered = hostname.toLowerCase()
  if (lowered === 'localhost' || lowered === '::1' || lowered === '[::1]') return true
  const parts = lowered.split('.').map(part => Number(part))
  return parts.length === 4 && parts[0] === 127 && parts.every(part => Number.isInteger(part))
}

/**
 * Extract the hostname from a `Host` header.
 *
 * @param header - Raw header, possibly with a port, possibly an IPv6 literal in brackets.
 * @returns The bare hostname in lower case, or `undefined` when there is nothing usable.
 */
export function hostnameOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const value = header.trim()
  if (value === '') return undefined
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0) return undefined
    return value.slice(1, end).toLowerCase()
  }
  // A Host header is `name`, `name:port`, or a bare IPv4 — a bare IPv6 address without brackets
  // is not valid there, so the last colon can only be introducing a port.
  const separator = value.lastIndexOf(':')
  if (separator < 0) return value.toLowerCase()
  const port = value.slice(separator + 1)
  // `example.com:` is malformed, not "no port": refuse it rather than guess.
  if (port === '' || !/^\d+$/u.test(port)) return undefined
  return value.slice(0, separator).toLowerCase()
}

/**
 * Whether a request may be answered on the LAN listener.
 *
 * @param header - The `Host` header of the request.
 * @param allowed - Hostnames this listener answers to: loopback plus the bound address.
 * @returns Whether the request is aimed at us.
 */
export function isAllowedLanHost(header: string | undefined, allowed: readonly string[]): boolean {
  const hostname = hostnameOf(header)
  if (hostname === undefined) return false
  if (isLoopbackHostname(hostname)) return true
  return allowed.some(candidate => candidate.toLowerCase() === hostname)
}
