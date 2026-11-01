// Procedural audio: every sound is synthesized with the Web Audio API (oscillators, filtered noise, envelopes),
// there are no asset files. Small and quiet by design: per-sound rate limits (real time, so x4 game speed does
// not multiply the noise), a global voice cap and a soft compressor on the master bus. Optional generative
// ambient pad that follows the game's tension (off by default).
//
// Without an AudioContext (Node tests, old browsers, blocked audio) every method still works and never throws:
// the rate limiting runs as usual, nothing is synthesized. See docs/AUDIO.md for the integration steps.

import type { Effect, GameEvent, GameState } from '../sim/types';

// ================================================================================================ sound table

export type SoundId =
  | 'uiClick'
  | 'uiHover'
  | 'uiError'
  | 'buildPlaced'
  | 'buildingDone'
  | 'buildingLost'
  | 'researchDone'
  | 'attackLaunched'
  | 'capture'
  | 'underAttack'
  | 'allianceRequest'
  | 'allianceFormed'
  | 'allianceBroken'
  | 'allianceExpired'
  | 'capitalLost'
  | 'capitalTaken'
  | 'cityTaken'
  | 'cityLost'
  | 'shipSunk'
  | 'explosion'
  | 'atomBomb'
  | 'missileLaunch'
  | 'shipHorn'
  | 'tradeCoin'
  | 'unitLost'
  | 'eliminated'
  | 'victory'
  | 'defeat'
  | 'countdown'
  | 'countdownGo'
  | 'shot';

/** 0 = cosmetic (dropped first), 1 = normal, 2 = important, 3 = critical (ignores the voice cap). */
export type SoundPriority = 0 | 1 | 2 | 3;

export interface SoundInfo {
  /** length in seconds (used for the voice cap) */
  dur: number;
  /** minimum real time between two plays of this sound, ms */
  gapMs: number;
  priority: SoundPriority;
}

export const SOUND_INFO: Readonly<Record<SoundId, SoundInfo>> = {
  uiClick: { dur: 0.06, gapMs: 40, priority: 0 },
  uiHover: { dur: 0.04, gapMs: 70, priority: 0 },
  uiError: { dur: 0.2, gapMs: 250, priority: 1 },
  buildPlaced: { dur: 0.2, gapMs: 80, priority: 1 },
  buildingDone: { dur: 1.0, gapMs: 350, priority: 1 },
  buildingLost: { dur: 0.4, gapMs: 600, priority: 1 },
  researchDone: { dur: 1.2, gapMs: 800, priority: 2 },
  attackLaunched: { dur: 0.65, gapMs: 1200, priority: 1 },
  capture: { dur: 0.03, gapMs: 70, priority: 0 },
  underAttack: { dur: 0.8, gapMs: 4000, priority: 3 },
  allianceRequest: { dur: 1.7, gapMs: 1500, priority: 2 },
  allianceFormed: { dur: 1.9, gapMs: 1500, priority: 2 },
  allianceBroken: { dur: 1.1, gapMs: 1500, priority: 2 },
  allianceExpired: { dur: 1.4, gapMs: 1500, priority: 1 },
  capitalLost: { dur: 1.8, gapMs: 3000, priority: 3 },
  capitalTaken: { dur: 1.2, gapMs: 3000, priority: 2 },
  cityTaken: { dur: 0.9, gapMs: 700, priority: 2 },
  cityLost: { dur: 1.0, gapMs: 700, priority: 2 },
  shipSunk: { dur: 1.3, gapMs: 600, priority: 1 },
  explosion: { dur: 0.95, gapMs: 110, priority: 1 },
  atomBomb: { dur: 5.2, gapMs: 1500, priority: 3 },
  missileLaunch: { dur: 1.35, gapMs: 500, priority: 1 },
  shipHorn: { dur: 1.7, gapMs: 4000, priority: 2 },
  tradeCoin: { dur: 0.42, gapMs: 500, priority: 0 },
  unitLost: { dur: 0.3, gapMs: 800, priority: 1 },
  eliminated: { dur: 2.3, gapMs: 2500, priority: 1 },
  victory: { dur: 3.0, gapMs: 5000, priority: 3 },
  defeat: { dur: 3.0, gapMs: 5000, priority: 3 },
  countdown: { dur: 0.1, gapMs: 400, priority: 2 },
  countdownGo: { dur: 0.7, gapMs: 1000, priority: 2 },
  shot: { dur: 0.05, gapMs: 120, priority: 0 },
};

export const SOUND_IDS = Object.keys(SOUND_INFO) as SoundId[];

/** Voices playing at once: cosmetic sounds stop at SOFT_VOICES, everything but critical ones at MAX_VOICES. */
export const SOFT_VOICES = 8;
export const MAX_VOICES = 14;

// ================================================================================================ settings

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = { master: 0.6, sfx: 0.8, music: 0, muted: false };
export const AUDIO_STORAGE_KEY = 'borderfall.audio.v1';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export interface AudioManagerOptions {
  /** Use this context right away (OfflineAudioContext for checks, or a shared context); skips unlock(). */
  context?: BaseAudioContext;
  /** Real-time clock in ms for the rate limits (tests inject a fake one). Default performance.now(). */
  now?: () => number;
  /** Settings store; null = do not persist. Default window.localStorage. */
  storage?: KeyValueStore | null;
  /** Context factory used by unlock(); return null when audio is unavailable. */
  createContext?: () => BaseAudioContext | null;
}

export interface PlayOptions {
  /** -1 (left) .. 1 (right) */
  pan?: number;
  /** 0..1, on top of the master and sfx volumes */
  volume?: number;
}

