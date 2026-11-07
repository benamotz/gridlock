import type { PlayerWire } from '@gridlock/shared';

/**
 * Who a touch tap may auto-target. Kept pure so the rules can be tested.
 *
 * A tap must never turn into a crime the player did not choose: auto-targeting
 * only ever picks threats. Anyone else - a pedestrian, a bystander, a player
 * who is not wanted - can still be shot, but only by aiming manually (a drag).
 */
export interface TargetContext {
  selfId: string | null;
  selfX: number;
  selfY: number;
  selfTeam: number;
  /** The viewer's own wanted stars: police only count as threats when hunting you. */
  selfWanted: number;
  freeRoam: boolean;
  players: PlayerWire[];
  /** Players (by id) who hurt the viewer, and when (ms, performance clock). */
  hurtBy: Map<string, number>;
  now: number;
  /** Weapon range: nothing further away is picked. */
  range: number;
  /** The direction the player faces; targets ahead are preferred. */
  facing: number;
  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean;
}

/** How long someone who shot you stays a fair auto-target. */
export const HURT_MEMORY_MS = 10_000;
/** Targets within this angle of facing count as "ahead". */
const AHEAD_CONE = Math.PI * 0.4;

export function isThreat(p: PlayerWire, ctx: TargetContext): boolean {
  if (p.life !== 'alive' || p.id === ctx.selfId) return false;
  // Your own crew is never a target, whatever their wanted level.
  if (p.crewmate) return false;
  if (!ctx.freeRoam) {
    // Team modes: every enemy, never a teammate.
    return ctx.selfTeam < 0 || p.team !== ctx.selfTeam;
  }
  switch (p.npc) {
    case 'thug':
      return p.marked === true;
    case 'cop':
      return ctx.selfWanted > 0;
    case 'ped':
      // Only a resident who is your job target.
      return p.marked === true;
    default: {
      const hurt = ctx.hurtBy.get(p.id);
      const recentlyHurtMe = hurt !== undefined && ctx.now - hurt < HURT_MEMORY_MS;
      return p.wanted > 0 || recentlyHurtMe;
    }
  }
}

function angleOff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/**
 * The best threat to fire at: in range and in sight, preferring targets ahead
 * and close. A target that is already locked is kept while it stays valid, so
 * holding the stick does not flick between two enemies.
 */
export function pickTarget(ctx: TargetContext, lockedId: string | null = null): PlayerWire | null {
  let best: PlayerWire | null = null;
  let bestScore = Infinity;
  for (const p of ctx.players) {
    if (!isThreat(p, ctx)) continue;
    const dx = p.x - ctx.selfX;
    const dy = p.y - ctx.selfY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1 || dist > ctx.range) continue;
    if (!ctx.lineOfSight(ctx.selfX, ctx.selfY, p.x, p.y)) continue;
    if (p.id === lockedId) return p;
    const off = angleOff(ctx.facing, Math.atan2(dy, dx));
    // Behind the player still counts, but anything ahead wins.
    const score = dist + off * 180 + (off > AHEAD_CONE ? 600 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}
