/**
 * The agent-facing browser tools: schemas, argument coercion, and the model-facing text.
 *
 * The tools are exposed to DSH over MCP (see `agent-bridge.ts`), so nothing here knows
 * about DSH plugins, providers or sessions: it is a name + JSON Schema + a call that
 * returns MCP `content` blocks. The browser operations themselves live in
 * `browser-view.ts`, behind {@link BrowserToolHost} — which also makes this file testable
 * with a fake host (no Electron).
 *
 * Semantics (element handles, viewport notes, side-effect markers) are adapted from OneCode
 * `apps/desktop/src/main/browser/agentBrowserTools.ts` (MIT); the page-injection scripts it
 * drives are vendored verbatim in `browser-snapshot.ts`.
 */

import { SNAPSHOT_DISPLAY_CAP } from './browser-snapshot.ts'
import { releasedPrefix, staleResultNote, waitTimeoutText, type ControlWaitOutcome } from './browser-control.ts'

export interface BrowserTextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface BrowserToolResult {
  readonly content: readonly BrowserTextBlock[]
  readonly isError?: boolean
}

export interface SnapshotElement {
  readonly index: number
  readonly role: string
  readonly name: string
  readonly tag: string
  readonly selector: string
  readonly text: string
  readonly inView: boolean
  readonly state: readonly string[]
}

export interface SnapshotData {
  readonly url: string
  readonly title: string
  readonly readyState: string
  readonly html: string
  readonly bodyText: string
  readonly interactive: readonly SnapshotElement[]
}

export type HostResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: string; readonly options?: readonly SelectOptionEntry[] }

export interface FindInput {
  readonly selector?: string | undefined
  readonly text?: string | undefined
  readonly regex?: boolean | undefined
  readonly caseSensitive?: boolean | undefined
  readonly maxResults?: number | undefined
  readonly attributes?: readonly string[] | undefined
  readonly cssScope?: string | undefined
}

export interface FindMatch {
  readonly tag?: string
  readonly text?: string
  readonly selector?: string
  readonly snippet?: string
  readonly attributes?: Record<string, string>
}

export interface FindOutput {
  readonly matches: readonly FindMatch[]
  readonly total?: number
}

export interface ScrollOutput {
  readonly scrollY: number
  readonly scrollHeight: number
  readonly viewport: number
  readonly url: string
  readonly title: string
}

export interface SelectOptionEntry {
  readonly value: string
  readonly text: string
  readonly selected: boolean
}

export interface SelectOutput {
  readonly selected?: SelectOptionEntry
  readonly options?: readonly SelectOptionEntry[]
}

/** One open sidebar browser tab, as the agent sees it. */
export interface BrowserTabSummary {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly visible: boolean
  readonly active: boolean
}

/** The browser operations a tool can drive. Implemented by `BrowserTabs`. */
export interface BrowserToolHost {
  /** False until a browser view exists; tools then explain how the user opens the panel. */
  readonly created: boolean
  /**
   * True while the user holds the browser (they clicked it and took over).
   *
   * Tools refuse anything that would fight them for the page: the user's click is a signal that
   * they want to drive, and silently navigating under their cursor is the worst possible answer.
   * Metadata lookups (`state`, `tabs`) stay allowed so the agent can report accurately.
   */
  readonly userDriving?: boolean
  /**
   * Resolve once the user hands control back (`'released'`), the wait cap passes (`'timeout'`),
   * or the transport cancels (`'aborted'`). Absent on hosts that predate handing over — those
   * fall back to the immediate refusal.
   */
  readonly waitForControl?: (signal?: AbortSignal) => Promise<ControlWaitOutcome>
  state(): { url: string; title: string; loading: boolean; visible: boolean; tab: string; tabCount: number }
  tabs(): readonly BrowserTabSummary[]
  switchTab(id: string): HostResult<{ tab: BrowserTabSummary }>
  navigate(address: string, options: { show: boolean }): Promise<HostResult<{ url: string; title: string; tab: string; visible: boolean }>>
  back(): HostResult<{ url: string; title: string }>
  forward(): HostResult<{ url: string; title: string }>
  reload(): HostResult<{ url: string; title: string }>
  snapshot(): Promise<HostResult<{ data: SnapshotData }>>
  click(input: {
    index?: number | undefined
    selector?: string | undefined
    coordinateX?: number | undefined
    coordinateY?: number | undefined
  }): Promise<HostResult<{ url: string; title: string; obscured?: { tag: string; text: string } }>>
  type(input: {
    index?: number | undefined
    selector?: string | undefined
    text: string
    clear?: boolean | undefined
  }): Promise<HostResult<{ url: string; title: string }>>
  keys(keys: string): Promise<HostResult<{ url: string; title: string }>>
  scroll(input: {
    direction: 'up' | 'down'
    pages: number
    selector?: string | undefined
  }): Promise<HostResult<ScrollOutput>>
  wait(input: {
    selector?: string | undefined
    text?: string | undefined
    seconds?: number | undefined
    timeoutSeconds?: number | undefined
  }): Promise<HostResult<{ url: string; title: string }>>
  select(input: {
    index?: number | undefined
    selector?: string | undefined
    value: string
  }): Promise<HostResult<SelectOutput>>
  find(input: FindInput): Promise<HostResult<FindOutput>>
  screenshot(fullPage: boolean): Promise<HostResult<{ file: string; bytes: number; fullPage: boolean }>>
}

