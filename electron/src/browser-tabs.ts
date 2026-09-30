/**
 * Multiple browser tabs: one native view per sidebar tab occurrence.
 *
 * Each tab is a whole {@link BrowserViewManager} (its own `WebContentsView`, its own
 * renderer process, its own history), so closing one never touches the others and a crash in
 * one page cannot take the panel down. This class only decides *which* view a command or a
 * tool call means, and keeps the panel's per-tab state routing straight.
 *
 * Target selection (the part that decides what the agent touches):
 *   1. inside one conversation — the sidebar tab that is on screen (that is what the user is
 *      watching), else the conversation's background scratch view, else its most recent tab;
 *   2. without a conversation — the explicit target (`switch_tab`), else the most recently shown
 *      tab, else the most recently touched one.
 *
 * `pickActiveTab` is pure so rule 2 is unit-tested without Electron.
 */

import type { BrowserCommandResult, BrowserViewManager, BrowserViewState } from './browser-view.ts'
import type { BrowserTabSummary, BrowserToolHost, HostResult } from './browser-tools.ts'

/** Synthetic tab used when the agent browses while no panel tab is open. */
export const AGENT_TAB_ID = 'agent'

interface TabRecord {
  readonly id: string
  readonly manager: BrowserViewManager
  /** Monotonic "touched" stamp: shown, navigated, or targeted. */
  lastSeen: number
}

export interface TabCandidate {
  readonly id: string
  readonly visible: boolean
  readonly lastSeen: number
}

/**
 * Which tab a tool call targets. See the rule in this module's header comment.
 */
export function pickActiveTab(candidates: readonly TabCandidate[], activeId?: string): string | undefined {
  if (candidates.length === 0) return undefined
  const explicit = activeId === undefined ? undefined : candidates.find((candidate) => candidate.id === activeId)
  if (explicit !== undefined) return explicit.id
  const newestVisible = [...candidates]
    .filter((candidate) => candidate.visible)
    .sort((left, right) => right.lastSeen - left.lastSeen)
    .at(0)
  if (newestVisible !== undefined) return newestVisible.id
  return [...candidates].sort((left, right) => right.lastSeen - left.lastSeen).at(0)?.id
}

export interface BrowserTabsOptions {
  /** Builds the manager for one tab. The shell owns the window/preferences wiring. */
  readonly createManager: (tabId: string, notify: (state: BrowserViewState) => void) => BrowserViewManager

  /** Panel state push, already keyed by tab so the right body updates. */
  readonly notify: (tabId: string, state: BrowserViewState) => void
  readonly log: (line: string) => void
  /**
   * Point one live view at another tab occurrence (see {@link BrowserTabs.adoptAgentTab}).
   *
   * The shell owns the closures that *name* the tab, so only the shell can re-point them. Optional
   * so the targeting rules stay unit-testable without a window.
   */
  readonly rebindManager?: (manager: BrowserViewManager, tabId: string) => void
  /**
   * Ask DSH's page to open the browser tab in the right sidebar.
   *
   * Called when the agent asks to show a page while no panel is on screen. Optional: without it,
   * `show: true` simply keeps the page in the background.
   */
  readonly onOpenPane?: (tabId: string, mayExpandSidebar: boolean, sessionId: string) => void
}

/** Max length of a tab id accepted from the renderer (it becomes a map key). */
const MAX_TAB_ID = 128

/**
 * Panel commands that only a human can trigger.
 *
 * They extend an active takeover's idle window; the automatic traffic the panel also sends
 * (ounds on resize, show, state, prefs) must not, or a busy render loop would keep the
 * agent waiting forever.
 */
const USER_ACTIVITY_COMMANDS = new Set([
  'navigate', 'back', 'forward', 'reload', 'history', 'clearHistory', 'pick', 'deviceSpec',
  'setPrefs', 'clearCache', 'clearCookies', 'openDownload', 'revealDownload', 'clearDownloads',
])

