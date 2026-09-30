/**
 * Tab targeting and adoption: with several sidebar browser tabs open, which one does a tool call
 * mean, and a new tab that comes on screen takes over *the agent's background view* — never another
 * tab's page.
 *
 * The model this pins:
 *   - a **sidebar tab occurrence** is one browser component instance (`<sessionId>::<tabId>`);
 *   - one conversation can own many of them (the slot is registered `multiple: true`);
 *   - browsing that happens before any tab exists lives in a per-conversation scratch view, and the
 *     first tab that comes on screen for that conversation adopts it (record moved, page not
 *     reloaded);
 *   - the veil belongs to the view a call drives, so adoption must not lose it.
 *
 * Run: node --test src/browser-tabs.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AGENT_TAB_ID, BrowserTabs, pickActiveTab, type TabCandidate } from '../src/browser-tabs.ts'
import type { BrowserViewManager, BrowserViewState } from '../src/browser-view.ts'

const tab = (id: string, visible: boolean, lastSeen: number): TabCandidate => ({ id, visible, lastSeen })

test('nothing open means no target', () => {
  assert.equal(pickActiveTab([]), undefined)
  assert.equal(pickActiveTab([], 't1'), undefined)
})

test('an explicit target wins, even when it is hidden behind another tab', () => {
  const candidates = [tab('a', false, 1), tab('b', true, 9)]
  assert.equal(pickActiveTab(candidates, 'a'), 'a')
  assert.equal(pickActiveTab(candidates, 'b'), 'b')
})

test('without an explicit target the most recently shown tab wins', () => {
  const candidates = [tab('a', true, 3), tab('b', true, 7), tab('c', false, 99)]
  assert.equal(pickActiveTab(candidates), 'b')
})

test('an explicit target that is gone falls back to the visible tab, then to the newest', () => {
  assert.equal(pickActiveTab([tab('a', false, 1), tab('b', true, 4)], 'closed'), 'b')
  assert.equal(pickActiveTab([tab('a', false, 1), tab('b', false, 4)], 'closed'), 'b')
})

/** The slice of `BrowserViewManager` these tests drive, with the calls recorded. */
interface FakeManager {
  manager: BrowserViewManager
  navigations: string[]
  /** Veil bracketing, so a stuck veil is testable. */
  veilBegins: number
  veilEnds: number
  /** Ids this view's state pushes named (`rebind`), in order. */
  rebinds: string[]
  /** Turn start/end signals this view received from the panel. */
  turnUpdates: boolean[]
  url: string
  visible: boolean
  panelVisible: boolean
  destroyed: boolean
}

function fakeManager(notify: (state: BrowserViewState) => void): FakeManager {
  const fake: FakeManager = {
    manager: undefined as unknown as BrowserViewManager,
    navigations: [],
    veilBegins: 0,
    veilEnds: 0,
    rebinds: [],
    turnUpdates: [],
    url: '',
    visible: false,
    panelVisible: false,
    destroyed: false,
  }
  const state = (): BrowserViewState => ({
    url: fake.url,
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    device: 'desktop',
    deviceWidth: 0,
    deviceHeight: 0,
    deviceRotated: false,
    picking: false,
    agentActive: false,
    userDriving: false,
    autoReleaseAt: 0,
    error: null,
  })
  const surface = {
    get visible() { return fake.visible },
    get created() { return !fake.destroyed },
    get panelVisibleNow() { return fake.panelVisible },
    state,
    // Control handover: these are what the panel's user-driven commands touch.
    get drivingByUser() { return false },
    get controlAutoReleaseAt() { return 0 },
    noteUserActivity: () => {},
    setAutoReleaseSeconds: () => {},
    waitForControl: async () => 'released',
    releaseToAgent: () => ({ ok: true, state: state() }),
    beginAgentActivity: () => { fake.veilBegins += 1 },
    endAgentActivity: () => { fake.veilEnds += 1 },
    setAgentTurn: (running: boolean) => { fake.turnUpdates.push(running) },
    ensureCreated: () => ({ ok: true, state: state() }),
    show: () => { fake.visible = true; notify(state()); return { ok: true } },
    hide: () => { fake.visible = false; fake.panelVisible = false; return { ok: true } },
    navigate: (url: unknown) => {
      fake.url = String(url)
      return { ok: true, state: state() }
    },
    back: () => ({ ok: true, state: state() }),
    forward: () => ({ ok: true, state: state() }),
    reload: () => ({ ok: true, state: state() }),
    setBounds: () => { fake.panelVisible = true; return { ok: true } },
    focus: () => ({ ok: true }),
    destroy: () => { fake.destroyed = true; fake.visible = false },
    shutdown: () => { fake.destroyed = true },
    toolNavigate: async (url: string) => {
      fake.navigations.push(url)
      fake.url = url
      return { ok: true, url, title: '', visible: fake.visible }
    },
  }
  fake.manager = surface as unknown as BrowserViewManager
  return fake
}

