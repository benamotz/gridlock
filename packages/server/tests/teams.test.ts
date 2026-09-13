import { describe, expect, it } from 'vitest';
import { balanceTeams, botsNeeded, pickTeamForJoin, teamSizes, type Balanceable } from '../src/teams.js';

const member = (
  playerId: string, team: number, isBot = false, pinned = false,
): Balanceable => ({ playerId, team, isBot, pinned });

describe('team balancing', () => {
  it('sends a joining player to the emptiest team', () => {
    const members = [member('a', 0), member('b', 0), member('c', 1)];
    expect(pickTeamForJoin(members, 2)).toBe(1);
  });

  it('counts humans before bots when placing a joiner', () => {
    // Team 1 has more members, but they are all bots - a human belongs there.
    const members = [member('a', 0), member('b1', 1, true), member('b2', 1, true)];
    expect(pickTeamForJoin(members, 2)).toBe(1);
  });

  it('evens out lopsided teams', () => {
    const members = [
      member('a', 0), member('b', 0), member('c', 0), member('d', 0), member('e', 1),
    ];
    balanceTeams(members, 2);
    const sizes = teamSizes(members, 2);
    expect(Math.abs(sizes[0] - sizes[1])).toBeLessThanOrEqual(1);
  });

  it('moves bots before humans when rebalancing', () => {
    const members = [
      member('h1', 0), member('h2', 0), member('bot', 0, true), member('h3', 1),
    ];
    balanceTeams(members, 2);
    expect(members.find((m) => m.playerId === 'bot')!.team).toBe(1);
    expect(members.find((m) => m.playerId === 'h1')!.team).toBe(0);
  });

  it('moves unpinned humans before pinned ones', () => {
    const members = [
      member('pinned', 0, false, true),
      member('loose', 0, false, false),
      member('also', 0, false, true),
      member('other', 1),
    ];
    balanceTeams(members, 2);
    expect(members.find((m) => m.playerId === 'loose')!.team).toBe(1);
    expect(members.find((m) => m.playerId === 'pinned')!.team).toBe(0);
  });

  it('assigns anyone who has no team yet', () => {
    const members = [member('a', -1), member('b', -1), member('c', -1), member('d', -1)];
    balanceTeams(members, 2);
    expect(members.every((m) => m.team === 0 || m.team === 1)).toBe(true);
    expect(teamSizes(members, 2)).toEqual([2, 2]);
  });

  it('spreads players across four teams', () => {
    const members = Array.from({ length: 12 }, (_, i) => member(`p${i}`, -1));
    balanceTeams(members, 4);
    expect(teamSizes(members, 4)).toEqual([3, 3, 3, 3]);
  });

  it('reports how many bots each team still needs', () => {
    const members = [member('a', 0), member('b', 0), member('c', 1)];
    expect(botsNeeded(members, 2, 4)).toEqual([2, 3]);
  });
});
