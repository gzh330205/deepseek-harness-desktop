/**
 * Tests for the ONE-WAY usage service.
 *
 * The gateway HTML below is hand-written from the regexes in `oneway-service.ts`: each fixture puts
 * the class names the parser keys on exactly where the real pages put them. That is deliberate — the
 * parsers are the only part of this module that can silently show wrong numbers, so the fixtures also
 * carry the awkward cases the real pages produce (an unlimited quota rendered as "不限", an empty
 * cell, a channel heading with a link glyph, an aborted inline chart script).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AuthError,
  CookieJar,
  USAGE_DEFAULTS,
  createUsageService,
  parseLogs,
  parseMagnitude,
  parseUsage,
  type UsageConfig,
  type UsageScope,
  type UsageService,
} from './oneway-service.ts'

/* ------------------------------------------------------------------ */
/* Gateway page fixtures                                               */
/* ------------------------------------------------------------------ */

/** One stat card group: an <h3> label followed by the label/value grid. */
function statSection(label: string, cells: readonly (readonly [string, string])[]): string {
  const rendered = cells
    .map(([name, value]) => `<p class="text-xs text-slate-400">${name}</p><p class="text-lg font-semibold text-slate-700">${value}</p>`)
    .join('')
  return `<h3 class="mb-2 text-xs font-semibold text-slate-500">${label}</h3><div class="grid grid-cols-2 gap-3">${rendered}</div></div>`
}

/** One eight-column quota-table row. */
function channelRow(cells: readonly string[]): string {
  return `<tr>${cells.map(cell => `<td class="py-2 px-3">${cell}</td>`).join('')}</tr>`
}

const CHANNEL_TABLE =
  '<h3 class="text-xs font-semibold text-slate-500 mb-2">按渠道用量 / 限额</h3>'
  + '<div class="overflow-x-auto"><table><thead><tr><th>渠道</th></tr></thead><tbody>'
  + channelRow(['oneway', '1.25M', '10M', '3,411', '76.70M', '200M', '不限', '—'])
  + channelRow(['backup', '0', '5M', '12', '1.2M', '50M', '3.4M', '9.9M'])
  + '</tbody></table></div>'

const MODEL_BLOCKS =
  '<div class="rounded-lg border border-slate-200 px-4 py-3">'
  + '<div class="flex flex-wrap items-center gap-2">'
  + '<span class="text-sm font-semibold text-slate-700">🔗 oneway</span>'
  + '<span class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600">deepseek-chat</span>'
  + '<span class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600" title="reasoner">deepseek-reasoner</span>'
  + '</div></div>'

const USAGE_HTML = [
  '<div class="p-6">',
  '<p class="text-sm text-slate-500">姓名：张三</p>',
  '<code class="px-2 py-1 rounded bg-slate-100 text-slate-700 font-mono break-all">sk-oneway-abcdef</code>',
  statSection('Token 用量', [['近 5 小时', '1.25M'], ['今日', '3,411'], ['本周', '76.70M'], ['本月', '不限'], ['本年', '103.1K']]),
  statSection('请求次数', [['近 5 小时', '120'], ['今日', '456'], ['本周', '7,890'], ['本月', '—'], ['本年', '12.0K']]),
  statSection('使用时长', [['近 5 小时', '49.3分钟'], ['今日', '3.5小时'], ['本周', '1.2天'], ['本月', ''], ['本年', '']]),
  CHANNEL_TABLE,
  MODEL_BLOCKS,
  '<script id="myHourlyChart" type="application/json">var data = [{"hour":"09:00","tokens":1200,"requests":4},{"hour":"10:00","tokens":3400,"requests":7}];</script>',
  '<script id="myTrendChart" type="application/json">var data = [{"date":"2026-10-17","tokens":52000,"requests":90}];</script>',
  '</div>',
].join('')

const LOGIN_PAGE_HTML = '<html><head><title>登录 - 企业微信扫码</title></head><body>请扫码</body></html>'

function logRow(row: {
  readonly id: string
  readonly time: string
  readonly model: string
  readonly key: string
  readonly channel: string
  readonly status: string
  readonly stream: string
  readonly latency: string
  readonly tokens: string
}): string {
  return '<tr>'
    + `<td class="font-mono text-xs">${row.time}</td>`
    + `<td class="font-medium">${row.model}</td>`
    + `<td class="text-slate-500">${row.key}</td>`
    + `<td class="text-slate-500">${row.channel}</td>`
    + `<td><span class="px-2 rounded bg-emerald-100 text-emerald-700">${row.status}</span></td>`
    + `<td class="text-slate-500">${row.stream}</td>`
    + `<td class="text-right font-mono">${row.latency}</td>`
    + `<td class="text-right font-mono">${row.tokens}</td>`
    + `<td><a href="/my-requests/${row.id}?from=logs" class="text-blue-600">详情</a></td>`
    + '</tr>'
}

