import type { Settings } from '../store.js';

type Voice = {
  /** Base frequency in Hz. */
  freq: number;
  /** Frequency at the end of the sound. */
  endFreq?: number;
  type: OscillatorType;
  duration: number;
  gain: number;
  /** Amount of white noise mixed in, 0-1. */
  noise: number;
  /** Low-pass cutoff applied to the noise component. */
  cutoff?: number;
};

/**
 * Procedural placeholder audio.
 *
 * Every sound is synthesised from an oscillator and a noise burst, so the repo
 * ships no audio files and every effect is original. Swapping in real samples
 * later means replacing `play` with a buffer player - the call sites and the
 * logical sound names in `render/assets.ts` do not change.
 */
const VOICES: Record<string, Voice> = {
  pistol:    { freq: 420, endFreq: 120, type: 'square',   duration: 0.09, gain: 0.30, noise: 0.5, cutoff: 3200 },
  smg:       { freq: 520, endFreq: 180, type: 'square',   duration: 0.06, gain: 0.22, noise: 0.55, cutoff: 3600 },
  shotgun:   { freq: 180, endFreq: 60,  type: 'sawtooth', duration: 0.22, gain: 0.42, noise: 0.85, cutoff: 1800 },
  rifle:     { freq: 480, endFreq: 140, type: 'sawtooth', duration: 0.10, gain: 0.32, noise: 0.6, cutoff: 3000 },
  marksman:  { freq: 260, endFreq: 70,  type: 'sawtooth', duration: 0.30, gain: 0.48, noise: 0.7, cutoff: 2200 },
  launcher:  { freq: 150, endFreq: 50,  type: 'sawtooth', duration: 0.35, gain: 0.50, noise: 0.8, cutoff: 1200 },
  throw:     { freq: 300, endFreq: 500, type: 'sine',     duration: 0.12, gain: 0.20, noise: 0.15 },
  melee:     { freq: 200, endFreq: 90,  type: 'triangle', duration: 0.10, gain: 0.26, noise: 0.4, cutoff: 2400 },
  reload:    { freq: 700, endFreq: 320, type: 'square',   duration: 0.14, gain: 0.16, noise: 0.35, cutoff: 4200 },
  pickup:    { freq: 620, endFreq: 980, type: 'sine',     duration: 0.14, gain: 0.22, noise: 0.05 },
  hitmark:   { freq: 1250, endFreq: 900, type: 'square',   duration: 0.06, gain: 0.20, noise: 0.05 },
  killmark:  { freq: 900, endFreq: 1500, type: 'square',   duration: 0.13, gain: 0.26, noise: 0.05 },
  hurt:      { freq: 210, endFreq: 90,  type: 'triangle', duration: 0.18, gain: 0.30, noise: 0.45, cutoff: 1400 },
  death:     { freq: 320, endFreq: 70,  type: 'sawtooth', duration: 0.42, gain: 0.30, noise: 0.4, cutoff: 1600 },
  explosion: { freq: 110, endFreq: 34,  type: 'sawtooth', duration: 0.55, gain: 0.55, noise: 0.95, cutoff: 900 },
  crash:     { freq: 240, endFreq: 80,  type: 'square',   duration: 0.24, gain: 0.38, noise: 0.9, cutoff: 2600 },
  engine:    { freq: 90,  endFreq: 110, type: 'sawtooth', duration: 0.30, gain: 0.12, noise: 0.2, cutoff: 700 },
  countdown: { freq: 660, endFreq: 660, type: 'sine',     duration: 0.16, gain: 0.28, noise: 0 },
  victory:   { freq: 520, endFreq: 880, type: 'triangle', duration: 0.60, gain: 0.35, noise: 0 },
  defeat:    { freq: 400, endFreq: 160, type: 'triangle', duration: 0.70, gain: 0.32, noise: 0 },
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastPlayedAt = new Map<string, number>();

  constructor(private settings: Settings) {}

  applySettings(settings: Settings): void {
    this.settings = settings;
    if (this.master) this.master.gain.value = settings.masterVolume;
  }

  /** Lazily created, because browsers only allow audio after a user gesture. */
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as {
        webkitAudioContext: typeof AudioContext
      }).webkitAudioContext;
      const ctx = new Ctor();
      this.master = ctx.createGain();
      this.master.gain.value = this.settings.masterVolume;
      this.master.connect(ctx.destination);

      const frames = Math.floor(ctx.sampleRate * 0.6);
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;

      this.ctx = ctx;
      return ctx;
    } catch {
      // Audio is a nicety; a browser that refuses it must not break the game.
      return null;
    }
  }

  resume(): void {
    const ctx = this.ensure();
    if (ctx?.state === 'suspended') void ctx.resume();
  }

  play(name: string, pan = 0, gain = 1): void {
    if (this.settings.effectsVolume <= 0 || this.settings.masterVolume <= 0) return;
    const voice = VOICES[name];
    if (!voice || gain <= 0.02) return;

    const ctx = this.ensure();
    if (!ctx || !this.master) return;

    // Rate-limit each sound so a full-auto weapon does not stack 12 voices
    // into a clipping mess.
    const now = ctx.currentTime;
    const last = this.lastPlayedAt.get(name) ?? -1;
    if (now - last < 0.02) return;
    this.lastPlayedAt.set(name, now);

    const out = ctx.createGain();
    out.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner).connect(this.master);

    const level = voice.gain * gain * this.settings.effectsVolume;
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, now + voice.duration);

    if (voice.noise < 1) {
      const osc = ctx.createOscillator();
      osc.type = voice.type;
      osc.frequency.setValueAtTime(voice.freq, now);
      if (voice.endFreq !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, voice.endFreq), now + voice.duration,
        );
      }
      const oscGain = ctx.createGain();
      oscGain.gain.value = 1 - voice.noise;
      osc.connect(oscGain).connect(out);
      osc.start(now);
      osc.stop(now + voice.duration + 0.02);
    }

    if (voice.noise > 0 && this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = voice.cutoff ?? 2400;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = voice.noise;
      src.connect(filter).connect(noiseGain).connect(out);
      src.start(now);
      src.stop(now + voice.duration + 0.02);
    }
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
