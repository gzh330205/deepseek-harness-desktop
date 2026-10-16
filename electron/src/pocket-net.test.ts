import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NetworkInterfaceInfoIPv4 } from 'node:os'

import {
  hostnameOf,
  isAllowedLanHost,
  isLoopbackHostname,
  isPrivateIpv4,
  listLanCandidates,
  rankLanCandidates,
} from './pocket-net.ts'

const entry = (address: string, internal = false): NetworkInterfaceInfoIPv4 => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: internal ? null : `${address}/24`,
})

test('a phone address is IPv4, not loopback, and never routable from the internet', () => {
  const candidates = listLanCandidates({
    'Wi-Fi': [entry('192.168.1.7'), entry('127.0.0.1', true)],
    'Ethernet 2': [entry('8.8.8.8')],
    'vEthernet (WSL)': [entry('172.20.0.1')],
    'Tailscale': [entry('100.64.0.5')],
  })
  assert.deepEqual(candidates.map(candidate => candidate.address), ['192.168.1.7', '172.20.0.1'])
  assert.equal(candidates[0]?.name, 'Wi-Fi')
  assert.equal(candidates[0]?.virtual, false)
  assert.equal(candidates[1]?.virtual, true)
})

test('a real adapter beats a virtual one even when the virtual one looks friendlier', () => {
  const ranked = rankLanCandidates([
    { address: '192.168.1.9', name: 'vEthernet (Default Switch)', virtual: true },
    { address: '10.2.3.4', name: 'Ethernet', virtual: false },
  ])
  // The phone can reach the Ethernet address; the Hyper-V switch address only exists inside
  // this machine, and advertising it is the classic "QR code does not work".
  assert.deepEqual(ranked.map(candidate => candidate.name), ['Ethernet', 'vEthernet (Default Switch)'])
})

test('home routers come first, link-local last', () => {
  const ranked = rankLanCandidates([
    { address: '169.254.10.1', name: 'a', virtual: false },
    { address: '172.20.0.1', name: 'b', virtual: false },
    { address: '10.0.0.5', name: 'c', virtual: false },
    { address: '192.168.0.4', name: 'd', virtual: false },
  ])
  assert.deepEqual(ranked.map(candidate => candidate.address), ['192.168.0.4', '10.0.0.5', '172.20.0.1', '169.254.10.1'])
})

test('the same machine keeps advertising the same address', () => {
  const first = rankLanCandidates([
    { address: '192.168.1.20', name: 'Wi-Fi', virtual: false },
    { address: '192.168.1.10', name: 'Ethernet', virtual: false },
  ])
  const second = rankLanCandidates([...first].reverse())
  assert.deepEqual(first.map(candidate => candidate.address), second.map(candidate => candidate.address))
})

test('only unroutable ranges count as private', () => {
  for (const address of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.1.1']) {
    assert.equal(isPrivateIpv4(address), true, address)
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '100.64.0.1', '127.0.0.1', '1.2.3', 'a.b.c.d']) {
    assert.equal(isPrivateIpv4(address), false, address)
  }
})

test('loopback hostnames are recognised as such', () => {
  for (const hostname of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname)
  }
  for (const hostname of ['example.com', '192.168.1.7', '127.0.0', 'localhost.evil.com']) {
    assert.equal(isLoopbackHostname(hostname), false, hostname)
  }
})

test('a host header is reduced to a bare hostname, and malformed ones are refused', () => {
  assert.equal(hostnameOf('192.168.1.7:41730'), '192.168.1.7')
  assert.equal(hostnameOf('Example.COM:41730'), 'example.com')
  assert.equal(hostnameOf('example.com'), 'example.com')
  assert.equal(hostnameOf('[fe80::1]:41730'), 'fe80::1')
  assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1')
  // A colon with no usable port is refused rather than silently treated as part of the name.
  assert.equal(hostnameOf('example.com:'), undefined)
  assert.equal(hostnameOf('example.com:abc'), undefined)
  assert.equal(hostnameOf(''), undefined)
  assert.equal(hostnameOf(undefined), undefined)
  assert.equal(hostnameOf('[fe80::1'), undefined)
})

test('the LAN listener refuses a name it does not serve, which is what stops rebinding', () => {
  const allowed = ['192.168.1.7']
  assert.equal(isAllowedLanHost('192.168.1.7:41730', allowed), true)
  assert.equal(isAllowedLanHost('localhost:41730', allowed), true)
  assert.equal(isAllowedLanHost('127.0.0.1:41730', allowed), true)
  // `evil.example` resolving to 192.168.1.7 still arrives with its own name in Host: refuse it,
  // otherwise the attacker's page reads DSH with the user's own cookie.
  assert.equal(isAllowedLanHost('evil.example:41730', allowed), false)
  assert.equal(isAllowedLanHost('192.168.1.8:41730', allowed), false)
  assert.equal(isAllowedLanHost(undefined, allowed), false)
})