const LOGS_HTML = '<div class="p-6"><p class="text-sm text-slate-500">共 1,234 条</p><table><tbody>'
  + logRow({ id: '9876', time: '2026-10-18 10:00:01', model: 'deepseek-chat', key: 'sk-abcd', channel: 'oneway', status: '成功', stream: '是', latency: '1.2s', tokens: '1,234' })
  + logRow({ id: '9875', time: '2026-10-18 09:59:02', model: 'deepseek-reasoner', key: 'sk-abcd', channel: 'backup', status: '成功', stream: '否', latency: '3.4s', tokens: '2.5K' })
  + '</tbody></table></div>'

/* ------------------------------------------------------------------ */
/* Gateway mock                                                        */
/* ------------------------------------------------------------------ */

/**
 * The WeCom qrcode endpoint answers with a real PNG (probed: `200 image/png`, PNG magic 89504e47),
 * and that image *is* the login code. A valid 1×1 PNG keeps the mock honest about the bytes the
 * service must decode and re-encode, without depending on a binary fixture file.
 */
const MOCK_QR_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
)

interface MockReply {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly setCookies?: readonly string[]
  readonly body?: string
  readonly json?: unknown
  /** Raw bytes for binary replies (the QR PNG); takes precedence over `body`. */
  readonly bytes?: Uint8Array
  /** Response URL, which the parser's auth check inspects; defaults to the request URL. */
  readonly url?: string
}

type MockHandler = (call: { readonly url: string; readonly init: RequestInit }) => MockReply

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** A `fetch` double: replies from `handler`, records every call, and never touches the network. */
function createFetch(handler: MockHandler): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    const reply = handler({ url, init: requestInit })
    const headers = new Headers(reply.headers ?? {})
    for (const cookie of reply.setCookies ?? []) headers.append('set-cookie', cookie)
    const body = reply.body ?? (reply.json === undefined ? '' : JSON.stringify(reply.json))
    const bytes = reply.bytes === undefined ? new ArrayBuffer(0) : (new Uint8Array(reply.bytes).buffer as ArrayBuffer)
    // A plain object is enough: the service only reads status/url/headers/text/json/arrayBuffer.
    const fake = {
      status: reply.status ?? 200,
      url: reply.url ?? url,
      headers,
      text: () => Promise.resolve(body),
      json: () => (reply.json === undefined ? Promise.reject(new Error('不是 JSON')) : Promise.resolve(reply.json)),
      arrayBuffer: () => Promise.resolve(bytes.slice(0)),
    }
    return fake as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

/* ------------------------------------------------------------------ */
/* Shell-side fixtures                                                 */
/* ------------------------------------------------------------------ */

interface ScopeFixture {
  readonly scope: UsageScope
  read(): UsageConfig
  readonly patches: Partial<UsageConfig>[]
}

/** The persistence face the shell owns; the tests only need an in-memory one. */
function createScope(initial: Partial<UsageConfig> = {}): ScopeFixture {
  let config: UsageConfig = { baseUrl: 'https://oneway.test', refreshSeconds: 120, sessionCookie: '', ...initial }
  const patches: Partial<UsageConfig>[] = []
  return {
    scope: {
      get: () => config,
      update: async (patch) => {
        patches.push(patch)
        config = { ...config, ...patch }
      },
    },
    read: () => config,
    patches,
  }
}

interface Harness {
  readonly service: UsageService
  readonly scope: ScopeFixture
  readonly calls: FetchCall[]
  readonly clock: { now: number }
  advance(ms: number): void
}

function createHarness(handler: MockHandler, initial: Partial<UsageConfig> = {}): Harness {
  const scope = createScope(initial)
  const clock = { now: 1_700_000_000_000 }
  const { fetchImpl, calls } = createFetch(handler)
  const service = createUsageService({ scope: scope.scope, fetchImpl, now: () => clock.now, log: () => {} })
  return { service, scope, calls, clock, advance: (ms) => { clock.now += ms } }
}

interface LoginScript {
  issued: number
  polls: number
  /** Whether the final handshake hop sets the gateway session cookie. */
  grantSession: boolean
  /** Statuses the WeCom poll endpoint returns, one per call. */
  readonly pollReplies: readonly string[]
  /** Overrides the QR-image reply; used for the "endpoint failed" cases. */
  readonly qrReply?: MockReply
}