function makeTabs(): { tabs: BrowserTabs; fakes: Map<string, FakeManager> } {
  const fakes = new Map<string, FakeManager>()
  const tabs = new BrowserTabs({
    createManager: (tabId, notify) => {
      const fake = fakeManager(notify)
      fakes.set(tabId, fake)
      return fake.manager
    },
    notify: () => {},
    log: () => {},
    // Mirrors the shell: re-point the closures that name the tab, and record it for assertions.
    rebindManager: (manager, tabId) => {
      for (const fake of fakes.values()) if (fake.manager === manager) fake.rebinds.push(tabId)
      // Adoption pushes a state update to the panel, and the real panel answers with a fresh claim
      // (it has a page now, so it reports itself visible). Simulating that is what proves the page
      // reaches the screen without the user switching tabs.
      tabs.handle(claim(tabId, tabs.sessionOf(tabId), { visible: true, instance: 'auto' }))
    },
  })
  return { tabs, fakes }
}

/** A panel claim: the one message that may place a view *and* the only trigger for adoption. */
const claim = (
  tabId: string,
  sessionId: string,
  options: { onScreen?: boolean; visible?: boolean; instance?: string } = {},
) => ({
  name: 'panel',
  tabId,
  sessionId,
  instanceId: options.instance ?? tabId,
  onScreen: options.onScreen ?? true,
  visible: options.visible ?? false,
  rect: { x: 8, y: 40, width: 500, height: 700 },
})

test('the atomic panel claim parks a background conversation and never conjures a view', () => {
  const { tabs, fakes } = makeTabs()

  // Conversation A's tab is on screen: its claim places A's view.
  assert.deepEqual(tabs.handle(claim('A::t1', 'A', { visible: true })), { ok: true })
  assert.equal(fakes.get('A::t1')?.visible, true)

  // Conversation B's tab is mounted but off screen: it must not create anything, and A stays put.
  assert.deepEqual(tabs.handle({ name: 'panel', tabId: 'B::t1', sessionId: 'B', instanceId: 'B', visible: false }), { ok: true })
  assert.equal(fakes.has('B::t1'), false, 'an off-screen panel must not build a view')
  assert.equal(fakes.get('A::t1')?.visible, true)

  // The user switches to B: A's tab now reports "off screen" — A parks (its page keeps running),
  // which is what stops it from flashing over B on every later state push.
  assert.deepEqual(tabs.handle({ name: 'panel', tabId: 'A::t1', sessionId: 'A', instanceId: 'A', visible: false }), { ok: true })
  assert.equal(fakes.get('A::t1')?.visible, false)
})

test('the panel visibility query never builds a view', () => {
  const tabs = new BrowserTabs({
    createManager: () => { throw new Error('panelVisible must not create a manager') },
    notify: () => {},
    log: () => {},
  })
  // Unknown tab: honestly "no", and no view was built (the createManager above would throw).
  assert.deepEqual(tabs.handle({ name: 'panelVisible', tabId: 'whatever' }), { ok: true, visible: false })
})

test('the sidebar tab adopts the agent\u2019s background view: moved, never reloaded', async () => {
  const { tabs, fakes } = makeTabs()

  // The agent browses before the sidebar is open: a scratch view, parked, keyed by conversation.
  const opened = await tabs.toolHost('s').navigate('https://example.com/', { show: false })
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.equal(opened.tab, 'agent:s', 'browsing with no tab open lives in the conversation\u2019s scratch view')
  assert.equal(opened.visible, false)
  const view = fakes.get('agent:s')
  assert.equal(view?.url, 'https://example.com/')

  // The user opens a sidebar tab for that conversation. It comes on screen empty, so it adopts the
  // live view: same object, same page, no second load, and only one view exists.
  assert.deepEqual(tabs.handle(claim('s::t5', 's', { visible: false })), { ok: true })
  assert.equal(tabs.tabCount, 1, 'adoption moves the record: no throwaway view is left behind')
  assert.deepEqual(tabs.toolHost('s').tabs().map((entry) => entry.id), ['s::t5'])
  assert.deepEqual(view?.rebinds, ['s::t5'], 'pushes and picks now name the tab that owns the view')
  assert.equal(fakes.get('agent:s'), view, 'the scratch record is gone but the view is the same object')

  // The panel re-claims once it has seen a page: the adopted view is placed, not reloaded.
  tabs.handle(claim('s::t5', 's', { visible: true }))
  assert.equal(view?.visible, true)
  assert.deepEqual(view?.navigations, ['https://example.com/'], 'the page was never loaded twice')

  // And the agent keeps driving that same tab: the user watches the work happen.
  const next = await tabs.toolHost('s').navigate('https://example.com/next', { show: true })
  assert.equal(next.ok, true)
  if (!next.ok) return
  assert.equal(next.tab, 's::t5')
  assert.equal(next.visible, true)
  assert.equal(view?.url, 'https://example.com/next')
  assert.equal(tabs.tabCount, 1)
})

