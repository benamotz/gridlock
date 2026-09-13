import {
  type BotDifficulty,
  Btn,
  GAMEPLAY,
  type InputCommand,
  angleDelta,
  dist,
  weaponDef,
} from '@gridlock/shared';
import type { PickupEntity, PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';
import { SLOT_PRIMARY } from '../sim/loadout.js';

interface DifficultyProfile {
  /** Seconds before a newly spotted enemy is engaged. */
  reactionSec: number;
  /** Standard deviation of aim error in radians at medium range. */
  aimError: number;
  /** How fast the bot's aim converges on its target, in radians/sec. */
  turnRate: number;
  /** How far the bot can notice an enemy. */
  awareness: number;
  /** Seconds between high-level decisions. */
  decisionSec: number;
  /** Chance per decision to keep pushing rather than take cover. */
  aggression: number;
}

const PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: { reactionSec: 0.65, aimError: 0.16, turnRate: 3.2, awareness: 620, decisionSec: 0.9, aggression: 0.45 },
  normal: { reactionSec: 0.32, aimError: 0.075, turnRate: 6.0, awareness: 900, decisionSec: 0.55, aggression: 0.7 },
  hard: { reactionSec: 0.14, aimError: 0.032, turnRate: 10.0, awareness: 1250, decisionSec: 0.32, aggression: 0.9 },
};

type Goal =
  | { kind: 'fight'; targetId: string }
  | { kind: 'gear'; pickupId: string }
  | { kind: 'heal'; pickupId: string }
  | { kind: 'roam'; x: number; y: number };

/**
 * Server-side bot.
 *
 * Bots are ordinary players: they produce `InputCommand`s and the world
 * validates them exactly as it does a human's. Nothing here can set health,
 * ammunition or position directly, which means a bot cannot do anything a
 * human client could not also do.
 */
export class BotController {
  private goal: Goal = { kind: 'roam', x: 0, y: 0 };
  private nextDecisionAt = 0;
  private seenTargetAt = 0;
  private aim = 0;
  private seq = 1;
  private strafeDir = 1;
  private nextStrafeFlipAt = 0;
  private stuckSince = 0;
  private lastX = 0;
  private lastY = 0;
  private unstickUntil = 0;
  private unstickAngle = 0;
  private nextJumpRollAt = 0;
  private nextPouchAt = 0;

  constructor(
    readonly playerId: string,
    private readonly profile: DifficultyProfile,
    private readonly rng: () => number,
  ) {}

  static forDifficulty(
    playerId: string,
    difficulty: BotDifficulty,
    rng: () => number,
  ): BotController {
    return new BotController(playerId, PROFILES[difficulty], rng);
  }

