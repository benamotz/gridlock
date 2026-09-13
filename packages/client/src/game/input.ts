import { Btn, type DeployableKind } from '@gridlock/shared';

export type ActionId =
  | 'up' | 'down' | 'left' | 'right'
  | 'fire' | 'sprint' | 'reload' | 'interact' | 'swap'
  | 'slot1' | 'slot2' | 'slot3' | 'slot4'
  | 'scoreboard' | 'map' | 'menu' | 'chat'
  | 'deployBarricade' | 'deployTurret' | 'deployMine'
  | 'jump' | 'useMedkit' | 'useArmor';

/**
 * Default bindings.
 *
 * Every action is looked up through this map rather than being tested against
 * a hard-coded key, which is what makes remapping (and, later, gamepad and
 * touch layers) a data change instead of a rewrite.
 */
export const DEFAULT_BINDINGS: Record<ActionId, string[]> = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  fire: ['Mouse0'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  reload: ['KeyR'],
  interact: ['KeyE'],
  swap: ['KeyF'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  deployBarricade: ['KeyQ'],
  deployTurret: ['KeyT'],
  deployMine: ['KeyX'],
  jump: ['Space'],
  useMedkit: ['KeyH'],
  useArmor: ['KeyG'],
  scoreboard: ['Tab'],
  map: ['KeyM'],
  menu: ['Escape'],
  chat: ['Enter'],
};

const BUTTON_ACTIONS: [ActionId, number][] = [
  ['up', Btn.Up],
  ['down', Btn.Down],
  ['left', Btn.Left],
  ['right', Btn.Right],
  ['fire', Btn.Fire],
  ['sprint', Btn.Sprint],
  ['reload', Btn.Reload],
  ['interact', Btn.Interact],
  ['swap', Btn.Swap],
  ['jump', Btn.Jump],
  ['useMedkit', Btn.UseMedkit],
  ['useArmor', Btn.UseArmor],
];

export interface InputSnapshot {
  buttons: number;
  aim: number;
  slot: number;
}

export interface InputCallbacks {
  onToggleScoreboard(down: boolean): void;
  onToggleMap(): void;
  onMenu(): void;
  onChat(): void;
  onDeploy(kind: DeployableKind): void;
  /**
   * The following let a mode (defence placement) claim input before it reaches
   * gameplay. Each returns true when it consumed the event.
   */
  onWheel?(direction: number): boolean;
  onPrimaryClick?(): boolean;
  onSecondaryClick?(): boolean;
  onCancel?(): boolean;
}

/**
 * Keyboard and mouse capture.
 *
 * Aim is computed from the mouse position relative to the player's position on
 * screen, which the game loop keeps up to date; the input layer itself never
 * needs to know about the camera.
 */
export class InputManager {
  private held = new Set<string>();
  private bindings: Record<ActionId, string[]>;
  private mouseX = 0;
  private mouseY = 0;
  /** Player's current screen position, updated by the game loop each frame. */
  private anchorX = 0;
  private anchorY = 0;
  private pendingSlot = -1;
  private enabled = true;
  sensitivity = 1;
  /**
   * Every listener is registered against this signal, so `dispose` removes
   * them all. Without it, each match left its listeners on `window`: after a
   * rematch the old instance still answered Escape, toggling the menu twice.
   */
  private readonly listeners = new AbortController();

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: InputCallbacks,
    bindings: Record<ActionId, string[]> = DEFAULT_BINDINGS,
  ) {
    this.bindings = bindings;
    this.attach();
  }

  setBindings(b: Record<ActionId, string[]>): void {
    this.bindings = b;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.held.clear();
  }

  /** The aim angle right now, for actions that happen between frames. */
  aimNow(): number {
    return Math.atan2(
      (this.mouseY - this.anchorY) * this.sensitivity,
      (this.mouseX - this.anchorX) * this.sensitivity,
    );
  }

  /** Detaches every listener. Called when the match view is torn down. */
  dispose(): void {
    this.listeners.abort();
    this.held.clear();
  }

  setAnchor(x: number, y: number): void {
    this.anchorX = x;
    this.anchorY = y;
  }

  private matches(action: ActionId, code: string): boolean {
    return this.bindings[action]?.includes(code) ?? false;
  }

  private isDown(action: ActionId): boolean {
    return this.bindings[action]?.some((code) => this.held.has(code)) ?? false;
  }

  private attach(): void {
    const el = this.element;
    const { signal } = this.listeners;

    window.addEventListener('keydown', (e) => {
      // Never swallow keys while the player is typing in a form field.
      if (isTextTarget(e.target)) return;
      if (this.matches('scoreboard', e.code)) e.preventDefault();
      // Space would otherwise scroll the page mid-jump.
      if (e.code === 'Tab' || this.matches('jump', e.code)) e.preventDefault();
      if (e.repeat) return;

      if (this.matches('menu', e.code)) {
        // Escape leaves placement mode before it opens the menu.
        if (this.callbacks.onCancel?.()) return;
        this.callbacks.onMenu();
        return;
      }
      if (!this.enabled) return;

      if (this.matches('scoreboard', e.code)) this.callbacks.onToggleScoreboard(true);
      if (this.matches('map', e.code)) this.callbacks.onToggleMap();
      if (this.matches('chat', e.code)) this.callbacks.onChat();
      if (this.matches('deployBarricade', e.code)) this.callbacks.onDeploy('barricade');
      if (this.matches('deployTurret', e.code)) this.callbacks.onDeploy('turret');
      if (this.matches('deployMine', e.code)) this.callbacks.onDeploy('mine');

      for (const [action, slot] of [
        ['slot1', 0], ['slot2', 1], ['slot3', 2], ['slot4', 3],
      ] as [ActionId, number][]) {
        if (this.matches(action, e.code)) this.pendingSlot = slot;
      }

      this.held.add(e.code);
    }, { signal });

    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
      if (this.matches('scoreboard', e.code)) this.callbacks.onToggleScoreboard(false);
    }, { signal });

    // Losing focus must release everything, or the player keeps running.
    window.addEventListener('blur', () => this.held.clear(), { signal });

    el.addEventListener('mousemove', (e) => {
      const rect = el.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
    }, { signal });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0 && this.callbacks.onPrimaryClick?.()) return;
      if (e.button === 2 && this.callbacks.onSecondaryClick?.()) return;
      this.held.add(`Mouse${e.button}`);
    }, { signal });
    window.addEventListener('mouseup', (e) => this.held.delete(`Mouse${e.button}`), { signal });
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    el.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const direction = e.deltaY > 0 ? 1 : -1;
      // Placement mode uses the wheel to rotate; otherwise it cycles slots.
      if (this.callbacks.onWheel?.(direction)) return;
      this.pendingSlot = direction > 0 ? -2 : -3;
    }, { passive: false, signal });
  }

  /** Samples the current frame's input and clears one-shot state. */
  sample(currentSlot: number, slotCount: number): InputSnapshot {
    let buttons = 0;
    if (this.enabled) {
      for (const [action, bit] of BUTTON_ACTIONS) {
        if (this.isDown(action)) buttons |= bit;
      }
    }

    const dx = (this.mouseX - this.anchorX) * this.sensitivity;
    const dy = (this.mouseY - this.anchorY) * this.sensitivity;
    const aim = Math.atan2(dy, dx);

    let slot = this.pendingSlot;
    if (slot === -2) slot = (currentSlot + 1) % slotCount;
    else if (slot === -3) slot = (currentSlot - 1 + slotCount) % slotCount;
    this.pendingSlot = -1;

    return { buttons, aim, slot };
  }
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
