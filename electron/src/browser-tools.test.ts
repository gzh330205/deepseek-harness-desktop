/**
 * The model-facing half of the browser tools: schema-independent behaviour that the model
 * actually reads — how a snapshot becomes text, which handles are accepted, and what an
 * error looks like. Driven through a fake host, so no Electron is involved.
 *
 * Run: node --test src/browser-tools.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BROWSER_TOOLS, callBrowserTool, type BrowserToolHost } from '../src/browser-tools.ts'

interface Recorded {
  readonly name: string
  readonly args: unknown
}

function fakeHost(overrides: Partial<BrowserToolHost> = {}, recorded: Recorded[] = []): BrowserToolHost {
  const note = (name: string, args: unknown): void => { recorded.push({ name, args }) }
  const base: BrowserToolHost = {
    created: true,
    userDriving: false,
    state: () => ({ url: 'https://example.com/', title: '示例', loading: false, visible: true, tab: 't1', tabCount: 1 }),
    tabs: () => [{ id: 't1', url: 'https://example.com/', title: '示例', visible: true, active: true }],
    switchTab: (id) => {
      note('switchTab', { id })
      return id === 't1'
        ? { ok: true, tab: { id: 't1', url: 'https://example.com/', title: '示例', visible: true, active: true } }
        : { ok: false, error: `没有这个标签：${id}` }
    },
    navigate: async (address, options) => {
      note('navigate', { address, options })
      return { ok: true, url: `https://${address}/`, title: 'navigated', tab: 'panel-1', visible: true }
    },
    back: () => { note('back', {}); return { ok: true, url: 'https://a/', title: 'A' } },
    forward: () => { note('forward', {}); return { ok: true, url: 'https://b/', title: 'B' } },
    reload: () => { note('reload', {}); return { ok: true, url: 'https://example.com/', title: '示例' } },
    snapshot: async () => {
      note('snapshot', {})
      return {
        ok: true,
        data: {
          url: 'https://example.com/',
          title: '示例页',
          readyState: 'complete',
          html: '<html></html>',
          bodyText: '欢迎来到示例页',
          interactive: [
            { index: 1, role: 'button', name: '登录', tag: 'button', selector: '#login', text: '登录', inView: true, state: [] },
            { index: 2, role: 'textbox', name: '账号', tag: 'input', selector: '#user', text: '', inView: false, state: ['placeholder="账号"'] },
          ],
        },
      }
    },
    click: async (input) => { note('click', input); return { ok: true, url: 'https://example.com/next', title: '下一页' } },
    type: async (input) => { note('type', input); return { ok: true, url: 'https://example.com/', title: '示例' } },
    keys: async (keys) => { note('keys', { keys }); return { ok: true, url: 'https://example.com/', title: '示例' } },
    scroll: async (input) => {
      note('scroll', input)
      return { ok: true, scrollY: 600, scrollHeight: 3000, viewport: 800, url: 'https://example.com/', title: '示例' }
    },
    wait: async (input) => {
      note('wait', input)
      // The real host validates too (defence in depth); mirror it so the error path is real.
      if (input.selector === undefined && input.text === undefined && input.seconds === undefined) {
        return { ok: false, error: '需要 selector、text 或 seconds 之一' }
      }
      return { ok: true, url: 'https://example.com/', title: '示例' }
    },
    select: async (input) => {
      note('select', input)
      if (input.value === 'missing') {
        return {
          ok: false,
          error: '没有匹配的选项',
          options: [{ value: 'a', text: '选项 A', selected: false }, { value: 'b', text: '选项 B', selected: true }],
        }
      }
      return { ok: true, selected: { value: input.value, text: input.value, selected: true } }
    },
    find: async (input) => {
      note('find', input)
      return { ok: true, matches: [{ tag: 'a', text: '文档', selector: '#doc', attributes: { href: 'https://example.com/doc' } }], total: 4 }
    },
    screenshot: async (fullPage) => {
      note('screenshot', { fullPage })
      return { ok: true, file: 'C:\\tmp\\browser-1.png', bytes: 2048, fullPage }
    },
  }
  return { ...base, ...overrides }
}

/**
 * A fake host whose `userDriving` can change *during* a call.
 *
 * `fakeHost` merges overrides with object spread, which would freeze a getter into a value — but
 * the real host reads a live getter, and the takeover-during-a-call case depends on that.
 */
