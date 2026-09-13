import { TEAM_PRESETS, type ZoneKind } from '@gridlock/shared';

/**
 * Central asset configuration.
 *
 * Every colour, shape and sound name the game draws or plays is declared here.
 * The MVP ships original procedural placeholder art - flat shapes and generated
 * audio - so swapping in real sprites and samples later means editing this file
 * and the two loaders that read it, not the renderer.
 */

export interface ZoneStyle {
  fill: string;
  detail?: string;
}

/**
 * Ground palette. A cool night-city base with warm district washes, so the
 * bold team colours on players stay the brightest thing on screen.
 */
export const GROUND = {
  base: '#2f333d',
  slabLine: 'rgba(0,0,0,0.22)',
  grit: 'rgba(255,255,255,0.022)',
  quay: '#2c3240',
  ripple: 'rgba(150,200,255,0.16)',
  bayLine: 'rgba(255,255,255,0.16)',
  teamTint: ['#ffb020', '#3d8bff', '#3ad07a', '#ff4d5e'],
  zones: {
    road:        { fill: '#22252c' },
    sidewalk:    { fill: '#2f333d' },
    downtown:    { fill: '#2a2e38' },
    residential: { fill: '#38322c' },
    industrial:  { fill: '#332e28' },
    park:        { fill: '#223628' },
    water:       { fill: '#132437' },
    base:        { fill: '#2c2936' },
  } as Record<ZoneKind, ZoneStyle>,
  /** Warm pools cast by street lamps along the avenues. */
  lampGlow: 'rgba(255,206,140,0.055)',
  lampPost: '#151820',
  lampHead: '#ffd79a',
};

/** Kept for the minimap, which paints flat zone colours. */
export const ZONE_STYLES: Record<ZoneKind, ZoneStyle> = GROUND.zones;

export const ROAD = {
  asphalt: '#25282f',
  wear: '#1f222a',
  kerb: '#565d6d',
  laneLine: 'rgba(226,214,150,0.55)',
  paint: 'rgba(232,236,244,0.72)',
  drain: '#181b21',
};

export const BUILDING = {
  footprint: '#0d0f13',
  outline: '#090b0f',
  wallSolid: '#171a21',
  faceSide: '#1c2029',
  faceFront: '#14171e',
  windowLit: 'rgba(255,198,118,0.62)',
  windowBright: 'rgba(255,232,180,0.92)',
  windowDark: 'rgba(120,140,170,0.16)',
  /** Pixels of extrusion per storey. */
  storeyOffset: 6.5,
  /**
   * Roof palette: brick, slate, tar, copper and rust. Kept darker than the
   * street so buildings read as mass and the lit streets carry the eye.
   */
  roofs: [
    { fill: '#6b4436', lit: '#855546', shade: '#3f281f', detail: '#57372c' }, // brick
    { fill: '#3d4552', lit: '#4e5867', shade: '#252b34', detail: '#333a46' }, // slate
    { fill: '#463f38', lit: '#59504a', shade: '#2b2621', detail: '#3a342e' }, // tar
    { fill: '#2f5148', lit: '#3d665b', shade: '#1d332d', detail: '#28453e' }, // copper
    { fill: '#5c4a3a', lit: '#725c48', shade: '#372c22', detail: '#4b3d30' }, // rust
    { fill: '#494155', lit: '#5c536b', shade: '#2c2734', detail: '#3d3648' }, // plum
  ],
};

export const PROP = {
  fill: '#5a5147',
  lit: '#6e6459',
  shade: '#3b352e',
  edge: '#1a1713',
  band: 'rgba(0,0,0,0.35)',
};

export const WORLD = {
  background: '#0d0f14',
  outOfBounds: '#070810',
};

export const PLAYER = {
  radius: 13,
  outline: '#0a0c10',
  /** Skin and boot tones, deliberately neutral so team colour dominates. */
  skin: '#d9a273',
  boots: '#232833',
  gun: '#1c1f27',
  gunHighlight: '#4a5162',
  shadow: 'rgba(0,0,0,0.45)',
  protectedRing: 'rgba(130,205,255,0.85)',
  /** Marker colour for anyone not on your team. */
  hostile: '#ff5566',
  selfRing: 'rgba(255,255,255,0.92)',
  nameShadow: 'rgba(0,0,0,0.85)',
};

export const VEHICLE = {
  shadow: 'rgba(0,0,0,0.5)',
  glass: '#141a26',
  glassLit: '#22304a',
  trim: '#0d1015',
  headlight: 'rgba(255,236,190,0.9)',
  taillight: 'rgba(255,70,70,0.85)',
  tyre: '#15171c',
  wreck: '#33302c',
  wreckChar: '#1c1a18',
};

export const teamColor = (team: number): string =>
  team >= 0 && team < TEAM_PRESETS.length ? TEAM_PRESETS[team].color : '#9aa3b2';

export const teamSymbol = (team: number): string =>
  team >= 0 && team < TEAM_PRESETS.length ? TEAM_PRESETS[team].symbol : '?';

export const teamName = (team: number): string =>
  team >= 0 && team < TEAM_PRESETS.length ? TEAM_PRESETS[team].name : 'Free agents';

/**
 * Colourblind-safe alternative palette. Team identity is also carried by the
 * symbol badge above each player, so colour is never the only signal.
 */
export const TEAM_COLORS_CB = ['#f0e442', '#0072b2', '#009e73', '#d55e00'];

export const teamColorFor = (team: number, colorblind: boolean): string =>
  colorblind
    ? (team >= 0 && team < TEAM_COLORS_CB.length ? TEAM_COLORS_CB[team] : '#9aa3b2')
    : teamColor(team);

export const PICKUP_STYLE: Record<string, { fill: string; glyph: string }> = {
  weapon: { fill: '#ffd479', glyph: 'W' },
  ammo:   { fill: '#9fd0ff', glyph: 'A' },
  health: { fill: '#7ef3a4', glyph: '+' },
  armor:  { fill: '#c4a4ff', glyph: 'S' },
};

export const FX = {
  tracer: 'rgba(255,236,190,0.85)',
  tracerHeavy: 'rgba(255,170,110,0.9)',
  muzzle: 'rgba(255,226,170,0.95)',
  impact: 'rgba(255,255,255,0.7)',
  bloodHit: 'rgba(255,90,110,0.9)',
  explosion: 'rgba(255,150,70,0.85)',
  explosionCore: 'rgba(255,235,180,0.95)',
};

/**
 * Logical sound names. The audio layer synthesises each one; replacing the
 * synthesiser with sample playback needs no changes anywhere else.
 */
export const SFX = {
  pistol: 'pistol',
  smg: 'smg',
  shotgun: 'shotgun',
  rifle: 'rifle',
  marksman: 'marksman',
  launcher: 'launcher',
  throw: 'throw',
  melee: 'melee',
  reload: 'reload',
  pickup: 'pickup',
  hurt: 'hurt',
  death: 'death',
  explosion: 'explosion',
  engine: 'engine',
  crash: 'crash',
  countdown: 'countdown',
  victory: 'victory',
  defeat: 'defeat',
} as const;

export type SfxName = (typeof SFX)[keyof typeof SFX];