/** Anything with the Camera's screen mapping (src/client/camera.ts matches). */
export interface ScreenView {
  viewW: number;
  viewH: number;
  tileToScreen(tx: number, ty: number): { x: number; y: number };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

function defaultNow(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch {
    /* fall through */
  }
  return Date.now();
}

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function defaultCreateContext(): BaseAudioContext | null {
  try {
    const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
  } catch {
    return null;
  }
}

// ================================================================================================ event mapping

export interface SoundChoice {
  id: SoundId;
  volume: number;
}

/** A ship sunk by a warship or a mine ("lost a transport ... to X's warship", "... hit a mine ... and sank"). */
const SHIP_SUNK = /to .+'s warship$|\bsank\b/;
/** A city changing hands ("X captured a City of Y"). */
const CITY_CAPTURED = /captured a City\b/;

/**
 * Which sound a sim event makes for the human player `humanId`, or null. Only events concerning the human
 * (or the few global big ones) make a sound. Pure: the same event always gives the same answer.
 * `near` = false when the event's tile is far off screen: a city changing hands or a ship sinking is then
 * silent (the event log still has it); undefined = unknown, treated as near.
 */
export function soundForEvent(e: GameEvent, humanId: number, near?: boolean): SoundChoice | null {
  const far = near === false;
  const h = humanId;
  const global = e.players.length === 0;
  const mine = h > 0 && e.players.includes(h);
  const first = h > 0 && e.players[0] === h;
  const pick = (id: SoundId, volume = 1): SoundChoice => ({ id, volume });
  switch (e.kind) {
    case 'info':
      // "The war begins!" is the only global info event: the spawn phase is over.
      if (global && /war begins/i.test(e.message)) return pick('countdownGo');
      return null;
    case 'attackStarted':
      if (!first) return null;
      return pick('attackLaunched', /neutral land/.test(e.message) ? 0.55 : 1);
    case 'underAttack':
      if (!mine) return null;
      // Watchtower warning about an enemy transport heading for our land: a ship horn instead of the alarm.
      if (/transport/.test(e.message)) return pick('shipHorn');
      return pick('underAttack');
    case 'surrounded':
      return first ? pick('underAttack') : null;
    case 'buildingDone':
      return first ? pick('buildingDone', /upgraded/.test(e.message) ? 1 : 0.85) : null;
    case 'buildingLost':
      return first ? pick('buildingLost') : null;
    case 'buildingCaptured':
      if (mine && CITY_CAPTURED.test(e.message)) return far ? null : pick(first ? 'cityTaken' : 'cityLost');
      if (first) return pick('buildingDone', 0.6);
      return mine ? pick('buildingLost') : null;
    case 'researchDone':
      return mine ? pick('researchDone') : null;
    case 'allianceRequest':
      return mine ? pick('allianceRequest') : null;
    case 'allianceFormed':
      return mine ? pick('allianceFormed', /renewed/.test(e.message) ? 0.6 : 1) : null;
    case 'allianceBroken':
      return mine ? pick('allianceBroken') : null;
    case 'allianceExpired':
      return mine ? pick('allianceExpired') : null;
    case 'eliminated':
      if (first) return pick('defeat');
      return global || mine ? pick('eliminated', mine ? 1 : 0.6) : null;
    case 'capitalLost':
      if (first) return pick('capitalLost');
      return mine ? pick('capitalTaken') : null;
    case 'nuke':
      return global || mine ? pick('atomBomb') : null; // the sim reports every atom bomb to everyone ([])
    case 'missile':
      if (!mine) return null;
      // Launch ("X launched a rocket at Y") whooshes; the strike report explodes.
      if (/launched/.test(e.message)) return pick('missileLaunch', first ? 1 : 0.8);
      return pick('explosion', first ? 0.8 : 1);
    case 'bombing':
      return mine ? pick('explosion', first ? 0.8 : 1) : null;
    case 'unitLost':
      if (!mine) return null;
      if (SHIP_SUNK.test(e.message)) return far ? null : pick('shipSunk', first ? 1 : 0.8);
      if (first) return pick('unitLost');
      return pick('explosion', 0.5); // an enemy unit lost to us (or its landing on our coast repelled)
    case 'tradeDelivered':
      return mine ? pick('tradeCoin') : null;
    case 'victory':
      if (first) return pick('victory');
      return null; // the human lost: a 'defeat' event follows
    case 'defeat':
      return mine ? pick('defeat') : null;
    default:
      return null;
  }
}

/**
 * Sound for a sim visual effect. `screenPan` undefined = the effect is off screen. `mine` (optional) says whether
 * a 'capture' is the human's own; when unknown, captures only sound on screen.
 */
export function soundForEffect(e: Effect, screenPan: number | undefined, mine?: boolean): SoundChoice | null {
  const onScreen = screenPan !== undefined;
  switch (e.kind) {
    case 'nuke':
      return { id: 'atomBomb', volume: onScreen ? 1 : 0.75 };
    case 'explosion':
      if (!onScreen) return null;
      return { id: 'explosion', volume: e.radius >= 2.5 ? 0.85 : 0.5 };
    case 'capture':
      if (mine === false) return null;
      if (mine === undefined && !onScreen) return null;
      return { id: 'capture', volume: e.radius > 2 ? 1 : 0.7 };
    case 'shot':
      return onScreen ? { id: 'shot', volume: 0.6 } : null;
    default:
      return null;
  }
}

/** Stereo position (-0.8..0.8) of a screen x coordinate in a view `viewW` wide. */
export function panFromScreenX(sx: number, viewW: number): number {
  if (!(viewW > 0) || !Number.isFinite(sx)) return 0;
  return clamp((sx / viewW) * 2 - 1, -1, 1) * 0.8;
}

// ================================================================================================ rate limiter

/** Per-sound minimum gaps plus a global voice cap; pure bookkeeping, runs with or without audio. */
export class SoundLimiter {
  private lastAt = new Map<SoundId, number>();
  private ends: number[] = [];