/** The full SSO → WeCom → gateway handshake, as the real endpoints behave. */
function loginHandler(script: LoginScript): MockHandler {
  return ({ url }) => {
    if (url.startsWith('https://oauth.eportyun.com/sso/login')) {
      script.issued += 1
      return {
        status: 302,
        headers: { location: 'https://login.work.weixin.qq.com/wwlogin/sso/qrcode?login_type=CorpApp' },
        setCookies: ['oauth_state=state-1; Path=/'],
      }
    }
    if (url.startsWith('https://login.work.weixin.qq.com/wwlogin/sso/qrcode')) {
      // One path serves both things the flow needs: `?login_type=…` is the scan page, `?key=…` is
      // the QR image the page embeds. A mock that matched only the prefix would answer the image
      // request with HTML — exactly the ambiguity the real service has to treat differently.
      if (url.includes('key=')) {
        return script.qrReply ?? { status: 200, headers: { 'content-type': 'image/png' }, bytes: MOCK_QR_PNG }
      }
      // `web_key` is the QR identity the page serializes as NUXT JSON; the SSO escapes "/" as \u002F.
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: `<html><script>window.__NUXT__={"web_key":"a1b2c3d4${String(script.issued)}","state":"a\\u002Fb c","redirect_uri":"https:\\u002F\\u002Foauth.eportyun.com\\u002Fsso\\u002Fwecom\\u002Fcallback"};</script></html>`,
      }
    }
    if (url.startsWith('https://login.work.weixin.qq.com/wwlogin/monoApi/')) {
      const reply = script.pollReplies[script.polls] ?? 'QRCODE_SCAN_NEVER'
      script.polls += 1
      if (reply === 'QRCODE_SCAN_SUCC') return { json: { errcode: 0, data: { status: reply, auth_code: 'AUTH-CODE-1' } } }
      return { json: { errcode: 0, data: { status: reply } } }
    }
    if (url.startsWith('https://oauth.eportyun.com/sso/wecom/callback')) {
      // The SSO sends the browser back to the gateway, which is where the session cookie is set.
      return { status: 302, headers: { location: 'https://oneway.test/my-usage' } }
    }
    if (url.startsWith('https://oneway.test/my-usage')) {
      return script.grantSession
        ? { status: 200, body: USAGE_HTML, setCookies: ['gw_session=ok; Path=/; Domain=oneway.test; HttpOnly'] }
        : { status: 200, body: USAGE_HTML }
    }
    return { status: 404, body: 'not found' }
  }
}

function headerValue(call: FetchCall, name: string): string {
  const headers = call.init.headers
  if (headers === undefined) return ''
  if (headers instanceof Headers) return headers.get(name) ?? ''
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name)
    return found?.[1] ?? ''
  }
  const record = headers as Record<string, string>
  return record[name] ?? ''
}

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
/* ------------------------------------------------------------------ */

test('parseMagnitude expands the dashboard abbreviations and treats placeholders as no number', () => {
  assert.equal(parseMagnitude('1.25M'), 1_250_000)
  assert.equal(parseMagnitude('3,411'), 3411)
  assert.equal(parseMagnitude('2.5K'), 2500)
  assert.equal(parseMagnitude('1.2万'), 12_000)
  assert.equal(parseMagnitude('1.5亿'), 150_000_000)
  assert.equal(parseMagnitude('49.3分钟'), 49.3)
  assert.equal(parseMagnitude('不限'), null)
  assert.equal(parseMagnitude('—'), null)
  assert.equal(parseMagnitude(''), null)
  assert.equal(parseMagnitude(null), null)
})

test('parseUsage reads the user, API key and the three stat groups', () => {
  const document = parseUsage(USAGE_HTML, 'https://oneway.test/')
  assert.equal(document.user, '张三')
  assert.equal(document.apiKey, 'sk-oneway-abcdef')
  assert.equal(document.pageUrl, 'https://oneway.test/my-usage')

  assert.equal(document.tokens.h5, 1_250_000)
  assert.equal(document.tokens.today, 3411)
  assert.equal(Math.round(document.tokens.week ?? -1), 76_700_000)
  assert.equal(document.tokens.month, null)
  assert.equal(Math.round(document.tokens.year ?? -1), 103_100)

  assert.deepEqual(document.requests, { h5: 120, today: 456, week: 7890, month: null, year: 12_000 })
  assert.deepEqual(document.duration, { h5: 49.3, today: 3.5, week: 1.2, month: null, year: null })
})

