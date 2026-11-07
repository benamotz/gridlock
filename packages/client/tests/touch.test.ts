import { describe, expect, it } from 'vitest';
import { Btn, type PlayerWire } from '@gridlock/shared';
import {
  DRAG_MIN_PX, FireStick, SPRINT_PUSH, STICK_DEADZONE, TAP_FIRE_MS, TAP_MAX_MS,
  contextFromPrompt, stickToDriveBits, stickVector,
} from '../src/game/touch/gestures.js';
import { type TargetContext, isThreat, pickTarget } from '../src/game/touch/targeting.js';

describe('move stick', () => {
  it('ignores a resting thumb inside the dead zone', () => {
    const v = stickVector(100, 100, 100 + 56 * STICK_DEADZONE * 0.9, 100, 56);
    expect(v.mag).toBe(0);
  });

  it('reaches full push at the stick radius, and no further', () => {
    const v = stickVector(100, 100, 100 + 200, 100, 56);
    expect(v.mag).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(1);
  });

  it('starts near zero just outside the dead zone, so walking can be slow', () => {
    const v = stickVector(0, 0, 56 * (STICK_DEADZONE + 0.02), 0, 56);
    expect(v.mag).toBeGreaterThan(0);
    expect(v.mag).toBeLessThan(0.05);
  });

  it('sprints only near full push', () => {
    expect(stickVector(0, 0, 56 * 0.7, 0, 56).mag).toBeLessThan(SPRINT_PUSH);
    expect(stickVector(0, 0, 56, 0, 56).mag).toBeGreaterThanOrEqual(SPRINT_PUSH);
  });

  it('maps a stick to car-style driving bits', () => {
    const bits = { up: Btn.Up, down: Btn.Down, left: Btn.Left, right: Btn.Right };
    expect(stickToDriveBits({ x: 0, y: -1, mag: 1 }, bits)).toBe(Btn.Up);
    expect(stickToDriveBits({ x: 0.8, y: -0.6, mag: 1 }, bits)).toBe(Btn.Up | Btn.Right);
    expect(stickToDriveBits({ x: 0.1, y: 0.1, mag: 0.14 }, bits)).toBe(0);
  });
});

describe('fire stick', () => {
  it('turns a quick, still touch into a short burst', () => {
    const f = new FireStick();
    f.down(10, 10, 1000);
    f.up(1000 + TAP_MAX_MS - 50);
    const t = 1000 + TAP_MAX_MS - 50;
    expect(f.firing(t + TAP_FIRE_MS - 10)).toBe(true);
    expect(f.firing(t + TAP_FIRE_MS + 10)).toBe(false);
  });

  it('keeps firing while held still, without manual aim', () => {
    const f = new FireStick();
    f.down(10, 10, 0);
    f.update(TAP_MAX_MS + 10);
    expect(f.phase).toBe('hold');
    expect(f.firing(TAP_MAX_MS + 10)).toBe(true);
    expect(f.dragAngle()).toBeNull();
  });

  it('aims by hand once the thumb moves', () => {
    const f = new FireStick();
    f.down(10, 10, 0);
    f.move(10, 10 + DRAG_MIN_PX + 5);
    expect(f.phase).toBe('drag');
    expect(f.dragAngle()).toBeCloseTo(Math.PI / 2);
  });

  it('does not fire a tap after a long press', () => {
    const f = new FireStick();
    f.down(10, 10, 0);
    f.update(TAP_MAX_MS + 100);
    f.up(TAP_MAX_MS + 200);
    expect(f.firing(TAP_MAX_MS + 210)).toBe(false);
  });
});

