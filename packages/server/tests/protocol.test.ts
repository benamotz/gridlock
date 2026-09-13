import { describe, expect, it } from 'vitest';
import { Btn, GAMEPLAY, parseClientMessage, sanitizeConfig } from '@gridlock/shared';
import { sanitizeName, filterChat } from '../src/names.js';
import { normalizeRoomCode, generateRoomCode } from '../src/rooms/roomCode.js';
import { RateLimiter } from '../src/net/rateLimit.js';

describe('inbound message validation', () => {
  it('rejects anything that is not a known message', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('hello')).toBeNull();
    expect(parseClientMessage({})).toBeNull();
    expect(parseClientMessage({ t: 'not_a_real_message' })).toBeNull();
    expect(parseClientMessage({ t: 'input' })).toBeNull();
    expect(parseClientMessage({ t: 'input', cmds: [] })).toBeNull();
  });

  it('clamps an input command that claims an impossible timestep', () => {
    const msg = parseClientMessage({
      t: 'input',
      cmds: [{ seq: 1, dtMs: 100000, buttons: Btn.Up, aim: 0, slot: -1 }],
    });
    expect(msg?.t).toBe('input');
    if (msg?.t !== 'input') throw new Error('unreachable');
    // Parsing caps it, and the simulation caps it again before use.
    expect(msg.cmds[0].dtMs).toBeLessThanOrEqual(100);
  });

  it('sanitises NaN, Infinity and out-of-range input fields', () => {
    const msg = parseClientMessage({
      t: 'input',
      cmds: [{ seq: NaN, dtMs: Infinity, buttons: -99999, aim: NaN, slot: 99 }],
    });
    if (msg?.t !== 'input') throw new Error('expected input');
    const cmd = msg.cmds[0];
    expect(Number.isFinite(cmd.seq)).toBe(true);
    expect(Number.isFinite(cmd.dtMs)).toBe(true);
    expect(Number.isFinite(cmd.aim)).toBe(true);
    expect(cmd.buttons).toBeGreaterThanOrEqual(0);
    expect(cmd.slot).toBeLessThanOrEqual(3);
  });

  it('caps how many commands one packet may carry', () => {
    const cmds = Array.from({ length: 500 }, (_, i) => ({
      seq: i, dtMs: 16, buttons: 0, aim: 0, slot: -1,
    }));
    const msg = parseClientMessage({ t: 'input', cmds });
    if (msg?.t !== 'input') throw new Error('expected input');
    expect(msg.cmds.length).toBeLessThanOrEqual(20);
  });

  it('never trusts a client-supplied score, health or ammunition', () => {
    // These fields simply do not exist in the client protocol; a message
    // carrying them is parsed without them ever reaching the simulation.
    const msg = parseClientMessage({
      t: 'set_ready', ready: true, hp: 9999, score: 9999, ammo: 9999,
    }) as Record<string, unknown> | null;
    expect(msg).toEqual({ t: 'set_ready', ready: true });
  });

  it('clamps a hostile room configuration into legal ranges', () => {
    const cfg = sanitizeConfig({
      teamCount: 99, teamSize: -5, scoreTarget: 1e9,
      matchDurationSec: 0, mode: 'wat', loadoutRule: 'god-mode',
      mapId: 'x'.repeat(500),
    });
    expect(cfg.teamCount).toBeLessThanOrEqual(4);
    expect(cfg.teamSize).toBeGreaterThanOrEqual(1);
    expect(cfg.scoreTarget).toBeLessThanOrEqual(200);
    expect(cfg.matchDurationSec).toBeGreaterThanOrEqual(60);
    expect(cfg.mode).toBeUndefined();
    expect(cfg.loadoutRule).toBeUndefined();
    expect(cfg.mapId!.length).toBeLessThanOrEqual(40);
  });
});

describe('display names and chat', () => {
  it('trims names to the configured maximum', () => {
    const { name } = sanitizeName('x'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(GAMEPLAY.net.maxNameLength);
  });

  it('strips invisible characters used to spoof or break layout', () => {
    const { name } = sanitizeName('Bad​Name‮');
    expect(name).toBe('BadName');
  });

  it('replaces impersonation-prone reserved names', () => {
    const { name } = sanitizeName('admin');
    expect(name.toLowerCase()).not.toBe('admin');
  });

  it('substitutes a generated name for an empty one', () => {
    const { name } = sanitizeName('   ');
    expect(name.length).toBeGreaterThan(1);
  });

  it('masks profanity in chat and caps its length', () => {
    expect(filterChat('what the fuck')).toBe('what the ****');
    expect(filterChat('a'.repeat(500)).length).toBe(160);
  });
});

describe('room codes', () => {
  it('generates unique, unambiguous codes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = generateRoomCode((c) => seen.has(c));
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('normalises user-typed codes', () => {
    expect(normalizeRoomCode(' ab-cd e ')).toBe('ABCDE');
    expect(normalizeRoomCode('abcdefghij')).toHaveLength(5);
  });
});

describe('rate limiting', () => {
  it('allows a normal burst and then throttles', () => {
    const limiter = new RateLimiter(10, 10);
    let allowed = 0;
    for (let i = 0; i < 50; i++) if (limiter.allow()) allowed++;
    expect(allowed).toBe(10);
  });
});