function drivingHost(
  driving: { value: boolean },
  overrides: Partial<BrowserToolHost> = {},
  recorded: Recorded[] = [],
): BrowserToolHost {
  const host = fakeHost({ ...overrides, userDriving: driving.value }, recorded)
  Object.defineProperty(host, 'userDriving', { get: () => driving.value, configurable: true })
  return host
}

function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content.map((block) => block.text).join('\n')
}

test('every tool is a valid MCP tool definition with a JSON-Schema object input', () => {
  assert.ok(BROWSER_TOOLS.length >= 10)
  for (const tool of BROWSER_TOOLS) {
    assert.match(tool.name, /^[a-z_]+$/u)
    assert.ok(tool.description.length > 10, `${tool.name} needs a description the model can act on`)
    assert.equal((tool.inputSchema as { type?: string }).type, 'object')
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean')
  }
  assert.equal(new Set(BROWSER_TOOLS.map((tool) => tool.name)).size, BROWSER_TOOLS.length)
})

test('without a view the tools explain how to open the panel — and navigate may still create one', async () => {
  const recorded: Recorded[] = []
  const host = fakeHost({ created: false }, recorded)
  const snapshot = await callBrowserTool(host, 'snapshot', {})
  assert.equal(snapshot.isError, true)
  assert.match(textOf(snapshot), /右侧栏/u)

  const navigate = await callBrowserTool(host, 'navigate', { url: 'example.com' })
  assert.equal(navigate.isError, undefined)
  assert.equal(recorded[0]?.name, 'navigate')

  const state = await callBrowserTool(host, 'state', {})
  assert.equal(state.isError, undefined)
  assert.match(textOf(state), /右侧栏/u)
})

test('a snapshot reads like a page inventory: indexes, selectors, form state, off-screen note', async () => {
  const result = await callBrowserTool(fakeHost(), 'snapshot', {})
  const text = textOf(result)
  assert.match(text, /\[1\] <button> role="button" name="登录"/u)
  assert.match(text, /selector: #login/)
  assert.match(text, /\[2\] <input> role="textbox" name="账号" placeholder="账号"/u)
  assert.match(text, /视口外/u)
  assert.match(text, /欢迎来到示例页/u)
})

test('interaction tools require a handle and pass it through unchanged', async () => {
  const recorded: Recorded[] = []
  const host = fakeHost({}, recorded)

  const missing = await callBrowserTool(host, 'click', {})
  assert.equal(missing.isError, true)
  assert.match(textOf(missing), /index、selector 或 coordinateX/u)

  await callBrowserTool(host, 'click', { index: 2 })
  assert.deepEqual(recorded.at(-1)?.args, { index: 2, selector: undefined, coordinateX: undefined, coordinateY: undefined })

  await callBrowserTool(host, 'type', { index: 1, text: '你好' })
  assert.deepEqual(recorded.at(-1)?.args, { index: 1, selector: undefined, text: '你好', clear: true })

  await callBrowserTool(host, 'type', { selector: '#user', text: 'x', clear: false })
  assert.deepEqual(recorded.at(-1)?.args, { index: undefined, selector: '#user', text: 'x', clear: false })

  await callBrowserTool(host, 'select', { index: 1, value: 'b' })
  assert.deepEqual(recorded.at(-1)?.args, { index: 1, selector: undefined, value: 'b' })
})

test('click reports what was actually hit when a layer covers the target', async () => {
  const host = fakeHost({
    click: async () => ({ ok: true, url: 'https://example.com/', title: '示例', obscured: { tag: 'div', text: '弹层' } }),
  })
  const result = await callBrowserTool(host, 'click', { selector: '#login' })
  assert.match(textOf(result), /被 <div> "弹层" 覆盖/u)
})

test('a failed select hands the model the option list instead of a dead end', async () => {
  const recorded: Recorded[] = []
  const result = await callBrowserTool(fakeHost({}, recorded), 'select', { index: 1, value: 'missing' })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /value="a" text="选项 A"/u)
  assert.match(textOf(result), /←当前/u)
})