export class BrowserTabs {
  private readonly records = new Map<string, TabRecord>()
  private activeId: string | undefined
  /**
   * The tab the agent asked for with `switch_tab`.
   *
   * With several sidebar tabs in one conversation, `target` would otherwise always answer "the one
   * on screen" and the other tabs would be unreachable. Cleared as soon as the *user* does something
   * in the browser (a real action, not the panel's layout chatter), so their focus wins again.
   */
  private chosenId: string | undefined
  private retired = false
  private clock = 0
  /**
   * Not a constructor parameter property: this module is imported by a unit test, and the
   * runner strips types instead of compiling them (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
   */
  /**
   * Tab ids whose panel has been on screen at least once this run.
   *
   * Only before that may the shell ask the page to *expand* the sidebar (a collapsed sidebar has to
   * be expanded for the panel to mount). Once it has been visible, the layout is the user's and a
   * blind toggle would collapse it.
   */
  private readonly panelEverVisible = new Set<string>()
  /**
   * Tab id -> the panel instance that owns placement right now.
   *
   * Several panels can be mounted at once (one per session, keepMounted); only the current one
   * may move the native surface, so a late message from a replaced instance cannot paint a page
   * over whatever the user is looking at.
   */
  private readonly panelInstance = new Map<string, string>()
  private readonly options: BrowserTabsOptions

  constructor(options: BrowserTabsOptions) {
    this.options = options
  }

  /** Whether any tab still has a live view (tools say "open the panel" until then). */
  get created(): boolean {
    for (const record of this.records.values()) {
      if (record.manager.created) return true
    }
    return false
  }

  get tabCount(): number {
    return this.records.size
  }

  private touch(id: string): void {
    this.clock += 1
    const record = this.records.get(id)
    if (record !== undefined) record.lastSeen = this.clock
  }

  /** Get (or build) the manager for one tab. */
  private ensure(tabId: string): HostResult<{ manager: BrowserViewManager }> {
    if (this.retired) return { ok: false, error: '侧边栏浏览器已关闭' }
    const existing = this.records.get(tabId)
    if (existing !== undefined) return { ok: true, manager: existing.manager }
    const record: TabRecord = {
      id: tabId,
      manager: this.options.createManager(tabId, (state) => { this.options.notify(tabId, state) }),
      lastSeen: 0,
    }
    this.touch(tabId)
    this.records.set(tabId, record)
    return { ok: true, manager: record.manager }
  }

  /**
   * Which DSH conversation each tab belongs to, as the panel reports it on every command.
   *
   * Tabs must be per conversation: a page one conversation is reading is not another's, and the
   * agent's scratch tab is keyed by conversation for the same reason. Before this, a second
   * conversation found the first one's page and read it ("已有一个标签正停在 OpenAI 新闻页" — the
   * agent's own words in a *new* conversation, which is exactly the leak this map prevents).
   */
  private readonly tabSessions = new Map<string, string>()

  /**
   * The conversation's **scratch** view: where the agent browses before a sidebar tab exists.
   *
   * When the user (or the agent's `show`) opens a sidebar tab for that conversation, the panel
   * claims under its own occurrence id and takes this view over — the record moves, the live
   * `WebContentsView` (and whatever it is loading) does not. That is what keeps "one component
   * instance per sidebar tab" true without ever re-navigating or duplicating a page.
   */
  private agentTabId(sessionId: string): string {
    return sessionId === '' ? AGENT_TAB_ID : `${AGENT_TAB_ID}:${sessionId}`
  }

  /** The conversation a tab was last reported as belonging to ('' when unknown). */
  sessionOf(tabId: string): string {
    return this.tabSessions.get(tabId) ?? ''
  }

  /**
   * Which tab one conversation's tools act on.
   *
   * With a session:
   *   1. the agent's explicit choice (`switch_tab`) — with several tabs in one conversation this is
   *      the only way to act on any but the one on screen;
   *   2. a **visible** panel tab of that conversation (that is what the user is watching, so the
   *      agent must drive it, not a hidden twin);
   *   3. the conversation's own scratch tab;
   *   4. any of its other tabs (most recently touched).
   * Without one, the historical global rule applies.
   */
  private target(sessionId = ''): { id: string; manager: BrowserViewManager } | undefined {
    if (sessionId !== '') {
      const scratchId = this.agentTabId(sessionId)
      const mine = [...this.records.values()].filter((record) => this.tabSessions.get(record.id) === sessionId)
      // Deliberately *not* cleared by ordinary panel traffic (bounds, show, state): a resize would
      // otherwise steal the agent's choice back mid-turn. A real user action clears it (see `handle`).
      const chosen = this.chosenId === undefined ? undefined : mine.find((record) => record.id === this.chosenId)
      if (chosen !== undefined) return { id: chosen.id, manager: chosen.manager }
      const visiblePanel = mine
        .filter((record) => record.id !== scratchId && record.manager.visible)
        .sort((left, right) => right.lastSeen - left.lastSeen)[0]
      if (visiblePanel !== undefined) return { id: visiblePanel.id, manager: visiblePanel.manager }
      const scratch = this.records.get(scratchId)
      if (scratch !== undefined) return { id: scratch.id, manager: scratch.manager }
      const anyMine = [...mine].sort((left, right) => right.lastSeen - left.lastSeen)[0]
      if (anyMine !== undefined) return { id: anyMine.id, manager: anyMine.manager }
      return undefined
    }
    const candidates: TabCandidate[] = [...this.records.values()].map((record) => ({
      id: record.id,
      visible: record.manager.visible,
      lastSeen: record.lastSeen,
    }))
    const id = pickActiveTab(candidates, this.activeId)
    if (id === undefined) return undefined
    const record = this.records.get(id)
    return record === undefined ? undefined : { id: record.id, manager: record.manager }
  }