test('a new conversation\u2019s first call shows the page without switching tabs', async () => {
  const { tabs, fakes } = makeTabs()

  // The real ordering, and the reason this needed a second adoption trigger: the first tool call
  // creates the conversation's background view, and the shell then asks the page to open the pane
  // **before** it navigates (so the pane has the whole load time to mount). The panel's first claim
  // therefore always arrives while the page is still empty — it finds no donor and cannot adopt, and
  // nothing asks the panel to claim again. Reported symptom: "新会话第一次打开浏览器什么都不显示，
  // 切走再切回来才显示"（切回来那一下会重新声明，那时页面已经加载完了）。
  tabs.beginAgentActivity('navigate', 's')
  tabs.handle(claim('s::t5', 's', { visible: false }))
  assert.equal(fakes.get('agent:s')?.url, '', 'the claim arrived before the page had a URL')

  const opened = await tabs.toolHost('s').navigate('https://example.com/', { show: true })
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  // The moment the page exists it moves into the tab, the panel is told, and it places the view: the
  // sidebar shows the page on the very first call, with nothing for the user to do.
  assert.equal(opened.tab, 's::t5', 'the answer names the sidebar tab that now owns the view')
  assert.equal(opened.visible, true, 'the page is on screen')
  assert.equal(fakes.get('s::t5')?.destroyed, true, 'the tab\u2019s empty placeholder view is gone')
  assert.equal(fakes.get('agent:s')?.url, 'https://example.com/', 'the live view kept its page')
  assert.deepEqual(tabs.toolHost('s').tabs().map((entry) => entry.id), ['s::t5'])
  assert.equal(tabs.tabCount, 1)
  tabs.endAgentActivity()
})

test('a tab that is open first is filled by the agent\u2019s next navigation', async () => {
  const { tabs, fakes } = makeTabs()

  // Sidebar first: the tab claims an empty view for the conversation (there is nothing to adopt).
  tabs.handle(claim('s::t5', 's', { visible: false }))
  assert.equal(fakes.get('s::t5')?.url, '')

  // Then the agent navigates *in that conversation*: it must land in that same view, so the user
  // sees it immediately (the bug was an empty sidebar while the agent browsed somewhere else).
  const opened = await tabs.toolHost('s').navigate('https://example.com/', { show: true })
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.equal(opened.tab, 's::t5')
  assert.equal(fakes.get('s::t5')?.url, 'https://example.com/')
  assert.equal(tabs.tabCount, 1)
})

test('a second tab in the same conversation is a second, empty browser', async () => {
  const { tabs, fakes } = makeTabs()

  // Two tabs of one conversation, as the slot's `multiple: true` allows.
  tabs.handle(claim('s::t1', 's', { visible: false, instance: 'P1' }))
  await tabs.toolHost('s').navigate('https://first.example/', { show: false })
  assert.equal(fakes.get('s::t1')?.url, 'https://first.example/')

  // Opening the second tab must NOT steal the first one's page: it is its own (still empty) browser.
  tabs.handle(claim('s::t2', 's', { visible: false, instance: 'P2' }))
  assert.equal(fakes.get('s::t2')?.url, '', 'no adoption from another sidebar tab')
  assert.equal(fakes.get('s::t1')?.url, 'https://first.example/', 'the first tab keeps its page')
  assert.equal(tabs.tabCount, 2)

  // What the user is looking at decides which one the agent drives.
  tabs.handle(claim('s::t2', 's', { visible: true, instance: 'P2' }))
  const driven = await tabs.toolHost('s').navigate('https://second.example/', { show: true })
  assert.equal(driven.ok, true)
  if (!driven.ok) return
  assert.equal(driven.tab, 's::t2')
  assert.equal(fakes.get('s::t2')?.url, 'https://second.example/')
  assert.equal(fakes.get('s::t1')?.url, 'https://first.example/', 'the other tab is untouched')
})