  /** Voices still sounding at `now`. */
  active(now: number): number {
    if (this.ends.length) this.ends = this.ends.filter((t) => t > now);
    return this.ends.length;
  }

  /** True (and the voice is counted) when `id` may play at `now` (ms). */
  accept(id: SoundId, now: number): boolean {
    const info = SOUND_INFO[id];
    if (!info) return false;
    const last = this.lastAt.get(id);
    if (last !== undefined && now - last < info.gapMs && now >= last) return false;
    const n = this.active(now);
    if (info.priority === 0 && n >= SOFT_VOICES) return false;
    if (info.priority < 3 && n >= MAX_VOICES) return false;
    this.lastAt.set(id, now);
    this.ends.push(now + info.dur * 1000);
    return true;
  }

  reset(): void {
    this.lastAt.clear();
    this.ends = [];
  }
}

// ================================================================================================ synthesis

interface ToneOpts {
  type?: OscillatorType;
  f: number;
  /** end frequency (exponential glide over `glide` s, default the whole note) */
  f2?: number;
  glide?: number;
  at?: number;
  dur: number;
  gain: number;
  attack?: number;
  hold?: number;
  detune?: number;
  /** low-pass cutoff points, spread evenly over the note */
  lp?: number[];
  q?: number;
}

interface NoiseOpts {
  at?: number;
  dur: number;
  gain: number;
  attack?: number;
  hold?: number;
  filter?: BiquadFilterType;
  /** filter frequency points, spread evenly over the sound */
  fs?: number[];
  q?: number;
  /** amplitude wobble: rate Hz, depth 0..1 */
  am?: { rate: number; depth: number };
}

const SILENT = 0.0001;

function envelope(p: AudioParam, t: number, peak: number, attack: number, hold: number, dur: number): void {
  const a = Math.max(0.001, attack);
  const end = Math.max(t + a + hold + 0.01, t + dur);
  p.setValueAtTime(SILENT, t);
  p.linearRampToValueAtTime(Math.max(SILENT, peak), t + a);
  if (hold > 0) p.setValueAtTime(Math.max(SILENT, peak), t + a + hold);
  p.exponentialRampToValueAtTime(SILENT, end);
}

function sweep(p: AudioParam, t: number, dur: number, pts: number[]): void {
  p.setValueAtTime(pts[0], t);
  for (let i = 1; i < pts.length; i++) p.exponentialRampToValueAtTime(Math.max(1, pts[i]), t + (dur * i) / (pts.length - 1));
}

/** One playing sound: builds its nodes into `out` starting at time `t`. */
class Voice {
  end: number;
  constructor(
    private ctx: BaseAudioContext,
    private out: AudioNode,
    private t: number,
    private noiseBuf: AudioBuffer,
  ) {
    this.end = t;
  }

  tone(o: ToneOpts): void {
    const c = this.ctx;
    const t = this.t + (o.at ?? 0);
    const osc = c.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t + (o.glide ?? o.dur));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const g = c.createGain();
    envelope(g.gain, t, o.gain, o.attack ?? 0.005, o.hold ?? 0, o.dur);
    let node: AudioNode = osc;
    if (o.lp && o.lp.length) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = o.q ?? 0.7;
      sweep(f.frequency, t, o.dur, o.lp.length > 1 ? o.lp : [o.lp[0], o.lp[0]]);
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(this.out);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
    this.end = Math.max(this.end, t + o.dur + 0.05);
  }

  noise(o: NoiseOpts): void {
    const c = this.ctx;
    const t = this.t + (o.at ?? 0);
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.filter ?? 'lowpass';
    f.Q.value = o.q ?? 0.7;
    const fs = o.fs && o.fs.length ? o.fs : [2000];
    sweep(f.frequency, t, o.dur, fs.length > 1 ? fs : [fs[0], fs[0]]);
    const g = c.createGain();
    envelope(g.gain, t, o.gain, o.attack ?? 0.005, o.hold ?? 0, o.dur);
    src.connect(f);
    f.connect(g);
    let last: AudioNode = g;
    if (o.am) {
      const wob = c.createGain();
      wob.gain.value = 1 - o.am.depth / 2;
      const lfo = c.createOscillator();
      lfo.frequency.value = o.am.rate;
      const depth = c.createGain();
      depth.gain.value = o.am.depth / 2;
      lfo.connect(depth);
      depth.connect(wob.gain);
      lfo.start(t);
      lfo.stop(t + o.dur + 0.05);
      g.connect(wob);
      last = wob;
    }
    last.connect(this.out);
    const len = this.noiseBuf.duration;
    src.start(t, Math.random() * Math.max(0, len - 0.1));
    src.stop(t + o.dur + 0.05);
    this.end = Math.max(this.end, t + o.dur + 0.05);
  }

  /** Bell / chime: a sine with a couple of slightly inharmonic partials. */
  bell(f: number, at: number, dur: number, gain: number): void {
    this.tone({ f, at, dur, gain, attack: 0.004 });
    this.tone({ f: f * 2.0, detune: 3, at, dur: dur * 0.55, gain: gain * 0.32, attack: 0.003 });
    this.tone({ f: f * 2.76, at, dur: dur * 0.3, gain: gain * 0.12, attack: 0.002 });
  }

  /** Soft brass: two detuned saws through a low-pass that opens on the attack. */
  brass(f: number, at: number, dur: number, gain: number, hold = 0): void {
    const lp = [f * 1.3, f * 4.5, f * 2.2, f * 1.4];
    this.tone({ type: 'sawtooth', f, at, dur, gain: gain * 0.6, attack: 0.03, hold, detune: -6, lp });
    this.tone({ type: 'sawtooth', f, at, dur, gain: gain * 0.6, attack: 0.04, hold, detune: 6, lp });
  }

