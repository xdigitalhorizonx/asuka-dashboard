/**
 * Haptic feedback — only fires on devices that verifiably support it.
 *
 * Desktop browsers expose `navigator.vibrate` but do nothing (or reject), so we
 * additionally require a coarse pointer (touch) before calling it. Every action
 * that triggers a haptic must ALSO show visible feedback; this is an extra, never
 * the only signal.
 */
export type HapticKind = "tap" | "save";

export function hapticsSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (typeof navigator.vibrate !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** Light tap for selection (dock, rows); double tap for a successful save. Returns whether it fired. */
export function haptic(kind: HapticKind): boolean {
  if (!hapticsSupported()) return false;
  try {
    return navigator.vibrate(kind === "save" ? [12, 60, 12] : 10);
  } catch {
    return false;
  }
}
