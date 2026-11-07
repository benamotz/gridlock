import { Btn, type PlayerWire } from '@gridlock/shared';
import {
  FireStick, SPRINT_PUSH, type StickVector, stickToDriveBits, stickVector,
} from './gestures.js';
import { type TargetContext, pickTarget } from './targeting.js';

/** On-screen buttons the touch HUD can hold down. */
export type TouchAction =
  | 'jump' | 'reload' | 'interact' | 'swap' | 'useMedkit' | 'useArmor' | 'fire';

const ACTION_BITS: Record<TouchAction, number> = {
  jump: Btn.Jump,
  reload: Btn.Reload,
  interact: Btn.Interact,
  swap: Btn.Swap,
  useMedkit: Btn.UseMedkit,
  useArmor: Btn.UseArmor,
  fire: Btn.Fire,
};

export interface TouchOptions {
  leftHanded: boolean;
  fireMode: 'stick' | 'button';
  driveMode: 'screen' | 'car';
  /** Stick travel in CSS pixels, from the button-size setting. */
  radius: number;
}

export interface TouchSampleContext {
  now: number;
  inVehicle: boolean;
  isDriver: boolean;
  /** Semi-automatic weapons need the trigger pulsed to keep firing. */
  semiAuto: boolean;
  /** No auto target this frame (placing a defence aims the preview instead). */
  noTarget?: boolean;
  /** Builds the auto-target context for this frame (facing filled in here). */
  targets: Omit<TargetContext, 'facing'>;
}

export interface TouchSample {
  buttons: number;
  aim: number;
  slot: number;
  ax?: number;
  ay?: number;
  /** Where the aim came from: an auto target, a manual drag, or facing. */
  aimSource: 'target' | 'drag' | 'facing';
  /** Who a tap would hit right now, for the on-screen marker. */
  target: PlayerWire | null;
}

interface Thumb {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

/**
 * Touch input: a floating move stick under the left thumb, the hybrid fire
 * stick under the right, and the HUD's on-screen buttons. It produces the same
 * snapshot as the keyboard and mouse - buttons, aim, slot and analog axes - so
 * nothing downstream knows or cares where the input came from.
 */
export class TouchInput {
  private readonly layer: HTMLDivElement;
  private readonly moveZone: HTMLDivElement;
  private readonly fireZone: HTMLDivElement;
  private readonly moveBase: HTMLDivElement;
  private readonly moveKnob: HTMLDivElement;
  private readonly fireBase: HTMLDivElement;
  private readonly fireKnob: HTMLDivElement;
  private readonly abort = new AbortController();

  private move: Thumb | null = null;
  private readonly fire = new FireStick();
  private fireId = -1;
  private readonly held = new Set<TouchAction>();
  /** Presses shorter than a frame still register once. */
  private readonly pulses = new Set<TouchAction>();
  private pendingSlot = -1;
  private facing = 0;
  private lockedId: string | null = null;
  private pulseToggle = false;
  private enabled = true;

  constructor(container: HTMLElement, private opts: TouchOptions) {
    const el = (cls: string, parent: HTMLElement): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      parent.appendChild(d);
      return d;
    };
    this.layer = el('touch-layer', container);
    this.moveZone = el('touch-zone move', this.layer);
    this.fireZone = el('touch-zone fire', this.layer);
    this.moveBase = el('touch-stick-base move', this.layer);
    this.moveKnob = el('touch-stick-knob', this.moveBase);
    this.fireBase = el('touch-stick-base fire', this.layer);
    this.fireKnob = el('touch-stick-knob', this.fireBase);
    this.attach();
    this.applyLayout();
  }

