import { describe, expect, it } from 'vitest';
import { EXTRAPOLATE_MAX_MS, SnapshotClock, interpAlpha } from '../src/game/snapshotClock.js';

const INTERVAL = 1000 / 15;

describe('adaptive interpolation delay', () => {
  it('stays at the base delay on a steady connection', () => {
    const clock = new SnapshotClock(120, INTERVAL);
    for (let i = 0; i < 60; i++) clock.arrive(i * INTERVAL, 5000 + i * INTERVAL + 10);
    expect(clock.delayMs).toBe(120);
  });

  // Regression: phone Wi-Fi delivered snapshots in bursts after ~200 ms naps.
  // The fixed 120 ms delay ran dry and everyone froze, then jumped.
  it('grows to cover bursty arrival, so the buffer never runs dry', () => {
    const clock = new SnapshotClock(120, INTERVAL);
    for (let i = 0; i < 60; i++) {
      // Every fourth snapshot is held back 200 ms and arrives with the next ones.
      const late = i % 4 === 0 ? 200 : 0;
      clock.arrive(i * INTERVAL, 5000 + i * INTERVAL + late);
    }
    expect(clock.delayMs).toBeGreaterThanOrEqual(INTERVAL + 200);
  });

  it('settles back down once the bursts stop', () => {
    const clock = new SnapshotClock(120, INTERVAL, 350, 60);
    clock.arrive(0, 5000 + 300);
    for (let i = 1; i <= 60; i++) clock.arrive(i * INTERVAL, 5000 + i * INTERVAL);
    expect(clock.delayMs).toBe(120);
  });

  it('never exceeds the cap on a terrible link', () => {
    const clock = new SnapshotClock(120, INTERVAL, 350);
    clock.arrive(0, 5000);
    clock.arrive(INTERVAL, 5000 + INTERVAL + 2000);
    expect(clock.delayMs).toBe(350);
  });
});

describe('interpolation fraction', () => {
  it('runs from 0 to 1 between the two snapshots', () => {
    expect(interpAlpha(0, 100, 0)).toBe(0);
    expect(interpAlpha(0, 100, 50)).toBeCloseTo(0.5);
    expect(interpAlpha(0, 100, 100)).toBe(1);
  });

  it('carries motion a little past the newest snapshot instead of freezing', () => {
    expect(interpAlpha(0, 100, 150)).toBeCloseTo(1.5);
    expect(interpAlpha(0, 100, 10_000)).toBeCloseTo(1 + EXTRAPOLATE_MAX_MS / 100);
  });
});
