// Motion presets as numbers (client only). A style module never branches on the preset name: it reads these values,
// so every style supports 'subtle', 'lively' and 'cinematic' with one implementation. Multipliers are relative to the
// style's own default (1 = as the style draws it by default); the 'lively' preset is all ones and the look the game had
// before presets existed, so a style that ignores a value still looks right.
//
//   subtle     small, calm motion that stays easy on the eye with hundreds of units
//   lively     clear motion: visible propellers, a gentle bob, quick punchy explosions (the default)
//   cinematic  big motion: hard banking, long wakes, slow rolling smoke columns, lingering fire
//
// Every params object carries every field, whatever category it was made for, so a style can read any of them.
import { prefersReducedMotion } from '../fx/settings';
import type { MotionPreset } from './artStyle';

export interface MotionParams {
  readonly preset: MotionPreset;
  /** prefers-reduced-motion: no idle motion (bob, sway, flicker, banking); blasts show a still frame */
  readonly reduced: boolean;

  // ---- ships (and their wakes)
  /** hull bob: amplitude in art px (0 = still) and the period of one bob (ms) */
  readonly bob: number;
  readonly bobMs: number;
  /** wake length behind a moving ship (multiplier) */
  readonly wakeLength: number;
  /** how long wake foam lasts (multiplier) */
  readonly foamLife: number;
  /** how wide the wake's V opens (multiplier) */
  readonly wakeSpread: number;

  // ---- land units
  /** dust kicked up by moving tracks (0 = none, 1 = a clear plume) */
  readonly treadDust: number;
  /** turret scanning left and right (radians at most; 0 = still) */
  readonly turretSway: number;
  /** engine vibration while moving (art px; 0 = none) */
  readonly jiggle: number;

  // ---- planes (and their contrails)
  /** bank angle (radians) per radian per second of turning, and the most it banks */
  readonly bankPerTurn: number;
  readonly bankMax: number;
  /** how clearly propellers show as spinning discs (0 = hidden, 1 = bold) and their flicker rate (frames per second) */
  readonly propellers: number;
  readonly propFps: number;
  /** plane contrails: how long they last (multiplier) */
  readonly contrailLife: number;
  /** a gentle rise and fall of a plane over its shadow (art px) */
  readonly altitudeBob: number;

  // ---- missiles (and their smoke trails)
  /** missile smoke trail: how long it lasts (multiplier) */
  readonly missileTrailLife: number;
  /** exhaust flame flicker: ms per frame */
  readonly flameMs: number;

  // ---- explosions
  /** how long a blast lasts (multiplier) */
  readonly blastTime: number;
  /** how long the smoke stays and rises after it (multiplier) */
  readonly smokeLinger: number;
  /** fire left burning after a blast (0 = none, 1 = long) */
  readonly fireLinger: number;
  /** debris thrown out (multiplier of the count) */
  readonly debris: number;
  /** shockwave ring size (multiplier) */
  readonly shockwave: number;

  // ---- craters
  /** how long a crater stays before it has faded (multiplier) */
  readonly craterLife: number;
  /** smoke still rising from a fresh crater (0 = none, 1 = clear wisps) */
  readonly craterSmoke: number;

  // ---- cannon fire
  /** muzzle flash size and how long it lasts (multipliers) */
  readonly flashSize: number;
  readonly flashTime: number;
  /** how high shells arc (multiplier) */
  readonly shellArc: number;
  /** gun smoke left at the muzzle (multiplier) */
  readonly muzzleSmoke: number;
  /** the hull rocking back when it fires (art px; 0 = none) */
  readonly recoil: number;
}

const BASE: Omit<MotionParams, 'preset' | 'reduced'> = {
  bob: 0.6,
  bobMs: 2800,
  wakeLength: 1,
  foamLife: 1,
  wakeSpread: 1,
  treadDust: 0.5,
  turretSway: 0.05,
  jiggle: 0.3,
  bankPerTurn: 0.5,
  bankMax: 0.4,
  propellers: 0.8,
  propFps: 14,
  contrailLife: 1,
  altitudeBob: 0.5,
  missileTrailLife: 1,
  flameMs: 90,
  blastTime: 1,
  smokeLinger: 1,
  fireLinger: 0.3,
  debris: 1,
  shockwave: 1,
  craterLife: 1,
  craterSmoke: 0.3,
  flashSize: 1,
  flashTime: 1,
  shellArc: 1,
  muzzleSmoke: 1,
  recoil: 0.5,
};

const PRESETS: Record<MotionPreset, Omit<MotionParams, 'preset' | 'reduced'>> = {
  subtle: {
    bob: 0.3,
    bobMs: 3600,
    wakeLength: 0.7,
    foamLife: 0.75,
    wakeSpread: 0.8,
    treadDust: 0,
    turretSway: 0,
    jiggle: 0,
    bankPerTurn: 0.25,
    bankMax: 0.18,
    propellers: 0.4,
    propFps: 8,
    contrailLife: 0.6,
    altitudeBob: 0,
    missileTrailLife: 0.7,
    flameMs: 140,
    blastTime: 0.8,
    smokeLinger: 0.6,
    fireLinger: 0,
    debris: 0.6,
    shockwave: 0.75,
    craterLife: 0.6,
    craterSmoke: 0,
    flashSize: 0.75,
    flashTime: 0.8,
    shellArc: 0.6,
    muzzleSmoke: 0.6,
    recoil: 0,
  },
  lively: BASE,
  cinematic: {
    bob: 1.1,
    bobMs: 2200,
    wakeLength: 1.8,
    foamLife: 1.7,
    wakeSpread: 1.3,
    treadDust: 1,
    turretSway: 0.12,
    jiggle: 0.6,
    bankPerTurn: 0.9,
    bankMax: 0.75,
    propellers: 1,
    propFps: 20,
    contrailLife: 1.8,
    altitudeBob: 1,
    missileTrailLife: 1.6,
    flameMs: 60,
    blastTime: 1.35,
    smokeLinger: 2.2,
    fireLinger: 1,
    debris: 1.5,
    shockwave: 1.3,
    craterLife: 1.6,
    craterSmoke: 1,
    flashSize: 1.4,
    flashTime: 1.3,
    shellArc: 1.4,
    muzzleSmoke: 2,
    recoil: 1,
  },
};

const cache = new Map<string, MotionParams>();

/**
 * The numbers of a preset. `reduced` (default: the player's prefers-reduced-motion) keeps the preset's sizes and
 * lifetimes but asks for no idle motion.
 */
export function motionParams(preset: MotionPreset, reduced = prefersReducedMotion()): MotionParams {
  const key = `${preset}|${reduced ? 1 : 0}`;
  let p = cache.get(key);
  if (!p) {
    const base = PRESETS[preset] ?? BASE;
    p = Object.freeze({ ...base, preset: PRESETS[preset] ? preset : 'lively', reduced });
    cache.set(key, p);
  }
  return p;
}