  setOptions(opts: TouchOptions): void {
    this.opts = opts;
    this.applyLayout();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  /** An on-screen button went down or up. */
  press(action: TouchAction, down: boolean): void {
    if (down) {
      this.held.add(action);
      this.pulses.add(action);
    } else {
      this.held.delete(action);
    }
  }

  selectSlot(slot: number): void {
    this.pendingSlot = slot;
  }

  dispose(): void {
    this.abort.abort();
    this.layer.remove();
  }

  private releaseAll(): void {
    this.move = null;
    this.fire.up(0);
    this.fireId = -1;
    this.held.clear();
    this.pulses.clear();
    this.renderSticks();
  }

  private applyLayout(): void {
    this.layer.classList.toggle('left-handed', this.opts.leftHanded);
    this.layer.classList.toggle('fire-button', this.opts.fireMode === 'button');
    this.layer.style.setProperty('--stick-radius', `${this.opts.radius}px`);
  }

  private attach(): void {
    const { signal } = this.abort;
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = this.layer.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    this.moveZone.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.move) return;
      e.preventDefault();
      capture(this.moveZone, e.pointerId);
      const p = local(e);
      this.move = { id: e.pointerId, originX: p.x, originY: p.y, x: p.x, y: p.y };
      this.renderSticks();
    }, { signal });
    this.moveZone.addEventListener('pointermove', (e) => {
      if (!this.move || e.pointerId !== this.move.id) return;
      const p = local(e);
      this.move.x = p.x;
      this.move.y = p.y;
      this.renderSticks();
    }, { signal });
    const endMove = (e: PointerEvent): void => {
      if (!this.move || e.pointerId !== this.move.id) return;
      this.move = null;
      this.renderSticks();
    };
    this.moveZone.addEventListener('pointerup', endMove, { signal });
    this.moveZone.addEventListener('pointercancel', endMove, { signal });

    this.fireZone.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.fireId !== -1 || this.opts.fireMode === 'button') return;
      e.preventDefault();
      capture(this.fireZone, e.pointerId);
      this.fireId = e.pointerId;
      const p = local(e);
      this.fire.down(p.x, p.y, performance.now());
      this.renderSticks();
    }, { signal });
    this.fireZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.fireId) return;
      const p = local(e);
      this.fire.move(p.x, p.y);
      this.renderSticks();
    }, { signal });
    const endFire = (e: PointerEvent): void => {
      if (e.pointerId !== this.fireId) return;
      this.fireId = -1;
      this.fire.up(performance.now());
      this.renderSticks();
    };
    this.fireZone.addEventListener('pointerup', endFire, { signal });
    this.fireZone.addEventListener('pointercancel', endFire, { signal });

    // Losing the page (a call, the app switcher) must not leave a thumb "down".
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    }, { signal });
  }

  /** Draws the sticks where the thumbs are; DOM only, never through React. */
  private renderSticks(): void {
    const r = this.opts.radius;
    const place = (base: HTMLDivElement, knob: HTMLDivElement, t: Thumb | null): void => {
      base.classList.toggle('active', t !== null);
      if (!t) {
        base.style.transform = '';
        knob.style.transform = '';
        return;
      }
      base.style.transform = `translate(${t.originX - r}px, ${t.originY - r}px)`;
      const v = stickVector(t.originX, t.originY, t.x, t.y, r, 0);
      knob.style.transform = `translate(${v.x * r}px, ${v.y * r}px)`;
    };
    place(this.moveBase, this.moveKnob, this.move);
    const f = this.fire;
    place(this.fireBase, this.fireKnob, f.phase === 'idle' ? null : {
      id: this.fireId, originX: f.originX, originY: f.originY, x: f.x, y: f.y,
    });
  }

  private moveVector(): StickVector {
    if (!this.move) return { x: 0, y: 0, mag: 0 };
    const m = this.move;
    return stickVector(m.originX, m.originY, m.x, m.y, this.opts.radius);
  }

  sample(ctx: TouchSampleContext): TouchSample {
    const now = ctx.now;
    this.fire.update(now);
    let buttons = 0;
    if (this.enabled) {
      for (const a of this.held) buttons |= ACTION_BITS[a];
      for (const a of this.pulses) buttons |= ACTION_BITS[a];
    }
    this.pulses.clear();

    const v = this.enabled ? this.moveVector() : { x: 0, y: 0, mag: 0 };
    let ax: number | undefined;
    let ay: number | undefined;
    if (ctx.inVehicle) {
      if (ctx.isDriver && v.mag > 0) {
        if (this.opts.driveMode === 'screen') {
          ax = v.x;
          ay = v.y;
        } else {
          buttons |= stickToDriveBits(v, { up: Btn.Up, down: Btn.Down, left: Btn.Left, right: Btn.Right });
        }
      }
    } else if (v.mag > 0) {
      ax = v.x;
      ay = v.y;
      if (v.mag >= SPRINT_PUSH) buttons |= Btn.Sprint;
      // With no stick on the trigger, the player faces where they walk.
      if (v.mag > 0.2) this.facing = Math.atan2(v.y, v.x);
    }

    const triggerDown = this.opts.fireMode === 'button'
      ? this.held.has('fire')
      : this.fire.firing(now);
    const drag = this.opts.fireMode === 'stick' ? this.fire.dragAngle() : null;
    // The marker always shows who a tap would hit; while firing the target is
    // locked so holding the stick does not flick between enemies.
    const target = drag === null && !ctx.noTarget
      ? pickTarget({ ...ctx.targets, facing: this.facing }, triggerDown ? this.lockedId : null)
      : null;
    this.lockedId = triggerDown && target ? target.id : null;

    let aim = this.facing;
    let aimSource: TouchSample['aimSource'] = 'facing';
    if (drag !== null) {
      aim = drag;
      aimSource = 'drag';
      this.facing = drag;
    } else if (target) {
      aim = Math.atan2(target.y - ctx.targets.selfY, target.x - ctx.targets.selfX);
      aimSource = 'target';
    }

    if (triggerDown) {
      // A semi-automatic weapon only fires on a fresh press: pulse it, and
      // let the server's fire-rate limit set the pace.
      this.pulseToggle = !this.pulseToggle;
      if (!ctx.semiAuto || this.pulseToggle) buttons |= Btn.Fire;
    }

    const slot = this.pendingSlot;
    this.pendingSlot = -1;
    return {
      buttons, aim, slot, aimSource,
      target: drag === null ? target : null,
      ...(ax !== undefined ? { ax, ay } : {}),
    };
  }
}

/**
 * Keeps a touch's events coming to its zone even when the thumb slides off it.
 * Capture can be refused (the pointer is already gone); the touch still counts.
 */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Not fatal: the zone just stops receiving moves once the thumb leaves it.
  }
}
