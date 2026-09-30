/**
 * Vendored from OneCode (MIT): `apps/desktop/src/main/browser/browserInput.ts`.
 *
 * CDP input is what makes an agent click a *real* click: Chromium's own input pipeline,
 * without stealing focus from the shell chrome. Copied as-is except one line (string
 * indexing → `charAt`, for this repository's `noUncheckedIndexedAccess`).
 */

import type { Debugger } from "electron";

/** CDP input targets a page without focusing its native view. Coordinates are
 * viewport CSS pixels, including when device emulation is active. */
export async function dispatchBrowserClick(dbg: Debugger, x: number, y: number): Promise<void> {
  const point = { x, y, button: "left", clickCount: 1 };
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
  await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
}

type Modifier = "control" | "shift" | "alt" | "meta";

/** Translate the existing accelerator names to DOM key/code and virtual key
 * codes. The latter retain Chromium's native editing/navigation behavior. */
export async function dispatchBrowserKeys(
  dbg: Debugger,
  parsed: { key: string; modifiers: Modifier[] },
): Promise<void> {
  const named: Record<string, [string, string, number]> = {
    Enter: ["Enter", "Enter", 13], Tab: ["Tab", "Tab", 9], Esc: ["Escape", "Escape", 27],
    Space: [" ", "Space", 32], Backspace: ["Backspace", "Backspace", 8], Del: ["Delete", "Delete", 46],
    Up: ["ArrowUp", "ArrowUp", 38], Down: ["ArrowDown", "ArrowDown", 40],
    Left: ["ArrowLeft", "ArrowLeft", 37], Right: ["ArrowRight", "ArrowRight", 39],
    PageUp: ["PageUp", "PageUp", 33], PageDown: ["PageDown", "PageDown", 34],
    Home: ["Home", "Home", 36], End: ["End", "End", 35], Ins: ["Insert", "Insert", 45],
  };
  const bits = { alt: 1, control: 2, meta: 4, shift: 8 };
  const modifiers = parsed.modifiers.reduce((mask, mod) => mask | bits[mod], 0);
  const shift = parsed.modifiers.includes("shift");
  let [key, code, windowsVirtualKeyCode] = named[parsed.key] ?? [parsed.key, "", 0];
  if (/^[a-z]$/i.test(parsed.key)) {
    key = shift ? parsed.key.toUpperCase() : parsed.key.toLowerCase();
    code = `Key${parsed.key.toUpperCase()}`;
    windowsVirtualKeyCode = parsed.key.toUpperCase().charCodeAt(0);
  } else if (/^[0-9]$/.test(parsed.key)) {
    // Local edit vs upstream: `.charAt()` instead of string indexing, because this
    // repository compiles with `noUncheckedIndexedAccess`.
    key = shift ? ")!@#$%^&*(".charAt(Number(parsed.key)) : parsed.key;
    code = `Digit${parsed.key}`;
    windowsVirtualKeyCode = parsed.key.charCodeAt(0);
  } else if (/^F\d+$/.test(parsed.key)) {
    code = parsed.key;
    windowsVirtualKeyCode = 111 + Number(parsed.key.slice(1));
  }
  const shortcut = parsed.modifiers.some((m) => m !== "shift");
  const text = shortcut ? "" : key === "Enter" ? "\r" : key.length === 1 ? key : "";
  const base = { key, code, windowsVirtualKeyCode, modifiers };
  await dbg.sendCommand("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}),
  });
  await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