test('parseUsage reads the channel quota table and the model groups', () => {
  const document = parseUsage(USAGE_HTML, 'https://oneway.test')
  assert.equal(document.channels.length, 2)
  const [first, second] = document.channels
  assert.equal(first?.channel, 'oneway')
  assert.equal(first?.h5, 1_250_000)
  assert.equal(first?.h5Limit, 10_000_000)
  assert.equal(first?.today, 3411)
  assert.equal(Math.round(first?.week ?? -1), 76_700_000)
  assert.equal(first?.weekLimit, 200_000_000)
  assert.equal(first?.month, null)
  assert.equal(first?.year, null)
  assert.equal(second?.channel, 'backup')
  assert.equal(second?.h5, 0)
  assert.equal(Math.round(second?.week ?? -1), 1_200_000)

  // The link glyph in front of the channel name is decoration, not part of the channel.
  assert.deepEqual(document.models, [
    { channel: 'oneway', count: 2, models: ['deepseek-chat', 'deepseek-reasoner'] },
  ])
})

test('parseUsage reads both inline chart scripts and keeps unknown fields', () => {
  const document = parseUsage(USAGE_HTML, 'https://oneway.test')
  assert.deepEqual(document.hourly, [
    { hour: '09:00', tokens: 1200, requests: 4 },
    { hour: '10:00', tokens: 3400, requests: 7 },
  ])
  assert.deepEqual(document.daily, [{ date: '2026-10-17', tokens: 52000, requests: 90 }])
})

test('parseUsage returns an empty document for a page it does not recognize', () => {
  const document = parseUsage('<html><body>新版本页面</body></html>', 'https://oneway.test')
  assert.equal(document.user, null)
  assert.equal(document.apiKey, null)
  assert.deepEqual(document.tokens, {})
  assert.deepEqual(document.channels, [])
  assert.deepEqual(document.models, [])
  assert.deepEqual(document.hourly, [])
  assert.deepEqual(document.daily, [])
})

test('parseLogs reads the row fields, the total and the page count', () => {
  const page = parseLogs(LOGS_HTML, 'https://oneway.test', 2, 10)
  assert.equal(page.page, 2)
  assert.equal(page.pageSize, 10)
  assert.equal(page.total, 1234)
  assert.equal(page.pages, 124)
  assert.deepEqual(page.rows[0], {
    id: '9876',
    time: '2026-10-18 10:00:01',
    model: 'deepseek-chat',
    key: 'sk-abcd',
    channel: 'oneway',
    status: '成功',
    stream: '是',
    latency: '1.2s',
    tokens: 1234,
  })
  assert.equal(page.rows[1]?.id, '9875')
  assert.equal(page.rows[1]?.tokens, 2500)
})

test('parseLogs leaves paging unknown when the page states no total', () => {
  const page = parseLogs('<html><body>没有请求</body></html>', 'https://oneway.test', 1, 10)
  assert.deepEqual(page.rows, [])
  assert.equal(page.total, null)
  assert.equal(page.pages, null)
})

/* ------------------------------------------------------------------ */
/* Cookie jar                                                          */
/* ------------------------------------------------------------------ */

test('CookieJar picks cookies by domain and path, and never leaks them to another host', () => {
  const jar = new CookieJar()
  jar.set({ name: 'host', value: 'h', domain: 'oneway.test', path: '/' })
  jar.set({ name: 'suffix', value: 's', domain: '.oneway.test', path: '/' })
  jar.set({ name: 'scoped', value: 'p', domain: 'oneway.test', path: '/admin' })

  assert.equal(jar.headerFor('https://oneway.test/my-usage'), 'host=h; suffix=s')
  assert.equal(jar.headerFor('https://api.oneway.test/my-usage'), 'suffix=s')
  assert.equal(jar.headerFor('https://other.test/my-usage'), '')
  assert.equal(jar.headerFor('https://oneway.test/admin/users'), 'host=h; suffix=s; scoped=p')
  assert.equal(jar.headerFor('not a url'), '')
  assert.equal(jar.hasFor('https://other.test/'), false)
})

test('CookieJar drops expired cookies and survives a serialize/restore round trip', () => {
  let now = 1000
  const jar = new CookieJar(() => now)
  jar.set({ name: 'live', value: '1', domain: 'oneway.test', expires: 5000 })
  jar.set({ name: 'dead', value: '2', domain: 'oneway.test', expires: 1500 })
  assert.equal(jar.headerFor('https://oneway.test/'), 'live=1; dead=2')

  now = 1600
  assert.equal(jar.headerFor('https://oneway.test/'), 'live=1')

  const restored = CookieJar.restore(jar.serialize(), () => now)
  assert.equal(restored.cookies.size, 2)
  assert.equal(restored.headerFor('https://oneway.test/'), 'live=1')
})

