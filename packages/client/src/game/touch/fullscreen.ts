/**
 * Full screen and landscape on phones, from the first tap anywhere - menus
 * included - rather than only once a match has started.
 *
 * Browsers only grant full screen inside a user gesture, and on a touchscreen
 * the gesture that counts is the finger *lifting* (pointerup / click), not
 * touching down: requesting it on pointerdown is silently refused. So the
 * request rides on the first tap the player makes anyway (a menu button, the
 * name field, a thumb on the stick), and again on the next tap after a back
 * gesture or app switch leaves full screen. iPhones offer no full screen to
 * web pages; there the rotate prompt does the job alone.
 */

type FullscreenRoot = HTMLElement & { requestFullscreen?: (o?: object) => Promise<void> };

export function fullscreenSupported(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

let pending = false;

/** Full screen, then a landscape lock where the browser allows it (Android Chrome). */
export function enterFullscreen(): void {
  const root = document.documentElement as FullscreenRoot;
  if (pending || document.fullscreenElement || !root.requestFullscreen) return;
  pending = true;
  root.requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      return orientation?.lock?.('landscape');
    })
    .catch(() => undefined)
    .finally(() => {
      pending = false;
    });
}

let installed = false;

/**
 * Asks for full screen on every tap while not already in it, whenever
 * `enabled()` says touch play is on. Installed once for the whole page.
 */
export function installAutoFullscreen(enabled: () => boolean): void {
  if (installed || typeof document === 'undefined' || !fullscreenSupported()) return;
  installed = true;
  const onTap = (e: PointerEvent | MouseEvent): void => {
    // A mouse click never counts: desktop stays a normal window.
    if ('pointerType' in e && e.pointerType === 'mouse') return;
    if (!enabled() || document.fullscreenElement) return;
    enterFullscreen();
  };
  document.addEventListener('pointerup', onTap as EventListener, { capture: true });
  document.addEventListener('click', onTap as EventListener, { capture: true });
}
