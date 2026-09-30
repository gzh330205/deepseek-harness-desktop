/**
 * The panel plugin, executed and rendered in a minimal host.
 *
 * `src-tauri/resources/dsh-desktop-shell/client.js` is loaded by DSH through
 * `window.__ModuleLoader__`, so nothing in this repository ever ran it — and that is how a
 * one-line ordering mistake shipped a **white sidebar** (a `useEffect` dependency array
 * referenced a `const` declared further down the component; dependency arrays are evaluated
 * during render, so the panel threw a TDZ `ReferenceError` and the whole body rendered
 * nothing). `apply` still returned cleanly, the host half was fine, and the only symptom was
 * a blank pane with no log line anywhere.
 *
 * This harness closes that hole: it stubs `window.__ModuleLoader__` plus the few React hooks
 * the plugin uses, runs `apply` with fake services, then actually renders the registered
 * components and drives one pick. Anything that throws shows up here instead of on screen.
 *
 * Run: node --test src/plugin-panel.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../../src-tauri/resources/dsh-desktop-shell/client.js', import.meta.url), 'utf8')
/** The launch overlay, because it is where DSH's own browser tab type is disabled. */
const OVERLAY_SOURCE = readFileSync(new URL('./desktop-files.ts', import.meta.url), 'utf8')

interface FakeElement {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: readonly unknown[]
}

interface FakeReact {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => FakeElement
  Fragment: unknown
  useState: (initial: unknown) => [unknown, (next: unknown) => void]
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => void
  useLayoutEffect: (effect: () => unknown) => void
  useRef: (initial: unknown) => { current: unknown }
  useCallback: <T>(fn: T) => T
  useMemo: <T>(fn: () => T) => T
  memo: <T>(component: T) => T
  created: FakeElement[]
  effects: (() => unknown)[]
}

