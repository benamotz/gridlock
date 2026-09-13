import {
  GAMEPLAY,
  type PickupWire,
  type SelfState,
  type WeaponId,
  weaponDef,
} from '@gridlock/shared';

/** One pickup travelling into the player. */
export interface CollectAnim {
  id: string;
  kind: PickupWire['kind'];
  weapon?: WeaponId;
  fromX: number;
  fromY: number;
  born: number;
}

/** How long a predicted grab keeps the pickup hidden while the server confirms. */
const HIDE_MS = 700;
/**
 * After a predicted grab the server never confirmed, how long to wait before
 * predicting that same item again. Without it an item the player could not
 * actually take was "collected" over and over.
 */
const SUPPRESS_MS = 1500;
/** Collection animation duration: flight, then the burst at the player. */
export const COLLECT_ANIM_MS = 460;

/** Inventory slot for a weapon, mirroring the server's class-based rule. */
function slotFor(id: WeaponId): number {
  switch (weaponDef(id).class) {
    case 'melee': return 0;
    case 'sidearm': return 1;
    case 'throwable': return 3;
    default: return 2;
  }
}

/**
 * Predicts pickup collection for the local player.
 *
 * The moment the player's predicted position reaches something they are able
 * to take, the item is hidden and flies into them - no waiting for a snapshot.
 * The rules mirror the server's, so a predicted grab is almost always one the
 * server also grants. On the rare disagreement (another player got there
 * first, or a dropped weapon was still arming) the hide simply expires and the
 * item reappears.
 */
export class CollectionPredictor {
  readonly anims: CollectAnim[] = [];
  private hiddenUntil = new Map<string, number>();
  private confirmed = new Set<string>();
  private suppressedUntil = new Map<string, number>();

  /** Whether the local player could collect this pickup right now. */
  static canCollect(self: SelfState, p: PickupWire): boolean {
    switch (p.kind) {
      case 'health':
        return self.medkits < GAMEPLAY.pouch.maxMedkits || self.hp < GAMEPLAY.player.maxHealth;
      case 'armor':
        return self.armorPlates < GAMEPLAY.pouch.maxArmorPlates ||
          self.armor < GAMEPLAY.player.maxArmor;
      case 'ammo':
        return self.weapons.some((w) => {
          const def = weaponDef(w.id);
          return def.pickupAmmo > 0 && w.reserve < def.reserveMax;
        });
      case 'weapon': {
        if (!p.weapon) return false;
        const slot = slotFor(p.weapon);
        const held = self.weapons[slot];
        // The wire marks an empty non-melee slot with a fists placeholder.
        const empty = !held || (slot !== 0 && held.id === 'fists' && held.ammo === -1);
        if (empty) return true;
        if (held.id === p.weapon) return held.reserve < weaponDef(held.id).reserveMax;
        const spent = held.ammo >= 0 && held.ammo <= 0 && held.reserve <= 0;
        return spent;
      }
    }
  }

  /** Runs each frame: starts a grab for anything in reach that can be taken. */
  update(now: number, self: SelfState, px: number, py: number, pickups: PickupWire[]): void {
    for (const [id, until] of this.hiddenUntil) {
      if (now < until) continue;
      this.hiddenUntil.delete(id);
      if (!this.confirmed.has(id)) this.suppressedUntil.set(id, now + SUPPRESS_MS);
      this.confirmed.delete(id);
    }
    for (const [id, until] of this.suppressedUntil) {
      if (now >= until) this.suppressedUntil.delete(id);
    }
    while (this.anims.length > 0 && now - this.anims[0].born > COLLECT_ANIM_MS) {
      this.anims.shift();
    }

    if (self.life !== 'alive' || self.vehicleId !== null) return;
    // A little inside the server radius, so prediction errs toward agreeing.
    const reach = GAMEPLAY.player.pickupRadius - 4;

    for (const p of pickups) {
      if (this.hiddenUntil.has(p.id) || this.suppressedUntil.has(p.id)) continue;
      const dx = p.x - px;
      const dy = p.y - py;
      if (dx * dx + dy * dy > reach * reach) continue;
      if (!CollectionPredictor.canCollect(self, p)) continue;
      this.start(p.id, p.kind, p.weapon, p.x, p.y, now);
    }
  }

  private start(
    id: string, kind: PickupWire['kind'], weapon: WeaponId | undefined,
    x: number, y: number, now: number,
  ): void {
    this.hiddenUntil.set(id, now + HIDE_MS);
    this.anims.push({ id, kind, weapon, fromX: x, fromY: y, born: now });
    if (this.anims.length > 24) this.anims.shift();
  }

  /**
   * Handles the server's confirmation of our own pickup. Returns true when the
   * grab was already predicted, so the caller does not animate it twice.
   */
  confirm(
    id: string, kind: PickupWire['kind'], weapon: WeaponId | undefined,
    x: number, y: number, now: number,
  ): boolean {
    const predicted = this.anims.some((a) => a.id === id) || this.hiddenUntil.has(id);
    if (!predicted) this.start(id, kind, weapon, x, y, now);
    this.confirmed.add(id);
    this.suppressedUntil.delete(id);
    // Keep it hidden until the next snapshot drops it from the list.
    this.hiddenUntil.set(id, now + HIDE_MS);
    return predicted;
  }

  isHidden(id: string): boolean {
    return this.hiddenUntil.has(id);
  }
}
