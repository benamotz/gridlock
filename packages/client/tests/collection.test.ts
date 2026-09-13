import { describe, expect, it } from 'vitest';
import type { PickupWire, SelfState } from '@gridlock/shared';
import { CollectionPredictor } from '../src/game/collection.js';

const self = (patch: Partial<SelfState> = {}): SelfState => ({
  x: 0, y: 0, vx: 0, vy: 0, hp: 100, armor: 0, stamina: 100, life: 'alive',
  ack: 0, slot: 1, weapons: [], reloadEndsAt: 0, spawnProtectedUntil: 0, respawnAt: 0,
  vehicleId: null, spread: 0, team: 0, seat: -1, deployables: [], air: 0, jumpCd: 0,
  medkits: 0, armorPlates: 0, pouchCooldownMs: 0,
  ...patch,
});

const medkit: PickupWire = { id: 'h1', x: 10, y: 0, kind: 'health' };

describe('predicted pickup collection', () => {
  it('grabs an item the moment the player reaches it', () => {
    const c = new CollectionPredictor();
    c.update(0, self(), 0, 0, [medkit]);
    expect(c.isHidden('h1')).toBe(true);
    expect(c.anims).toHaveLength(1);
  });

  it('does not re-grab an item the server never granted, on a loop', () => {
    // Regression: during the countdown the server grants nothing, and every
    // expired prediction immediately "collected" the same item again.
    const c = new CollectionPredictor();
    c.update(0, self(), 0, 0, [medkit]);
    c.update(800, self(), 0, 0, [medkit]); // prediction expired, unconfirmed
    expect(c.isHidden('h1')).toBe(false);
    expect(c.anims).toHaveLength(0);

    c.update(1500, self(), 0, 0, [medkit]); // still backing off
    expect(c.anims).toHaveLength(0);

    c.update(2500, self(), 0, 0, [medkit]); // back-off over
    expect(c.anims).toHaveLength(1);
  });

  it('animates a confirmed grab once, not twice', () => {
    const c = new CollectionPredictor();
    c.update(0, self(), 0, 0, [medkit]);
    const alreadyAnimated = c.confirm('h1', 'health', undefined, 10, 0, 50);
    expect(alreadyAnimated).toBe(true);
    expect(c.anims).toHaveLength(1);
  });

  it('skips items the player could not take', () => {
    const c = new CollectionPredictor();
    c.update(0, self({ medkits: 3 }), 0, 0, [medkit]); // pouch full, full health
    expect(c.anims).toHaveLength(0);
  });
});