function makeReact(): FakeReact {
  const react: FakeReact = {
    created: [],
    effects: [],
    createElement: (type, props, ...children) => {
      const element: FakeElement = { type, props: props ?? {}, children }
      react.created.push(element)
      return element
    },
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
    useEffect: (effect) => { react.effects.push(effect) },
    useLayoutEffect: (effect) => { react.effects.push(effect) },
    useRef: (initial) => ({ current: initial ?? null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    memo: (component) => component,
  }
  return react
}

interface Registered {
  readonly name: string
  readonly component: (props: Record<string, unknown>) => FakeElement
  readonly definition: Record<string, unknown>
}

interface Harness {
  readonly registered: Registered[]
  readonly calls: string[]
  readonly bailEvents: { name: string; payload: Record<string, unknown> }[]
  readonly insertTexts: string[]
  readonly pickListeners: ((pick: unknown) => void)[]
  /** Render the registered pane-tab body, then run the effects it registered. */
  renderPanel(props?: Record<string, unknown>): FakeElement
  /** Run one pick through the panel's onPick subscription. */
  deliverPick(pick: Record<string, unknown>): Promise<void>
}

/**
 * Boot the plugin the way DSH does: module loader → factory → apply → render.
 * @param options.chipApplies - what `scope.bail('slash/input-insert-reference')` answers.
 */
function boot(options: { chipApplies?: boolean; browserEnabled?: boolean } = {}): Harness {
  const react = makeReact()
  const registered: Registered[] = []
  const calls: string[] = []
  const bailEvents: { name: string; payload: Record<string, unknown> }[] = []
  const insertTexts: string[] = []
  const pickListeners: ((pick: unknown) => void)[] = []

  let loaded: { id: string; factory: (require: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | undefined
  const globalScope = globalThis as unknown as Record<string, unknown>
  globalScope.window = {
    __ModuleLoader__: { load: (definition: typeof loaded) => { loaded = definition } },
    // The panel measures its stage and schedules bounds pushes through these.
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: () => {},
    clearTimeout,
    setTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    ResizeObserver: class { observe(): void {} disconnect(): void {} },
    confirm: () => true,
  }
  // `navigator` is a getter-only global in modern Node, so it needs a property definition.
  Object.defineProperty(globalScope, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  })
  globalScope.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      revision: 1,
      settings: { browser: { enabled: options.browserEnabled !== false } },
    }),
  })
  globalScope.__DSH_DESKTOP_BROWSER__ = {
    command: async () => ({ ok: true }),
    subscribe: () => () => {},
    onPick: (listener: (pick: unknown) => void) => { pickListeners.push(listener); return () => {} },
  }

  // eslint-disable-next-line no-new-func -- the plugin is evaluated the way DSH evaluates it
  new Function('window', SOURCE)(globalScope.window)
  assert.ok(loaded !== undefined, 'client.js never called __ModuleLoader__.load')
  const exported = loaded.factory((name: string) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${String(name)})`)
  })

  const slots = {
    inject: (name: string, register: () => unknown) => { calls.push(`slots.inject(${name})`); const result = register(); return typeof result === 'function' ? result : () => {} },
    register: (definition: Record<string, unknown>, component: Registered['component']) => {
      calls.push(`slots.register(${String(definition.name)})`)
      registered.push({ name: String(definition.name), component, definition })
      return () => {}
    },
  }
  const inputActions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 7 }),
    insertText: (text: string) => { insertTexts.push(text); return true },
  }
  const services = {
    slots,
    // Injected scopes carry `effect` too: cordis runs the callback immediately and keeps the
    // returned disposer.
    effect: (effect: () => unknown) => { const disposer = effect(); return typeof disposer === 'function' ? disposer : () => {} },
    sessions: {
      scope: () => ({
        bail: (name: string, payload: Record<string, unknown>) => {
          bailEvents.push({ name, payload })
          return options.chipApplies === true
        },
      }),
    },
    inputTriggers: { registerSource: (source: { name: string }) => { calls.push(`registerSource(${source.name})`); return () => {} } },
    sidebarRightTabs: { register: (definition: { id: string }) => { calls.push(`tab.register(${definition.id})`); return () => {} } },
    sidebarRight: { registerCloseHandler: () => { calls.push('registerCloseHandler'); return () => {} } },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
  }
  const ctx = {
    slots,
    locale: services.locale,
    effect: (effect: () => unknown) => { const disposer = effect(); return typeof disposer === 'function' ? disposer : () => {} },
    get: (name: string) => (name === 'inputTriggers' ? services.inputTriggers : undefined),
    inject: (names: readonly string[], callback?: (scope: unknown) => unknown) => {
      calls.push(`ctx.inject([${names.join(',')}])`)
      if (callback !== undefined) callback(services)
      return undefined
    },
    plugin: () => {},
  }
  exported.apply(ctx)

  const panelProps = {
    useTabInfo: () => ({ sidebar: { open: true, fullscreen: false }, panel: { id: 'panel-1' }, tab: { id: 'tab-1', visible: true } }),
    sessionId: 'session-1',
    inputActions,
  }

  return {
    registered,
    calls,
    bailEvents,
    insertTexts,
    pickListeners,
    renderPanel: (props = panelProps) => {
      const panel = registered.find((entry) => entry.name === 'sidebar.right.pane.tab')
      assert.ok(panel !== undefined, `pane body was never registered (got: ${registered.map((entry) => entry.name).join(', ')})`)
      react.effects.length = 0
      const tree = panel.component(props)
      // Effects are where the panel subscribes to state and picks; run them like React would.
      for (const effect of react.effects) effect()
      return tree
    },
    deliverPick: async (pick) => {
      for (const listener of pickListeners) listener(pick)
      // `handlePick` awaits the chip round trip before deciding what to do.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    },
  }
}

/** `apply` registers the pane body asynchronously (it first reads the saved settings). */
async function bootSettled(options: { chipApplies?: boolean; browserEnabled?: boolean } = {}): Promise<Harness> {
  const harness = boot(options)
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  return harness
}

const PICK = {
  // The shell echoes the view id the panel sent: `<conversation>::<sidebar tab>` (one sidebar tab is
  // one browser component instance, and the conversation qualifies it because DSH mints tab ids per
  // session).
  tabId: 'session-1::tab-1',
  selector: '#s-top-loginbtn',
  preview: '#s-top-loginbtn',
  url: 'https://www.baidu.com/',
  outerHTML: '<a id="s-top-loginbtn">登录</a>',
}

test('the panel renders a toolbar and a stage instead of throwing', async () => {
  const harness = await bootSettled()
  const tree = harness.renderPanel()
  const classes = (harness.registered.length, collectClasses(tree))
  assert.ok(classes.has('dsb-bar'), 'no toolbar rendered')
  assert.ok(classes.has('dsb-stage'), 'no stage rendered')
})

test('the panel still renders without a session id or composer actions', async () => {
  const harness = await bootSettled()
  // A sidebar pane that is not session-scoped, or a DSH build without ui-conversation, must
  // degrade to a working browser rather than a blank pane.
  const tree = harness.renderPanel({ useTabInfo: () => ({ tab: { id: 'tab-1', visible: true } }) })
  assert.ok(collectClasses(tree).has('dsb-stage'))
})

test('a pick becomes a reference chip with a self-contained ref', async () => {
  const harness = await bootSettled({ chipApplies: true })
  harness.renderPanel()
  assert.ok(harness.pickListeners.length > 0, 'the panel never subscribed to picks')
  await harness.deliverPick(PICK)

  const event = harness.bailEvents.find((entry) => entry.name === 'slash/input-insert-reference')
  assert.ok(event !== undefined, 'the chip insertion event was never emitted')
  const reference = event.payload.reference as Record<string, unknown>
  assert.equal(reference.source, 'desktop-element')
  // The ref carries the element itself, so a chip in a persisted draft survives a reload.
  const ref = JSON.parse(String(reference.ref)) as Record<string, unknown>
  assert.equal(ref.selector, '#s-top-loginbtn')
  assert.equal(ref.html, '<a id="s-top-loginbtn">登录</a>')
  // The span must be the composer's own insertion span: the shell CAS-checks `draftRev`.
  assert.equal((event.payload.span as Record<string, unknown>).draftRev, 7)
  // Chip success is silent: no text insertion, no clipboard dance.
  assert.deepEqual(harness.insertTexts, [])
})

test('a pick falls back to plain text when the chip channel refuses', async () => {
  const harness = await bootSettled({ chipApplies: false })
  harness.renderPanel()
  await harness.deliverPick(PICK)
  assert.equal(harness.insertTexts.length, 1)
  // OneCode's element block format, which is also what the chip serializes to at submit.
  assert.match(harness.insertTexts[0] ?? '', /^--- 页面元素 \(#s-top-loginbtn\) ---\n来源: https:\/\/www\.baidu\.com\//u)
})

test('the reference source the chip routes to is registered with a serializer', async () => {
  const harness = await bootSettled()
  assert.ok(harness.calls.includes('registerSource(desktop-element)'), harness.calls.join(', '))
})


test('placement has exactly one path: the atomic panel claim', () => {
  // Real bug: with two sessions, the background session's panel kept receiving state pushes and
  // sent a lone `show`, so session A's page was painted over session B's UI. Placement now leaves
  // through one function, one message, carrying visibility *and* the rect together.
  assert.match(SOURCE, /name: 'panel',\r?\n\s+instanceId,/u)
  assert.match(SOURCE, /React\.useMemo\(\(\) => `p-\$\{Math\.random/u)
  // The state subscription must go through it instead of sending `show` on its own.
  assert.match(SOURCE, /syncBounds\(\);\r?\n\s+if \(editingRef\.current/u)
  // And the panel must not send the three separate placement primitives any more.
  assert.equal(SOURCE.includes("void send({ name: 'show' })"), false)
  assert.equal(SOURCE.includes("name: 'bounds',"), false)
  assert.equal(SOURCE.includes("{ name: hasPageRef.current ? 'show' : 'hide' }"), false)
})
test('opening the browser uses the documented open, and never toggles blindly', () => {
  // Reading the source (`packages/client/ui-sidebar-right`) settled the whole "opened then closed"
  // saga: `openTab`/`openTabIn` → `placeTab` → the store's `openContent`, whose first op is
  // `planSetExpanded(state, true)` — that is, **opening expands the column**. The reverse-engineered
  // `commandTarget`/`openTabFromTarget` probing and the "read the state, guess, toggle" dance are
  // gone; what remains is one documented call plus a reuse check.
  assert.match(SOURCE, /sidebar\.openTabIn\(sessionId, BROWSER_TAB_KIND/u)
  assert.match(SOURCE, /sidebar\.openTab\(BROWSER_TAB_KIND/u)
  assert.equal(SOURCE.includes('openTabFromTarget('), false, 'the reverse-engineered path is gone')
  assert.equal(SOURCE.includes('commandTarget('), false, 'the reverse-engineered path is gone')
  // `openTabIn` does not throw for a session whose store was never adopted — it silently does
  // nothing (its own comment says so). A new conversation hit exactly that: the sidebar never
  // opened. The call is therefore verified and falls back to the on-screen `openTab`.
  assert.match(SOURCE, /if \(!oursInSession\(\)\) throw new Error\('openTabIn 未生效/u)  // Reuse first: `multiple: true` gives every open a fresh contentId, so an agent that asks to show
  // a page twice must focus the session's existing browser tab instead of stacking new ones.
  assert.match(SOURCE, /sidebar\.tabsIn\(sessionId\)\.find/u)
  assert.match(SOURCE, /sidebar\.focus\(existing\.id\)/u)
  // `toggleExpanded` is a toggle: it may only run when the documented `isExpanded()` read says the
  // column is collapsed (an unreadable answer must mean "do nothing").
  const toggleAt = SOURCE.indexOf('sidebar.toggleExpanded();')
  assert.ok(toggleAt > 0, 'the guarded expansion exists')
  const guardAt = SOURCE.lastIndexOf('sidebar.isExpanded() === false', toggleAt)
  assert.ok(guardAt > 0 && toggleAt > guardAt, 'toggleExpanded is guarded by a read of isExpanded()')
})

test('a panel view id is a session-qualified tab occurrence', () => {
  // Two conversations both see `tab5` from DSH's dockkit (its id counter lives in the session
  // store). The shell keys views by what the panel sends, so a bare id made the second
  // conversation's sidebar adopt the first conversation's page — and made `begin`/`end` land on
  // different views, leaving the veil stuck.
  //
  // The id must *also* keep the tab occurrence: qualifying by conversation alone collapsed two
  // sidebar tabs of one conversation into a single browser, and the slot is registered
  // `multiple: true` precisely so one conversation can have several independent browsers.
  assert.match(SOURCE, /const viewId = sessionId === '' \? tabId : `\$\{sessionId\}::\$\{tabId\}`/u)
  assert.match(SOURCE, /bridge\.command\(Object\.assign\(\{ tabId: viewId, sessionId \}, command\)\)/u)
  assert.match(SOURCE, /raw\.tabId !== viewId/u)
  // The shell *pushes* navigation state tagged with the same view id, so the push filter has to use
  // `viewId` as well. Comparing the raw DSH tab id silently dropped every push: the panel never
  // learned the page existed, and a brand-new conversation's sidebar stayed blank until the user
  // switched tabs and back (用户实报：「新会话第一次打开浏览器不显示内容，切走再切回才显示」）。
  assert.match(SOURCE, /if \(typeof next\.tabId === 'string' && next\.tabId !== viewId\) return;/u)
  // …while the tab-strip title stays keyed by DSH's own tab id (that layer knows nothing of viewId).
  assert.match(SOURCE, /publishBrowserTitle\(tabId, next\.title\)/u)
})
test('the browser type is registered the way the source documents it', () => {
  // Two stages, exactly as `packages/client/ui-sidebar-right/src/client/index.ts` describes:
  // the type into `ctx.sidebarRightTabs`, its body into the keyed `sidebar.right.pane.tab` seat
  // under the same id. `multiple: true` is what gives the session independent tabs; `keepMounted`
  // keeps the native page alive while the tab is hidden (we park the view instead of reloading).
  assert.match(SOURCE, /scope\.sidebarRightTabs\.register\(\{/u)
  assert.match(SOURCE, /id: BROWSER_TAB_ID,/u)
  assert.match(SOURCE, /kind: BROWSER_TAB_KIND,/u)
  assert.match(SOURCE, /multiple: true,/u)
  assert.match(SOURCE, /keepMounted: true,/u)
  // The manual entry is DSH's own guide card, and it carries the shortcut so the card shows the key.
  assert.match(SOURCE, /guide: \[/u)
  assert.match(SOURCE, /commandId: BROWSER_NEW_COMMAND,/u)
  assert.match(SOURCE, /const BROWSER_NEW_COMMAND = 'dsh-desktop\.browser\.new'/u)
  assert.match(SOURCE, /scope\.shortcuts\.register\(\{/u)
  // DSH's own browser tab type is disabled through the launch overlay, so only one browser exists.
  assert.match(OVERLAY_SOURCE, /- id: ui-sidebar-browser\r?\n  disabled: true/u)
})
test('the panel can be asked to open the sidebar browser tab', () => {
  // The shell sends `browser-open-pane` when the agent wants the user to see a page but no panel
  // is on screen; only the client half can open a pane.
  assert.match(SOURCE, /bridge\.onOpenPane\(/u)
  assert.match(SOURCE, /openBrowserPaneTab = \(sessionId\) => \{/u)
  assert.match(SOURCE, /openTabIn\(sessionId, BROWSER_TAB_KIND/u)
  // Visibility must be *asked*, not guessed from the DOM: keepMounted keeps other sessions' panel
  // bodies in the document, so `querySelector('.dsb-bar')` is a false positive (it cost us a
  // broken auto-open). The shell answers `panelVisible`.
  assert.match(SOURCE, /name: 'panelVisible'/u)
  assert.equal(SOURCE.includes("querySelector('.dsb-bar')"), false)
})
test('the panel tells the shell when it is off screen', () => {
  // Off-screen (collapsed sidebar, another tab, too small) is reported as `onScreen: false` on the
  // single placement message, which parks the native view. `onScreen` and `visible` are separate on
  // purpose: the shell hands the agent's background page to a panel that is *on screen* even though
  // it has no page yet — merging the two deadlocked (empty panel never claimed visible, so it never
  // received the page, so it stayed empty).
  assert.match(SOURCE, /const onScreen = visible === true && rect !== null && rect\.width >= 24 && rect\.height >= 24/u)
  assert.match(SOURCE, /visible: onScreen && hasPageRef\.current === true/u)
  // And it must re-measure when visibility changes (collapse, tab switch, dock form change).
  assert.match(SOURCE, /\[visible, send, instanceId\]/u)
})

/** Collect every `className` in the rendered tree (the tree is plain objects in this harness). */
function collectClasses(node: unknown, found = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return found
  const element = node as { props?: Record<string, unknown>; children?: readonly unknown[] }
  const className = element.props?.className
  if (typeof className === 'string') for (const name of className.split(' ')) found.add(name)
  for (const child of element.children ?? []) collectClasses(child, found)
  return found
}