  /** Kettle drum: a falling sine thump. */
  drum(f: number, at: number, gain: number): void {
    this.tone({ f, f2: f * 0.8, at, dur: 0.45, gain, attack: 0.004 });
    this.noise({ at, dur: 0.08, gain: gain * 0.25, filter: 'lowpass', fs: [700, 200] });
  }
}

type Recipe = (v: Voice) => void;

const RECIPES: Record<SoundId, Recipe> = {
  uiClick: (v) => v.tone({ f: 1100, f2: 700, dur: 0.05, gain: 0.07, attack: 0.002 }),
  uiHover: (v) => v.tone({ f: 2200, dur: 0.03, gain: 0.018, attack: 0.002 }),
  uiError: (v) => {
    v.tone({ type: 'triangle', f: 220, dur: 0.08, gain: 0.09, lp: [1200] });
    v.tone({ type: 'triangle', f: 185, at: 0.09, dur: 0.1, gain: 0.09, lp: [1200] });
  },
  buildPlaced: (v) => {
    v.tone({ type: 'triangle', f: 260, f2: 150, dur: 0.12, gain: 0.15, attack: 0.002 });
    v.noise({ dur: 0.05, gain: 0.07, filter: 'bandpass', fs: [1800], q: 1.5, attack: 0.001 });
    v.tone({ type: 'triangle', f: 330, f2: 190, at: 0.07, dur: 0.1, gain: 0.11, attack: 0.002 });
  },
  buildingDone: (v) => {
    v.bell(784, 0, 0.7, 0.1);
    v.bell(1175, 0.09, 0.9, 0.085);
  },
  buildingLost: (v) => {
    v.tone({ type: 'triangle', f: 330, f2: 110, dur: 0.35, gain: 0.15, lp: [900] });
    v.noise({ dur: 0.25, gain: 0.08, fs: [500, 150] });
  },
  researchDone: (v) => {
    [523, 659, 784, 1047].forEach((f, i) => v.bell(f, i * 0.07, 0.9, 0.065));
    v.tone({ f: 523, dur: 1.1, gain: 0.035, attack: 0.25 });
    v.tone({ f: 784, dur: 1.1, gain: 0.03, attack: 0.25 });
  },
  attackLaunched: (v) => {
    v.brass(196, 0, 0.18, 0.12);
    v.brass(294, 0.14, 0.48, 0.13, 0.1);
    v.noise({ dur: 0.35, gain: 0.045, filter: 'bandpass', fs: [600, 2500, 900], q: 1.2, attack: 0.05 });
  },
  capture: (v) => v.tone({ f: 1500 + Math.random() * 400, dur: 0.025, gain: 0.03, attack: 0.001 }),
  underAttack: (v) => {
    for (let i = 0; i < 2; i++) {
      v.tone({ type: 'triangle', f: 880, at: i * 0.32, dur: 0.14, gain: 0.12, lp: [2500], attack: 0.004 });
      v.tone({ type: 'triangle', f: 660, at: i * 0.32 + 0.15, dur: 0.16, gain: 0.12, lp: [2500], attack: 0.004 });
    }
    v.tone({ f: 110, dur: 0.75, gain: 0.08, attack: 0.02 });
  },
  allianceRequest: (v) => {
    v.bell(659, 0, 1.1, 0.085);
    v.bell(831, 0.12, 1.1, 0.08);
    v.bell(988, 0.24, 1.4, 0.08);
  },
  allianceFormed: (v) => {
    [523, 659, 784].forEach((f, i) => v.bell(f, i * 0.1, 1.0, 0.07));
    v.bell(1047, 0.32, 1.5, 0.07);
    for (const f of [262, 330, 392]) v.tone({ type: 'triangle', f, dur: 1.7, gain: 0.035, attack: 0.3, lp: [1500] });
  },
  allianceBroken: (v) => {
    v.tone({ type: 'triangle', f: 466, dur: 0.35, gain: 0.1, lp: [1800] });
    v.tone({ type: 'triangle', f: 330, at: 0.3, dur: 0.75, gain: 0.1, lp: [1600] });
    v.tone({ type: 'triangle', f: 333, at: 0.3, dur: 0.75, gain: 0.06, lp: [1600] });
    v.tone({ f: 82, dur: 1.0, gain: 0.08, attack: 0.05 });
  },
  allianceExpired: (v) => {
    v.bell(587, 0, 0.8, 0.06);
    v.bell(440, 0.2, 1.1, 0.06);
  },
  capitalLost: (v) => {
    for (const f of [147, 175, 220]) v.brass(f, 0, 1.6, 0.075, 0.3);
    v.tone({ f: 70, f2: 35, dur: 1.2, gain: 0.28, attack: 0.005 });
    v.noise({ dur: 1.0, gain: 0.11, fs: [800, 120], attack: 0.005 });
  },
  capitalTaken: (v) => {
    v.brass(262, 0, 0.2, 0.1);
    v.brass(392, 0.16, 0.2, 0.1);
    v.brass(523, 0.32, 0.85, 0.11, 0.15);
    v.drum(98, 0, 0.2);
  },
  // a city of yours changes hands: a short rising bugle call with a drum; lost: the same call falling, muted
  cityTaken: (v) => {
    v.brass(294, 0, 0.14, 0.08);
    v.brass(440, 0.12, 0.6, 0.09, 0.1);
    v.drum(110, 0, 0.14);
  },
  cityLost: (v) => {
    v.brass(330, 0, 0.18, 0.07);
    v.brass(247, 0.16, 0.7, 0.075, 0.12);
    v.tone({ f: 82, f2: 55, dur: 0.8, gain: 0.12, attack: 0.01 });
  },
  // ship sunk: a low hull crump, then water closing over it (a falling filtered wash with a bubble tail)
  shipSunk: (v) => {
    v.tone({ f: 90, f2: 40, dur: 0.4, gain: 0.2, attack: 0.004 });
    v.noise({ dur: 1.2, gain: 0.16, fs: [1800, 700, 250], attack: 0.01, am: { rate: 9, depth: 0.5 } });
    for (let i = 0; i < 3; i++) v.tone({ f: 420 + i * 90, f2: 900 + i * 120, at: 0.45 + i * 0.13, dur: 0.06, gain: 0.025, attack: 0.002 });
  },
  explosion: (v) => {
    v.noise({ dur: 0.9, gain: 0.3, fs: [2500, 900, 150], attack: 0.004 });
    v.tone({ f: 110, f2: 38, dur: 0.45, gain: 0.32, attack: 0.003 });
    v.noise({ dur: 0.06, gain: 0.08, filter: 'bandpass', fs: [3000], q: 0.8, attack: 0.001 });
  },
  atomBomb: (v) => {
    v.tone({ f: 55, f2: 24, dur: 3.0, gain: 0.42, attack: 0.01, hold: 0.2 });
    v.noise({ dur: 4.5, gain: 0.3, fs: [1500, 400, 90, 60], attack: 0.02, hold: 0.3 });
    v.noise({ dur: 5.0, gain: 0.16, fs: [140, 120, 90], attack: 1.0, am: { rate: 5, depth: 0.6 } });
    v.tone({ f: 33, dur: 5.0, gain: 0.14, attack: 0.8 });
  },
  missileLaunch: (v) => {
    v.noise({ dur: 1.3, gain: 0.2, filter: 'bandpass', fs: [300, 1500, 3500, 1200], q: 2, attack: 0.25 });
    v.tone({ f: 180, f2: 90, dur: 1.0, gain: 0.055, attack: 0.2 });
  },
  shipHorn: (v) => {
    for (const [f, d] of [[98, -4], [98, 5], [147, 0]] as const) {
      v.tone({ type: 'sawtooth', f, detune: d, dur: 1.6, gain: 0.065, attack: 0.25, hold: 0.7, lp: [400, 700, 500] });
    }
  },
  tradeCoin: (v) => {
    v.tone({ f: 1976, dur: 0.08, gain: 0.055, attack: 0.002 });
    v.tone({ f: 2637, at: 0.06, dur: 0.35, gain: 0.055, attack: 0.002 });
    v.tone({ f: 5274, at: 0.06, dur: 0.12, gain: 0.012, attack: 0.002 });
  },
  unitLost: (v) => {
    v.tone({ type: 'triangle', f: 220, f2: 140, dur: 0.25, gain: 0.1, lp: [800] });
    v.noise({ dur: 0.2, gain: 0.06, fs: [600, 200] });
  },
  eliminated: (v) => {
    v.tone({ f: 98, dur: 2.2, gain: 0.1, attack: 0.01 });
    v.tone({ f: 246, dur: 1.5, gain: 0.04, attack: 0.01 });
    v.tone({ f: 389, dur: 0.8, gain: 0.02, attack: 0.01 });
  },
  victory: (v) => {
    const notes = [392, 523, 659, 784];
    notes.forEach((f, i) => v.brass(f, i * 0.16, i === 3 ? 0.5 : 0.16, 0.09));
    for (const f of [523, 659, 784, 1047]) v.brass(f, 0.9, 1.9, 0.055, 0.6);
    v.drum(98, 0, 0.18);
    v.drum(98, 0.48, 0.18);
    v.drum(131, 0.9, 0.22);
  },
  defeat: (v) => {
    [392, 370, 349].forEach((f, i) => v.brass(f, i * 0.4, 0.45, 0.08));
    v.brass(330, 1.2, 1.7, 0.085, 0.4);
    v.tone({ f: 82, dur: 2.9, gain: 0.11, attack: 0.3 });
    v.noise({ dur: 2.5, gain: 0.045, fs: [220, 180], attack: 0.5 });
  },
  countdown: (v) => {
    v.tone({ f: 880, dur: 0.09, gain: 0.085, attack: 0.002 });
    v.tone({ f: 1760, dur: 0.04, gain: 0.02, attack: 0.002 });
  },
  countdownGo: (v) => {
    v.tone({ f: 1320, dur: 0.5, gain: 0.09, attack: 0.003 });
    v.tone({ type: 'triangle', f: 660, dur: 0.5, gain: 0.055, attack: 0.003 });
    v.bell(1760, 0, 0.6, 0.035);
  },
  shot: (v) => v.noise({ dur: 0.04, gain: 0.04, filter: 'bandpass', fs: [2500], q: 1, attack: 0.001 }),
};