test('CookieJar absorbs Set-Cookie domain, path and Max-Age, and strips security prefixes', () => {
  let now = 10_000
  const jar = new CookieJar(() => now)
  jar.addFromResponse('https://oneway.test/my-usage', [
    'gw_session=ok; Path=/; Domain=oneway.test; Max-Age=60; HttpOnly',
    '__Secure-token=tok; Path=/my-usage; Domain=oneway.test',
    'plain=1; Path=/',
    'malformed-cookie; Path=/',
  ])
  // Domain came back as the response host, the path scopes the token, and __Secure- never survives.
  assert.equal(jar.headerFor('https://oneway.test/my-usage'), 'gw_session=ok; token=tok; plain=1')
  assert.equal(jar.headerFor('https://oneway.test/other'), 'gw_session=ok; plain=1')

  // Max-Age is applied against the injected clock, not wall time.
  now += 61_000
  assert.equal(jar.headerFor('https://oneway.test/my-usage'), 'token=tok; plain=1')
})

test('CookieJar starts empty when the persisted value is corrupted', () => {
  assert.equal(CookieJar.restore('{not json').cookies.size, 0)
  assert.equal(CookieJar.restore('{"cookie":true}').cookies.size, 0)
  const partly = CookieJar.restore(JSON.stringify([{ name: 'ok', value: '1', domain: 'oneway.test', path: '/' }, { name: 7 }, null]))
  assert.equal(partly.cookies.size, 1)
  assert.equal(partly.headerFor('https://oneway.test/'), 'ok=1')
})

/* ------------------------------------------------------------------ */
/* Snapshot and its degradation                                        */
/* ------------------------------------------------------------------ */

test('snapshot without a session is an empty, signed-out snapshot', async () => {
  const harness = createHarness(() => ({ status: 500 }))
  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.loggedIn, false)
  assert.equal(snapshot.needsLogin, true)
  assert.equal(snapshot.error, '尚未登录。')
  assert.equal(snapshot.fetchedAt, undefined)
  assert.equal(snapshot.user, undefined)
  assert.deepEqual(snapshot.tokens, {})
  assert.deepEqual(snapshot.channels, [])
  assert.deepEqual(snapshot.models, [])
  assert.deepEqual(snapshot.hourly, [])
  assert.deepEqual(snapshot.daily, [])
  assert.deepEqual(snapshot.reference, { weekTokens: 0, monthTokens: 0 })
  assert.deepEqual(snapshot.settings, { baseUrl: 'https://oneway.test', refreshSeconds: 120 })
  assert.equal(harness.calls.length, 0, '未登录时不应该请求网关')
})

test('snapshot turns a 401 into "sign in again" instead of an error the page must catch', async () => {
  const harness = createHarness(() => ({ status: 401 }), { sessionCookie: 'gw_session=stale' })
  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.loggedIn, false)
  assert.equal(snapshot.needsLogin, true)
  assert.match(snapshot.error ?? '', /重新扫码登录/u)
  assert.equal(new AuthError('x').name, 'AuthError')
})

test('snapshot treats a 200 login page as an expired session too', async () => {
  const harness = createHarness(() => ({ status: 200, body: LOGIN_PAGE_HTML }), { sessionCookie: 'gw_session=stale' })
  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.loggedIn, false)
  assert.equal(snapshot.needsLogin, true)
  assert.match(snapshot.error ?? '', /会话已过期/u)
})

test('snapshot reports a page-structure change as an error that needs no new login', async () => {
  const harness = createHarness(() => ({ status: 200, body: '<html><body>新版页面</body></html>' }), { sessionCookie: 'gw_session=ok' })
  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.loggedIn, false)
  assert.equal(snapshot.needsLogin, false)
  assert.match(snapshot.error ?? '', /页面结构变化/u)
})

test('snapshot keeps the last good document when the network fails, and says so', async () => {
  let broken = false
  const harness = createHarness(() => {
    if (broken) throw new Error('network down')
    return { status: 200, body: USAGE_HTML }
  }, { sessionCookie: 'gw_session=ok' })

  const first = await harness.service.snapshot()
  assert.equal(first.loggedIn, true)
  assert.equal(first.user, '张三')
  assert.equal(first.fetchedAt, harness.clock.now)

  broken = true
  harness.advance(121_000)
  const second = await harness.service.snapshot()
  assert.equal(second.loggedIn, true, '旧数据比空面板有用')
  assert.equal(second.user, '张三')
  assert.equal(second.fetchedAt, first.fetchedAt)
  assert.equal(second.needsLogin, false)
  assert.match(second.error ?? '', /network down/u)
})

