import type { Corner, Point } from './roadNet.js';

/**
 * Per-resident decision state. A brain turns what a resident wants into the
 * same `InputCommand` a human would send, so residents obey every rule of the
 * simulation without special cases.
 */
export interface BrainBase {
  id: string;
  /** Input sequence, carried across role changes so commands stay ordered. */
  seq: number;
  lastX: number;
  lastY: number;
  stuckMs: number;
  /** Cached waypoint from `CityDirector.route`, refreshed a few times a second. */
  routeX?: number;
  routeY?: number;
  routeAt?: number;
  /** A wedged driver backs out, wheel turned, until this sim time. */
  unstickUntil?: number;
  unstickSteer?: number;
}

/** Walks the kerbs corner to corner; runs from trouble. */
export interface WalkState {
  corner: Corner;
  prevNode: number;
  panicUntil: number;
  threatX: number;
  threatY: number;
}

/** Follows right-hand lanes from intersection to intersection. */
export interface LaneState {
  from: number;
  to: number;
  blockedMs: number;
  pushThroughUntil: number;
}

export interface PedBrain extends BrainBase, WalkState {
  kind: 'ped';
  /** A fugitive on a bounty job: shoots back at the hunter instead of only running. */
  armed?: boolean;
  toggle?: boolean;
}

export interface DriverBrain extends BrainBase, LaneState {
  kind: 'driver';
  vehicleId: number;
}

export interface CopBrain extends BrainBase, WalkState, LaneState {
  kind: 'cop';
  targetId: string | null;
  /**
   * Sent after a suspect (and so leaves once nobody is wanted), as opposed to
   * a patrol crew that goes back to its rounds.
   */
  dispatched: boolean;
  /** Sim time the officer last had nobody to chase, 0 while chasing. */
  idleSince: number;
  /** Alternates trigger and door presses, which are edge-triggered. */
  toggle: boolean;
  /** While set, an officer who is stuck sidesteps in this direction. */
  jinkUntil: number;
  jinkAngle: number;
  /** Where this officer is searching after losing the suspect. */
  searchX: number;
  searchY: number;
  searchSet: boolean;
  /** The last-known position the current search is centred on. */
  searchAnchorX: number;
  searchAnchorY: number;
  /** Road-block officers hold this spot until they see the suspect. */
  post: Point | null;
}

/** An armed crew member set against one player by a job. */
export interface CrewBrain extends BrainBase, WalkState {
  kind: 'crew';
  groupId: number;
  targetId: string | null;
  /** Where this member stands guard (a hideout post, or their seat). */
  postX: number;
  postY: number;
  /** Where the target was last seen, and when. */
  seenX: number;
  seenY: number;
  seenAt: number;
  /** No shooting before this: the moment between spotting someone and firing. */
  reactAt: number;
  /** Automatic weapons fire in bursts. */
  burstUntil: number;
  restUntil: number;
  toggle: boolean;
}

export type Brain = PedBrain | DriverBrain | CopBrain | CrewBrain;

export interface Command {
  buttons: number;
  aim: number;
  ax?: number;
  ay?: number;
}

/** A command that heads for `target` at `pace` (0-1). */
export function towards(
  from: Point, target: Point, pace: number, buttons: number, aim?: number,
): Command {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return { buttons, aim: aim ?? 0 };
  return {
    buttons,
    aim: aim ?? Math.atan2(dy, dx),
    ax: (dx / len) * pace,
    ay: (dy / len) * pace,
  };
}

export function pickWeighted<T>(items: [T, number][], rng: () => number): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [item, w] of items) {
    roll -= w;
    if (roll <= 0) return item;
  }
  return items[items.length - 1][0];
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function randomBetween(range: readonly [number, number], rng: () => number): number {
  return Math.round(range[0] + rng() * (range[1] - range[0]));
}