  /** Produces this tick's input command, or null when the bot cannot act. */
  think(world: World, dtMs: number): InputCommand | null {
    const me = world.players.get(this.playerId);
    if (!me || me.life !== 'alive') return null;

    const dt = dtMs / 1000;
    if (world.now >= this.nextDecisionAt) {
      this.decide(world, me);
      this.nextDecisionAt = world.now + this.profile.decisionSec * 1000 * (0.7 + this.rng() * 0.6);
    }

    this.detectStuck(world, me, dt);

    let buttons = 0;
    let desiredAim = this.aim;
    let slot = -1;

    const target = this.goal.kind === 'fight'
      ? world.players.get(this.goal.targetId) ?? null
      : null;

    // --- aiming ---------------------------------------------------------
    if (target && target.life === 'alive') {
      // Lead the shot slightly so moving targets are not automatically missed.
      const lead = 0.12;
      const tx = target.x + target.vx * lead;
      const ty = target.y + target.vy * lead;
      desiredAim = Math.atan2(ty - me.y, tx - me.x);
    } else if (this.goal.kind !== 'fight') {
      const g = this.goalPoint(world);
      if (g) desiredAim = Math.atan2(g.y - me.y, g.x - me.x);
    }

    // Converging at a finite rate is what makes low difficulties beatable.
    const delta = angleDelta(this.aim, desiredAim);
    const maxTurn = this.profile.turnRate * dt;
    this.aim += Math.max(-maxTurn, Math.min(maxTurn, delta));

    // --- movement -------------------------------------------------------
    let moveAngle: number | null = null;

    if (world.now < this.unstickUntil) {
      moveAngle = this.unstickAngle;
    } else if (target && target.life === 'alive') {
      const d = dist(me.x, me.y, target.x, target.y);
      const toTarget = Math.atan2(target.y - me.y, target.x - me.x);
      const def = weaponDef(world.currentWeaponId(me));
      const preferred = def.falloffStart * 0.7;

      if (world.now >= this.nextStrafeFlipAt) {
        this.strafeDir = this.rng() < 0.5 ? 1 : -1;
        this.nextStrafeFlipAt = world.now + 700 + this.rng() * 900;
      }
      if (d > preferred * 1.25) moveAngle = toTarget;
      else if (d < preferred * 0.45) moveAngle = toTarget + Math.PI;
      else moveAngle = toTarget + (Math.PI / 2) * this.strafeDir;

      if (me.hp < 40 && this.rng() > this.profile.aggression) {
        moveAngle = toTarget + Math.PI;
      }
    } else {
      const g = this.goalPoint(world);
      if (g) {
        moveAngle = Math.atan2(g.y - me.y, g.x - me.x);
        if (dist(me.x, me.y, g.x, g.y) < 40) this.nextDecisionAt = 0;
      }
    }

    if (moveAngle !== null) {
      moveAngle = this.avoidWalls(world, me, moveAngle);
      buttons |= this.buttonsForAngle(moveAngle);
      // Sprint when travelling, not while trading shots.
      if (!target && me.stamina > 30) buttons |= Btn.Sprint;
    }

    // --- weapon handling ------------------------------------------------
    const held = me.slots[me.slot];
    if (!held || (held.ammo <= 0 && held.reserve <= 0)) {
      const better = me.slots.findIndex((s) => s && (s.ammo > 0 || s.reserve > 0));
      if (better >= 0 && better !== me.slot) slot = better;
    } else if (me.slots[SLOT_PRIMARY] && me.slot !== SLOT_PRIMARY) {
      const primary = me.slots[SLOT_PRIMARY]!;
      if (primary.ammo > 0 || primary.reserve > 0) slot = SLOT_PRIMARY;
    }
    if (held && held.ammo <= 0 && held.reserve > 0) buttons |= Btn.Reload;

    // Always press interact/swap opportunistically - the server decides whether
    // anything actually happens, so this cannot become a bot-only capability.
    if (me.prompt) buttons |= Btn.Swap;

    // --- evasion and self-care --------------------------------------------
    // Under fire, sometimes jump - the same dodge a human has, with the same
    // stamina cost and cooldown enforced by the server.
    let lastHitAt = 0;
    for (const rec of me.damageTakenFrom.values()) lastHitAt = Math.max(lastHitAt, rec.at);
    if (world.now - lastHitAt < 300 && world.now >= this.nextJumpRollAt) {
      this.nextJumpRollAt = world.now + 900;
      if (this.rng() < this.profile.aggression * 0.45) buttons |= Btn.Jump;
    }
    if (world.now >= this.nextPouchAt) {
      if (me.hp < 45 && me.medkits > 0) {
        buttons |= Btn.UseMedkit;
        this.nextPouchAt = world.now + 1200;
      } else if (me.armor < 25 && me.armorPlates > 0) {
        buttons |= Btn.UseArmor;
        this.nextPouchAt = world.now + 1200;
      }
    }

    // --- firing ---------------------------------------------------------
    if (target && target.life === 'alive' && held && held.ammo > 0) {
      const d = dist(me.x, me.y, target.x, target.y);
      const def = weaponDef(held.id);
      const reacted = world.now - this.seenTargetAt >= this.profile.reactionSec * 1000;
      const onTarget = Math.abs(angleDelta(this.aim, desiredAim)) < 0.12;
      const visible = world.grid.lineOfSight(me.x, me.y, target.x, target.y);
      if (reacted && onTarget && visible && d < def.range * 0.9) {
        buttons |= Btn.Fire;
        // Aim error is applied at the trigger, so bots miss the way humans do.
        const errorScale = 1 + d / 900;
        this.aim += (this.rng() * 2 - 1) * this.profile.aimError * errorScale;
      }
    }

    return {
      seq: this.seq++,
      dtMs,
      buttons,
      aim: this.aim,
      slot,
    };
  }

  // -------------------------------------------------------------------------