test('snapshot serves the cache for refreshSeconds and refetches when forced', async () => {
  const harness = createHarness(() => ({ status: 200, body: USAGE_HTML }), { sessionCookie: 'gw_session=ok' })
  await harness.service.snapshot()
  await harness.service.snapshot()
  assert.equal(harness.calls.length, 1)
  await harness.service.snapshot({ force: true })
  assert.equal(harness.calls.length, 2)
  assert.ok(USAGE_DEFAULTS.refreshSeconds > 0)
})

/* ------------------------------------------------------------------ */
/* QR login state machine                                              */
/* ------------------------------------------------------------------ */

test('startLogin returns the WeCom login PNG itself, not a QR code drawn around its URL', async () => {
  const script: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: [] }
  const harness = createHarness(loginHandler(script))
  const first = await harness.service.startLogin()
  assert.match(first.key, /^[a-f0-9]+$/u)
  assert.ok(first.qrDataUrl.startsWith('data:image/png;base64,'), '扫码要直接显示企业微信返回的 PNG')
  const encoded = first.qrDataUrl.slice('data:image/png;base64,'.length)
  assert.deepEqual(new Uint8Array(Buffer.from(encoded, 'base64')), MOCK_QR_PNG, 'data URL 必须原样携带二维码字节')
  assert.equal(first.expiresAt, harness.clock.now + 10 * 60 * 1000)
  // The image is requested with the page's web_key — the magic that makes one scan enough.
  const qrCall = harness.calls.find(call => call.url.startsWith('https://login.work.weixin.qq.com/wwlogin/sso/qrcode?key='))
  assert.ok(qrCall !== undefined, '必须按 web_key 抓取二维码图片')
  assert.equal(new URL(qrCall.url).searchParams.get('key'), first.key)
  const fetchesAfterFirst = harness.calls.length

  const again = await harness.service.startLogin()
  assert.equal(again.key, first.key)
  assert.equal(again.qrDataUrl, first.qrDataUrl)
  assert.equal(harness.calls.length, fetchesAfterFirst, '未过期时不应重新签发二维码')
})

test('startLogin reports a readable error when the QR image endpoint fails', async () => {
  const failing: LoginScript = {
    issued: 0,
    polls: 0,
    grantSession: true,
    pollReplies: [],
    qrReply: { status: 500, body: 'upstream exploded' },
  }
  const harness = createHarness(loginHandler(failing))
  await assert.rejects(harness.service.startLogin(), /无法获取企业微信登录二维码（HTTP 500）/u)
  // A failed start leaves no flow behind, so a retry reissues both the page and the image.
  assert.equal(failing.issued, 1)
  await assert.rejects(harness.service.startLogin(), /无法获取企业微信登录二维码（HTTP 500）/u)
  assert.equal(failing.issued, 2, '失败的二维码不应被当作可复用的 flow')
})

test('startLogin rejects a QR response that is not an image, or is empty', async () => {
  const notImage: LoginScript = {
    issued: 0,
    polls: 0,
    grantSession: true,
    pollReplies: [],
    qrReply: { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>不是二维码</html>' },
  }
  await assert.rejects(createHarness(loginHandler(notImage)).service.startLogin(), /返回类型不是图片：text\/html/u)

  const empty: LoginScript = {
    issued: 0,
    polls: 0,
    grantSession: true,
    pollReplies: [],
    qrReply: { status: 200, headers: { 'content-type': 'image/png' }, bytes: new Uint8Array(0) },
  }
  await assert.rejects(createHarness(loginHandler(empty)).service.startLogin(), /响应为空/u)
})

test('startLogin rejects an absurdly large QR response instead of base64ing it', async () => {
  const huge: LoginScript = {
    issued: 0,
    polls: 0,
    grantSession: true,
    pollReplies: [],
    qrReply: { status: 200, headers: { 'content-type': 'image/png' }, bytes: new Uint8Array(1024 * 1024) },
  }
  await assert.rejects(createHarness(loginHandler(huge)).service.startLogin(), /图片过大/u)
})

test('startLogin issues a new QR code when the caller asks to refresh', async () => {
  const script: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: [] }
  const harness = createHarness(loginHandler(script))
  const first = await harness.service.startLogin()
  const refreshed = await harness.service.startLogin({ refresh: true })
  assert.notEqual(refreshed.key, first.key)
  assert.equal(script.issued, 2)
})