// ================================================================================================ music

const PEACE_CHORDS = [
  [50, 57, 61, 64], // D maj9-ish
  [47, 54, 57, 62], // B m7
  [43, 50, 54, 59], // G maj7
  [45, 52, 57, 64], // A sus
];
const TENSE_CHORDS = [
  [50, 53, 57, 64], // D m(add9)
  [46, 53, 58, 62], // B flat
  [43, 50, 55, 58], // G m
  [45, 52, 57, 61], // A
];
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Slow generative pad: 4 voices x 2 oscillators retuned in place (no node churn), a sub drone and a slow filter. */
class Pad {
  private oscs: OscillatorNode[] = [];
  private filter: BiquadFilterNode;
  private sub: OscillatorNode;
  private subGain: GainNode;
  private trem: OscillatorNode;
  private lfo: OscillatorNode;
  private out: GainNode;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private step = 0;
  private tension = 0;

  constructor(
    private ctx: BaseAudioContext,
    dest: AudioNode,
  ) {
    const c = ctx;
    const t = c.currentTime;
    this.out = c.createGain();
    this.out.gain.setValueAtTime(SILENT, t);
    this.out.gain.exponentialRampToValueAtTime(1, t + 4);
    this.out.connect(dest);
    this.filter = c.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 600;
    this.filter.Q.value = 0.5;
    this.filter.connect(this.out);
    this.lfo = c.createOscillator();
    this.lfo.frequency.value = 0.05;
    const lfoDepth = c.createGain();
    lfoDepth.gain.value = 180;
    this.lfo.connect(lfoDepth);
    lfoDepth.connect(this.filter.frequency);
    this.lfo.start();
    const chord = PEACE_CHORDS[0];
    for (let i = 0; i < 4; i++) {
      for (const [type, det] of [['triangle', -7], ['sine', 7]] as const) {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = midiHz(chord[i]);
        o.detune.value = det;
        const g = c.createGain();
        g.gain.value = 0.045;
        o.connect(g);
        g.connect(this.filter);
        o.start();
        this.oscs.push(o);
      }
    }
    this.sub = c.createOscillator();
    this.sub.frequency.value = midiHz(chord[0] - 12);
    this.subGain = c.createGain();
    this.subGain.gain.value = 0.03;
    const tremDepth = c.createGain();
    tremDepth.gain.value = 0.015;
    this.trem = c.createOscillator();
    this.trem.frequency.value = 0.2;
    this.trem.connect(tremDepth);
    tremDepth.connect(this.subGain.gain);
    this.sub.connect(this.subGain);
    this.subGain.connect(this.out);
    this.sub.start();
    this.trem.start();
    this.schedule();
  }

