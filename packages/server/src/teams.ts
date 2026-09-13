import { NO_TEAM } from '@gridlock/shared';

export interface Balanceable {
  playerId: string;
  team: number;
  isBot: boolean;
  /** True when the player explicitly picked this team in the lobby. */
  pinned: boolean;
}

/**
 * Assigns a team to a single joining member: the smallest team, counting humans
 * before bots so a human never lands on a team that a bot could vacate.
 */
export function pickTeamForJoin(members: Balanceable[], teamCount: number): number {
  const counts = teamSizes(members, teamCount);
  const humanCounts = teamSizes(members.filter((m) => !m.isBot), teamCount);
  let best = 0;
  for (let t = 1; t < teamCount; t++) {
    if (
      humanCounts[t] < humanCounts[best] ||
      (humanCounts[t] === humanCounts[best] && counts[t] < counts[best])
    ) {
      best = t;
    }
  }
  return best;
}

export function teamSizes(members: Balanceable[], teamCount: number): number[] {
  const counts = new Array<number>(teamCount).fill(0);
  for (const m of members) {
    if (m.team >= 0 && m.team < teamCount) counts[m.team]++;
  }
  return counts;
}

/**
 * Rebalances teams so no two differ by more than one member.
 *
 * Bots are moved before humans, and unpinned humans before pinned ones, so
 * automatic balancing disturbs a player's explicit lobby choice last.
 * Mutates and returns `members`.
 */
export function balanceTeams(members: Balanceable[], teamCount: number): Balanceable[] {
  if (teamCount < 2) {
    for (const m of members) m.team = NO_TEAM;
    return members;
  }

  // Anyone unassigned goes to the smallest team first.
  for (const m of members) {
    if (m.team < 0 || m.team >= teamCount) m.team = pickTeamForJoin(members, teamCount);
  }

  // Move-cost ordering: bots are cheapest to shuffle, pinned humans dearest.
  const cost = (m: Balanceable) => (m.isBot ? 0 : m.pinned ? 2 : 1);

  for (let guard = 0; guard < members.length * teamCount + 8; guard++) {
    const counts = teamSizes(members, teamCount);
    let big = 0;
    let small = 0;
    for (let t = 1; t < teamCount; t++) {
      if (counts[t] > counts[big]) big = t;
      if (counts[t] < counts[small]) small = t;
    }
    if (counts[big] - counts[small] <= 1) break;

    const movable = members
      .filter((m) => m.team === big)
      .sort((a, b) => cost(a) - cost(b))[0];
    if (!movable) break;
    movable.team = small;
    // A forced move invalidates the player's pin - they were rebalanced.
    movable.pinned = false;
  }

  return members;
}

/** How many bots to add so every team reaches `teamSize`. */
export function botsNeeded(
  members: Balanceable[],
  teamCount: number,
  teamSize: number,
): number[] {
  const counts = teamSizes(members, teamCount);
  return counts.map((c) => Math.max(0, teamSize - c));
}
