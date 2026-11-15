// Sound and music. Effects are recordings (sound/library.ts says which file plays for each sound), decoded into Web
// Audio buffers in the background after the first click; every play picks a variant take (never the same one twice
// in a row) and varies its pitch and level a little, so repeats never sound the same. A sound whose file is not loaded
// (yet, or at all) plays its synthesized version below, so nothing is ever silent and nothing throws. Music is real
// music streamed by sound/music.ts, its mood following the game.
//
// Not everything is heard at once: sounds at a map place (fighting) play only when that place is on screen or just
// off it, and their volume follows the zoom (sound/spatial.ts): full close up, fading out as the camera pulls back,
// the small ones silent when far out. Your own nation's news (alerts, alliances, victory, defeat) and the UI always
// play. Per-sound rate limits (real time, so x4 game speed does not multiply the noise), a per-sound cap on copies
// playing at once, a global voice cap and a soft compressor on the master bus keep a big battle from clipping.
//
// Without an AudioContext (Node tests, old browsers, blocked audio) every method still works and never throws:
// the rate limiting runs as usual, nothing is played. See docs/AUDIO.md.

import { fogEvent, fogFor } from './fog/fogView';
import type { Effect, GameEvent, GameState } from '../sim/types';
import { isTribe } from '../sim/types';
import { BattleEars, type BattleCue } from './sound/battle';
import { SampleBank } from './sound/bank';
import { audioFormats, SFX, type SampleSet } from './sound/library';
import { LOUDNESS } from './sound/loudness.gen';
import { initialMood, MusicPlayer, stepMood, type MoodState, type MusicMood } from './sound/music';
import { gunfireLevel, MIN_AUDIBLE, pickVariant, playVariation, screenGain, spatialGain, zoomGain, type SpatialTier } from './sound/spatial';

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
  | 'explosionBig'
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
  | 'shot'
  | 'bombard'
  | 'tankShot'
  | 'tankDestroyed'
  | 'planeCrash'
  | 'sonarPing';

/** 0 = cosmetic (dropped first), 1 = normal, 2 = important, 3 = critical (ignores the voice cap). */
export type SoundPriority = 0 | 1 | 2 | 3;

export interface SoundInfo {
  /** seconds a play counts as a voice (for the voice cap and the per-sound cap): its loud part, not the whole tail */
  dur: number;
  /** minimum real time between two plays of this sound, ms */
  gapMs: number;
  priority: SoundPriority;
  /** copies of this sound playing at once, at most (default 2) */
  cap?: number;
  /** a sound at a map place: heard only on (or just off) screen, by zoom (sound/spatial.ts) */
  spatial?: SpatialTier;
}

export const SOUND_INFO: Readonly<Record<SoundId, SoundInfo>> = {
  uiClick: { dur: 0.06, gapMs: 40, priority: 0 },
  uiHover: { dur: 0.04, gapMs: 70, priority: 0, cap: 1 },
  uiError: { dur: 0.2, gapMs: 250, priority: 1, cap: 1 },
  buildPlaced: { dur: 0.3, gapMs: 80, priority: 1 },
  buildingDone: { dur: 1.0, gapMs: 350, priority: 1 },
  buildingLost: { dur: 0.4, gapMs: 600, priority: 1 },
  researchDone: { dur: 1.2, gapMs: 800, priority: 2, cap: 1 },
  attackLaunched: { dur: 0.65, gapMs: 1200, priority: 1, cap: 1 },
  capture: { dur: 0.03, gapMs: 70, priority: 0 },
  underAttack: { dur: 2.0, gapMs: 4000, priority: 3, cap: 1 },
  allianceRequest: { dur: 1.7, gapMs: 1500, priority: 2, cap: 1 },
  allianceFormed: { dur: 1.9, gapMs: 1500, priority: 2, cap: 1 },
  allianceBroken: { dur: 1.5, gapMs: 1500, priority: 2, cap: 1 },
  allianceExpired: { dur: 1.4, gapMs: 1500, priority: 1, cap: 1 },
  capitalLost: { dur: 2.0, gapMs: 3000, priority: 3, cap: 1 },
  capitalTaken: { dur: 1.2, gapMs: 3000, priority: 2, cap: 1 },
  cityTaken: { dur: 1.0, gapMs: 700, priority: 2, cap: 1 },
  cityLost: { dur: 1.2, gapMs: 700, priority: 2, cap: 1 },
  shipSunk: { dur: 1.3, gapMs: 600, priority: 1, spatial: 'big' },
  explosion: { dur: 1.0, gapMs: 110, priority: 1, cap: 4, spatial: 'small' },
  explosionBig: { dur: 2.0, gapMs: 250, priority: 2, cap: 3, spatial: 'big' },
  atomBomb: { dur: 5.5, gapMs: 1500, priority: 3, cap: 2, spatial: 'big' },
  missileLaunch: { dur: 1.5, gapMs: 500, priority: 1, spatial: 'medium' },
  shipHorn: { dur: 1.7, gapMs: 4000, priority: 2, cap: 1 },
  tradeCoin: { dur: 0.42, gapMs: 500, priority: 0, cap: 1 },
  unitLost: { dur: 0.8, gapMs: 800, priority: 1, spatial: 'medium' },
  eliminated: { dur: 2.3, gapMs: 2500, priority: 1, cap: 1 },
  victory: { dur: 3.0, gapMs: 5000, priority: 3, cap: 1 },
  defeat: { dur: 3.0, gapMs: 5000, priority: 3, cap: 1 },
  countdown: { dur: 0.1, gapMs: 400, priority: 2, cap: 1 },
  countdownGo: { dur: 0.7, gapMs: 1000, priority: 2, cap: 1 },
  shot: { dur: 0.3, gapMs: 120, priority: 0, cap: 3, spatial: 'small' },
  bombard: { dur: 1.0, gapMs: 300, priority: 1, spatial: 'medium' },
  tankShot: { dur: 0.4, gapMs: 90, priority: 0, cap: 3, spatial: 'small' },
  tankDestroyed: { dur: 0.8, gapMs: 150, priority: 1, cap: 3, spatial: 'medium' },
  planeCrash: { dur: 1.5, gapMs: 300, priority: 1, spatial: 'medium' },
  sonarPing: { dur: 1.5, gapMs: 1200, priority: 0, cap: 1, spatial: 'medium' },
};