  setTension(v: number): void {
    this.tension = clamp01(v);
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(500 + 900 * this.tension, t, 2);
    this.subGain.gain.setTargetAtTime(0.03 + 0.04 * this.tension, t, 2);
    this.trem.frequency.setTargetAtTime(0.2 + 1.2 * this.tension, t, 2);
  }

  private schedule(): void {
    const secs = this.tension > 0.5 ? 6 : 9;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.nextChord();
      } catch {
        /* context closed */
      }
      this.schedule();
    }, secs * 1000);
  }

  private nextChord(): void {
    this.step = (this.step + 1 + (Math.random() < 0.25 ? 1 : 0)) % 4;
    const pool = this.tension > 0.5 ? TENSE_CHORDS : PEACE_CHORDS;
    const chord = pool[this.step];
    const t = this.ctx.currentTime;
    this.oscs.forEach((o, k) => o.frequency.setTargetAtTime(midiHz(chord[k >> 1]), t, 1.5));
    this.sub.frequency.setTargetAtTime(midiHz(chord[0] - 12), t, 2);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const t = this.ctx.currentTime;
    try {
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setTargetAtTime(SILENT, t, 0.5);
      for (const o of [...this.oscs, this.sub, this.trem, this.lfo]) o.stop(t + 3);
      setTimeout(() => {
        try {
          this.out.disconnect();
        } catch {
          /* already gone */
        }
      }, 3500);
    } catch {
      /* context closed */
    }
  }
}

// ================================================================================================ manager

export class AudioManager {
  readonly limiter = new SoundLimiter();
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private pad: Pad | null = null;
  private failed = false;
  private disposed = false;
  private now: () => number;
  private storage: KeyValueStore | null;
  private createContext: () => BaseAudioContext | null;
  private tension = 0;
  private autoTension = 0;
  private alarm = 0;
  private alarmAt = 0;
  // update() bookkeeping
  private seenEvents = new WeakSet<GameEvent>();
  private seenEffects = new WeakSet<Effect>();
  private lastState: GameState | null = null;
  private lastCountdown = -1;
  private unlockCleanup: (() => void) | null = null;
  private visCleanup: (() => void) | null = null;

  constructor(opts: AudioManagerOptions = {}) {
    this.now = opts.now ?? defaultNow;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.createContext = opts.createContext ?? defaultCreateContext;
    this.load();
    if (opts.context) this.attach(opts.context);
  }

  // -------------------------------------------------------------------------------------------- public API

  /** Call from the first user gesture (click / key): creates or resumes the AudioContext (autoplay policy). */
  unlock(): void {
    if (this.disposed) return;
    try {
      if (!this.ctx && !this.failed) {
        const c = this.createContext();
        if (!c) {
          this.failed = true;
          return;
        }
        this.attach(c);
        this.watchVisibility();
      }
      const c = this.ctx as (BaseAudioContext & { resume?: () => Promise<void> }) | null;
      if (c && c.state === 'suspended' && typeof c.resume === 'function') c.resume().catch(() => {});
      this.syncMusic();
    } catch {
      this.failed = true;
    }
  }

  /** Calls unlock() on the first pointerdown / keydown on `target` (default window). Returns a remover. */
  unlockOnGesture(target?: EventTarget): () => void {
    try {
      const tgt = target ?? (typeof window !== 'undefined' ? window : null);
      if (!tgt) return () => {};
      const fn = () => {
        this.unlock();
        if (this.ctx && this.ctx.state === 'running') off();
      };
      const off = () => {
        tgt.removeEventListener('pointerdown', fn, true);
        tgt.removeEventListener('keydown', fn, true);
        this.unlockCleanup = null;
      };
      tgt.addEventListener('pointerdown', fn, true);
      tgt.addEventListener('keydown', fn, true);
      this.unlockCleanup?.();
      this.unlockCleanup = off;
      return off;
    } catch {
      return () => {};
    }
  }

  /** Volumes 0..1 (saved). Pass undefined to keep one. */
  setVolume(master?: number, sfx?: number, music?: number): void {
    if (master !== undefined) this.settings.master = clamp01(master);
    if (sfx !== undefined) this.settings.sfx = clamp01(sfx);
    if (music !== undefined) this.settings.music = clamp01(music);
    this.applyGains();
    this.syncMusic();
    this.save();
  }

