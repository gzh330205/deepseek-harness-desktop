/**
 * The "parked native surface" state machine for the sidebar browser.
 *
 * A `WebContentsView` always paints above the panel's DOM, so opening a menu means parking the
 * surface and showing a frozen snapshot instead. Two callers touch that state and they must not
 * be confused with one another:
 *
 * - a **menu** freezes and thaws (the page must come back exactly as it was);
 * - a **hide** (tab switched away, panel collapsed) parks the surface for good and must forget
 *   any freeze, otherwise a later `show()` looks like "still frozen" and the page never returns.
 *
 * Getting that wrong is invisible in code review and looks like a blank panel on screen — which
 * is exactly what happened twice, so the transitions live here and are unit-tested.
 */

export interface FreezeState {
  readonly frozen: boolean
  /** Whether the surface was on screen when it was frozen: only then should thawing show it. */
  readonly wasVisible: boolean
}

/** Nothing frozen; nothing to restore. */
export const FREEZE_IDLE: FreezeState = { frozen: false, wasVisible: false }

/**
 * A menu is taking over the surface.
 * @param visible - whether the surface was actually on screen at that moment.
 */
export function beginFreeze(visible: boolean): FreezeState {
  return { frozen: true, wasVisible: visible }
}

/**
 * The surface was hidden for a reason unrelated to menus (or the view is going away): drop the
 * freeze so the next `show()` is not mistaken for "a menu is still open".
 */
export function clearFreeze(): FreezeState {
  return FREEZE_IDLE
}

/**
 * The menu closed.
 * @returns `restore: true` when the surface should be shown again.
 */
export function endFreeze(state: FreezeState): { next: FreezeState; restore: boolean } {
  if (!state.frozen) return { next: FREEZE_IDLE, restore: false }
  return { next: FREEZE_IDLE, restore: state.wasVisible }
}

/** Whether a command that would place the surface must be ignored while a menu is open. */
export function blocksSurfaceShow(state: FreezeState): boolean {
  return state.frozen
}