  private decide(world: World, me: PlayerEntity): void {
    // 1. Badly hurt and a medkit is nearby - go and heal.
    if (me.hp < 55) {
      const medkit = this.nearestPickup(world, me, (p) => p.kind === 'health');
      if (medkit && dist(me.x, me.y, medkit.x, medkit.y) < 900) {
        this.goal = { kind: 'heal', pickupId: medkit.id };
        return;
      }
    }

    // 2. An enemy in sight always outranks errands.
    const enemy = this.findEnemy(world, me);
    if (enemy) {
      if (this.goal.kind !== 'fight' || this.goal.targetId !== enemy.id) {
        this.seenTargetAt = world.now;
      }
      this.goal = { kind: 'fight', targetId: enemy.id };
      return;
    }

    // 3. No real weapon - find one.
    const primary = me.slots[SLOT_PRIMARY];
    if (!primary || (primary.ammo <= 0 && primary.reserve <= 0)) {
      const gun = this.nearestPickup(
        world, me, (p) => p.kind === 'weapon' || p.kind === 'ammo',
      );
      if (gun && dist(me.x, me.y, gun.x, gun.y) < 1400) {
        this.goal = { kind: 'gear', pickupId: gun.id };
        return;
      }
    }

    // 4. Otherwise roam toward a random point, biased to the map centre where
    //    the contested pickups are.
    const m = world.mapDef;
    const cx = m.width / 2;
    const cy = m.height / 2;
    this.goal = {
      kind: 'roam',
      x: cx + (this.rng() * 2 - 1) * m.width * 0.38,
      y: cy + (this.rng() * 2 - 1) * m.height * 0.38,
    };
  }

  private goalPoint(world: World): { x: number; y: number } | null {
    if (this.goal.kind === 'roam') return { x: this.goal.x, y: this.goal.y };
    if (this.goal.kind === 'gear' || this.goal.kind === 'heal') {
      const p = world.pickups.get(this.goal.pickupId);
      if (!p || !p.active) {
        this.nextDecisionAt = 0;
        return null;
      }
      return { x: p.x, y: p.y };
    }
    return null;
  }

  private findEnemy(world: World, me: PlayerEntity): PlayerEntity | null {
    let best: PlayerEntity | null = null;
    let bestD = this.profile.awareness;
    for (const p of world.players.values()) {
      if (p.id === me.id || p.life !== 'alive') continue;
      if (p.team === me.team && me.team >= 0) continue;
      if (world.isProtected(p)) continue;
      const d = dist(me.x, me.y, p.x, p.y);
      if (d > bestD) continue;
      if (!world.grid.lineOfSight(me.x, me.y, p.x, p.y)) continue;
      best = p;
      bestD = d;
    }
    return best;
  }

  private nearestPickup(
    world: World,
    me: PlayerEntity,
    filter: (p: PickupEntity) => boolean,
  ): PickupEntity | null {
    let best: PickupEntity | null = null;
    let bestD = Infinity;
    for (const p of world.pickups.values()) {
      if (!p.active || !filter(p)) continue;
      const d = dist(me.x, me.y, p.x, p.y);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * Cheap obstacle avoidance: cast three whiskers and steer toward whichever
   * is clearest. Good enough for a city grid without a navmesh, and it degrades
   * gracefully into the stuck-detection below when it is not.
   */
  private avoidWalls(world: World, me: PlayerEntity, angle: number): number {
    const probe = 110;
    const clear = (a: number): number => {
      const t = world.grid.raycast(
        me.x, me.y, me.x + Math.cos(a) * probe, me.y + Math.sin(a) * probe,
      );
      return t;
    };
    const straight = clear(angle);
    if (straight > 0.92) return angle;

    let bestAngle = angle;
    let bestClear = straight;
    for (const off of [0.5, -0.5, 0.95, -0.95, 1.5, -1.5]) {
      const c = clear(angle + off);
      if (c > bestClear) {
        bestClear = c;
        bestAngle = angle + off;
      }
    }
    return bestAngle;
  }

  private detectStuck(world: World, me: PlayerEntity, dt: number): void {
    const moved = dist(me.x, me.y, this.lastX, this.lastY);
    this.lastX = me.x;
    this.lastY = me.y;
    if (moved < 4 * dt * 60 * 0.05) {
      this.stuckSince += dt;
      if (this.stuckSince > 1.2 && world.now >= this.unstickUntil) {
        this.unstickAngle = this.rng() * Math.PI * 2;
        this.unstickUntil = world.now + 600;
        this.stuckSince = 0;
        this.nextDecisionAt = 0;
      }
    } else {
      this.stuckSince = 0;
    }
  }

  /** Converts a world-space heading into WASD button bits. */
  private buttonsForAngle(angle: number): number {
    let b = 0;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    const threshold = 0.38;
    if (cx > threshold) b |= Btn.Right;
    if (cx < -threshold) b |= Btn.Left;
    if (cy > threshold) b |= Btn.Down;
    if (cy < -threshold) b |= Btn.Up;
    return b;
  }
}

export const botProfile = (d: BotDifficulty): DifficultyProfile => PROFILES[d];
export { GAMEPLAY };