  setMuted(muted: boolean): void {
    this.settings.muted = !!muted;
    this.applyGains();
    this.syncMusic();
    this.save();
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  /** True when an AudioContext exists and is running. */
  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** The context in use (null before unlock() or without audio). */
  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  /**
   * Plays a sound now. Returns true when it passed the rate limit and voice cap (it is then synthesized if
   * audio is available); false when it was dropped or muted.
   */
  play(id: SoundId, opts: PlayOptions = {}): boolean {
    if (this.disposed || !(id in SOUND_INFO)) return false;
    const vol = opts.volume === undefined ? 1 : clamp01(opts.volume);
    if (this.settings.muted || vol <= 0) return false;
    let now: number;
    try {
      now = this.now();
    } catch {
      return false;
    }
    if (!this.limiter.accept(id, now)) return false;
    this.synth(id, vol, opts.pan ?? 0);
    return true;
  }

  /** Maps a sim event to a sound (see soundForEvent). Returns the sound played, or null. */
  onGameEvent(e: GameEvent, humanId: number, screenPan?: number, near?: boolean): SoundId | null {
    try {
      const ch = soundForEvent(e, humanId, near);
      if (!ch) return null;
      if (ch.id === 'underAttack' || ch.id === 'shipHorn' || ch.id === 'capitalLost' || (ch.id === 'missileLaunch' && e.players[0] !== humanId)) {
        this.raiseAlarm(ch.id === 'capitalLost' ? 1 : 0.7);
      }
      return this.play(ch.id, { volume: ch.volume, pan: screenPan }) ? ch.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Maps a sim effect to a sound. Pass `screenPan` only for effects on (or near) the screen; `mine` says whether
   * a 'capture' is the human's (when known). Returns the sound played, or null.
   */
  onEffect(e: Effect, humanId: number, screenPan?: number, mine?: boolean): SoundId | null {
    try {
      void humanId;
      const ch = soundForEffect(e, screenPan, mine);
      if (!ch) return null;
      return this.play(ch.id, { volume: ch.volume, pan: screenPan }) ? ch.id : null;
    } catch {
      return null;
    }
  }

  /** Ambient music tension 0 (peace) .. 1 (your nation under attack). update() also raises it by itself. */
  setTension(v: number): void {
    this.tension = clamp01(v);
    this.applyTension();
  }

  /**
   * One call per frame does everything: drains new events and effects of `state` (each once), spawn countdown
   * ticks, auto tension. `view` (the Camera) gives stereo pan and the on-screen test; without it nothing is panned.
   */
  /**
   * Treats everything `state` holds now as history (no sounds for it): an online client replaying a catch-up calls
   * this instead of update(), so minutes of replayed events don't all sound at once.
   */
  skipTo(state: GameState): void {
    this.lastState = null;
    this.update(state, undefined, true);
  }

  update(state: GameState, view?: ScreenView, silent = false): void {
    if (this.disposed) return;
    if (silent) {
      this.lastState = state;
      this.seenEvents = new WeakSet();
      this.seenEffects = new WeakSet();
      for (const e of state.events) this.seenEvents.add(e);
      for (const e of state.effects) this.seenEffects.add(e);
      return;
    }
    try {
      const h = state.humanId;
      if (state !== this.lastState) {
        // New game: everything already there is history, not news.
        this.lastState = state;
        this.seenEvents = new WeakSet();
        this.seenEffects = new WeakSet();
        for (const e of state.events) this.seenEvents.add(e);
        for (const e of state.effects) this.seenEffects.add(e);
        this.lastCountdown = -1;
        this.alarm = 0;
      }
      const evs = state.events;
      let k = evs.length - 1;
      while (k >= 0 && !this.seenEvents.has(evs[k])) k--;
      for (let i = k + 1; i < evs.length; i++) {
        const e = evs[i];
        this.seenEvents.add(e);
        const pan = e.tile >= 0 && view ? this.tilePan(state, view, e.tile) : undefined;
        const near = e.tile >= 0 && view ? this.tileNear(state, view, e.tile) : undefined;
        this.onGameEvent(e, h, pan ?? undefined, near);
      }
      const w = state.map.width;
      for (const fx of state.effects) {
        if (this.seenEffects.has(fx)) continue;
        this.seenEffects.add(fx);
        let pan: number | undefined;
        if (view) {
          const s = view.tileToScreen(fx.x, fx.y);
          const m = Math.max(view.viewW, view.viewH) * 0.15;
          if (s.x >= -m && s.y >= -m && s.x <= view.viewW + m && s.y <= view.viewH + m) pan = panFromScreenX(s.x, view.viewW);
        }
        let mine: boolean | undefined;
        if (fx.kind === 'capture') {
          const tile = Math.floor(fx.y) * w + Math.floor(fx.x);
          mine = h > 0 && state.map.owner[tile] === h;
        }
        this.onEffect(fx, h, pan, mine);
      }
      // Spawn countdown: a tick for each of the last 5 seconds.
      if (state.phase === 'spawn') {
        const s = Math.ceil(state.spawnLeft);
        if (s !== this.lastCountdown) {
          if (s >= 1 && s <= 5 && this.lastCountdown !== -1) this.play('countdown', { volume: s === 1 ? 1 : 0.8 });
          this.lastCountdown = s;
        }
      } else this.lastCountdown = -1;
      // Auto tension: attacks on us, plus a decaying alarm from recent warnings.
      let onMe = 0;
      if (h > 0 && state.phase === 'playing') for (const a of state.attacks) if (a.target === h) onMe++;
      this.autoTension = Math.min(1, Math.max(onMe * 0.3, this.currentAlarm()));
      this.applyTension();
    } catch {
      /* never break the game loop */
    }
  }

  /** Stops everything and releases the AudioContext. The manager is a no-op afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pad?.stop();
      this.pad = null;
      this.unlockCleanup?.();
      this.visCleanup?.();
      const c = this.ctx as (BaseAudioContext & { close?: () => Promise<void> }) | null;
      if (c && typeof c.close === 'function' && c.state !== 'closed') c.close().catch(() => {});
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }

  // -------------------------------------------------------------------------------------------- internals

  private attach(c: BaseAudioContext): void {
    try {
      this.ctx = c;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 6;
      comp.ratio.value = 12;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      comp.connect(c.destination);
      this.master = c.createGain();
      this.master.connect(comp);
      this.sfxBus = c.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = c.createGain();
      this.musicBus.connect(this.master);
      const len = Math.floor(c.sampleRate * 2);
      this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.applyGains(true);
    } catch {
      this.ctx = null;
      this.failed = true;
    }
  }

  private applyGains(instant = false): void {
    const c = this.ctx;
    if (!c || !this.master || !this.sfxBus || !this.musicBus) return;
    try {
      const s = this.settings;
      const t = c.currentTime;
      const set = (p: AudioParam, v: number) => {
        if (instant) p.setValueAtTime(v, t);
        else p.setTargetAtTime(v, t, 0.05);
      };
      set(this.master.gain, s.muted ? 0 : s.master);
      set(this.sfxBus.gain, s.sfx);
      set(this.musicBus.gain, s.music * 0.6);
    } catch {
      /* ignore */
    }
  }

  private syncMusic(): void {
    const c = this.ctx;
    if (!c || this.disposed) return;
    const want = this.settings.music > 0 && !this.settings.muted && c.state !== 'closed';
    try {
      if (want && !this.pad && this.musicBus) {
        this.pad = new Pad(c, this.musicBus);
        this.applyTension();
      } else if (!want && this.pad) {
        this.pad.stop();
        this.pad = null;
      }
    } catch {
      this.pad = null;
    }
  }

  private currentAlarm(): number {
    if (this.alarm <= 0) return 0;
    const dt = (this.now() - this.alarmAt) / 1000;
    return this.alarm * Math.pow(0.5, Math.max(0, dt) / 20); // half-life 20 s
  }

  private raiseAlarm(v: number): void {
    const cur = this.currentAlarm();
    this.alarm = Math.max(cur, v);
    this.alarmAt = this.now();
  }

  /** Tension the music follows: the larger of setTension() and the automatic one. */
  get effectiveTension(): number {
    return Math.max(this.tension, this.autoTension, this.currentAlarm());
  }

  private applyTension(): void {
    if (!this.pad) return;
    try {
      this.pad.setTension(this.effectiveTension);
    } catch {
      /* ignore */
    }
  }

  private tilePan(state: GameState, view: ScreenView, tile: number): number | undefined {
    const w = state.map.width;
    const s = view.tileToScreen((tile % w) + 0.5, Math.floor(tile / w) + 0.5);
    return panFromScreenX(s.x, view.viewW);
  }

  /** True when `tile` is on screen or less than one view width / height beyond its edge. */
  private tileNear(state: GameState, view: ScreenView, tile: number): boolean {
    const w = state.map.width;
    const s = view.tileToScreen((tile % w) + 0.5, Math.floor(tile / w) + 0.5);
    return s.x >= -view.viewW && s.y >= -view.viewH && s.x <= view.viewW * 2 && s.y <= view.viewH * 2;
  }

  private synth(id: SoundId, vol: number, pan: number): void {
    const c = this.ctx;
    if (!c || !this.sfxBus || !this.noiseBuf || c.state === 'closed') return;
    try {
      const t = c.currentTime + 0.01;
      const g = c.createGain();
      g.gain.value = vol;
      let out: AudioNode = g;
      const p = Number.isFinite(pan) ? clamp(pan, -1, 1) : 0;
      if (p !== 0 && typeof (c as AudioContext).createStereoPanner === 'function') {
        const sp = (c as AudioContext).createStereoPanner();
        sp.pan.value = p;
        g.connect(sp);
        out = sp;
      }
      out.connect(this.sfxBus);
      const v = new Voice(c, g, t, this.noiseBuf);
      RECIPES[id](v);
      // Free the voice's bus nodes once it is done (sources stop by themselves).
      const ms = (v.end - c.currentTime) * 1000 + 200;
      const offline = typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext;
      if (!offline && typeof setTimeout === 'function') {
        setTimeout(() => {
          try {
            out.disconnect();
            if (out !== g) g.disconnect();
          } catch {
            /* ignore */
          }
        }, ms);
      }
    } catch {
      /* a failed sound is silence, never an error */
    }
  }

  private watchVisibility(): void {
    try {
      if (typeof document === 'undefined') return;
      const fn = () => {
        const c = this.ctx as AudioContext | null;
        if (!c || typeof c.suspend !== 'function') return;
        if (document.hidden) c.suspend().catch(() => {});
        else c.resume().catch(() => {});
      };
      document.addEventListener('visibilitychange', fn);
      this.visCleanup = () => document.removeEventListener('visibilitychange', fn);
    } catch {
      /* ignore */
    }
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(AUDIO_STORAGE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw) as Partial<AudioSettings>;
      const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : d);
      this.settings = {
        master: num(o.master, DEFAULT_AUDIO_SETTINGS.master),
        sfx: num(o.sfx, DEFAULT_AUDIO_SETTINGS.sfx),
        music: num(o.music, DEFAULT_AUDIO_SETTINGS.music),
        muted: typeof o.muted === 'boolean' ? o.muted : DEFAULT_AUDIO_SETTINGS.muted,
      };
    } catch {
      /* corrupt or blocked storage: defaults */
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode / quota: settings just aren't remembered */
    }
  }
}