export const SOUND_IDS = Object.keys(SOUND_INFO) as SoundId[];

/** Voices playing at once: cosmetic sounds stop at SOFT_VOICES, everything but critical ones at MAX_VOICES. */
export const SOFT_VOICES = 8;
export const MAX_VOICES = 14;
/** Copies of one sound playing at once when SOUND_INFO does not say. */
export const DEFAULT_SOUND_CAP = 2;

// ================================================================================================ settings

export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = { master: 0.6, sfx: 0.8, music: 0.5, muted: false };
/** Settings since the real music came in (version 2). */
export const AUDIO_STORAGE_KEY = 'borderfall.audio.v2';
/** The settings of version 1, when music was a synth pad that was off by default: read once, then replaced. */
export const LEGACY_AUDIO_STORAGE_KEY = 'borderfall.audio.v1';

const num01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : d);

/** Settings from a stored object (anything: missing or broken fields take the default). */
export function parseAudioSettings(o: unknown): AudioSettings {
  const r = (o && typeof o === 'object' ? o : {}) as Partial<Record<keyof AudioSettings, unknown>>;
  const d = DEFAULT_AUDIO_SETTINGS;
  return { master: num01(r.master, d.master), sfx: num01(r.sfx, d.sfx), music: num01(r.music, d.music), muted: typeof r.muted === 'boolean' ? r.muted : d.muted };
}

/**
 * Version 1 settings to version 2: master, effects and mute are kept; music comes on at the new default, because
 * version 1 saved music 0 for everyone who never touched it (it was the default). A player who had turned the old
 * pad up keeps that level.
 */
export function migrateAudioSettings(v1: unknown): AudioSettings {
  const s = parseAudioSettings(v1);
  const old = (v1 && typeof v1 === 'object' ? (v1 as { music?: unknown }).music : undefined) as unknown;
  s.music = typeof old === 'number' && Number.isFinite(old) && old > 0 ? clamp01(old) : DEFAULT_AUDIO_SETTINGS.music;
  return s;
}

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
  /** screen px per tile; without it sounds count as close up */
  zoom?: number;
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
 * `near` = false when the event's tile is far off screen: a city you took or a ship sinking is then silent (the
 * event log still has it); undefined = unknown, treated as near.
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
      // a city of yours lost always sounds (your nation's news); one you took only near the camera
      if (mine && CITY_CAPTURED.test(e.message)) return first ? (far ? null : pick('cityTaken')) : pick('cityLost');
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
 * a 'capture' is the human's own; when unknown, captures only sound on screen. (With a camera, update() hears the
 * fighting through sound/battle.ts instead, which also tells a warship's cannon from anti-air fire and a unit's death
 * from a hit; this is the plain mapping.)
 */