  /** Every open tab, newest first, with the active one flagged. */
  tabs(sessionId = ''): readonly BrowserTabSummary[] {
    const active = this.target(sessionId)?.id
    const records = sessionId === ''
      ? [...this.records.values()]
      // The agent sees its own conversation's tabs only (plus the shared, session-less ones).
      : [...this.records.values()].filter((record) => {
        const owner = this.tabSessions.get(record.id) ?? ''
        return owner === '' || owner === sessionId
      })
    return records
      .sort((left, right) => right.lastSeen - left.lastSeen)
      .map((record) => {
        const state = record.manager.state()
        return {
          id: record.id,
          url: state.url,
          title: state.title,
          visible: record.manager.visible,
          active: record.id === active,
        }
      })
  }

  /**
   * Panel command dispatch. Every view command carries the panel tab it belongs to; the
   * renderer is a renderer, so the id is validated as a plain bounded string here.
   */
  handle(command: unknown): BrowserCommandResult | Promise<BrowserCommandResult> {
    if (typeof command !== 'object' || command === null) return { ok: false, reason: '命令格式不合法' }
    const raw = command as Record<string, unknown>
    const name = raw.name
    if (typeof name !== 'string') return { ok: false, reason: '命令格式不合法' }

    const tabId = typeof raw.tabId === 'string' ? raw.tabId : ''
    if (tabId === '' || tabId.length > MAX_TAB_ID) return { ok: false, reason: '缺少或非法的 tabId' }
    // Every panel command names the conversation it is rendered for; remembering it here is what
    // makes `toolHost(sessionId)` able to pick *this conversation's* tab instead of whatever the
    // last conversation used (the leak behind "第二个会话复用了第一个会话的浏览器").
    if (typeof raw.sessionId === 'string' && raw.sessionId !== '') {
      const previous = this.tabSessions.get(tabId)
      this.tabSessions.set(tabId, raw.sessionId)
      // Diagnostics: when a panel opens for a different conversation than the agent's, adoption
      // (correctly) refuses to hand the view over and the user sees an empty browser. One line here
      // makes that visible instead of mysterious.
      if (previous !== undefined && previous !== raw.sessionId) {
        this.options.log(`浏览器标签 ${tabId} 的会话由 ${previous} 变为 ${raw.sessionId}`)
      }
    }

    // Neither of these should bring a tab into existence for a view that was never built.
    if (name === 'hide') {
      this.records.get(tabId)?.manager.hide()
      return { ok: true }
    }
    if (name === 'close') {
      // Closing a tab the shell has no view for is a no-op, not an error: the user may close a tab
      // whose page was never opened. Logged, because "the tab closed but its page kept running" is
      // exactly the kind of leak this line makes visible.
      if (!this.closeTab(tabId)) this.options.log(`面板请求关闭标签 ${tabId}，但壳里没有对应的视图（可能从未打开过页面）`)
      return { ok: true }
    }
    // "Is the panel actually on screen?" — only the shell knows (it is the one receiving bounds),
    // and the page needs it: a kept-mounted panel body from another session makes any DOM lookup
    // a lie, so the client asks instead of guessing.
    if (name === 'panelVisible') {
      return { ok: true, visible: this.records.get(tabId)?.manager.panelVisibleNow === true }
    }
    /**
     * The conversation's agent turn started or ended.
     *
     * Relayed from DSH's own session status by the panel. This is what the marker follows: up while
     * the turn is running and it has touched this browser, down the moment the turn is over — instead
     * of showing/hiding around every single tool call, which made the page blink while the agent
     * worked. Never creates a view (a turn that has not touched the browser has nothing to mark).
     */
    if (name === 'agentRunning') {
      const running = raw.running === true
      const owner = this.tabSessions.get(tabId) ?? ''
      const affected = owner === ''
        ? [this.records.get(tabId)].filter((record) => record !== undefined)
        : [...this.records.values()].filter((record) => this.tabSessions.get(record.id) === owner)
      for (const record of affected) record.manager.setAgentTurn(running)
      if (running === false) this.options.log(`会话 ${owner === '' ? tabId : owner} 的助手回合已结束（有遮罩就随回合撤下）`)
      return { ok: true }
    }
    /**
     * The panel's single placement claim: "I am on screen *or* not, and here is my rect".
     *
     * This is the normal path (`bounds` / `show` / `hide` remain as low-level primitives used by
     * probes and the agent path). Collapsing the three messages into one is what fixed a real bug:
     * with two sessions, the background session's panel kept receiving state pushes and sent a
     * lone `show`, so session A's page was painted over session B's UI for a moment.
     *
     * Rules:
     * - `visible: false` → park this tab's view. Never creates a view, so a background panel
     *   reports harmlessly even when the shell has no record for that tab.
     * - `visible: true` → only the *current* instance may place it (`instanceId`), and only this
     *   claim moves the native surface.
     */
    if (name === 'panel') {
      const instanceId = typeof raw.instanceId === 'string' ? raw.instanceId : ''
      if (instanceId !== '' && this.panelInstance.get(tabId) !== instanceId) {
        const previous = this.panelInstance.get(tabId)
        if (previous !== undefined) {
          this.options.log(`侧边栏浏览器：面板实例 ${previous} → ${instanceId}（旧实例的放置请求作废，先 park）`)
          this.records.get(tabId)?.manager.hide()
        }
        this.panelInstance.set(tabId, instanceId)
      }
      if (raw.visible !== true && raw.onScreen !== true) {
        this.records.get(tabId)?.manager.hide()
        return { ok: true }
      }
      // A tab that is on screen and has no page of its own **takes over** its conversation's
      // background view. Runs before `ensure`, so the view that gets placed is the live one, and it
      // is the single trigger for adoption: nothing else may move a page between ids.
      if (raw.onScreen === true) this.adoptAgentTab(tabId)
      const resolvedPanel = this.ensure(tabId)
      if (!resolvedPanel.ok) return { ok: false, reason: resolvedPanel.error }
      this.touch(tabId)
      resolvedPanel.manager.setBounds(raw.rect)
      // Place the native view only once this view really has a page (an empty view would cover the
      // panel's own empty-state hint). The panel re-claims when the page reports state.
      if (raw.visible === true) {
        const shown = resolvedPanel.manager.show('panel')
        if (shown.ok) this.activeId = tabId
        if (resolvedPanel.manager.panelVisibleNow) this.panelEverVisible.add(tabId)
        // One surface at a time: the conversation on screen is the only one whose view (and with it
        // its veil) may be up. Parking the others here is what makes a session switch safe — a view
        // left behind would take its veil with it, floating over the conversation the user switched
        // to. The manager parks view and veil together (`syncVeil`).
        for (const [id, record] of this.records) {
          if (id === tabId) continue
          if (record.manager.visible || record.manager.panelVisibleNow) record.manager.hide()
        }
      }
      return { ok: true }
    }

    const resolved = this.ensure(tabId)
    if (!resolved.ok) return { ok: false, reason: resolved.error }
    const manager = resolved.manager

    // Panel actions that can only come from the user count as "the user is working in the
    // browser": they keep an active takeover (and its auto-release countdown) alive. Automatic
    // traffic (`bounds`, `show`, `state`, `prefs`) deliberately does not.
    if (USER_ACTIVITY_COMMANDS.has(name)) {
      manager.noteUserActivity()
      // A real user action moves their focus: the agent's explicit `switch_tab` choice is dropped so
      // "what I am looking at" becomes the target again (layout traffic must not, see `chosenId`).
      this.chosenId = undefined
    }
    switch (name) {
      case 'create': {
        const created = manager.ensureCreated()
        if (created.ok) this.touch(tabId)
        return created
      }
      case 'bounds': {
        this.touch(tabId)
        const placed = manager.setBounds(raw.rect)
        // A usable rect from the panel means it is on screen: the layout is the user's from now on.
        if (manager.panelVisibleNow) this.panelEverVisible.add(tabId)
        return placed
      }
      case 'show': {
        this.touch(tabId)
        const current = this.records.get(tabId)?.manager ?? manager
        const shown = current.show()
        if (shown.ok) this.activeId = tabId
        if (current.panelVisibleNow) this.panelEverVisible.add(tabId)
        return shown
      }
      case 'hide':
        return manager.hide()
      case 'navigate': {
        const navigated = manager.navigate(raw.url)
        if (navigated.ok) {
          this.touch(tabId)
          this.activeId = tabId
        }
        return navigated
      }
      case 'back': return manager.back()
      case 'forward': return manager.forward()
      case 'reload': return manager.reload()
      case 'focus': {
        this.activeId = tabId
        return manager.focus()
      }
      // Both of these go through CDP, so they answer asynchronously.
      case 'pick': return manager.handle({ name: 'pick', enabled: raw.enabled })
      case 'device': return manager.handle({ name: 'device', device: raw.device })
      case 'deviceSpec': return manager.handle({
        name: 'deviceSpec',
        preset: raw.preset,
        width: raw.width,
        height: raw.height,
        rotate: raw.rotate,
      })
      // Browser chrome: address-bar history, the freeze snapshot for DOM menus, prefs, privacy.
      case 'history': return manager.handle({ name: 'history' })
      case 'clearHistory': return manager.handle({ name: 'clearHistory', url: raw.url })
      case 'freeze': return manager.handle({ name: 'freeze' })
      // The panel button belongs to one browser: hand *that* one back, not "the conversation's".
      case 'releaseBrowser': return this.records.get(tabId)?.manager.releaseToAgent() ?? { ok: false, reason: '还没有打开的浏览器标签' }
      case 'unfreeze': return manager.handle({ name: 'unfreeze' })
      case 'prefs': return manager.handle({ name: 'prefs' })
      case 'setPrefs': return manager.handle({ name: 'setPrefs', patch: raw.patch })
      case 'clearCache': return manager.handle({ name: 'clearCache' })
      case 'clearCookies': return manager.handle({ name: 'clearCookies' })
      case 'state': return { ok: true, state: manager.state() }
      default:
        return { ok: false, reason: '未知命令' }
    }
  }

