import { randomInt } from 'node:crypto';
import { CREW_CODE_LENGTH, type CrewWire, GAMEPLAY } from '@gridlock/shared';
import type { PlayerEntity } from '../sim/entities.js';
import type { World } from '../sim/World.js';

const CREW = GAMEPLAY.freeRoam.playerCrew;
/** Same alphabet as room codes: no I, O, 0 or 1, so a code reads aloud cleanly. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type CrewJoinResult = 'ok' | 'full' | 'gone';

/**
 * Player crews in the city: 2-4 friends who cannot hurt each other, share one
 * job and its pay, and share the police's attention.
 *
 * A crew exists only while the city does - nothing is saved. Its code goes in
 * the invite link; the code is drawn from a CSPRNG so crews cannot be guessed
 * and joined by strangers. (Not to be confused with `npc/crews.ts`, the armed
 * gangs the city sets against players.)
 */
export class PlayerCrews {
  /** Crew code -> member ids, the founder first. */
  private readonly crews = new Map<string, string[]>();
  private readonly byPlayer = new Map<string, string>();
  /** Names kept for the "left your crew" notice, sent after they are gone. */
  private readonly names = new Map<string, string>();

  constructor(private readonly world: World) {}

  /** Starts a crew with `p` in it (or returns the one they are already in). */
  create(p: PlayerEntity): string {
    const existing = this.byPlayer.get(p.id);
    if (existing) return existing;
    const code = this.newCode();
    this.crews.set(code, [p.id]);
    this.byPlayer.set(p.id, code);
    this.names.set(p.id, p.name);
    return code;
  }

  /** Joins `p` to the crew with this code, leaving any crew they were in. */
  join(p: PlayerEntity, code: string): CrewJoinResult {
    const members = this.crews.get(code);
    if (!members) return 'gone';
    if (members.includes(p.id)) return 'ok';
    if (members.length >= CREW.maxSize) return 'full';
    this.leave(p);
    members.push(p.id);
    this.byPlayer.set(p.id, code);
    this.names.set(p.id, p.name);
    for (const mate of this.mates(p)) this.notice(mate, `${p.name} joined your crew`);
    return 'ok';
  }

  leave(p: PlayerEntity): void {
    this.remove(p.id);
  }

  codeOf(id: string): string | null {
    return this.byPlayer.get(id) ?? null;
  }

  /** Member ids of `id`'s crew, including `id`; empty when not in one. */
  memberIds(id: string): string[] {
    const code = this.byPlayer.get(id);
    return code ? [...(this.crews.get(code) ?? [])] : [];
  }

  /** Member ids of the crew with this code; empty if it is gone. */
  membersOf(code: string | null): string[] {
    return code ? [...(this.crews.get(code) ?? [])] : [];
  }

  /** The other members of `p`'s crew who are in the world. */
  mates(p: PlayerEntity): PlayerEntity[] {
    const out: PlayerEntity[] = [];
    for (const id of this.memberIds(p.id)) {
      if (id === p.id) continue;
      const mate = this.world.players.get(id);
      if (mate) out.push(mate);
    }
    return out;
  }

  same(a: PlayerEntity, b: PlayerEntity): boolean {
    if (a.npc || b.npc || a.id === b.id) return false;
    const code = this.byPlayer.get(a.id);
    return code !== undefined && code === this.byPlayer.get(b.id);
  }

  /** Drops members who have left the city; an empty crew disappears. */
  step(): void {
    for (const id of [...this.byPlayer.keys()]) {
      if (!this.world.players.has(id)) this.remove(id);
    }
  }

  wire(p: PlayerEntity): CrewWire | null {
    const code = this.byPlayer.get(p.id);
    if (!code) return null;
    const members = (this.crews.get(code) ?? []).flatMap((id) => {
      const m = this.world.players.get(id);
      return m ? [{ id: m.id, name: m.name, alive: m.life === 'alive' }] : [];
    });
    return { code, members };
  }

  /**
   * Moves a player who just arrived by a crew link next to a crewmate, so a
   * friend's link means playing together straight away. Prefers a living
   * member; a mate in a car gets you beside the car.
   */
  placeNear(p: PlayerEntity): boolean {
    const mate = this.mates(p).find((m) => m.life === 'alive');
    if (!mate) return false;
    const world = this.world;
    const r = GAMEPLAY.player.radius;
    const start = world.rng() * Math.PI * 2;
    for (const dist of [CREW.joinDistance, CREW.joinDistance * 0.6, CREW.joinDistance * 1.6]) {
      for (let i = 0; i < 12; i++) {
        const a = start + (i / 12) * Math.PI * 2;
        const x = mate.x + Math.cos(a) * dist;
        const y = mate.y + Math.sin(a) * dist;
        if (world.grid.circleBlocked(x, y, r + 4)) continue;
        if (!world.grid.lineOfSight(mate.x, mate.y, x, y)) continue;
        p.x = x;
        p.y = y;
        p.vx = 0;
        p.vy = 0;
        return true;
      }
    }
    return false;
  }

  private remove(id: string): void {
    const code = this.byPlayer.get(id);
    if (!code) return;
    this.byPlayer.delete(id);
    const who = this.names.get(id) ?? 'Someone';
    this.names.delete(id);
    const members = (this.crews.get(code) ?? []).filter((m) => m !== id);
    if (members.length === 0) {
      this.crews.delete(code);
      return;
    }
    this.crews.set(code, members);
    for (const mid of members) {
      const mate = this.world.players.get(mid);
      if (mate) this.notice(mate, `${who} left your crew`);
    }
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < CREW_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
      if (!this.crews.has(code)) return code;
    }
    throw new Error('Unable to allocate a crew code');
  }

  private notice(p: PlayerEntity, text: string): void {
    this.world.emit({ e: 'notice', by: p.id, text });
  }
}