test('find insists on a query and reports totals', async () => {
  const recorded: Recorded[] = []
  const host = fakeHost({}, recorded)
  const empty = await callBrowserTool(host, 'find', {})
  assert.equal(empty.isError, true)

  const found = await callBrowserTool(host, 'find', { selector: '.doc' })
  assert.match(textOf(found), /共 4 个/u)
  assert.match(textOf(found), /href="https:\/\/example.com\/doc"/u)
})

test('scroll, wait, keys, history and screenshot report usable text', async () => {
  const recorded: Recorded[] = []
  const host = fakeHost({}, recorded)

  const scrolled = await callBrowserTool(host, 'scroll', { direction: 'down', pages: 2 })
  assert.deepEqual(recorded.at(-1)?.args, { direction: 'down', pages: 2, selector: undefined })
  assert.match(textOf(scrolled), /已向下滚动 2 屏/u)

  const waitNothing = await callBrowserTool(host, 'wait', {})
  assert.equal(waitNothing.isError, true)

  await callBrowserTool(host, 'wait', { selector: '#login', timeoutSeconds: 5 })
  assert.deepEqual(recorded.at(-1)?.args, { selector: '#login', text: undefined, seconds: undefined, timeoutSeconds: 5 })

  const keys = await callBrowserTool(host, 'keys', { keys: 'Control+a' })
  assert.match(textOf(keys), /Control\+a/u)

  const badHistory = await callBrowserTool(host, 'history', { action: 'sideways' })
  assert.equal(badHistory.isError, true)
  const back = await callBrowserTool(host, 'history', { action: 'back' })
  assert.match(textOf(back), /已后退/u)

  const shot = await callBrowserTool(host, 'screenshot', {})
  assert.deepEqual(recorded.at(-1)?.args, { fullPage: false })
  assert.match(textOf(shot), /browser-1\.png/u)

  const fullShot = await callBrowserTool(host, 'screenshot', { fullPage: true })
  assert.deepEqual(recorded.at(-1)?.args, { fullPage: true })
  assert.match(textOf(fullShot), /整页/u)
})

test('while the user is driving, a page tool waits for control and then runs', async () => {
  const recorded: Recorded[] = []
  let waited = 0
  const driving = { value: true }
  const host = drivingHost(driving, {
    // The user hands control back after a moment: the call must *continue*, not fail.
    waitForControl: async () => { waited += 1; driving.value = false; return 'released' },
  }, recorded)

  const clicked = await callBrowserTool(host, 'click', { index: 1 })
  assert.equal(clicked.isError, undefined, 'the call should run once control is back')
  assert.match(textOf(clicked), /交还给了助手/u, 'it should say why the answer is late')
  assert.match(textOf(clicked), /继续执行/u)
  assert.match(textOf(clicked), /已点击/u, 'and carry the real tool result')
  assert.equal(waited, 1)
  assert.deepEqual(recorded.map((entry) => entry.name), ['click'], 'the operation ran exactly once')

  // Metadata never waits: it answers while the user still has the browser.
  const state = await callBrowserTool(host, 'state', {})
  assert.equal(state.isError, undefined)
  assert.match(textOf(state), /example\.com/u)
  const tabs = await callBrowserTool(host, 'tabs', {})
  assert.equal(tabs.isError, undefined)
  assert.match(textOf(tabs), /t1/u)

  // Once handed back, the same call works again.
  const released = fakeHost({ userDriving: false }, recorded)
  const second = await callBrowserTool(released, 'click', { index: 1 })
  assert.equal(second.isError, undefined)
  assert.match(textOf(second), /已点击/u)
})

test('a takeover during a call holds its result instead of ending the turn', async () => {
  const recorded: Recorded[] = []
  // The user takes over *while* the tool runs: the page work happens, then the answer is held
  // until control comes back. Without this the step completes and the agent ends its turn.
  const driving = { value: false }
  let releaseHold: (() => void) | undefined
  const host = drivingHost(driving, {
    waitForControl: async () => {
      if (!driving.value) return 'released'
      await new Promise<void>((resolve) => { releaseHold = resolve })
      driving.value = false
      return 'released'
    },
  }, recorded)

  // `click` flips the takeover on as it runs, standing in for the user clicking the page mid-call.
  const originalClick = host.click
  host.click = async (input) => {
    driving.value = true
    return await originalClick(input)
  }

  const pending = callBrowserTool(host, 'click', { index: 1 })
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, 'the result must be withheld while the user holds the browser')

  releaseHold?.()
  const result = await pending
  assert.equal(result.isError, undefined)
  assert.match(textOf(result), /交还给了助手/u, 'it should explain the hold')
  assert.match(textOf(result), /已点击/u, 'and still carry the real result')
})