  /**
   * Hand the conversation's **background** view to the sidebar tab that just came on screen.
   *
   * The agent browses before any sidebar tab exists, in a scratch view keyed by conversation. When a
   * tab then opens for that conversation it becomes the component instance the user sees, so the page
   * must move into it — by **moving the record**, never by copying the URL into a fresh view. Copying
   * showed a stale page whenever the agent was still loading, and only caught up on its next call.
   *
   * The scratch view is the only donor. Another *sidebar tab of the same conversation* is a browser
   * of its own: opening a second tab must give you a second, empty browser, not steal the first one's
   * page (multiple tabs per conversation is the whole point of the slot's `multiple: true`).
   */
  private adoptAgentTab(viewId: string): void {
    const sessionId = this.tabSessions.get(viewId) ?? ''
    const scratchId = this.agentTabId(sessionId)
    if (viewId === scratchId) return
    // A tab that already has a page is its own browser: leave it alone.
    const own = this.records.get(viewId)
    if (own !== undefined && own.manager.state().url !== '') return
    const donor = this.records.get(scratchId)
    if (donor === undefined || donor.manager.state().url === '') return
    const url = donor.manager.state().url
    // The tab's own view is empty (that is why we are here): drop it, keep the live one.
    if (own !== undefined) {
      own.manager.destroy()
      this.records.delete(viewId)
      if (this.activeId === viewId) this.activeId = undefined
    }
    this.records.delete(scratchId)
    this.tabSessions.delete(scratchId)
    if (this.activeId === scratchId) this.activeId = undefined
    // An explicit choice follows the view it named, or it would silently point at nothing.
    if (this.chosenId === scratchId) this.chosenId = viewId
    this.records.set(viewId, { id: viewId, manager: donor.manager, lastSeen: 0 })
    if (sessionId !== '') this.tabSessions.set(viewId, sessionId)
    // Pushes, picks and control notes must name the tab that now owns this view.
    this.options.rebindManager?.(donor.manager, viewId)
    this.touch(viewId)
    this.options.log(`浏览器视图已交给侧边栏 tab ${viewId}（同一个视图，页面不重载）：${url}`)
  }