test('pollLogin walks waiting → scanned → confirmed and stores the session', async () => {
  const script: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: ['QRCODE_SCAN_NEVER', 'QRCODE_SCAN_ING', 'QRCODE_SCAN_SUCC'] }
  const harness = createHarness(loginHandler(script))
  const start = await harness.service.startLogin()

  assert.deepEqual(await harness.service.pollLogin(start.key), { state: 'waiting' })
  assert.deepEqual(await harness.service.pollLogin(start.key), { state: 'scanned' })
  assert.deepEqual(await harness.service.pollLogin(start.key), { state: 'confirmed' })

  // The gateway cookie was captured and persisted, and the verification fetch replayed it.
  assert.notEqual(harness.scope.read().sessionCookie, '')
  assert.equal(CookieJar.restore(harness.scope.read().sessionCookie).hasFor('https://oneway.test'), true)
  const verification = harness.calls.find(call => call.url.startsWith('https://oneway.test/my-usage') && call.init.redirect !== 'manual')
  assert.ok(verification !== undefined)
  assert.match(headerValue(verification, 'cookie'), /gw_session=ok/u)

  const snapshot = await harness.service.snapshot()
  assert.equal(snapshot.loggedIn, true)
  assert.equal(snapshot.user, '张三')
  assert.equal(snapshot.needsLogin, false)
  assert.equal(snapshot.error, undefined)

  // A completed flow is gone: the window closing and reopening must not show a dead QR code.
  assert.deepEqual(await harness.service.pollLogin(start.key), { state: 'expired', message: '二维码已失效，请重新获取。' })
})

test('pollLogin reports expired for an unknown or superseded key', async () => {
  const script: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: ['QRCODE_SCAN_NEVER'] }
  const harness = createHarness(loginHandler(script))
  const start = await harness.service.startLogin()
  const polled = await harness.service.pollLogin('deadbeef')
  assert.equal(polled.state, 'expired')
  assert.match(polled.message ?? '', /重新获取/u)

  const refreshed = await harness.service.startLogin({ refresh: true })
  const staleKey = await harness.service.pollLogin(start.key)
  assert.equal(staleKey.state, 'expired')
  assert.notEqual(refreshed.key, start.key)
})

test('pollLogin turns a failed scan and an unknown status into error states', async () => {
  const failing: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: ['QRCODE_SCAN_FAIL'] }
  const first = createHarness(loginHandler(failing))
  const start = await first.service.startLogin()
  const failed = await first.service.pollLogin(start.key)
  assert.equal(failed.state, 'error')
  assert.match(failed.message ?? '', /扫码失败/u)

  const unknown: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: ['SOMETHING_NEW'] }
  const second = createHarness(loginHandler(unknown))
  const nextStart = await second.service.startLogin()
  const odd = await second.service.pollLogin(nextStart.key)
  assert.equal(odd.state, 'error')
  assert.match(odd.message ?? '', /未知扫码状态/u)
})

test('pollLogin expires a QR code that sat on screen for too long', async () => {
  const script: LoginScript = { issued: 0, polls: 0, grantSession: true, pollReplies: ['QRCODE_SCAN_NEVER'] }
  const harness = createHarness(loginHandler(script))
  const start = await harness.service.startLogin()
  harness.advance(11 * 60 * 1000)
  const expired = await harness.service.pollLogin(start.key)
  assert.equal(expired.state, 'expired')
  assert.match(expired.message ?? '', /已过期/u)
  // The flow is dropped, so a second poll cannot resurrect it.
  assert.deepEqual(await harness.service.pollLogin(start.key), { state: 'expired', message: '二维码已失效，请重新获取。' })
})

test('completeLogin refuses to keep a session that never reached the gateway', async () => {
  const script: LoginScript = { issued: 0, polls: 0, grantSession: false, pollReplies: ['QRCODE_SCAN_SUCC'] }
  const harness = createHarness(loginHandler(script))
  const start = await harness.service.startLogin()
  const result = await harness.service.pollLogin(start.key)
  assert.equal(result.state, 'error')
  assert.match(result.message ?? '', /未取得网关会话 Cookie/u)
  assert.equal(harness.scope.read().sessionCookie, '')
  assert.equal(harness.scope.patches.some(patch => (patch.sessionCookie ?? '') !== ''), false)
})