test('a held result that never gets control back is handed over with a staleness warning', async () => {
  const recorded: Recorded[] = []
  const driving = { value: false }
  const host = drivingHost(driving, {
    waitForControl: async () => (driving.value ? 'timeout' : 'released'),
  }, recorded)
  const originalClick = host.click
  host.click = async (input) => {
    driving.value = true
    return await originalClick(input)
  }

  const result = await callBrowserTool(host, 'click', { index: 1 })
  // The click did happen, so this is not an error — but the page has been in the user's hands.
  assert.equal(result.isError, undefined)
  assert.match(textOf(result), /接管浏览器之前/u)
  assert.match(textOf(result), /核对一次/u)
  assert.match(textOf(result), /已点击/u)
})

test('a wait that runs out explains itself instead of hanging the turn', async () => {
  const recorded: Recorded[] = []
  const host = fakeHost({
    userDriving: true,
    waitForControl: async () => 'timeout',
  }, recorded)

  // Every page-touching tool takes the same path, and — crucially — never reaches the page.
  for (const [name, args] of [
    ['navigate', { url: 'example.com' }],
    ['snapshot', {}],
    ['find', { selector: '#login' }],
    ['click', { index: 1 }],
    ['type', { index: 1, text: 'hi' }],
    ['keys', { keys: 'Enter' }],
    ['scroll', { direction: 'down' }],
    ['screenshot', {}],
  ] as const) {
    const result = await callBrowserTool(host, name, args)
    assert.equal(result.isError, true, `${name} must not run while the user drives`)
    assert.match(textOf(result), /仍在操作浏览器/u, `${name} should say the user is still working`)
    assert.match(textOf(result), /自动交还/u, `${name} should mention the automatic hand-back`)
    assert.match(textOf(result), /立即交还/u, `${name} should say how to hand back now`)
  }
  assert.deepEqual(recorded, [], 'no page operation may run while the user drives')

  // A host from before this feature (no `waitForControl`) keeps the old immediate refusal.
  const legacy = fakeHost({ userDriving: true }, recorded)
  const refused = await callBrowserTool(legacy, 'snapshot', {})
  assert.equal(refused.isError, true)
  assert.match(textOf(refused), /没有执行/u)
})

test('tabs and switch_tab let the model pick its target deliberately', async () => {
  const recorded: Recorded[] = []
  const host = fakeHost({}, recorded)

  const listed = await callBrowserTool(host, 'tabs', {})
  assert.equal(listed.isError, undefined)
  assert.match(textOf(listed), /t1（当前目标、可见）/u)
  assert.match(textOf(listed), /example\.com/u)

  const switched = await callBrowserTool(host, 'switch_tab', { tab: 't1' })
  assert.equal(switched.isError, undefined)
  assert.match(textOf(switched), /已切换目标标签：t1/u)
  assert.deepEqual(recorded.at(-1)?.args, { id: 't1' })

  const missing = await callBrowserTool(host, 'switch_tab', { tab: 'nope' })
  assert.equal(missing.isError, true)
  assert.match(textOf(missing), /没有这个标签/u)

  const noId = await callBrowserTool(host, 'switch_tab', {})
  assert.equal(noId.isError, true)
  assert.match(textOf(noId), /tab 不能为空/u)
})

test('state names the tab being driven and how many are open', async () => {
  const result = await callBrowserTool(fakeHost(), 'state', {})
  assert.match(textOf(result), /共 1 个标签，当前目标 t1/u)
})

test('an unknown tool is an error result, never a crash', async () => {
  const result = await callBrowserTool(fakeHost(), 'rm_rf', {})
  assert.equal(result.isError, true)
  assert.match(textOf(result), /未知工具/u)
})