  /**
   * Hand the conversation's background view to the tab that is already on screen for it.
   *
   * The shell asks the page to open the tab **before** it navigates (so the pane has the whole load
   * time to mount), which means the panel's first claim always arrives while the page is still empty
   * — adoption then finds no donor and does nothing. Without this second trigger the tab stays empty
   * until the user switches tabs and back (that re-claims, and by then the page exists): exactly the
   * reported "新会话第一次打开浏览器什么都不显示，切走再切回来才显示".
   *
   * Called right after a successful navigation. The claim stays the trigger for the other direction
   * (the user opens a tab while the agent was already browsing).
   */
  adoptForSession(sessionId = ''): void {
    if (sessionId === '') return
    const scratchId = this.agentTabId(sessionId)
    const empty = [...this.records.values()].filter((record) => {
      if (record.id === scratchId) return false
      if (this.tabSessions.get(record.id) !== sessionId) return false
      return record.manager.state().url === ''
    })
    // The tab on screen wins; a single candidate is unambiguous even before its first claim (the pane
    // may still be laying out). Several off-screen candidates: leave it to the claim.
    const donor = empty.find((record) => record.manager.panelVisibleNow) ?? (empty.length === 1 ? empty[0] : undefined)
    if (donor === undefined) return
    this.adoptAgentTab(donor.id)
  }