export interface BrowserToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: { readonly readOnlyHint: boolean; readonly openWorldHint: boolean }
}

const TEXT_SCHEMA: Record<string, unknown> = { type: 'string' }
/**
 * Schemas stay inside the JSON Schema subset DSH's native tool registry accepts
 * (`type/oneOf/properties/required/additionalProperties/items/enum/const` plus the
 * `description/title/default/examples` annotations). Numeric bounds such as `minimum` are
 * rejected there, so they live in the description and are enforced in code instead (the page
 * script clamps `maxResults`, and the shell rejects a missing element index with a message).
 * `browser-tool-schema.test.ts` keeps every tool inside that subset.
 */
const INDEX_SCHEMA: Record<string, unknown> = {
  type: 'integer',
  description: '元素索引（从 1 开始），来自最近一次 snapshot 的 [n]',
}
const SELECTOR_SCHEMA: Record<string, unknown> = {
  type: 'string',
  description: 'CSS 选择器（index 的兜底写法）',
}
const HANDLE_PROPERTIES: Record<string, unknown> = { index: INDEX_SCHEMA, selector: SELECTOR_SCHEMA }

/**
 * The tool catalog. Names are prefixed by the MCP server name (`desktop_browser`), so the
 * model sees `mcp__desktop_browser__snapshot` and friends.
 */
