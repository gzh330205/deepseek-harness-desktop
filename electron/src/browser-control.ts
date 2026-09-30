/**
 * Handing browser control between the user and the agent.
 *
 * The contract this encodes (all of it learned from user feedback):
 *
 * - when the user takes over, an agent tool call **waits** instead of failing — the user should not
 *   have to notice a refused call and repeat themselves;
 * - while the user keeps *using* the page (clicks, typing, scrolling), that wait keeps going;
 * - when the user stops for a while, control is handed back **automatically**, so the waiting call
 *   continues on its own;
 * - the takeover and the hand-back are **pushed into the session**, so the agent is told rather
 *   than left to discover it by probing.
 *
 * The timing rules and the texts live here (pure, unit-tested); the Electron plumbing lives in
 * `browser-view.ts` and the session write in the host plugin.
 */

/** How long the user can be idle before control is handed back automatically. */
export const DEFAULT_AUTO_RELEASE_SECONDS = 30
export const MIN_AUTO_RELEASE_SECONDS = 5
export const MAX_AUTO_RELEASE_SECONDS = 600

/**
 * Safety cap for one waiting tool call.
 *
 * Deliberately below the transport limits (MCP 120s, native tools 180s): a call that hits this
 * gives the model an actionable answer instead of being cut off by a timeout it cannot explain.
 */
export const CONTROL_WAIT_SECONDS = 100

/** Marker a page-side activity listener logs (throttled) for the shell to observe. */
export const ACTIVITY_MARKER = 'dsh-user-activity'

/** Source kind for the session notes, so they are never mistaken for the user's own prompt. */
export const CONTROL_NOTE_SOURCE = 'desktop-shell-browser-control'

/**
 * Page-side listener for "the user is touching the page".
 *
 * Mouse and wheel input cannot be observed from the main process, so a passive capture listener
 * reports it through the console (the same channel the picker uses). It adds no DOM and never
 * calls `preventDefault`, so pages behave exactly as before; the throttle keeps the console quiet.
 */
export const ACTIVITY_PROBE_SCRIPT = `(function () {
  if (window.${'__dshActivityProbe'} === true) return 'already';
  window.${'__dshActivityProbe'} = true;
  var last = 0;
  function report() {
    var now = Date.now();
    if (now - last < 400) return;
    last = now;
    try { console.log('${ACTIVITY_MARKER}'); } catch (error) { /* console gone */ }
  }
  for (var event of ['pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'scroll']) {
    window.addEventListener(event, report, { capture: true, passive: true });
  }
  return 'installed';
})()`

export function isActivityMessage(message: unknown): boolean {
  return typeof message === 'string' && message.includes(ACTIVITY_MARKER)
}

/** Clamp the auto-release window to something sane; invalid input becomes the default. */
export function clampAutoReleaseSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AUTO_RELEASE_SECONDS
  return Math.min(MAX_AUTO_RELEASE_SECONDS, Math.max(MIN_AUTO_RELEASE_SECONDS, Math.round(value)))
}

/** When the idle deadline lands, given a fresh activity event. */
export function nextAutoReleaseAt(now: number, seconds: number): number {
  return now + clampAutoReleaseSeconds(seconds) * 1000
}

export function isAutoReleaseDue(now: number, deadline: number): boolean {
  return Number.isFinite(deadline) && deadline > 0 && now >= deadline
}

/** How a waiting tool call ended. */
export type ControlWaitOutcome = 'released' | 'timeout' | 'aborted'

/**
 * Text prepended to a call that waited for the user and then ran.
 *
 * It matters that the model knows *why* the call took a while and that its action was executed
 * after the hand-back — otherwise "the result arrived late" looks like a stale answer.
 */
export function releasedPrefix(waitedSeconds: number): string {
  const waited = waitedSeconds >= 1 ? `（等待了约 ${String(Math.round(waitedSeconds))} 秒）` : ''
  return `用户把浏览器控制权交还给了助手${waited}，本次调用继续执行：`
}

/** The answer a call gets when the user never handed control back in time. */
export function waitTimeoutText(waitedSeconds: number): string {
  return (
    `用户仍在操作浏览器（已等待约 ${String(Math.round(waitedSeconds))} 秒），本次调用没有执行。` +
    '请不要继续操作页面；可以先用 state 看看当前状态，用户停止操作后控制权会自动交还，' +
    '或者请用户在右侧「浏览器」面板点「立即交还」。'
  )
}

/**
 * A result that was already produced when the user took over, and is handed over anyway because
 * the wait ran out.
 *
 * The work did happen, so this must not be an error — but the page has been in the user's hands
 * since, so the answer may describe a page that no longer exists.
 */
export function staleResultNote(heldSeconds: number): string {
  return (
    `（本次结果是在用户接管浏览器之前得到的，随后用户操作了约 ${String(Math.round(heldSeconds))} 秒，` +
    '页面可能已经变了：继续之前先用 state 或 snapshot 核对一次。）'
  )
}

/** The note appended to the session when control changes hands. */
export function controlNote(state: 'taken' | 'released' | 'expired', seconds: number): string {
  // Wording rules, learned the hard way (a real session ended its turn instead of continuing):
  // these notes are *notifications*. Anything that sounds like an instruction ("stop operating",
  // "wait for me") makes the model politely stop and promise to continue later — and nothing ever
  // resumes it. So: state the fact, then say explicitly that no action is needed.
  if (state === 'taken') {
    return (
      '【浏览器·通知，无需动作】用户点了浏览器页面，正在自己操作。' +
      '你正在等待中的浏览器调用不会失败，控制权交还后会自动继续；' +
      `用户停止操作约 ${String(clampAutoReleaseSeconds(seconds))} 秒后会自动交还。` +
      '**不要因此结束回合、不要暂停任务、也不要承诺稍后继续**：按原计划继续即可。'
    )
  }
  if (state === 'expired') {
    return '【浏览器·通知，无需动作】用户已停止操作，控制权已自动交还给助手；被等待的调用已继续执行。'
  }
  return '【浏览器·通知，无需动作】用户已把控制权交还给助手；被等待的调用已继续执行。'
}

/**
 * Whether a control change should write a session note.
 *
 * When a call is already in flight at takeover time, the hold explains itself: the call's own
 * result (delivered after the hand-back) carries "等待了约 N 秒，本次调用继续执行". Writing a note
 * on top of that is not just redundant — it is what made a real agent stop: it read "用户已接管"
 * before the result and answered "我暂停，稍后继续读结构", then ended its turn.
 */
export function shouldWriteControlNote(
  change: { readonly state: 'taken' | 'released'; readonly agentActive: boolean },
  wroteTakeoverNote: boolean,
): boolean {
  if (change.state === 'taken') return !change.agentActive
  return wroteTakeoverNote
}