  /**
   * Wait (briefly) until the panel's claim has placed this view.
   *
   * The claim is a round trip — state push → panel render → `panel` command — so the answer to "is the
   * user looking at it?" is not known synchronously. Bounded, and only used when the caller asked for
   * the page to be shown.
   */
  private async settleVisible(manager: BrowserViewManager, timeoutMs = 400): Promise<boolean> {
    // Nothing is going to place it while its panel is off screen: do not wait for a claim that is not
    // coming (this is the normal "the user never opened the sidebar" case).
    if (!manager.panelVisibleNow) return manager.visible
    const deadline = Date.now() + timeoutMs
    while (!manager.visible && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 25) })
    }
    return manager.visible
  }

  /**
   * In-flight agent calls, keyed by the **manager** that raised the veil.
   *
   * Keyed by manager rather than by id because the id may be replaced under a call (a panel opening
   * for the conversation moves the view); a key lookup at `end` then cleared a different tab's
   * veil — which is how the veil got stuck ("agent 结束了调用，浏览器还显示被 agent 控制中").
   */
  private readonly inflightCalls = new Map<BrowserViewManager, number>()

  /**
   * Bracket one agent tool call: raise the veil before the call runs, lower it after.
   *
   * The view is **created here when it does not exist yet**, because the first call of a
   * conversation is usually the one that makes it. Looking the target up first found nothing, so the
   * very first navigation ran with no veil at all and the user only saw "the agent is driving" from
   * the second call on. Ensuring the view first is what makes the marker automatic.
   */
  beginAgentActivity(toolName: string, sessionId = ''): void {
    // The veil belongs to the view the call is about to drive — that is {@link target}. Only when
    // there is no view yet does the call create one (the conversation's scratch view), and that is
    // the one to mark. Marking by conversation id alone raised the veil on a *different* manager
    // than the call used whenever the panel had already adopted the view.
    const key = this.target(sessionId)?.id ?? this.agentTabId(sessionId)
    const ensured = this.ensure(key)
    if (!ensured.ok) return
    if (sessionId !== '' && !this.tabSessions.has(key)) this.tabSessions.set(key, sessionId)
    this.inflightCalls.set(ensured.manager, (this.inflightCalls.get(ensured.manager) ?? 0) + 1)
    ensured.manager.beginAgentActivity(toolName)
  }

  /**
   * Drop one in-flight call on every manager that has one (see {@link inflightCalls}).
   *
   * Ends with a sweep of the views that are *not* tracked: the manager ignores the call when nothing
   * is in flight, and it is what guarantees a veil never outlives the tool call that raised it —
   * whatever path that call took (early return, timeout, abort, the view appearing mid-call).
   */
  endAgentActivity(): void {
    const tracked = new Set(this.inflightCalls.keys())
    for (const manager of [...this.inflightCalls.keys()]) {
      const depth = this.inflightCalls.get(manager) ?? 0
      if (depth <= 0) continue
      manager.endAgentActivity()
      if (depth === 1) this.inflightCalls.delete(manager)
      else this.inflightCalls.set(manager, depth - 1)
    }
    for (const record of this.records.values()) {
      if (tracked.has(record.manager)) continue
      record.manager.endAgentActivity()
    }
  }

  /** Apply the configured idle window to every live tab. */
  setAutoReleaseSeconds(seconds: unknown): void {
    for (const record of this.records.values()) record.manager.setAutoReleaseSeconds(seconds)
  }

  /** Hand the target tab back to the agent (panel button after a user takeover). */
  releaseToAgent(sessionId = ''): BrowserCommandResult {
    const target = this.target(sessionId)
    if (target === undefined) return { ok: false, reason: '还没有打开的浏览器标签' }
    const result = target.manager.releaseToAgent()
    // The manager already pushed its own state; nothing else to notify here.
    return result
  }

  /** The agent-facing face: operations go to {@link target}, plus tab listing/switching. */
  toolHost(sessionId = ''): BrowserToolHost {
    const tabs = this
    const withTargetAsync = async <T>(
      run: (manager: BrowserViewManager) => Promise<HostResult<T>>,
    ): Promise<HostResult<T>> => {
      const target = tabs.target(sessionId)
      if (target === undefined) return { ok: false, error: '还没有打开的浏览器标签' }
      const result = await run(target.manager)
      if (result.ok) tabs.touch(target.id)
      return result
    }
    const withTargetSync = <T>(run: (manager: BrowserViewManager) => HostResult<T>): HostResult<T> => {
      const target = tabs.target(sessionId)
      if (target === undefined) return { ok: false, error: '还没有打开的浏览器标签' }
      const result = run(target.manager)
      if (result.ok) tabs.touch(target.id)
      return result
    }

    return {
      get created() { return tabs.created },
      // True while the *target* tab is being driven by the user (clicked the veil): tools then
      // wait for control instead of fighting them for the page.
      get userDriving() {
        return tabs.target(sessionId)?.manager.drivingByUser === true
      },
      waitForControl: async (signal) => {
        const target = tabs.target(sessionId)
        // No tab at all means nothing is being driven: let the call proceed and report itself.
        if (target === undefined) return 'released'
        return await target.manager.waitForControl(signal)
      },
      state: () => {
        const target = tabs.target(sessionId)
        if (target === undefined) {
          return { url: '', title: '', loading: false, visible: false, tab: '', tabCount: tabs.tabs(sessionId).length }
        }
        const state = target.manager.state()
        return {
          url: state.url,
          title: state.title,
          loading: state.loading,
          visible: target.manager.visible,
          tab: target.id,
          // Scoped to the calling conversation: a global count made a fresh conversation look like
          // it already had a tab ("共 1 个标签" with no target), which is exactly the confusion the
          // per-conversation split is meant to remove.
          tabCount: tabs.tabs(sessionId).length,
        }
      },
      tabs: () => tabs.tabs(sessionId),
      switchTab: (id) => {
        const record = typeof id === 'string' ? tabs.records.get(id) : undefined
        if (record === undefined) {
          return { ok: false, error: `没有这个标签：${String(id)}（用 tabs 查看可用 id）` }
        }
        const owner = tabs.tabSessions.get(record.id) ?? ''
        if (sessionId !== '' && owner !== sessionId) {
          return { ok: false, error: `标签 ${record.id} 属于另一个会话，不能切换` }
        }
        tabs.chosenId = record.id
        tabs.activeId = record.id
        tabs.touch(record.id)
        const summary = tabs.tabs(sessionId).find((entry) => entry.id === record.id)
        return summary === undefined ? { ok: false, error: '标签已关闭' } : { ok: true, tab: summary }
      },
      navigate: async (address, options) => {
        // The agent may browse before the user opens the panel: give it its own hidden tab.
        let target = tabs.target(sessionId)
        if (target === undefined) {
          // One scratch tab **per conversation**: a second conversation must not inherit the first
          // one's page (it did — the agent in a new conversation read the old page's headline).
          const scratchId = tabs.agentTabId(sessionId)
          const created = tabs.ensure(scratchId)
          if (!created.ok) return { ok: false, error: created.error }
          if (sessionId !== '') tabs.tabSessions.set(scratchId, sessionId)
          target = { id: scratchId, manager: created.manager }
          tabs.activeId = scratchId
        }
        // `show: true` means "let the user see this". If the panel is not on screen the shell asks
        // the *page* to open the browser tab in DSH's right sidebar — opening a pane is a
        // client-side operation, so the page does it and then reports its bounds, which is what
        // finally places the native view inside the sidebar. Ask before loading: the page then has
        // the whole page-load time to mount, and `show` below already arrives to a laid-out panel.
        if (options.show && !target.manager.panelVisibleNow) {
          // The *driving* conversation travels with the request: the panel must open the tab for the
          // conversation the agent is working in, not for whatever happens to be on screen.
          this.options.onOpenPane?.(target.id, !this.panelEverVisible.has(target.id), sessionId)
        }
        const result = await target.manager.toolNavigate(address, options)
        if (!result.ok) return result
        tabs.touch(target.id)
        // The page has a URL now, so this is the moment the tab the shell opened for this call can
        // take the view over (see `adoptForSession`). Without it the empty tab stays empty until the
        // user switches tabs and back — the reported "新会话第一次打开浏览器什么都不显示".
        tabs.adoptForSession(sessionId)
        const owner = tabs.target(sessionId)
        const manager = owner?.manager ?? target.manager
        // The panel learns about the page from a state *push* and places it on its next claim, so wait
        // a moment and report what the user actually sees rather than guessing. `show: false` is a
        // background read: no claim was asked for, so do not linger on its behalf.
        const visible = result.visible || (options.show ? await tabs.settleVisible(manager) : manager.visible)
        return { ...result, tab: owner?.id ?? target.id, visible }
      },
      back: () => withTargetSync((manager) => manager.toolHistory('back')),
      forward: () => withTargetSync((manager) => manager.toolHistory('forward')),
      reload: () => withTargetSync((manager) => manager.toolHistory('reload')),
      snapshot: () => withTargetAsync((manager) => manager.toolSnapshot()),
      click: (input) => withTargetAsync((manager) => manager.toolClick(input)),
      type: (input) => withTargetAsync((manager) => manager.toolType(input)),
      keys: (keys) => withTargetAsync((manager) => manager.toolKeys(keys)),
      scroll: (input) => withTargetAsync((manager) => manager.toolScroll(input)),
      wait: (input) => withTargetAsync((manager) => manager.toolWait(input)),
      select: (input) => withTargetAsync((manager) => manager.toolSelect(input)),
      find: (input) => withTargetAsync((manager) => manager.toolFind(input)),
      screenshot: (fullPage) => withTargetAsync((manager) => manager.toolScreenshot(fullPage)),
    }
  }

  /** Park every tab's view (the DSH page navigated away, e.g. reload or launcher). */
  hideAll(): void {
    for (const record of this.records.values()) record.manager.hide()
  }

  /** Window is going away: tear every tab down. */
  shutdown(): void {
    this.retired = true
    for (const record of this.records.values()) record.manager.shutdown()
    this.records.clear()
    this.activeId = undefined
    this.chosenId = undefined
  }

  /** Panel body's tab was closed: destroy that tab's view, keep the others. */
  closeTab(tabId: string): boolean {
    const record = this.records.get(tabId)
    if (record === undefined) return false
    record.manager.destroy()
    this.inflightCalls.delete(record.manager)
    this.records.delete(tabId)
    this.tabSessions.delete(tabId)
    if (this.activeId === tabId) this.activeId = undefined
    if (this.chosenId === tabId) this.chosenId = undefined
    return true
  }

  /**
   * What one view currently shows (used by the agent's `tabs` listing and the panel).
   *
   * `undefined` for a view that was never created (a tab whose page has not been opened yet) — the
   * strip then shows the URL it was created with.
   */
  tabState(tabId: string): { readonly url: string; readonly title: string } | undefined {
    const record = this.records.get(tabId)
    if (record === undefined) return undefined
    const state = record.manager.state()
    return { url: state.url, title: state.title }
  }

  /** Test/diagnostic hook: the id the next tool call would target. */
  activeTabId(): string | undefined {
    return this.target()?.id
  }
}