/* ------------------------------------------------------------------ */
/* Request logs                                                        */
/* ------------------------------------------------------------------ */

test('requests parses the log page and caches it briefly', async () => {
  const harness = createHarness(
    ({ url }) => (url.startsWith('https://oneway.test/my-requests') ? { status: 200, body: LOGS_HTML } : { status: 404 }),
    { sessionCookie: 'gw_session=ok' },
  )
  const query = { startDate: '2026-10-12', endDate: '2026-10-18', page: 2, pageSize: 10 }
  const page = await harness.service.requests(query)
  assert.equal(page.rows.length, 2)
  assert.equal(page.total, 1234)
  assert.equal(page.page, 2)
  assert.equal(page.pages, 124)
  assert.equal(page.error, undefined)
  assert.deepEqual(page.rows[0], {
    id: '9876',
    time: '2026-10-18 10:00:01',
    model: 'deepseek-chat',
    key: 'sk-abcd',
    channel: 'oneway',
    status: '成功',
    stream: '是',
    latency: '1.2s',
    tokens: 1234,
  })

  const url = new URL(harness.calls[0]?.url ?? '')
  assert.equal(url.pathname, '/my-requests')
  assert.equal(url.searchParams.get('startDate'), '2026-10-12')
  assert.equal(url.searchParams.get('endDate'), '2026-10-18')
  assert.equal(url.searchParams.get('page'), '2')
  assert.equal(url.searchParams.get('pageSize'), '10')

  const cached = await harness.service.requests(query)
  assert.equal(cached.total, 1234)
  assert.equal(harness.calls.length, 1, '同样的查询在 15 秒内应命中缓存')

  const nextPage = await harness.service.requests({ ...query, page: 3 })
  assert.equal(nextPage.page, 3)
  assert.equal(harness.calls.length, 2)
})

test('requests normalizes the query it sends to the gateway', async () => {
  const harness = createHarness(() => ({ status: 200, body: LOGS_HTML }), { sessionCookie: 'gw_session=ok' })
  const page = await harness.service.requests({ startDate: '2026-1-1', page: Number.NaN, pageSize: 999 })
  const url = new URL(harness.calls[0]?.url ?? '')
  assert.equal(url.searchParams.get('startDate'), null, '不是 YYYY-MM-DD 的日期要丢弃')
  assert.equal(url.searchParams.get('page'), '1')
  assert.equal(url.searchParams.get('pageSize'), '50')
  assert.equal(page.page, 1)
  assert.equal(page.pageSize, 50)
})

test('requests returns an empty page carrying the reason instead of rejecting', async () => {
  const harness = createHarness(() => { throw new Error('network down') }, { sessionCookie: 'gw_session=ok' })
  const page = await harness.service.requests()
  assert.deepEqual(page.rows, [])
  assert.equal(page.total, null)
  assert.equal(page.pages, null)
  assert.match(page.error ?? '', /network down/u)
})

test('an auth failure while loading logs invalidates the usage cache as well', async () => {
  let expired = false
  const harness = createHarness(
    ({ url }) => {
      if (expired) return { status: 200, body: LOGIN_PAGE_HTML }
      return url.startsWith('https://oneway.test/my-requests') ? { status: 200, body: LOGS_HTML } : { status: 200, body: USAGE_HTML }
    },
    { sessionCookie: 'gw_session=ok' },
  )
  const before = await harness.service.snapshot()
  assert.equal(before.loggedIn, true)

  expired = true
  const page = await harness.service.requests()
  assert.match(page.error ?? '', /会话已过期/u)

  const after = await harness.service.snapshot()
  assert.equal(after.loggedIn, false)
  assert.equal(after.needsLogin, true)
})

/* ------------------------------------------------------------------ */
/* Signing out                                                         */
/* ------------------------------------------------------------------ */

test('logout clears the session and returns the signed-out snapshot', async () => {
  const harness = createHarness(() => ({ status: 200, body: USAGE_HTML }), { sessionCookie: 'gw_session=ok' })
  const before = await harness.service.snapshot()
  assert.equal(before.loggedIn, true)

  const after = await harness.service.logout()
  assert.equal(after.loggedIn, false)
  assert.equal(after.needsLogin, true)
  assert.equal(after.error, '尚未登录。')
  assert.equal(after.user, undefined)
  assert.equal(harness.scope.read().sessionCookie, '')
  assert.ok(harness.scope.patches.some(patch => patch.sessionCookie === ''))
  assert.equal(harness.calls.length, 1, '退出登录不需要再请求网关')
})
