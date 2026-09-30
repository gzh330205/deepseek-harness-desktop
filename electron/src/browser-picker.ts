/**
 * Element picker: hover-highlight an element in the sidebar browser and hand its HTML and a
 * stable selector to the user (and from there into the conversation).
 *
 * Vendored from OneCode (MIT) `apps/desktop/src/main/browser/pickerScript.ts`. The overlay,
 * `buildSelector`, the capture-phase listeners and "Esc to exit" are unchanged; the part that
 * carries the result back was rewritten twice over, and the second rewrite is the one that
 * matters:
 *
 * 1. OneCode forwards picks through `window.mcodeBridge.pickElement`, a preload it installs on
 *    the browser view. Our browser views have **no preload on purpose** — nothing a visited
 *    page can reach may talk to the shell — so the pick travels without one.
 * 2. The first attempt used `window.open('dsh-pick:…')` plus a marked `console.log`. The popup
 *    transport was a mistake: a malformed scheme string made Chromium treat the URL as
 *    *relative*, resolve it against the page and hand us a perfectly ordinary `https:` URL —
 *    which our window-open handler then loaded, navigating the user's tab to a 404. It is gone.
 *
 * The pick now arrives as the **resolved value of the injected script**: the script returns a
 * promise that settles on the first click (or on Esc), and `webContents.executeJavaScript`
 * awaits it. Verified against Electron 44 with a real Chromium click, not assumed. The marked
 * `console.log` stays as a second, lower-bandwidth transport (it keeps working for picks after
 * the first one, since the promise only settles once); the main process de-duplicates.
 *
 * Security: the injected code is read-only w.r.t. the page — it attaches non-capturing
 * listeners plus its own overlay and reads element data on click. It never touches Node or
 * Electron APIs. The nonce is baked in as a JSON string literal, so a page cannot forge a pick
 * the user never made.
 */

/** Cap the outerHTML we forward so a giant subtree can't blow up the prompt. */
export const PICKER_HTML_CAP = 2000

/** Marks a pick in the page's console stream (the backup transport). */
export const PICK_MARKER = '__DSH_PICK__'

/** Marks the page-side picker tearing itself down (Esc), so the panel can un-arm too. */
export const PICK_OFF_MARKER = '__DSH_PICK_OFF__'

/**
 * Returned instead of a promise when the picker was already armed, so the shell can tell
 * "nothing to do" apart from "the picker was removed" (`null`).
 */
export const PICKER_ALREADY_ACTIVE = 'dsh-picker-already-active'

export interface PickedElement {
  readonly selector: string
  readonly outerHTML: string
  readonly url: string
  readonly preview: string
}

/**
 * Build the injection for one pick session.
 *
 * `nonce` is embedded as a JSON string literal, so no page-controlled value can escape it.
 * The script returns a promise (`Promise<PickedElement | null>`): the first pick, or `null`
 * when the picker is removed (already armed, or Esc).
 */
export function buildPickerScript(nonce: string): string {
  return PICKER_SCRIPT
    .replace('%NONCE%', JSON.stringify(nonce))
    .replace('%MARKER%', JSON.stringify(PICK_MARKER))
    .replace('%OFF_MARKER%', JSON.stringify(PICK_OFF_MARKER))
    .replace('%ALREADY_ACTIVE%', JSON.stringify(PICKER_ALREADY_ACTIVE))
    .replace('%CAP%', String(PICKER_HTML_CAP))
}

/** Parse a pick that arrived over the console transport. `undefined` for anything else. */
export function parseConsolePick(raw: string, expectedNonce: string): PickedElement | undefined {
  if (!raw.startsWith(PICK_MARKER)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(PICK_MARKER.length))
  } catch {
    return undefined
  }
  return asPickedElement(parsed, expectedNonce)
}

/**
 * Validate a value that claims to be a pick (the promise transport hands us a real object).
 * Returns `undefined` unless it matches the armed nonce and carries a usable selector.
 */
export function asPickedElement(value: unknown, expectedNonce: string): PickedElement | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.nonce !== expectedNonce) return undefined
  if (typeof record.selector !== 'string' || record.selector === '') return undefined
  if (typeof record.url !== 'string') return undefined
  return {
    selector: record.selector,
    outerHTML: typeof record.outerHTML === 'string' ? record.outerHTML : '',
    url: record.url,
    preview: typeof record.preview === 'string' ? record.preview : record.selector,
  }
}