export const BROWSER_TOOLS: readonly BrowserToolDefinition[] = [
  {
    name: 'state',
    description:
      '查看侧边栏浏览器的当前状态：正在操作的标签、URL、标题、是否加载中、面板是否可见、一共开了几个标签。不打开新页面、不改动页面。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tabs',
    description:
      '列出侧边栏里所有已打开的浏览器标签（id、URL、标题、是否可见、哪个是当前操作目标）。只读。' +
      '当用户开了多个标签时，先用它确认目标，再用 switch_tab 切换。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'switch_tab',
    description: '把后续工具调用的目标切到指定标签（id 来自 tabs）。只读定位操作，不改变用户在看的页面。',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'tabs 返回的标签 id' } },
      required: ['tab'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'navigate',
    description:
      '在桌面端自带的侧边栏浏览器里打开一个 http/https 网址并等待加载完成。不带 scheme 的主机名补全为 https。' +
      '默认会把它显示给用户（打开右侧栏的「浏览器」标签），用户看到的就是你正在操作的这一页。' +
      '加载后用 snapshot 读取页面结构，或直接 click/type 操作。会新建页面、产生真实网络请求。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { ...TEXT_SCHEMA, description: '要打开的网址，例如 example.com 或 https://example.com/a' },
        show: {
          type: 'boolean',
          description:
            '是否把这一页显示给用户（默认 true）。为 true 时桌面壳会打开右侧栏的「浏览器」标签并把这一页摆到用户眼前——' +
            '用户看到的那一个页面就是你正在操作的那一个（同一个视图）。' +
            '只有当你确实不想打扰用户、只想在后台读取时才传 false。',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'snapshot',
    description:
      '读取当前页面的结构化快照：URL、标题、正文文本，以及带 [n] 索引的可交互元素（角色、可访问名、表单状态、是否在视口内、稳定选择器）。' +
      '索引可直接传给 click/type/select 的 index 参数。这是理解页面内容、定位元素的主要方式，只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'find',
    description:
      '不拉取整页 HTML 的轻量查找：按 CSS 选择器找元素（可提取 href/src/class 等属性），或按文本/正则搜索页面正文并返回上下文片段。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_SCHEMA,
        text: { ...TEXT_SCHEMA, description: '要在页面正文里搜索的文本' },
        regex: { type: 'boolean', description: 'text 按正则解释（默认 false）' },
        caseSensitive: { type: 'boolean', description: '是否区分大小写（默认 false）' },
        maxResults: { type: 'integer', description: '最多返回多少条（默认 25，上限 100）' },
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description: 'selector 模式下要一并返回的属性名，例如 ["href","class"]（最多 8 个）',
        },
        cssScope: { ...TEXT_SCHEMA, description: '只在该选择器命中的子树里查找' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'click',
    description:
      '点击页面元素：优先传 index（最近一次 snapshot 的 [n]），也可传 selector 或视口坐标 coordinateX/coordinateY。' +
      '点击走真实输入管线（会自动把元素滚到视口内），hover 菜单、焦点行为与用户点击一致。有副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...HANDLE_PROPERTIES,
        coordinateX: { type: 'number', description: '视口坐标 X（与 coordinateY 一起用）' },
        coordinateY: { type: 'number', description: '视口坐标 Y（与 coordinateX 一起用）' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'type',
    description:
      '向输入框/textarea/contenteditable 填文本（React/Vue 受控组件同样生效）。clear 默认 true（覆盖），false 表示追加。' +
      '输入后元素保持聚焦，可接 keys({keys:"Enter"}) 提交表单。有副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...HANDLE_PROPERTIES,
        text: { ...TEXT_SCHEMA, description: '要填入的文本' },
        clear: { type: 'boolean', description: '先清空原值（默认 true）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'keys',
    description:
      '发送一个按键或组合键（Enter / Escape / Tab / ArrowDown / PageDown / Control+a / Shift+Enter）。' +
      '走真实输入管线，Enter 能提交表单、Tab 能移动焦点。一次一个组合键；要输入文本请用 type。有副作用。',
    inputSchema: {
      type: 'object',
      properties: { keys: { ...TEXT_SCHEMA, description: '按键或组合键，例如 Enter 或 Control+a' } },
      required: ['keys'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'scroll',
    description: '滚动页面（或指定元素的可滚动区域）。只读（不改动页面内容）。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: '方向' },
        pages: { type: 'number', description: '滚动多少屏（默认 1）' },
        selector: { ...SELECTOR_SCHEMA, description: '要滚动的元素（省略则滚整个页面）' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'wait',
    description:
      '等待某个元素出现/可见，或等待某段文本出现在正文里，或固定等待若干秒（异步页面加载用）。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: SELECTOR_SCHEMA,
        text: { ...TEXT_SCHEMA, description: '等待正文里出现的文本' },
        seconds: { type: 'number', description: '固定等待秒数（1–60）' },
        timeoutSeconds: { type: 'number', description: '超时秒数（默认 10，上限 60）' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'history',
    description: '浏览历史操作：后退 / 前进 / 刷新，并等待页面稳定。只读（不改变页面内容之外的状态）。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'], description: '要执行的动作' } },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'select',
    description:
      '在原生 <select> 下拉框里按 value 或可见文本选中一项（先精确匹配，再忽略大小写/空格）。' +
      '没有匹配时返回全部选项供重试。自定义（div 模拟的）下拉请用 click 展开后点击选项。有副作用。',
    inputSchema: {
      type: 'object',
      properties: {
        ...HANDLE_PROPERTIES,
        value: { ...TEXT_SCHEMA, description: '选项的 value 或可见文本' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'screenshot',
    description:
      '截图并保存为本地 PNG 文件，返回文件路径供后续用 present 展示。fullPage: true 抓整页（含滚动区域），' +
      '默认只抓当前视口。只读。',
    inputSchema: {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: '是否抓整页（默认 false，只抓视口）' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
]

function text(value: string): BrowserToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function errorResult(value: string): BrowserToolResult {
  return { content: [{ type: 'text', text: value }], isError: true }
}

/** The user has to open the panel once: tools never conjure a native surface out of nothing. */
const NO_BROWSER =
  '当前还没有浏览器视图。请先在 DSH 右侧栏打开「浏览器」面板（侧栏 guide 里的浏览器入口），然后再调用这些工具。' +
  '面板打开后页面会一直保留，即使切到别的 tab。'

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return list.length === 0 ? undefined : list
}

function describeTarget(index: number | undefined, selector: string | undefined): string {
  if (index !== undefined) return `元素 [${index}]`
  return `"${selector ?? ''}"`
}

/** Prepend an explanatory line to a result (used when a call had to wait for control). */
function withPrefix(result: BrowserToolResult, prefix: string): BrowserToolResult {
  const [first, ...rest] = result.content
  if (first === undefined) {
    return result.isError === true
      ? { content: [{ type: 'text', text: prefix }], isError: true }
      : { content: [{ type: 'text', text: prefix }] }
  }
  const head = first.text === '' ? prefix : `${prefix}\n${first.text}`
  return result.isError === true
    ? { content: [{ type: 'text', text: head }, ...rest], isError: true }
    : { content: [{ type: 'text', text: head }, ...rest] }
}

/** Tools that only read metadata: they answer immediately even while the user is driving. */
const METADATA_TOOLS: readonly string[] = ['state', 'tabs', 'switch_tab']

/**
 * Run one tool call and format its MCP result.
 *
 * Handing the browser over cuts into the agent's turn in two places, and both must *hold the
 * step* rather than let it slide past the takeover:
 *
 * 1. the user already had the browser when the call arrived → wait for control, then run it;
 * 2. the user took over **while** the call was running → the work happened, but its answer is
 *    withheld until control comes back, so the agent's step cannot finish and end its turn
 *    (this is what "the agent 直接结束了" looked like: an in-flight `navigate` returned its
 *    result one millisecond after the takeover, and the model, seeing a complete step, stopped).
 *
 * If the wait runs out, the call still answers — as an error when nothing ran, or as a
 * stale-result note when the work had already happened.
 *
 * Unknown tool names and malformed arguments become `isError` results rather than thrown
 * exceptions: an MCP error must reach the model as text it can act on.
 */
export async function callBrowserTool(
  host: BrowserToolHost,
  name: string,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<BrowserToolResult> {
  const waitForControl = host.waitForControl
  const pageTouching = !METADATA_TOOLS.includes(name)
  let waitedSeconds = 0
  let waitedForControl = false

  if (pageTouching && host.userDriving === true) {
    if (waitForControl === undefined) return errorResult(waitTimeoutText(0))
    const waitedFrom = Date.now()
    const outcome = await waitForControl(signal)
    waitedSeconds = (Date.now() - waitedFrom) / 1000
    waitedForControl = true
    if (outcome !== 'released') return errorResult(waitTimeoutText(waitedSeconds))
  }

  const result = await runBrowserTool(host, name, rawArgs)

  // The takeover may have arrived while this call was in flight: hold the answer.
  if (pageTouching && waitForControl !== undefined && host.userDriving === true) {
    const heldFrom = Date.now()
    const outcome = await waitForControl(signal)
    const held = (Date.now() - heldFrom) / 1000
    return outcome === 'released'
      ? withPrefix(result, releasedPrefix(waitedSeconds + held))
      : withPrefix(result, staleResultNote(held))
  }
  return waitedForControl ? withPrefix(result, releasedPrefix(waitedSeconds)) : result
}

/** The tool switch itself, without the control-wait wrapper. */
async function runBrowserTool(
  host: BrowserToolHost,
  name: string,
  rawArgs: unknown,
): Promise<BrowserToolResult> {
  const args = asRecord(rawArgs)
  // `navigate` may create a view itself (hidden); the tab-aware tools explain the panel
  // themselves; everything else needs a view to exist, because a tool that silently
  // conjures a native surface has nothing to report about.
  if (name !== 'state' && name !== 'tabs' && name !== 'switch_tab' && name !== 'navigate' && !host.created) {
    return errorResult(NO_BROWSER)
  }

  switch (name) {
    case 'state': {
      if (!host.created) return text(NO_BROWSER)
      const state = host.state()
      return text(
        [
          `侧边栏浏览器状态：${state.loading ? '加载中' : '空闲'}（共 ${String(state.tabCount)} 个标签，当前目标 ${state.tab === '' ? '(无)' : state.tab}）`,
          `URL: ${state.url === '' ? '(空白页)' : state.url}`,
          `标题: ${state.title === '' ? '(无)' : state.title}`,
          `面板可见: ${state.visible ? '是' : '否（页面仍在后台运行）'}`,
        ].join('\n'),
      )
    }
    case 'tabs': {
      if (!host.created) return text(NO_BROWSER)
      const tabs = host.tabs()
      if (tabs.length === 0) return text('当前没有打开的浏览器标签。')
      const lines = tabs.map((tab) => {
        const marks = [tab.active ? '当前目标' : '', tab.visible ? '可见' : '后台']
          .filter((mark) => mark !== '')
          .join('、')
        return `  • ${tab.id}${marks === '' ? '' : `（${marks}）`}: ${tab.title === '' ? '(无标题)' : tab.title}\n    ${tab.url === '' ? '(空白页)' : tab.url}`
      })
      return text(`已打开的浏览器标签（共 ${String(tabs.length)} 个）：\n${lines.join('\n')}`)
    }
    case 'switch_tab': {
      const id = optionalString(args.tab)
      if (id === undefined) return errorResult('tab 不能为空（用 tabs 查看可用 id）')
      const result = host.switchTab(id)
      if (!result.ok) return errorResult(result.error)
      return text(`已切换目标标签：${result.tab.id}${result.tab.title === '' ? '' : `（${result.tab.title}）`}。后续工具调用都作用于它。`)
    }
    case 'navigate': {
      const url = optionalString(args.url)
      if (url === undefined) return errorResult('url 不能为空')
      const show = optionalBoolean(args.show) !== false
      const result = await host.navigate(url, { show })
      if (!result.ok) return errorResult(`导航失败：${result.error}`)
      const where = result.visible
        ? `（标签 ${result.tab}，侧边栏里可见：用户看到的正是这一页）`
        : `（后台标签 ${result.tab}；右侧栏暂时没有可见的面板——` +
          '常见原因是这个会话不在屏幕前台，或用户刚把右侧栏收起了。' +
          '不要因此停下：页面已经加载好，snapshot/click 照常可用）'
      return text(
        `已打开 ${result.url}${result.title === '' ? '' : `（标题：${result.title}）`}${where}。` +
          '可以调用 snapshot 读取页面结构，或用 click/type/find 操作页面。',
      )
    }
    case 'snapshot': {
      const result = await host.snapshot()
      if (!result.ok) return errorResult(`读取快照失败：${result.error}`)
      const data = result.data
      const inView = data.interactive.filter((element) => element.inView)
      const offView = data.interactive.filter((element) => !element.inView)
      const shown = [...inView, ...offView].slice(0, SNAPSHOT_DISPLAY_CAP)
      const lines = shown.map((element) => {
        const statePart = element.state.length > 0 ? ` ${element.state.join(' ')}` : ''
        const head = `  [${element.index}] <${element.tag}> role="${element.role}" name="${element.name}"${statePart}`
        const body = [`      selector: ${element.selector}`]
        if (element.text !== '' && element.text !== element.name) body.push(`      text: ${element.text}`)
        if (!element.inView) body.push('      (视口外——点击时会自动滚动到位)')
        return [head, ...body].join('\n')
      })
      const hidden = data.interactive.length - shown.length
      const elementText = lines.length === 0 ? '  (未发现可交互元素)' : lines.join('\n')
      return text(
        [
          '页面快照',
          `URL: ${data.url}`,
          `标题: ${data.title === '' ? '(无)' : data.title}`,
          `readyState: ${data.readyState}`,
          '',
          `可交互元素（共 ${data.interactive.length} 个：视口内 ${inView.length} + 视口外 ${offView.length}；展示前 ${shown.length} 个。` +
            '[n] 是元素索引，可直接传给 click/type/select 的 index 参数）：',
          elementText,
          ...hidden > 0
            ? [`(还有 ${hidden} 个元素未展示——用 find 按选择器/文本精确定位，它们同样可以用 index 操作)`]
            : [],
          '',
          `页面正文（前 ${data.bodyText.length} 字符）：`,
          data.bodyText === '' ? '(空)' : data.bodyText,
        ].join('\n'),
      )
    }
    case 'find': {
      const selector = optionalString(args.selector)
      const needle = optionalString(args.text)
      if (selector === undefined && needle === undefined) return errorResult('需要 selector 或 text 参数之一')
      const result = await host.find({
        selector,
        text: needle,
        regex: optionalBoolean(args.regex),
        caseSensitive: optionalBoolean(args.caseSensitive),
        maxResults: optionalNumber(args.maxResults),
        attributes: optionalStringArray(args.attributes),
        cssScope: optionalString(args.cssScope),
      })
      if (!result.ok) return errorResult(`查找失败：${result.error}`)
      const lines = result.matches.map((match) => {
        if (match.snippet !== undefined) return `  • …${match.snippet}…`
        const attributes = match.attributes === undefined || Object.keys(match.attributes).length === 0
          ? ''
          : ` ${Object.entries(match.attributes).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`
        return `  • <${match.tag ?? '?'}> ${JSON.stringify(match.text ?? '')}${attributes}\n    selector: ${match.selector ?? ''}`
      })
      const totalNote = result.total !== undefined && result.total > result.matches.length
        ? `（共 ${result.total} 个，展示前 ${result.matches.length} 个）`
        : ''
      return text(`查找结果：${result.matches.length} 条${totalNote}\n\n${lines.join('\n') === '' ? '(无匹配)' : lines.join('\n')}`)
    }
    case 'click': {
      const index = optionalNumber(args.index)
      const selector = optionalString(args.selector)
      const coordinateX = optionalNumber(args.coordinateX)
      const coordinateY = optionalNumber(args.coordinateY)
      const hasCoords = coordinateX !== undefined && coordinateY !== undefined
      if (!hasCoords && index === undefined && selector === undefined) {
        return errorResult('需要 index、selector 或 coordinateX+coordinateY 之一')
      }
      const result = await host.click({ index, selector, coordinateX, coordinateY })
      if (!result.ok) return errorResult(`点击失败：${result.error}`)
      const target = hasCoords ? `坐标(${String(coordinateX)}, ${String(coordinateY)})` : describeTarget(index, selector)
      const obscured = result.obscured === undefined
        ? ''
        : `\n⚠️ 目标中心被 <${result.obscured.tag}> "${result.obscured.text}" 覆盖，实际点到的是它——如非预期，先滚动或关闭遮挡层再重试。`
      return text(`已点击 ${target}。当前 URL: ${result.url === '' ? '(未知)' : result.url}${result.title === '' ? '' : `\n标题: ${result.title}`}${obscured}`)
    }
    case 'type': {
      const value = typeof args.text === 'string' ? args.text : undefined
      if (value === undefined) return errorResult('text 必须是字符串')
      const index = optionalNumber(args.index)
      const selector = optionalString(args.selector)
      if (index === undefined && selector === undefined) return errorResult('需要 index 或 selector 之一')
      const clear = optionalBoolean(args.clear) !== false
      const result = await host.type({ index, selector, text: value, clear })
      if (!result.ok) return errorResult(`输入失败：${result.error}`)
      return text(
        `已向 ${describeTarget(index, selector)} ${clear ? '输入' : '追加'} ${JSON.stringify(value)}。` +
          `当前 URL: ${result.url === '' ? '(未知)' : result.url}` +
          '\n(输入框已聚焦，可用 keys({keys:"Enter"}) 提交表单)',
      )
    }
    case 'keys': {
      const keys = optionalString(args.keys)
      if (keys === undefined) return errorResult('keys 不能为空')
      const result = await host.keys(keys)
      if (!result.ok) return errorResult(`按键失败：${result.error}`)
      return text(`已发送按键 ${keys}。当前 URL: ${result.url === '' ? '(未知)' : result.url}`)
    }
    case 'scroll': {
      const direction = args.direction === 'up' ? 'up' : args.direction === 'down' ? 'down' : undefined
      if (direction === undefined) return errorResult('direction 必须是 up 或 down')
      const pages = optionalNumber(args.pages) ?? 1
      const result = await host.scroll({ direction, pages, selector: optionalString(args.selector) })
      if (!result.ok) return errorResult(`滚动失败：${result.error}`)
      const atBottom = result.scrollY + result.viewport >= result.scrollHeight - 2
      const atTop = result.scrollY <= 0
      return text(
        `已向${direction === 'down' ? '下' : '上'}滚动 ${String(pages)} 屏。` +
          `位置 ${String(Math.round(result.scrollY))}/${String(Math.max(0, result.scrollHeight - result.viewport))}` +
          `${atBottom ? '（已到底部）' : atTop ? '（已在顶部）' : ''}。`,
      )
    }
    case 'wait': {
      const result = await host.wait({
        selector: optionalString(args.selector),
        text: optionalString(args.text),
        seconds: optionalNumber(args.seconds),
        timeoutSeconds: optionalNumber(args.timeoutSeconds),
      })
      if (!result.ok) return errorResult(result.error)
      return text(`等待完成。当前 URL: ${result.url === '' ? '(未知)' : result.url}${result.title === '' ? '' : `\n标题: ${result.title}`}`)
    }
    case 'history': {
      const action = args.action
      if (action !== 'back' && action !== 'forward' && action !== 'reload') {
        return errorResult('action 必须是 back / forward / reload')
      }
      const result = action === 'back' ? host.back() : action === 'forward' ? host.forward() : host.reload()
      if (!result.ok) return errorResult(`${action} 失败：${result.error}`)
      return text(`${action === 'back' ? '已后退' : action === 'forward' ? '已前进' : '已刷新'}。当前 URL: ${result.url === '' ? '(未知)' : result.url}`)
    }
    case 'select': {
      const value = optionalString(args.value)
      if (value === undefined) return errorResult('value 不能为空（选项的 value 或可见文本）')
      const index = optionalNumber(args.index)
      const selector = optionalString(args.selector)
      if (index === undefined && selector === undefined) return errorResult('需要 index 或 selector 之一')
      const result = await host.select({ index, selector, value })
      if (!result.ok) {
        // A miss returns the option list: a custom <select> is otherwise a guessing game.
        const options = result.options
        if (options !== undefined && options.length > 0) {
          const lines = options.map((option) => `  • value=${JSON.stringify(option.value)} text=${JSON.stringify(option.text)}${option.selected ? ' ←当前' : ''}`)
          return errorResult(`${result.error}\n可选选项：\n${lines.join('\n')}`)
        }
        return errorResult(`选择失败：${result.error}`)
      }
      return text(`已在 ${describeTarget(index, selector)} 选中 ${JSON.stringify(result.selected?.value ?? value)}。`)
    }
    case 'screenshot': {
      const fullPage = optionalBoolean(args.fullPage) === true
      const result = await host.screenshot(fullPage)
      if (!result.ok) return errorResult(`截图失败：${result.error}`)
      return text(
        `已截图${result.fullPage ? '（整页）' : '（当前视口）'}（${String(Math.round(result.bytes / 1024))} KiB）：${result.file}\n` +
          '可用 present 工具把这个文件展示给用户。',
      )
    }
    default:
      return errorResult(`未知工具：${name}`)
  }
}
