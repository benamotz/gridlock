/**
 * Touch detection. A coarse pointer (finger) is the signal; a laptop with a
 * touch screen and a mouse reports a fine pointer as primary and keeps the
 * desktop controls unless the player switches touch on in Settings.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Whether the touch layer should run, from the Auto / On / Off setting. */
export function touchEnabled(setting: 'auto' | 'on' | 'off'): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return isTouchDevice();
}

/** A short vibration where supported (Android Chrome); silently nothing elsewhere. */
export function buzz(ms: number): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    // Some browsers throw when vibration is blocked; it is only a nicety.
  }
}
