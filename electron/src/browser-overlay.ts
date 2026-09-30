/**
 * The "the agent is driving" veil: which calls raise it, what it says, and how it reports a
 * takeover click.
 *
 * The veil is a *native* `WebContentsView` layered over the browser view (a DOM overlay cannot
 * cover a native surface — see `docs/sidebar-browser-integration.md` §4.5). Everything that is
 * decision-making rather than Electron plumbing lives here, so it is testable: the tool set that
 * deserves a veil, the label shown to the user, and the marker the veil page logs when clicked.
 */

/** Console marker the veil page logs on the first user click. */
export const OVERLAY_TAKEOVER_MARKER = 'dsh-agent-veil:takeover'

/**
 * Escape text for the veil document.
 *
 * The label is built from our own table plus a tool name, so it is trusted input — this is
 * defence in depth for the day someone feeds it a page title instead.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Tools that do not raise the veil.
 *
 * `state` / `tabs` are metadata lookups that finish in microseconds: flashing a dark layer for
 * them would be noise, and nothing on the page changes. Everything else either reads the page
 * (slow enough to be worth showing) or acts on it.
 */
export const VEIL_SILENT_TOOLS: readonly string[] = ['state', 'tabs', 'switch_tab']

/** Human label per tool, so the veil says what is going on rather than just "busy". */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  navigate: '正在打开网页',
  snapshot: '正在读取页面结构',
  find: '正在页面里查找',
  click: '正在点击页面元素',
  type: '正在输入内容',
  keys: '正在按键',
  scroll: '正在滚动页面',
  wait: '正在等待页面变化',
  history: '正在切换页面历史',
  select: '正在选择下拉项',
  screenshot: '正在截图',
}

/** How long the veil stays up even if the call finished instantly (avoids a flicker). */
export const MIN_VEIL_MS = 700

/**
 * How long the marker stays up after the last call ended when the turn status is **unknown**.
 *
 * The marker follows the agent's *turn*, not each tool call: the model thinks for a few seconds between
 * two calls, and showing/hiding around every call made the whole page flicker. When DSH's session
 * status is available the turn ending takes the marker down exactly (this is unused); this linger is
 * the fallback for an older DSH, chosen to cover an ordinary think-then-call gap.
 */
export const VEIL_LINGER_MS = 8000

/**
 * The pill text lives in its own span so it can be rewritten **without reloading** the veil document.
 *
 * Reloading the veil (once per tool call, to change the label) is itself a visible flash — the whole
 * point of this round was to stop the page blinking while the agent works.
 */
export const VEIL_LABEL_ELEMENT_ID = 'dsb-veil-label'
const VEIL_LABEL_PREFIX = '助手正在操作 · '

/**
 * Hard ceiling on how long one tool call may hold the veil.
 *
 * The veil is lowered by the shell the moment a call settles (`main.ts` brackets every call in
 * `try/finally`), so this is **not** the normal path — it is the safety net for a call that never
 * settles at all (a hung CDP round trip, a renderer that died mid-call, an aborted transport).
 * Nothing depends on the model remembering to close it, which is the point: a stuck marker would
 * leave the page reading "被助手控制中" for the rest of the session.
 */
export const AGENT_VEIL_MAX_MS = 5 * 60 * 1000

export function shouldShowAgentVeil(toolName: string): boolean {
  return !VEIL_SILENT_TOOLS.includes(toolName)
}

/** e.g. `助手正在操作 · 正在点击页面元素（click）· 点击任意位置接管`. */
export function veilLabel(toolName: string): string {
  const label = TOOL_LABELS[toolName] ?? '正在操作页面'
  return `${label}（${toolName}）`
}

/**
 * The veil document. Kept as one self-contained HTML string: the view is created with a `data:`
 * URL, so there is no file to ship and no navigation policy to widen.
 *
 * The click listener is registered in the capture phase so page-level handlers cannot swallow it,
 * and it fires once (`{ once: true }`) — after a takeover the view is hidden anyway.
 */
export function overlayDocument(label: string): string {
  const safe = escapeHtml(label)
  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>',
    'html,body{margin:0;height:100%;overflow:hidden;background:rgba(15,17,20,0.22)}',
    'body{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;',
    'padding-top:10px;font:12px/1.5 "Segoe UI",system-ui,sans-serif;color:#fff;cursor:pointer;',
    '-webkit-user-select:none;user-select:none}',
    '.pill{display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;',
    'background:rgba(17,17,19,0.62);border:1px solid rgba(255,255,255,0.14);box-shadow:0 2px 10px rgba(0,0,0,0.25);',
    'opacity:0.92;font-size:11px}',
    '.dot{width:6px;height:6px;border-radius:50%;background:#4ea1ff;animation:pulse 1.4s infinite}',
    '@keyframes pulse{70%{opacity:.3}100%{opacity:1}}',
    '.hint{margin-top:4px;font-size:10px;color:rgba(255,255,255,0.6)}',
    '</style></head><body>',
    `<div class="pill"><span class="dot"></span><span id="${VEIL_LABEL_ELEMENT_ID}">${VEIL_LABEL_PREFIX}${safe}</span></div>`,
    '<div class="hint">点击页面任意位置即可接管</div>',
    '<script>',
    `addEventListener('pointerdown',function(){console.log(${JSON.stringify(OVERLAY_TAKEOVER_MARKER)})},{capture:true,once:true});`,
    // Label updates go through here: the shell rewrites the text of a *live* veil instead of reloading
    // the document (a reload is a visible flash, and it used to happen once per tool call).
    `window.__dshVeilLabel=function(t){var el=document.getElementById(${JSON.stringify(VEIL_LABEL_ELEMENT_ID)});` +
      `if(el)el.textContent=${JSON.stringify(VEIL_LABEL_PREFIX)}+String(t)};`,
    '</script></body></html>',
  ].join('')
}

/** Whether a console line from the veil view is the takeover signal. */
export function isTakeoverMessage(message: unknown): boolean {
  return typeof message === 'string' && message.includes(OVERLAY_TAKEOVER_MARKER)
}

/**
 * The veil's address: a `data:` URL, so there is no file to ship and no navigation policy to
 * widen (the view never loads anything else — a `will-navigate` guard refuses that).
 */
export function overlayUrl(label: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(overlayDocument(label))}`
}
