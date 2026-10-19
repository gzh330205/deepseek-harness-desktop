/**
 * Static guards for the ONE-WAY usage window.
 *
 * Same class of bug every shell page in this repo was guarded against: nothing else sees this markup,
 * its CSS and its script together, and `did-finish-load` fires happily for a page whose script throws
 * before its first paint. The window is also the only place that assembles the plugin's four tabs from
 * the shell bridge, so a rename on either side of `window.__DSH_USAGE__` would silently blank a panel.
 *
 * The guards below pin the decisions the task asked for explicitly:
 *
 *   - three metric cards (近 5 小时 / 今日 / 本周) with a percentage relative to this week, falling
 *     back to this month when the week is 0;
 *   - four tabs, request logs with date range + paging, width-only trend bars, channel limits and
 *     model chips;
 *   - QR login polls `loginPoll` every 1.5 s and handles waiting/scanned/expired/confirmed/error;
 *   - the page only ever speaks through `window.__DSH_USAGE__`, and says so when it is missing.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(fileURLToPath(new URL('./usage-ui/index.html', import.meta.url)), 'utf8')
const script = /<script>([\s\S]*)<\/script>/u.exec(page)?.[1] ?? ''
const markup = page.slice(0, page.indexOf('<script>'))

/** All ids used through the `$('…')` helper, plus the dynamic metric ids it builds at runtime. */
const DYNAMIC_IDS = ['metricH5', 'metricH5Pct', 'barH5', 'metricToday', 'metricTodayPct', 'barToday', 'metricWeek', 'metricWeekPct', 'barWeek']

test('one style block in the head, and a CSP that permits no network', () => {
  assert.equal((page.match(/<style\b/gu) ?? []).length, 1, 'a second style block can silently override the layout')
  assert.ok(page.indexOf('<style') < page.indexOf('</head>'), 'styles belong in the head')
  assert.match(page, /Content-Security-Policy[^>]*default-src 'none'/u)
  assert.match(page, /Content-Security-Policy[^>]*img-src 'self' data:/u)
  assert.match(page, /Content-Security-Policy[^>]*script-src 'unsafe-inline'/u)
})