test('closing a sidebar tab destroys exactly that browser', async () => {
  const { tabs, fakes } = makeTabs()

  tabs.handle(claim('s::t1', 's', { visible: false, instance: 'P1' }))
  tabs.handle(claim('s::t2', 's', { visible: false, instance: 'P2' }))
  assert.equal(tabs.tabCount, 2)

  // The panel names the closed occurrence the same way it names every other command. A bare DSH tab
  // id matched no record, so the closed tab's page kept running (a leaked native view).
  assert.deepEqual(tabs.handle({ name: 'close', tabId: 's::t1' }), { ok: true })
  assert.equal(fakes.get('s::t1')?.destroyed, true, 'the closed tab\u2019s view is destroyed')
  assert.equal(fakes.get('s::t2')?.destroyed, false, 'the other browser keeps running')
  assert.deepEqual(tabs.toolHost('s').tabs().map((entry) => entry.id), ['s::t2'])

  // Closing a tab whose page was never opened is harmless, not an error.
  assert.deepEqual(tabs.handle({ name: 'close', tabId: 's::gone' }), { ok: true })
})

test('the agent can choose which of a conversation\u2019s tabs it drives', async () => {
  const { tabs, fakes } = makeTabs()

  // One conversation, two tabs: the first adopts the agent's background page, the second is new.
  await tabs.toolHost('s').navigate('https://first.example/', { show: false })
  tabs.handle(claim('s::t1', 's', { visible: false, instance: 'P1' }))
  tabs.handle(claim('s::t2', 's', { visible: false, instance: 'P2' }))
  assert.equal(tabs.tabCount, 2)

  // `switch_tab` is the only way to reach the tab that is *not* on screen — and the panel's layout
  // chatter must not steal that choice back mid-turn.
  assert.equal(tabs.toolHost('s').switchTab('s::t1').ok, true)
  tabs.handle(claim('s::t2', 's', { visible: true, instance: 'P2' }))
  const driven = await tabs.toolHost('s').navigate('https://chosen.example/', { show: false })
  assert.equal(driven.ok, true)
  if (!driven.ok) return
  assert.equal(driven.tab, 's::t1', 'the explicitly chosen tab wins over the visible one')
  assert.equal(fakes.get('agent:s')?.url, 'https://chosen.example/')
  assert.equal(fakes.get('s::t2')?.url, '', 'the other tab is untouched')

  // The user acting in the browser takes the focus back.
  tabs.handle({ name: 'reload', tabId: 's::t2', sessionId: 's' })
  const after = await tabs.toolHost('s').navigate('https://user.example/', { show: false })
  assert.equal(after.ok, true)
  if (!after.ok) return
  assert.equal(after.tab, 's::t2', 'after a user action the tab on screen is the target again')

  // A tab of another conversation is not the agent's to switch to.
  const stranger = tabs.toolHost('s').switchTab('other::t9')
  assert.equal(stranger.ok, false)
})

test('the agent turn signal is routed by conversation, and builds nothing', () => {
  const { tabs, fakes } = makeTabs()

  // One browser tab per conversation, both claimed but with no page yet.
  tabs.handle(claim('A::t1', 'A', { visible: false, instance: 'PA' }))
  tabs.handle(claim('B::t1', 'B', { visible: false, instance: 'PB' }))
  const a = fakes.get('A::t1')
  const b = fakes.get('B::t1')

  // The marker follows the *turn*, so the shell has to know when it starts and ends. Relayed by the
  // panel from DSH's own session status; it must reach that conversation's browser only.
  tabs.handle({ name: 'agentRunning', tabId: 'A::t1', sessionId: 'A', running: true })
  assert.deepEqual(a?.turnUpdates, [true])
  assert.deepEqual(b?.turnUpdates, [], 'another conversation\u2019s browser is untouched')

  tabs.handle({ name: 'agentRunning', tabId: 'A::t1', sessionId: 'A', running: false })
  assert.deepEqual(a?.turnUpdates, [true, false])

  // A turn signal for a tab that has no view must not conjure one.
  tabs.handle({ name: 'agentRunning', tabId: 'C::t1', sessionId: 'C', running: true })
  assert.equal(fakes.has('C::t1'), false)
})