describe('context button', () => {
  it('labels it from the server prompt, without the key', () => {
    expect(contextFromPrompt('E - Buy SMG ($400)', false)).toEqual({ label: 'Buy SMG ($400)', action: 'interact' });
    expect(contextFromPrompt('E - Steal Car', false)).toEqual({ label: 'Steal Car', action: 'interact' });
    expect(contextFromPrompt('F - Swap for Rifle', false)).toEqual({ label: 'Swap for Rifle', action: 'swap' });
  });

  it('offers Exit in a vehicle and nothing for information-only prompts', () => {
    expect(contextFromPrompt(null, true)).toEqual({ label: 'Exit', action: 'interact' });
    expect(contextFromPrompt('Hold your ground to rob the store', false)).toBeNull();
    expect(contextFromPrompt(null, false)).toBeNull();
  });
});

const player = (id: string, x: number, y: number, extra: Partial<PlayerWire> = {}): PlayerWire => ({
  id, name: id, x, y, aim: 0, team: -1, life: 'alive', weapon: 'pistol', hp: -1,
  vehicleId: null, sprinting: false, protected: false, carryingFlag: -1, air: 0, wanted: 0,
  ...extra,
});

function ctx(players: PlayerWire[], over: Partial<TargetContext> = {}): TargetContext {
  return {
    selfId: 'me', selfX: 0, selfY: 0, selfTeam: -1, selfWanted: 0, freeRoam: true,
    players, hurtBy: new Map(), now: 100_000, range: 600, facing: 0,
    lineOfSight: () => true,
    ...over,
  };
}

describe('auto-target', () => {
  it('never picks a pedestrian, a bystander or an unwanted player', () => {
    const c = ctx([
      player('ped', 100, 0, { npc: 'ped' }),
      player('bystander', 120, 0),
      player('cop', 140, 0, { npc: 'cop' }),
    ]);
    expect(pickTarget(c)).toBeNull();
  });

  it('picks gunmen set against you, your job target and wanted players', () => {
    expect(isThreat(player('g', 100, 0, { npc: 'thug', marked: true }), ctx([]))).toBe(true);
    expect(isThreat(player('t', 100, 0, { npc: 'ped', marked: true }), ctx([]))).toBe(true);
    expect(isThreat(player('w', 100, 0, { wanted: 2 }), ctx([]))).toBe(true);
    // Someone else's crew is not your fight.
    expect(isThreat(player('g2', 100, 0, { npc: 'thug' }), ctx([]))).toBe(false);
  });

  it('only counts police while they are after you', () => {
    const cop = player('cop', 100, 0, { npc: 'cop' });
    expect(isThreat(cop, ctx([]))).toBe(false);
    expect(isThreat(cop, ctx([], { selfWanted: 1 }))).toBe(true);
  });

  it('remembers who shot you, for a while', () => {
    const shooter = player('shooter', 100, 0);
    const hurtBy = new Map([['shooter', 99_000]]);
    expect(isThreat(shooter, ctx([], { hurtBy }))).toBe(true);
    expect(isThreat(shooter, ctx([], { hurtBy, now: 99_000 + 11_000 }))).toBe(false);
  });

  it('prefers a target ahead over a closer one behind', () => {
    const ahead = player('ahead', 300, 0, { wanted: 1 });
    const behind = player('behind', -150, 0, { wanted: 1 });
    expect(pickTarget(ctx([ahead, behind]))?.id).toBe('ahead');
  });

  it('ignores targets out of range or out of sight, and keeps a locked one', () => {
    const far = player('far', 900, 0, { wanted: 1 });
    expect(pickTarget(ctx([far]))).toBeNull();
    const hidden = player('hidden', 100, 0, { wanted: 1 });
    expect(pickTarget(ctx([hidden], { lineOfSight: () => false }))).toBeNull();
    const a = player('a', 100, 0, { wanted: 1 });
    const b = player('b', 300, 0, { wanted: 1 });
    expect(pickTarget(ctx([a, b]), 'b')?.id).toBe('b');
  });

  it('targets every enemy (and no teammate) in team modes', () => {
    const c = ctx([], { freeRoam: false, selfTeam: 0 });
    expect(isThreat(player('enemy', 100, 0, { team: 1 }), c)).toBe(true);
    expect(isThreat(player('mate', 100, 0, { team: 0 }), c)).toBe(false);
  });
});
