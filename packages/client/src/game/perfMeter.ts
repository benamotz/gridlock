/**
 * A small on-screen performance readout, for checking how the game runs on a
 * real device (phones especially). It is written straight into the DOM a few
 * times a second, never through React, so measuring costs next to nothing.
 *
 * Shows frames per second, average and worst frame time, the share spent in
 * each part of the frame, and how many frames ran long (over 20 ms).
 */
export type PerfPart = 'input' | 'world' | 'minimap';

export class PerfMeter {
  private readonly el: HTMLDivElement;
  private frames = 0;
  private longFrames = 0;
  private worstGap = 0;
  private workSum = 0;
  private readonly parts: Record<PerfPart, number> = { input: 0, world: 0, minimap: 0 };
  private windowStart = performance.now();
  private lastFrameAt = 0;
  private partStart = 0;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'perf-overlay';
    host.appendChild(this.el);
  }

  dispose(): void {
    this.el.remove();
  }

  /** Call at the top of each frame. */
  frameStart(now: number): void {
    if (this.lastFrameAt > 0) {
      const gap = now - this.lastFrameAt;
      this.worstGap = Math.max(this.worstGap, gap);
      if (gap > 20) this.longFrames++;
    }
    this.lastFrameAt = now;
    this.frames++;
  }

  begin(): void {
    this.partStart = performance.now();
  }

  end(part: PerfPart): void {
    const ms = performance.now() - this.partStart;
    this.parts[part] += ms;
    this.workSum += ms;
  }

  /** Call at the end of each frame; refreshes the readout twice a second. */
  frameEnd(extra: string): void {
    const now = performance.now();
    const span = now - this.windowStart;
    if (span < 500) return;
    const fps = (this.frames * 1000) / span;
    const per = (ms: number) => (this.frames > 0 ? ms / this.frames : 0).toFixed(1);
    this.el.textContent =
      `${fps.toFixed(0)} fps · work ${per(this.workSum)} ms · worst gap ${this.worstGap.toFixed(0)} ms\n` +
      `input ${per(this.parts.input)} · world ${per(this.parts.world)} · map ${per(this.parts.minimap)} ms\n` +
      `long frames ${this.longFrames}/${this.frames} · ${extra}`;
    this.frames = 0;
    this.longFrames = 0;
    this.worstGap = 0;
    this.workSum = 0;
    this.parts.input = this.parts.world = this.parts.minimap = 0;
    this.windowStart = now;
  }
}