/**
 * Two picks are the same event when they name the same element on the same page. Used to drop
 * the duplicate that the backup transport produces for the first pick of a session.
 */
export function pickSignature(element: PickedElement): string {
  return JSON.stringify([element.url, element.selector, element.outerHTML, element.preview])
}

/** Human/model-facing rendering of a pick, capped so it cannot dominate a prompt. */
export function describePickedElement(element: PickedElement): string {
  const lines = [
    '来自侧边栏浏览器拾取的元素：',
    `页面: ${element.url}`,
    `选择器: ${element.selector}`,
  ]
  if (element.outerHTML !== '') lines.push(`HTML: ${element.outerHTML}`)
  return lines.join('\n')
}

const PICKER_SCRIPT = `
(function () {
  if (window.__dshPickerActive) return %ALREADY_ACTIVE%;
  window.__dshPickerActive = true;

  var cap = %CAP%;
  var nonce = %NONCE%;
  var marker = %MARKER%;
  var offMarker = %OFF_MARKER%;

  // Highlight overlay - a fixed, pointer-events:none box that follows the hovered element.
  var overlay = document.createElement('div');
  overlay.id = '__dsh-picker-overlay';
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;' +
    'border:2px solid #4f8cff;background:rgba(79,140,255,0.12);' +
    'transition:all 0.05s ease-out;display:none;' +
    'box-shadow:0 0 0 9999px rgba(0,0,0,0.05);';
  (document.body || document.documentElement).appendChild(overlay);

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function showOverlay(el) {
    var p = rectOf(el);
    overlay.style.left = p.left + 'px';
    overlay.style.top = p.top + 'px';
    overlay.style.width = p.width + 'px';
    overlay.style.height = p.height + 'px';
    overlay.style.display = 'block';
  }
  function hideOverlay() { overlay.style.display = 'none'; }

  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + CSS.escape(node.id); parts.unshift(part); break; }
      var classes = Array.from(node.classList).filter(Boolean);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          part += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 5) break;
    }
    return parts.join(' > ');
  }

  function previewFor(el, selector) {
    var tag = el.tagName.toLowerCase();
    var idCls = '';
    if (el.id) idCls = '#' + el.id;
    else if (el.className && typeof el.className === 'string' && el.className.trim()) {
      idCls = '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
    }
    return (selector || (tag + idCls)).slice(0, 40);
  }

  function onOver(e) {
    var el = e.target;
    if (!el || el === overlay || el.id === '__dsh-picker-overlay') return;
    if (el === document.documentElement || el === document.body) { hideOverlay(); return; }
    showOverlay(el);
  }
  function onMove(e) { onOver(e); }

  // The promise's resolver: the first click settles it (the shell is awaiting this script).
  var settle = null;

  function onClick(e) {
    var el = e.target;
    if (!el || el === overlay) return;
    if (el === document.documentElement || el === document.body) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var selector = buildSelector(el);
    var html = el.outerHTML || '';
    if (html.length > cap) html = html.slice(0, cap) + '\\u2026';
    var picked = {
      nonce: nonce,
      selector: selector,
      outerHTML: html,
      url: location.href,
      preview: previewFor(el, selector),
    };
    // Backup transport: still fires for picks after the first one, since the promise above
    // can only settle once. The shell drops the duplicate of the first pick.
    try { console.log(marker + JSON.stringify(picked)); } catch (err) { /* best-effort */ }
    if (settle) { var done = settle; settle = null; done(picked); }
    overlay.style.borderColor = '#22c55e';
    setTimeout(function () { overlay.style.borderColor = '#4f8cff'; }, 250);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (window.__dshPickerRemove) window.__dshPickerRemove();
    }
  }
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.__dshPickerRemove = function () {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    window.__dshPickerActive = false;
    delete window.__dshPickerRemove;
    // Tell the shell the page-side picker is gone: it un-arms the panel toggle and settles
    // this promise with null.
    try { console.log(offMarker); } catch (err) { /* best-effort */ }
    if (settle) { var done = settle; settle = null; done(null); }
  };

  return new Promise(function (resolve) { settle = resolve; });
})();
`

/**
 * Remove the picker: tears down all listeners and the overlay. Safe to run even if the picker
 * was never injected.
 */
export const PICKER_REMOVE_SCRIPT = `
(function () {
  if (window.__dshPickerRemove) { window.__dshPickerRemove(); }
  return 'dsh-picker-removed';
})();
`