export function soundForEffect(e: Effect, screenPan: number | undefined, mine?: boolean): SoundChoice | null {
  const onScreen = screenPan !== undefined;
  switch (e.kind) {
    case 'nuke':
      return { id: 'atomBomb', volume: onScreen ? 1 : 0.75 };
    case 'explosion':
      if (!onScreen) return null;
      if (e.radius >= 4) return { id: 'explosionBig', volume: 0.85 };
      return { id: 'explosion', volume: e.radius >= 2.5 ? 0.85 : 0.6 };
    case 'barrage':
      return onScreen ? { id: 'bombard', volume: 1 } : null;
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

/** Per-sound minimum gaps, a per-sound cap on copies at once and a global voice cap; pure bookkeeping. */
export class SoundLimiter {
  private lastAt = new Map<SoundId, number>();
  private ends: number[] = [];
  private endsOf = new Map<SoundId, number[]>();

  /** Voices still sounding at `now`. */
  active(now: number): number {
    if (this.ends.length) this.ends = this.ends.filter((t) => t > now);
    return this.ends.length;
  }

  /** Copies of `id` still sounding at `now`. */
  activeOf(id: SoundId, now: number): number {
    const e = this.endsOf.get(id);
    if (!e || !e.length) return 0;
    let n = 0;
    for (let i = 0; i < e.length; i++) if (e[i] > now) e[n++] = e[i];
    e.length = n;
    return n;
  }

  /** True when `id` would pass the gap and the caps at `now` (nothing is counted). */
  allows(id: SoundId, now: number): boolean {
    const info = SOUND_INFO[id];
    if (!info) return false;
    const last = this.lastAt.get(id);
    if (last !== undefined && now - last < info.gapMs && now >= last) return false;
    if (this.activeOf(id, now) >= (info.cap ?? DEFAULT_SOUND_CAP)) return false;
    const n = this.active(now);
    if (info.priority === 0 && n >= SOFT_VOICES) return false;
    if (info.priority < 3 && n >= MAX_VOICES) return false;
    return true;
  }

  /** True (and the voice is counted) when `id` may play at `now` (ms). */
  accept(id: SoundId, now: number): boolean {
    if (!this.allows(id, now)) return false;
    const end = now + SOUND_INFO[id].dur * 1000;
    this.lastAt.set(id, now);
    this.ends.push(end);
    let e = this.endsOf.get(id);
    if (!e) this.endsOf.set(id, (e = []));
    e.push(end);
    return true;
  }

  reset(): void {
    this.lastAt.clear();
    this.ends = [];
    this.endsOf.clear();
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
  // the sounds that came with the recordings, synthesized for when their file is not loaded
  explosionBig: (v) => {
    v.noise({ dur: 1.6, gain: 0.32, fs: [2200, 700, 120], attack: 0.004 });
    v.tone({ f: 80, f2: 30, dur: 0.9, gain: 0.36, attack: 0.003 });
    v.noise({ at: 0.12, dur: 1.2, gain: 0.12, fs: [400, 150], attack: 0.05, am: { rate: 7, depth: 0.5 } });
  },
  bombard: (v) => {
    for (let i = 0; i < 3; i++) {
      v.tone({ f: 95 + i * 6, f2: 45, at: i * 0.18, dur: 0.3, gain: 0.16, attack: 0.002 });
      v.noise({ at: i * 0.18, dur: 0.35, gain: 0.1, fs: [1800, 300], attack: 0.002 });
    }
  },
  tankShot: (v) => {
    v.tone({ f: 120, f2: 60, dur: 0.22, gain: 0.16, attack: 0.002 });
    v.noise({ dur: 0.25, gain: 0.1, fs: [2600, 500], attack: 0.001 });
  },
  tankDestroyed: (v) => {
    v.noise({ dur: 0.8, gain: 0.24, fs: [1800, 600, 140], attack: 0.003 });
    v.tone({ type: 'triangle', f: 160, f2: 70, dur: 0.5, gain: 0.14, lp: [900], attack: 0.003 });
  },
  planeCrash: (v) => {
    v.noise({ dur: 0.9, gain: 0.08, filter: 'bandpass', fs: [2600, 900], q: 1.5, attack: 0.05 });
    v.noise({ at: 0.75, dur: 0.9, gain: 0.26, fs: [2000, 600, 130], attack: 0.004 });
    v.tone({ f: 90, f2: 35, at: 0.75, dur: 0.6, gain: 0.26, attack: 0.003 });
  },
  sonarPing: (v) => {
    v.tone({ f: 1250, dur: 1.3, gain: 0.05, attack: 0.004, lp: [3000, 1800] });
    v.tone({ f: 1250, detune: 8, at: 0.35, dur: 0.9, gain: 0.018, attack: 0.004 });
  },
};

// ================================================================================================ manager

/** Music bus level at music volume 1 (music files are levelled to about -20 LUFS, effects to about -16). */
const MUSIC_LEVEL = 0.85;
/** Your nation counts as at war this long after its last attack on (or from) another nation, ms. */
const WAR_MEMORY_MS = 30_000;
/** Effects older than this (ticks, 10 per second) are history, not news (as fx/). */
const FRESH_TICKS = 15;
/** The fighting in view (captures, tanks firing) fades with this time constant, ms. */
const HEAT_TAU_MS = 2500;
/** No game update() for this long: the title screen (the menu music plays). */
const MENU_AFTER_MS = 1500;
/** Sounds that duck the music for a moment: [music gain at the bottom, seconds held]. */
const DUCK: Partial<Record<SoundId, readonly [number, number]>> = {
  atomBomb: [0.25, 5],
  capitalLost: [0.5, 2.5],
  underAttack: [0.6, 1.6],
  cityLost: [0.65, 1.5],
  allianceRequest: [0.7, 1.5],
  allianceFormed: [0.7, 1.5],
  allianceBroken: [0.65, 1.5],
  researchDone: [0.75, 1.2],
  shipHorn: [0.7, 1.5],
};

/**
 * Evens out a variant take that sits quieter or louder than its sound's first take (peak-limited recordings land below
 * the -16 LUFS target): at most 4 dB either way, so the mix in sound/library.ts holds for every take.
 */
export function takeTrim(set: SampleSet, file: string): number {
  const ref = LOUDNESS[set.files[0]];
  const l = LOUDNESS[file];
  if (ref === undefined || l === undefined) return 1;
  return Math.pow(10, clamp(ref - l, -4, 4) / 20);
}

export class AudioManager {
  readonly limiter = new SoundLimiter();
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private ctx: BaseAudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private bank: SampleBank | null = null;
  private music: MusicPlayer | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private mood: MoodState;
  private failed = false;
  private disposed = false;
  private hidden = false;
  private now: () => number;
  private storage: KeyValueStore | null;
  private createContext: () => BaseAudioContext | null;
  private tension = 0;
  private autoTension = 0;
  private alarm = 0;
  private alarmAt = 0;
  // the game, as update() last saw it (for the music)
  private lastGameAt = -Infinity;
  private lastWarAt = -Infinity;
  private gameOver = false;
  private stingUntil = -Infinity;
  private duckUntil = 0;
  private duckDepth = 1;
  // the fighting in view and the gunfire bed under it
  private heat = 0;
  private heatAt = 0;
  private bed: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private bedQuietSince = 0;
  // per-play variation
  private lastVariant = new Map<SoundId, number>();
  private lastRate = new Map<SoundId, number>();
  // update() bookkeeping
  private seenEvents = new WeakSet<GameEvent>();
  private seenEffects = new WeakSet<Effect>();
  private lastState: GameState | null = null;
  private lastCountdown = -1;
  private ears = new BattleEars();
  private cues: BattleCue[] = [];
  private unlockCleanup: (() => void) | null = null;
  private visCleanup: (() => void) | null = null;

  constructor(opts: AudioManagerOptions = {}) {
    this.now = opts.now ?? defaultNow;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.createContext = opts.createContext ?? defaultCreateContext;
    this.mood = initialMood(this.safeNow());
    this.load();
    if (opts.context) this.attach(opts.context);
  }

  // -------------------------------------------------------------------------------------------- public API

  /**
   * Call from a user gesture (click / key): creates or resumes the AudioContext (autoplay policy). The first time it
   * also starts loading the recorded effects in the background and starts the music.
   */
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
        this.startMedia();
      }
      const c = this.ctx as (BaseAudioContext & { resume?: () => Promise<void> }) | null;
      if (c && c.state === 'suspended' && typeof c.resume === 'function' && !this.hidden) c.resume().catch(() => {});
      this.music?.gesture();
      this.musicTick();
    } catch {
      this.failed = true;
    }
  }

  /** Calls unlock() on pointerdown / keydown on `target` (default window): the first one, and any later one the
   * browser needs to let the music play. Returns a remover. */
  unlockOnGesture(target?: EventTarget): () => void {
    try {
      const tgt = target ?? (typeof window !== 'undefined' ? window : null);
      if (!tgt) return () => {};
      const fn = () => {
        if (this.ctx && this.ctx.state === 'running' && !this.music?.needsGesture) return;
        this.unlock();
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
    this.musicTick();
    this.save();
  }

  setMuted(muted: boolean): void {
    this.settings.muted = !!muted;
    this.applyGains();
    this.musicTick();
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

  /** The music's mood now (menu, peace, war, battle). */
  get musicMood(): MusicMood {
    return this.mood.mood;
  }

  /** The music track playing, or null. */
  get musicTrack(): string | null {
    return this.music?.track ?? null;
  }

  /** How the recorded effects are loading (null before unlock()). */
  get sampleStats(): { loaded: number; failed: number; bytes: number; total: number } | null {
    return this.bank ? { ...this.bank.stats } : null;
  }

  /** The gunfire bed's level now (0..1, before the volumes). */
  get gunfireLevel(): number {
    return this.bedTarget;
  }
  private bedTarget = 0;

  /**
   * Plays a sound now. Returns true when it passed the rate limit and the caps (it then plays if audio is
   * available: its recording when loaded, else its synthesized version); false when it was dropped or muted.
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
    this.sound(id, vol, opts.pan ?? 0, now);
    return true;
  }

  /** Maps a sim event to a sound (see soundForEvent). Returns the sound played, or null. */
  onGameEvent(e: GameEvent, humanId: number, screenPan?: number, near?: boolean): SoundId | null {
    try {
      const ch = soundForEvent(e, humanId, near);
      if (!ch) return null;
      this.alarmFor(ch.id, e, humanId);
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

  /** Music tension 0 (peace) .. 1 (your nation under attack). update() also raises it by itself. */
  setTension(v: number): void {
    this.tension = clamp01(v);
  }

  /**
   * Treats everything `state` holds now as history (no sounds for it): an online client replaying a catch-up calls
   * this instead of update(), so minutes of replayed events don't all sound at once.
   */
  skipTo(state: GameState): void {
    this.lastState = null;
    this.update(state, undefined, true);
  }

  /**
   * One call per frame does everything: drains new events and effects of `state` (each once), hears the fighting on
   * screen, spawn countdown ticks, the gunfire bed, the music's mood. `view` (the Camera) gives the on-screen test,
   * the zoom and the stereo pan; without it nothing at a map place is heard (only your nation's news).
   */
  update(state: GameState, view?: ScreenView, silent = false): void {
    if (this.disposed) return;
    const now = this.safeNow();
    this.lastGameAt = now;
    if (silent) {
      this.lastState = state;
      this.seenEvents = new WeakSet();
      this.seenEffects = new WeakSet();
      for (const e of state.events) this.seenEvents.add(e);
      for (const e of state.effects) this.seenEffects.add(e);
      this.ears.reset(state);
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
        this.ears.reset(state);
        this.lastCountdown = -1;
        this.alarm = 0;
        this.heat = 0;
        this.lastWarAt = -Infinity;
        this.stingUntil = -Infinity;
        this.gameOver = false;
      }
      const w = state.map.width;
      const zoom = view && Number.isFinite(view.zoom) ? view.zoom : undefined;
      // ---- events (your nation's news; the fighting is heard from the effects below when there is a camera)
      const evs = state.events;
      let k = evs.length - 1;
      while (k >= 0 && !this.seenEvents.has(evs[k])) k--;
      for (let i = k + 1; i < evs.length; i++) {
        this.seenEvents.add(evs[i]);
        const e = state.fog ? fogEvent(state, evs[i]) : evs[i]; // fog of war: no sound placed on land you never saw
        const near = e.tile >= 0 && view ? this.tileNear(state, view, e.tile) : undefined;
        const ch = soundForEvent(e, h, near);
        if (!ch) continue;
        this.alarmFor(ch.id, e, h);
        let vol = ch.volume;
        let pan = e.tile >= 0 && view ? this.tilePan(state, view, e.tile) : undefined;
        const tier = SOUND_INFO[ch.id].spatial;
        if (tier && view) {
          // heard where it happens (sound/battle.ts), except an atom bomb on your own land, which is your news too
          if (ch.id !== 'atomBomb' || e.tile < 0 || state.map.owner[e.tile] !== h) continue;
          const s = view.tileToScreen((e.tile % w) + 0.5, Math.floor(e.tile / w) + 0.5);
          vol = Math.max(0.6, spatialGain('big', zoom, s.x, s.y, view.viewW, view.viewH));
          if (screenGain('big', s.x, s.y, view.viewW, view.viewH) <= 0) pan = 0;
        }
        this.play(ch.id, { volume: vol, pan });
      }
      // ---- effects
      const fog = state.fog ? fogFor(state) : null;
      const fresh = state.tick - FRESH_TICKS;
      for (const fx of state.effects) {
        if (this.seenEffects.has(fx)) continue;
        this.seenEffects.add(fx);
        // fog of war: no sound from fights and bombs you can't see
        if (fog?.active && !fog.visible(Math.max(0, Math.min(state.map.height - 1, Math.floor(fx.y))) * w + Math.max(0, Math.min(w - 1, Math.floor(fx.x))))) continue;
        if (fx.kind === 'capture') {
          // the tick of land changing hands: yours anywhere, others' on screen and close up
          const tile = Math.floor(fx.y) * w + Math.floor(fx.x);
          const mine = h > 0 && state.map.owner[tile] === h;
          let pan: number | undefined;
          let g = 1;
          if (view) {
            const s = view.tileToScreen(fx.x, fx.y);
            const on = screenGain('small', s.x, s.y, view.viewW, view.viewH);
            if (on > 0) pan = panFromScreenX(s.x, view.viewW);
            if (!mine) g = on * zoomGain('small', zoom);
          }
          const ch = soundForEffect(fx, pan, mine);
          if (ch && ch.volume * g >= MIN_AUDIBLE) this.play(ch.id, { volume: ch.volume * g, pan });
        }
        if (fx.tick < fresh) continue;
        if (view) this.ears.effect(state, fx, this.cues);
        else if (fx.kind === 'nuke') this.onEffect(fx, h, undefined); // no camera: an atom bomb still rumbles
      }
      this.ears.tick(state, this.cues);
      // ---- the fighting on screen, by zoom
      let heatIn = 0;
      if (view) {
        for (const c of this.cues) {
          const s = view.tileToScreen(c.x, c.y);
          if (c.id === 'front') {
            heatIn += c.volume * screenGain('medium', s.x, s.y, view.viewW, view.viewH);
            continue;
          }
          const g = spatialGain(SOUND_INFO[c.id].spatial ?? 'medium', zoom, s.x, s.y, view.viewW, view.viewH);
          if (g < MIN_AUDIBLE) continue;
          this.play(c.id, { volume: c.volume * g, pan: panFromScreenX(s.x, view.viewW) });
        }
      }
      this.cues.length = 0;
      const dt = Math.max(0, Math.min(1000, now - this.heatAt));
      this.heatAt = now;
      this.heat = this.heat * Math.exp(-dt / HEAT_TAU_MS) + heatIn;
      this.setBed(view ? gunfireLevel(this.heat, zoom) : 0, now);
      // ---- spawn countdown: a tick for each of the last 5 seconds
      if (state.phase === 'spawn') {
        const s = Math.ceil(state.spawnLeft);
        if (s !== this.lastCountdown) {
          if (s >= 1 && s <= 5 && this.lastCountdown !== -1) this.play('countdown', { volume: s === 1 ? 1 : 0.8 });
          this.lastCountdown = s;
        }
      } else this.lastCountdown = -1;
      // ---- tension and war for the music: attacks on us, our attacks on nations, recent alarms, fighting in view
      let onMe = 0;
      let mineOut = 0;
      if (h > 0 && state.phase === 'playing') {
        for (const a of state.attacks) {
          if (a.target === h) {
            onMe++;
            if (a.attacker > 0 && !isTribe(state.players[a.attacker])) this.lastWarAt = now;
          } else if (a.attacker === h && a.target > 0 && !isTribe(state.players[a.target])) {
            mineOut++;
            this.lastWarAt = now;
          }
        }
      }
      const fight = Math.min(0.65, this.heat / 15);
      this.autoTension = Math.min(1, Math.max(onMe * 0.3 + mineOut * 0.12, this.currentAlarm(), fight));
      this.gameOver = state.phase === 'over';
    } catch {
      /* never break the game loop */
    }
  }

  /** Stops everything and releases the AudioContext. The manager is a no-op afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.musicTimer) clearInterval(this.musicTimer);
      this.musicTimer = null;
      this.music?.dispose();
      this.music = null;
      this.stopBed();
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

  private safeNow(): number {
    try {
      return this.now();
    } catch {
      return 0;
    }
  }

  private attach(c: BaseAudioContext): void {
    try {
      this.ctx = c;
      // a soft limiter on the master bus: a busy battle can't clip
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 8;
      comp.ratio.value = 10;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      comp.connect(c.destination);
      this.master = c.createGain();
      this.master.connect(comp);
      this.sfxBus = c.createGain();
      this.sfxBus.connect(this.master);
      this.musicDuck = c.createGain();
      this.musicDuck.connect(this.master);
      this.musicBus = c.createGain();
      this.musicBus.connect(this.musicDuck);
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

  /** The recorded effects and the music: only with a real AudioContext in a browser (not an offline render). */
  private startMedia(): void {
    const c = this.ctx as AudioContext | null;
    if (!c || typeof c.createMediaElementSource !== 'function' || typeof fetch !== 'function' || typeof Audio === 'undefined') return;
    try {
      const probe = new Audio();
      const formats = audioFormats((t) => probe.canPlayType(t));
      this.bank = new SampleBank(c, formats);
      this.bank.start();
      if (this.musicDuck) this.music = new MusicPlayer(c, this.musicBus ?? this.musicDuck, formats);
      if (typeof setInterval === 'function') this.musicTimer = setInterval(() => this.musicTick(), 250);
    } catch {
      this.bank = null;
      this.music = null;
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
      set(this.musicBus.gain, s.music * MUSIC_LEVEL);
    } catch {
      /* ignore */
    }
  }

  /** The music's mood and track, a few times a second (also on the title screen, where update() is not called). */
  private musicTick(): void {
    const m = this.music;
    if (!m || this.disposed) return;
    try {
      const now = this.safeNow();
      m.tick();
      const want = this.settings.music > 0 && !this.settings.muted && !this.hidden;
      if (!want) {
        if (m.playing) m.stop();
        return;
      }
      if (now < this.stingUntil) return; // a victory or defeat sting plays on its own
      const inGame = now - this.lastGameAt < MENU_AFTER_MS;
      if (inGame && this.gameOver) {
        if (this.mood.mood !== 'peace') this.mood = initialMood(now, 'peace');
      } else {
        this.mood = stepMood(this.mood, { inGame, atWar: now - this.lastWarAt < WAR_MEMORY_MS, tension: this.effectiveTension }, now);
      }
      m.setMood(this.mood.mood);
    } catch {
      /* ignore */
    }
  }

  private alarmFor(id: SoundId, e: GameEvent, humanId: number): void {
    if (id === 'underAttack' || id === 'shipHorn' || id === 'capitalLost' || (id === 'missileLaunch' && e.players[0] !== humanId)) {
      this.raiseAlarm(id === 'capitalLost' ? 1 : 0.7);
    }
  }

  private currentAlarm(): number {
    if (this.alarm <= 0) return 0;
    const dt = (this.safeNow() - this.alarmAt) / 1000;
    return this.alarm * Math.pow(0.5, Math.max(0, dt) / 20); // half-life 20 s
  }

  private raiseAlarm(v: number): void {
    const cur = this.currentAlarm();
    this.alarm = Math.max(cur, v);
    this.alarmAt = this.safeNow();
  }

  /** Tension the music follows: the larger of setTension() and the automatic one. */
  get effectiveTension(): number {
    return Math.max(this.tension, this.autoTension, this.currentAlarm());
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

  /** A sound that passed the limits: its recording when loaded, else the synth; then the music ducks or stops. */
  private sound(id: SoundId, vol: number, pan: number, now: number): void {
    const set = SFX[id];
    let len = SOUND_INFO[id].dur;
    if (this.ctx) {
      const played = set ? this.playSample(id, set, vol, pan) : -1;
      if (played >= 0) len = played;
      else this.synth(id, vol, pan);
    }
    if (id === 'victory' || id === 'defeat') {
      // the sting stands alone: the music stops, and comes back softly after it
      this.stingUntil = now + (len + 3) * 1000;
      this.music?.stop(0.6);
    }
    const d = DUCK[id];
    if (d) this.duck(d[0], d[1], now);
  }

  /** Plays a recording of `id` (a variant, varied); returns its length in s, or -1 when none is loaded. */
  private playSample(id: SoundId, set: SampleSet, vol: number, pan: number): number {
    const c = this.ctx;
    const bank = this.bank;
    if (!c || !bank || !this.sfxBus || c.state === 'closed') return -1;
    try {
      const n = set.files.length;
      let vi = pickVariant(n, this.lastVariant.get(id) ?? -1, Math.random());
      let buf = bank.get(set.files[vi]);
      for (let j = 0; !buf && j < n; j++) {
        buf = bank.get(set.files[j]);
        if (buf) vi = j;
      }
      if (!buf) return -1;
      this.lastVariant.set(id, vi);
      const spread = set.pitch ?? 0.05;
      const db = set.sting ? 0.5 : 2;
      let v = playVariation(spread, db, Math.random(), Math.random());
      // even with one take, two plays in a row never sound the same: the rate moves a clear step each time
      const lr = this.lastRate.get(id);
      for (let tries = 0; spread > 0 && lr !== undefined && Math.abs(v.rate - lr) < spread * 0.35 && tries < 4; tries++) v = playVariation(spread, db, Math.random(), Math.random());
      this.lastRate.set(id, v.rate);
      const t = c.currentTime + 0.005;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = v.rate;
      const g = c.createGain();
      g.gain.value = vol * set.gain * v.gain * takeTrim(set, set.files[vi]);
      src.connect(g);
      let out: AudioNode = g;
      const p = Number.isFinite(pan) ? clamp(pan, -1, 1) : 0;
      if (p !== 0 && typeof (c as AudioContext).createStereoPanner === 'function') {
        const sp = (c as AudioContext).createStereoPanner();
        sp.pan.value = p;
        g.connect(sp);
        out = sp;
      }
      out.connect(this.sfxBus);
      src.onended = () => {
        try {
          src.disconnect();
          out.disconnect();
          if (out !== g) g.disconnect();
        } catch {
          /* ignore */
        }
      };
      src.start(t);
      return buf.duration / v.rate;
    } catch {
      return -1;
    }
  }

  /** Lowers the music for `s` seconds to `depth` (the deeper of two overlapping ducks wins). */
  private duck(depth: number, s: number, now: number): void {
    const g = this.musicDuck?.gain;
    const c = this.ctx;
    if (!g || !c) return;
    try {
      const busy = now < this.duckUntil;
      const d = busy ? Math.min(depth, this.duckDepth) : depth;
      const until = Math.max(this.duckUntil, now + s * 1000);
      this.duckDepth = d;
      this.duckUntil = until;
      const t = c.currentTime;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(d, t, 0.08);
      g.setTargetAtTime(1, t + (until - now) / 1000, 0.7);
    } catch {
      /* ignore */
    }
  }

  /** The looping gunfire bed: one voice, its level smoothed; stopped after a few quiet seconds. */
  private setBed(level: number, now: number): void {
    this.bedTarget = level;
    const c = this.ctx;
    const set = SFX.frontGunfire;
    if (!c || !this.sfxBus || !set || this.settings.muted) {
      if (this.bed) this.stopBed();
      return;
    }
    try {
      if (level > 0.02) this.bedQuietSince = now;
      if (!this.bed) {
        if (level <= 0.02) return;
        const buf = this.bank?.get(set.files[pickVariant(set.files.length, -1, Math.random())]) ?? null;
        if (!buf) return; // no synth bed: the shots and blasts carry the fight until the file is in
        const src = c.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = playVariation(set.pitch ?? 0.04, 0, Math.random(), 0.5).rate;
        const gain = c.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(this.sfxBus);
        src.start(c.currentTime + 0.01, Math.random() * buf.duration); // a random place in the loop
        this.bed = { src, gain };
      }
      this.bed.gain.gain.setTargetAtTime(level * set.gain, c.currentTime, 0.8);
      if (level <= 0.02 && now - this.bedQuietSince > 5000) this.stopBed();
    } catch {
      this.bed = null;
    }
  }

  private stopBed(): void {
    const b = this.bed;
    this.bed = null;
    if (!b) return;
    try {
      const c = this.ctx;
      const t = c ? c.currentTime : 0;
      b.gain.gain.setTargetAtTime(0, t, 0.3);
      b.src.stop(t + 1.5);
      b.src.onended = () => {
        try {
          b.src.disconnect();
          b.gain.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }
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
        this.hidden = document.hidden;
        if (this.hidden) this.music?.pauseNow();
        if (!c || typeof c.suspend !== 'function') return;
        if (document.hidden) c.suspend().catch(() => {});
        else c.resume().catch(() => {});
        this.musicTick();
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
      if (raw) {
        this.settings = parseAudioSettings(JSON.parse(raw));
        return;
      }
      // once: the version 1 settings, with music turned on (it was off by default then)
      const old = this.storage?.getItem(LEGACY_AUDIO_STORAGE_KEY);
      if (!old) return;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(old);
      } catch {
        parsed = null;
      }
      this.settings = migrateAudioSettings(parsed);
      this.save();
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