test('the page never fetches, frames or writes markup itself, and loads no external resource', () => {
  assert.doesNotMatch(script, /\bfetch\(|XMLHttpRequest|innerHTML/u, '用量数据只能走桌面壳桥')
  assert.doesNotMatch(page, /<link\b/iu, 'no external stylesheets')
  assert.doesNotMatch(page, /<script[^>]*\bsrc=/iu, 'the only script is inline')
  assert.doesNotMatch(page, /@import/iu, 'no CSS imports')
  assert.doesNotMatch(page, /\bsrc="https?:/iu, 'no remote images or scripts')
})

test('the page only speaks through __DSH_USAGE__, and every id it looks up exists', () => {
  const bridges = new Set([...script.matchAll(/window\.__DSH_([A-Z]+)__/gu)].map(match => match[1]))
  assert.deepEqual([...bridges], ['USAGE'], '这个窗口只该用 __DSH_USAGE__ 桥')

  const markupIds = [...markup.matchAll(/id="([A-Za-z0-9_-]+)"/gu)].map(match => match[1])
  assert.deepEqual([...new Set(markupIds)].length, markupIds.length, 'duplicate ids would make getElementById lie')
  const ids = new Set(markupIds)
  const looked = new Set([
    ...[...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/gu)].map(match => match[1]),
    ...DYNAMIC_IDS,
  ])
  assert.ok(looked.size > 35, `sanity: the page should look up a lot of elements（实际 ${looked.size}）`)
  const missing = [...looked].filter(id => !ids.has(id))
  assert.deepEqual(missing, [], `the script looks up ids that do not exist: ${missing.join(', ')}`)
})

test('exactly the bridge methods from the ONE-WAY window contract are used', () => {
  const used = new Set([...script.matchAll(/api\.([A-Za-z]+)\(/gu)].map(match => match[1]))
  const expected = ['close', 'get', 'loginPoll', 'loginStart', 'logout', 'refresh', 'requestDetail', 'requests', 'saveSettings', 'settings']
  assert.deepEqual([...used].sort(), expected, '方法名必须与 preload 契约一致')
})

test('one page-level scrollbar: inner tables and trend lists no longer scroll on their own', () => {
  // The window used to have `main { overflow-y: auto }` plus a capped-height `.table-wrap` and
  // `.bar-list` with their own `overflow`, so scrolling the page inside a panel produced a second,
  // inner scrollbar. Only two vertical scrollers are allowed: `main` for the page and the request
  // detail modal, whose JSON body can be a megabyte tall.
  assert.equal((page.match(/overflow-y:\s*auto/gu) ?? []).length, 2, 'main 与请求明细弹窗是仅有的两个纵向滚动容器')
  assert.match(page, /\.detail-modal \{[^}]*max-height: calc\(100vh - 48px\)[^}]*overflow-y: auto/u)
  assert.match(page, /\.table-wrap \{[^}]*overflow-x: auto/u, '窄窗口仍要能横向滚动表格')
  // Vertical overflow is left to the page: the table-wrap must not cap or scroll its height.
  assert.doesNotMatch(page, /\.table-wrap \{[^}]*max-height/u)
  // `overflow-x: auto` alone computes `overflow-y` as `auto` (CSS rule), which made the box a second
  // vertical scroll container in computed styles; say `clip` explicitly so the single-scroll intent is
  // visible in the stylesheet and in the layout probe.
  assert.match(page, /\.table-wrap \{[^}]*overflow-y: clip/u)
  assert.doesNotMatch(page, /\.table-wrap \{[^}]*overflow-y: (?:auto|scroll)/u)
  // Same for the hourly/daily lists: they now grow with the page.
  assert.doesNotMatch(page, /\.bar-list \{[^}]*max-height/u)
  assert.doesNotMatch(page, /\.bar-list \{[^}]*overflow/u)
  assert.doesNotMatch(page, /overflow:\s*auto/u, '内层不能再出现双向 auto 滚动')
})

test('three metric cards show the plugin trio, relative to this week (month when the week is 0)', () => {
  const metrics: ReadonlyArray<readonly [string, string]> = [['metricH5', '近 5 小时'], ['metricToday', '今日'], ['metricWeek', '本周']]
  for (const [id, label] of metrics) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'))
    assert.match(markup, new RegExp(label.replace(/ /gu, ' '), 'u'))
  }
  assert.match(script, /tokens\[metric\.key\]/u)
  assert.match(script, /reference\.weekTokens/u)
  assert.match(script, /reference\.monthTokens/u)
  assert.match(script, /percentOf\(/u)
  // The card percentages come from `referenceTokens`, which falls back week → month.
  assert.match(script, /本周用量为 0，占比改按本月用量/u)
  assert.match(markup, /id="weekRefHint"/u)
})

test('four tabs, one visible panel at a time', () => {
  const tabs = ['tabLogs', 'tabTrend', 'tabChannels', 'tabModels']
  const panels = ['panelLogs', 'panelTrend', 'panelChannels', 'panelModels']
  for (const id of [...tabs, ...panels]) assert.match(markup, new RegExp(`id="${id}"`, 'u'))
  for (const label of ['请求日志', '用量趋势', '渠道用量 · 限额', '渠道与模型']) assert.match(markup, new RegExp(label.replace(/ /gu, '\\s*'), 'u'))
  // Only the log panel starts visible; the script flips `hidden` + `aria-selected` together.
  assert.match(markup, /id="panelTrend" role="tabpanel"[^>]*hidden/u)
  assert.match(markup, /id="panelChannels" role="tabpanel"[^>]*hidden/u)
  assert.match(markup, /id="panelModels" role="tabpanel"[^>]*hidden/u)
  assert.match(script, /setAttribute\('aria-selected'/u)
  assert.match(script, /\$\(tab\.panel\)\.hidden = !selected/u)
})

test('request logs: date range, the plugin eight columns, and paging', () => {
  for (const id of ['logStart', 'logEnd', 'logPageSize', 'logQuery', 'logError', 'logRows', 'logPrev', 'logNext', 'logPagerInfo']) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'))
  }
  for (const header of ['时间', '模型', '所属 Key', '渠道', '状态', '流式', '延迟', 'Token']) {
    assert.match(markup, new RegExp(`>${header}<`, 'u'))
  }
  assert.match(script, /api\.requests\(\{ startDate: startDate, endDate: endDate, page: logs\.page, pageSize: pageSize \}\)/u)
  for (const field of ['row.time', 'row.model', 'row.key', 'row.channel', 'row.stream', 'row.latency', 'row.tokens', 'row.status']) {
    assert.match(script, new RegExp(field.replace('.', '\\.'), 'u'), `日志行要渲染 ${field}`)
  }
  assert.match(script, /第 ' \+ logs\.page \+ ' \/ ' \+ logs\.pages/u)
  // A degraded page arrives as `{ rows: [], error }` rather than a rejection; it must be shown.
  assert.match(script, /result\.error/u)
  assert.match(script, /读取请求日志失败/u)
})

test('the top bar shows the masked API key the shell parsed from the page', () => {
  assert.match(markup, /id="apiKey"/u)
  assert.match(script, /\$\('apiKey'\)\.textContent = display\(state\.apiKey\)/u)
})

test('request log rows open the detail modal by click, Enter and Space', () => {
  // Rows carry the request id and are keyboard reachable; the CSS gives them a pointer cursor and a
  // focus ring. The 9th gateway column is not rendered, so the row itself is the affordance.
  assert.match(page, /\.logs tbody tr\[data-id\] \{ cursor: pointer; \}/u)
  assert.match(script, /line\.dataset\.id = rowId/u)
  assert.match(script, /line\.tabIndex = 0/u)
  assert.match(script, /\$\(tab\.button\)\.addEventListener\('click', \(\) => \{ paintDetailBody\(tab\.key\) \}\)/u)
  assert.match(script, /\$\('logRows'\)\.addEventListener\('click', \(event\) => \{[\s\S]{0,220}openDetail\(id\)/u)
  // Enter and Space both trigger the row, not only the mouse.
  assert.match(script, /event\.key !== 'Enter' && event\.key !== ' '/u)
  assert.match(script, /void openDetail\(id\)/u)
  assert.match(script, /api\.requestDetail\(text\)/u)
})

test('request detail modal: title, info grid, body tabs, truncation constant and copy', () => {
  for (const id of [
    'detailModal', 'detailTitle', 'detailMeta', 'detailLoading', 'detailError', 'detailInfo', 'detailBodies',
    'detailTabRequest', 'detailTabResponse', 'detailRequestBody', 'detailResponseBody',
    'detailRequestPre', 'detailResponsePre', 'detailRequestHint', 'detailResponseHint',
    'detailRequestCopy', 'detailResponseCopy', 'detailClose', 'detailFooterClose',
  ]) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'))
  }
  assert.match(markup, /id="detailModal"[^>]*hidden/u)
  assert.match(markup, /id="detailModal"[\s\S]{0,200}role="dialog"[^>]*aria-modal="true"/u)
  assert.match(markup, /id="detailTitle">请求明细/u)
  // Two body tabs, request first; only one panel is visible at a time.
  assert.match(markup, /id="detailTabRequest"[^>]*aria-selected="true"/u)
  assert.match(markup, /id="detailResponseBody" role="tabpanel"[^>]*hidden/u)
  for (const label of ['请求体', '响应体', '复制完整 JSON']) assert.match(markup, new RegExp(label, 'u'))
  // The truncation threshold is a named constant, and the copy button always copies the full text.
  assert.match(script, /DETAIL_BODY_LIMIT = 120000/u)
  assert.match(script, /text\.length > DETAIL_BODY_LIMIT/u)
  assert.match(script, /text\.slice\(0, DETAIL_BODY_LIMIT\)/u)
  assert.match(script, /已截断，共 /u)
  assert.match(script, /pre\.textContent = /u, 'JSON 只能写 textContent，不能用 innerHTML')
  assert.match(script, /navigator\.clipboard\.writeText/u)
  assert.match(script, /复制失败/u)
  // Loading and error are separate states, and Esc closes the modal.
  assert.match(script, /detailLoading'\)\.hidden = false/u)
  assert.match(script, /读取请求明细失败：/u)
  assert.match(script, /event\.key === 'Escape'/u)
  assert.match(script, /if \(!api \|\| typeof api\.requestDetail !== 'function'\)/u, '旧壳没有该方法时不能崩')
})

test('trend tab: 24 hourly and 30 daily bars made of divs and widths, never canvas', () => {
  assert.match(markup, /id="hourlyList"/u)
  assert.match(markup, /id="dailyList"/u)
  assert.match(markup, /近 24 小时 · 每小时/u)
  assert.match(markup, /近 30 天 · 每日/u)
  assert.match(script, /renderBars\(\$\('hourlyList'\), snapshot\.hourly, 'hour'/u)
  assert.match(script, /renderBars\(\$\('dailyList'\), snapshot\.daily, 'date'/u)
  assert.match(script, /fill\.style\.width = /u)
  assert.doesNotMatch(page, /<canvas|<svg/iu, '条形图必须用 div 宽度实现')
})

test('channels tab: five usage windows and limit progress bars', () => {
  assert.match(markup, /id="channelRows"/u)
  for (const header of ['近 5 小时', '5h 限额', '今日', '本周', '周限额', '本月', '本年']) {
    assert.match(markup, new RegExp(`>${header}<`, 'u'))
  }
  assert.match(script, /limitCell\(channel\.h5, channel\.h5Limit\)/u)
  assert.match(script, /limitCell\(channel\.week, channel\.weekLimit\)/u)
  assert.match(script, /'不限'/u, 'no limit must read as 不限, not as a zero-length bar')
  assert.match(script, /bar\.dataset\.warn = 'true'/u)
  assert.match(script, /bar\.dataset\.full = 'true'/u)
})

test('models tab: chips grouped by channel', () => {
  assert.match(markup, /id="modelGrid"/u)
  assert.match(script, /group\.channel/u)
  assert.match(script, /group\.models/u)
  assert.match(script, /'chip'/u)
  assert.match(script, /个模型/u)
})

test('QR login: loginStart image, 1.5 s loginPoll loop, and every state answered', () => {
  for (const id of ['loginModal', 'loginQr', 'loginState', 'loginHint', 'loginMessage', 'loginRefresh', 'loginCancel']) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'))
  }
  assert.match(markup, /id="loginModal"[^>]*hidden/u)
  assert.match(script, /api\.loginStart\(\)/u)
  assert.match(script, /api\.loginPoll\(login\.key\)/u)
  assert.match(script, /LOGIN_POLL_MS = 1500/u)
  assert.match(script, /setTimeout\(\(\) => \{ void pollLogin\(generation\) \}, LOGIN_POLL_MS\)/u)
  assert.match(script, /result\.qrDataUrl/u)
  for (const phase of ['waiting', 'scanned', 'expired', 'confirmed', 'error']) {
    assert.match(script, new RegExp(`phase === '${phase}'`, 'u'), `扫码状态 ${phase} 必须有分支`)
  }
  // Expired keeps the dialog open and offers a fresh QR rather than pretending success.
  assert.match(script, /phase === 'expired'[\s\S]{0,320}\$\('loginRefresh'\)\.disabled = false/u)
  assert.match(script, /phase === 'confirmed'[\s\S]{0,320}refreshNow\(\)/u)
})

test('settings open from the top bar and sit at the top of the page, validated and refreshing immediately', () => {
  assert.match(markup, /<details class="settings" id="settingsBox"/u)
  assert.match(markup, /id="baseUrlInput"/u)
  assert.match(markup, /id="refreshSecondsInput"[^>]*min="30"[^>]*max="3600"/u)
  assert.match(markup, /id="settingsSave"/u)
  assert.match(markup, /id="settingsHint"/u)
  assert.match(script, /api\.saveSettings\(\{ baseUrl: baseUrl, refreshSeconds: Math\.round\(refreshSeconds\) \}\)/u)
  assert.match(script, /refreshSeconds < 30 \|\| refreshSeconds > 3600/u)
  assert.match(script, /await refreshNow\(\)/u, '保存后立即刷新')
  assert.match(script, /baseUrlInput'\)\.value = settingsCache\.baseUrl/u, '设置表单要回填当前值')
  assert.match(script, /await applySettingsFromShell\(true\)/u, '打开窗口时要把已保存的设置填进表单')

  // The toggle lives in the top bar next to 立即刷新; the form itself is the first thing in <main>,
  // ahead of the metric cards — it used to be the last block on the page, which is what made it hard
  // to find. Both controls drive the same <details>, so there is still exactly one settings form.
  const header = markup.slice(markup.indexOf('<header class="topbar"'), markup.indexOf('</header>'))
  assert.match(header, /id="refreshBtn"/u)
  assert.match(header, /id="settingsToggle"[^>]*aria-controls="settingsBox"/u)
  assert.ok(markup.indexOf('id="refreshBtn"') < markup.indexOf('id="settingsToggle"'), '设置按钮紧挨立即刷新')
  assert.ok(markup.indexOf('id="settingsBox"') < markup.indexOf('class="cards"'), '设置面板要移到 main 顶部')
  assert.match(script, /function toggleSettings\(\)/u)
  assert.match(script, /\$\('settingsBox'\)/u)
  assert.match(script, /box\.open = !box\.open/u)
  assert.match(script, /scrollIntoView\(/u, '打开设置后要滚到可见')
  assert.match(script, /\$\('settingsToggle'\)\.addEventListener\('click', toggleSettings\)/u)
  assert.match(script, /aria-expanded/u, '按钮与 <details> 的展开状态要保持同步')
})

test('automatic polling re-reads the settings before every get, so a new interval takes effect', () => {
  assert.match(script, /async function tick\(\)/u)
  assert.match(script, /await applySettingsFromShell\(false\)/u)
  assert.match(script, /const snapshot = await api\.get\(\)/u)
  assert.match(script, /refreshTimer = setTimeout\(\(\) => \{ void tick\(\) \}, seconds \* 1000\)/u)
  assert.match(script, /settingsCache\.refreshSeconds/u)
})

test('without the bridge the window explains itself instead of going blank', () => {
  assert.match(markup, /id="apiMissing"/u)
  assert.match(markup, /桌面壳 API 未加载/u)
  assert.match(script, /if \(!api\)/u)
  assert.match(script, /\$\('apiMissing'\)\.hidden = false/u)
  assert.match(script, /setStatus\('桌面壳 API 未加载/u)
  // Every command on the page is wired to the bridge: refresh, logout, close and settings.
  assert.match(script, /api\.refresh\(\)/u)
  assert.match(script, /api\.logout\(\)/u)
  assert.match(script, /api\.close\(\)/u)
})