test('the agent marker is automatic and lands on the view the call will drive', async () => {
  const { tabs, fakes } = makeTabs()

  // Nothing exists yet: no view, no panel. The first call must still raise the veil — looking the
  // target up first found nothing, so the first navigation ran unmarked and the user only saw
  // "the agent is driving" from the second call on.
  tabs.beginAgentActivity('navigate', 's')
  const view = fakes.get('agent:s')
  assert.ok(view !== undefined, 'the view is created for the call')
  assert.equal(view.veilBegins, 1, 'the veil is up before the page even loads')

  // The call creates the page, then ends: the marker goes down with it.
  const opened = await tabs.toolHost('s').navigate('https://example.com/', { show: true })
  assert.equal(opened.ok, true)
  if (!opened.ok) return
  assert.equal(fakes.get('agent:s'), view, 'the call used the view the marker was raised on')
  tabs.endAgentActivity()
  assert.equal(view.veilEnds, 1, 'and it is released when the call ends')
})

test('the veil follows the view across adoption, so it is never left behind', async () => {
  const { tabs, fakes } = makeTabs()

  await tabs.toolHost('s').navigate('https://example.com/', { show: false })
  const view = fakes.get('agent:s')
  tabs.beginAgentActivity('snapshot', 's')
  assert.equal(view?.veilBegins, 1)

  // The panel comes on screen mid-call and adopts the view (the record is renamed). The call is
  // still in flight on the *same* view, so the veil must be lowered on that view — tracking calls by
  // tab id instead of by view is how the veil once got stuck ("agent 结束了调用，还显示被控制中").
  tabs.handle(claim('s::t5', 's', { visible: true }))
  assert.deepEqual(tabs.toolHost('s').tabs().map((entry) => entry.id), ['s::t5'])
  tabs.endAgentActivity()
  assert.equal(view?.veilEnds, 1, 'the veil is lowered on the view that raised it')
})

test('placing one conversation\u2019s view parks every other one, veil included', async () => {
  const { tabs, fakes } = makeTabs()

  // Both conversations have a page; only one may be on screen at a time.
  await tabs.toolHost('A').navigate('https://a.example/', { show: false })
  await tabs.toolHost('B').navigate('https://b.example/', { show: false })
  tabs.handle(claim('A::t1', 'A', { visible: true }))
  assert.equal(fakes.get('agent:A')?.visible, true)

  // Switching to B places B and parks A in the same step: a left-behind view would take its veil
  // with it and float over the conversation the user switched to (the panel calls this "遮罩跟丢").
  tabs.handle(claim('B::t1', 'B', { visible: true }))
  assert.equal(fakes.get('agent:B')?.visible, true)
  assert.equal(fakes.get('agent:A')?.visible, false, 'the previous conversation is parked, veil and all')
})

test('two conversations never share a browser view', async () => {
  const { tabs } = makeTabs()

  // Conversation A browses: the view is keyed by the conversation.
  const a = await tabs.toolHost('session-a').navigate('https://a.example/', { show: false })
  assert.equal(a.ok, true)
  if (!a.ok) return

  // Conversation B starts fresh. It must NOT continue in A's page (DSH mints its own tab ids per
  // session, so an id-based key leaked A's page into B's sidebar).
  assert.deepEqual(tabs.toolHost('session-b').tabs(), [])
  const b = await tabs.toolHost('session-b').navigate('https://b.example/', { show: false })
  assert.equal(b.ok, true)
  if (!b.ok) return
  assert.notEqual(b.tab, a.tab)

  assert.deepEqual(tabs.toolHost('session-a').tabs().map((entry) => entry.url), ['https://a.example/'])
  assert.deepEqual(tabs.toolHost('session-b').tabs().map((entry) => entry.url), ['https://b.example/'])
  assert.equal(tabs.toolHost('session-a').state().url, 'https://a.example/')
  assert.equal(tabs.toolHost('session-b').state().url, 'https://b.example/')

  // Switching conversations switches views: each panel claim places only its own conversation's view.
  tabs.handle(claim('session-b::t3', 'session-b', { visible: true }))
  const state = tabs.handle({ name: 'panelVisible', tabId: a.tab }) as { visible: boolean }
  assert.equal(state.visible, false, 'the conversation on screen is B: A is parked')
})

test('the agent drives the tab the user already has open, instead of a hidden duplicate', async () => {
  const { tabs, fakes } = makeTabs()

  // The user opens the panel and browses first.
  tabs.handle({ name: 'show', tabId: 'panel-1' })
  tabs.handle({ name: 'navigate', tabId: 'panel-1', url: 'https://user.example/' })

  // The agent then browses: it must land in that same tab, so the user watches the work.
  const result = await tabs.toolHost().navigate('https://agent.example/', { show: true })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.tab, 'panel-1')
  assert.equal(result.visible, true)
  assert.equal(fakes.get('panel-1')?.url, 'https://agent.example/')
  assert.equal(tabs.tabCount, 1)
  // No background tab was created behind the user's back.
  assert.equal(fakes.has(AGENT_TAB_ID), false)
})
