// Procedural audio in Node (no AudioContext): the manager must be a silent no-op that never throws, while its
// event mapping, rate limits and voice cap still work (checked with a fake clock).
import { describe, expect, it } from 'vitest';
import {
  AUDIO_STORAGE_KEY,
  AudioManager,
  DEFAULT_AUDIO_SETTINGS,
  MAX_VOICES,
  SOFT_VOICES,
  SOUND_IDS,
  SOUND_INFO,
  SoundLimiter,
  panFromScreenX,
  soundForEffect,
  soundForEvent,
} from '../src/client/audio';
import type { SoundId } from '../src/client/audio';
import type { Effect, GameEvent, GameEventKind } from '../src/sim/types';
import { makeTestGame } from './helpers';

// A Record forces this list to name every GameEventKind (tsc fails when a kind is added to types.ts).
const KIND_MAP: Record<GameEventKind, true> = {
  info: true,
  attackStarted: true,
  underAttack: true,
  surrounded: true,
  buildingDone: true,
  buildingLost: true,
  buildingCaptured: true,
  researchDone: true,
  allianceRequest: true,
  allianceFormed: true,
  allianceBroken: true,
  allianceExpired: true,
  eliminated: true,
  capitalLost: true,
  nuke: true,
  missile: true,
  bombing: true,
  unitLost: true,
  tradeDelivered: true,
  paradrop: true,
  barrage: true,
  doctrineUnlocked: true,
  doctrineChosen: true,
  doctrineLevelUp: true,
  victory: true,
  defeat: true,
};
const ALL_KINDS = Object.keys(KIND_MAP) as GameEventKind[];

const H = 1;
const ev = (kind: GameEventKind, players: number[], message = '', tile = -1): GameEvent => ({ tick: 0, kind, message, players, tile });

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('AudioManager without an AudioContext', () => {
  it('constructs, unlocks, plays, sets volume/mute/tension and disposes without throwing', () => {
    expect(typeof (globalThis as { AudioContext?: unknown }).AudioContext).toBe('undefined');
    const a = new AudioManager({ storage: null });
    expect(() => a.unlock()).not.toThrow();
    expect(a.running).toBe(false);
    expect(a.context).toBeNull();
    for (const id of SOUND_IDS) expect(() => a.play(id, { pan: -1, volume: 0.5 })).not.toThrow();
    expect(() => a.setVolume(0.3, 0.4, 0.5)).not.toThrow();
    expect(() => a.setMuted(true)).not.toThrow();
    expect(() => a.setTension(0.8)).not.toThrow();
    expect(() => a.unlockOnGesture()).not.toThrow();
    expect(() => a.dispose()).not.toThrow();
    expect(a.play('explosion')).toBe(false); // disposed
  });

  it('works with the default constructor (no options at all)', () => {
    const a = new AudioManager();
    expect(() => a.play('uiClick')).not.toThrow();
    a.dispose();
  });

  it('survives a context factory that throws or returns null', () => {
    const a = new AudioManager({
      storage: null,
      createContext: () => {
        throw new Error('no audio');
      },
    });
    expect(() => a.unlock()).not.toThrow();
    expect(a.play('buildPlaced')).toBe(true); // limiter still runs; nothing is synthesized
    const b = new AudioManager({ storage: null, createContext: () => null });
    expect(() => b.unlock()).not.toThrow();
  });

  it('accepts weird input without throwing', () => {
    const a = new AudioManager({ storage: null });
    expect(a.play('nope' as SoundId)).toBe(false);
    expect(() => a.play('explosion', { pan: NaN, volume: NaN })).not.toThrow();
    expect(() => a.setVolume(NaN, -5, 7)).not.toThrow();
    expect(a.getSettings().sfx).toBe(0);
    expect(a.getSettings().music).toBe(1);
    expect(() => a.onGameEvent({ tick: 0, kind: 'bogus' as GameEventKind, message: '', players: [], tile: -1 }, H)).not.toThrow();
  });
});

describe('event -> sound mapping', () => {
  it('handles every GameEventKind, for the human, for others and globally, without throwing', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    for (const kind of ALL_KINDS) {
      for (const players of [[H], [H, 2], [2, H], [2], [2, 3], []]) {
        expect(() => a.onGameEvent(ev(kind, players, 'x launched a rocket at y'), H, 0.3)).not.toThrow();
        expect(() => a.onGameEvent(ev(kind, players, 'Rocket strike by x'), H)).not.toThrow();
        clock.advance(10_000);
      }
    }
  });

  it('ignores events that do not concern the human (except global big ones)', () => {
    for (const kind of ALL_KINDS) {
      const r = soundForEvent(ev(kind, [2, 3], 'A attacks B'), H);
      expect(r, kind).toBeNull();
    }
    expect(soundForEvent(ev('nuke', [], 'A dropped an atom bomb'), H)?.id).toBe('atomBomb');
    expect(soundForEvent(ev('eliminated', [], 'X has been eliminated'), H)?.id).toBe('eliminated');
    expect(soundForEvent(ev('info', [], 'The war begins!'), H)?.id).toBe('countdownGo');
    expect(soundForEvent(ev('info', [], 'something else'), H)).toBeNull();
  });

  it('maps the human\'s events to the right sounds', () => {
    const m = (kind: GameEventKind, players: number[], msg = '') => soundForEvent(ev(kind, players, msg), H)?.id ?? null;
    expect(m('attackStarted', [H], 'Me attacks You')).toBe('attackLaunched');
    expect(soundForEvent(ev('attackStarted', [H], 'Me expands into neutral land'), H)?.volume).toBeLessThan(1);
    expect(m('underAttack', [H], 'Me is under attack by You')).toBe('underAttack');
    expect(m('underAttack', [H], 'Watchtower: an enemy transport (300 troops) of X is approaching your land')).toBe('shipHorn');
    expect(m('buildingDone', [H], 'Farm finished')).toBe('buildingDone');
    expect(m('buildingLost', [H])).toBe('buildingLost');
    expect(m('buildingCaptured', [H, 2])).toBe('buildingDone');
    expect(m('buildingCaptured', [2, H])).toBe('buildingLost');
    expect(m('researchDone', [H])).toBe('researchDone');
    expect(m('allianceRequest', [H])).toBe('allianceRequest');
    expect(m('allianceFormed', [2, H])).toBe('allianceFormed');
    expect(m('allianceBroken', [2, H])).toBe('allianceBroken');
    expect(m('allianceExpired', [H, 2])).toBe('allianceExpired');
    expect(m('eliminated', [H, 2])).toBe('defeat');
    expect(m('capitalLost', [H, 2])).toBe('capitalLost');
    expect(m('capitalLost', [2, H])).toBe('capitalTaken');
    expect(m('missile', [H, 2], 'Me launched a rocket at You')).toBe('missileLaunch');
    expect(m('missile', [2, H], 'Rocket strike by You: 1 building destroyed')).toBe('explosion');
    expect(m('bombing', [2, H])).toBe('explosion');
    expect(m('unitLost', [H, 2])).toBe('unitLost');
    expect(m('tradeDelivered', [H])).toBe('tradeCoin');
    expect(m('victory', [H])).toBe('victory');
    expect(m('victory', [2])).toBeNull();
    expect(m('defeat', [H])).toBe('defeat');
  });

  it('never makes a sound for a spectator (humanId 0) except global ones', () => {
    for (const kind of ALL_KINDS) {
      const r = soundForEvent(ev(kind, [1, 2], 'x'), 0);
      expect(r, kind).toBeNull();
    }
  });

  it('effects: nukes always, explosions/shots on screen only, captures only when ours or on screen', () => {
    const fx = (kind: Effect['kind'], radius = 1.5): Effect => ({ kind, x: 1, y: 1, radius, tick: 0 });
    expect(soundForEffect(fx('nuke'), undefined)?.id).toBe('atomBomb');
    expect(soundForEffect(fx('explosion'), undefined)).toBeNull();
    expect(soundForEffect(fx('explosion'), 0.2)?.id).toBe('explosion');
    expect(soundForEffect(fx('shot'), undefined)).toBeNull();
    expect(soundForEffect(fx('capture'), undefined)).toBeNull();
    expect(soundForEffect(fx('capture'), 0)?.id).toBe('capture');
    expect(soundForEffect(fx('capture'), 0, false)).toBeNull();
    expect(soundForEffect(fx('capture'), undefined, true)?.id).toBe('capture');
  });

  it('pans by screen position', () => {
    expect(panFromScreenX(0, 800)).toBeCloseTo(-0.8);
    expect(panFromScreenX(400, 800)).toBeCloseTo(0);
    expect(panFromScreenX(800, 800)).toBeCloseTo(0.8);
    expect(panFromScreenX(5000, 800)).toBeCloseTo(0.8);
    expect(panFromScreenX(NaN, 800)).toBe(0);
    expect(panFromScreenX(10, 0)).toBe(0);
  });
});

describe('rate limits and voice cap (fake clock)', () => {
  it('enforces the per-sound minimum gap in real time', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    const gap = SOUND_INFO.explosion.gapMs;
    expect(a.play('explosion')).toBe(true);
    expect(a.play('explosion')).toBe(false);
    clock.advance(gap - 1);
    expect(a.play('explosion')).toBe(false);
    clock.advance(1);
    expect(a.play('explosion')).toBe(true);
    // A different sound is not blocked by the explosion's gap.
    expect(a.play('buildPlaced')).toBe(true);
  });

  it('a flood of captures (hundreds per frame, x4 speed) plays at most one per gap', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    let played = 0;
    // 10 s of frames at 60 fps, 50 captures per frame.
    for (let f = 0; f < 600; f++) {
      for (let k = 0; k < 50; k++) if (a.play('capture', { pan: 0 })) played++;
      clock.advance(1000 / 60);
    }
    expect(played).toBeGreaterThan(0);
    expect(played).toBeLessThanOrEqual(Math.ceil(10_000 / SOUND_INFO.capture.gapMs) + 1);
  });

  it('caps simultaneous voices; critical sounds still get through', () => {
    const clock = fakeClock();
    const lim = new SoundLimiter();
    const ids = SOUND_IDS.filter((id) => SOUND_INFO[id].priority === 1 || SOUND_INFO[id].priority === 2);
    let ok = 0;
    for (const id of ids) if (lim.accept(id, clock.now())) ok++;
    expect(ok).toBe(Math.min(ids.length, MAX_VOICES));
    expect(lim.active(clock.now())).toBeLessThanOrEqual(MAX_VOICES);
    // Cosmetic sounds give way first.
    expect(lim.accept('uiClick', clock.now())).toBe(false);
    // Critical ones ignore the cap.
    expect(lim.accept('defeat', clock.now())).toBe(true);
    // Voices end with time.
    clock.advance(6000);
    expect(lim.active(clock.now())).toBe(0);
    expect(lim.accept('uiClick', clock.now())).toBe(true);
  });

  it('cosmetic sounds stop at the soft voice limit', () => {
    const lim = new SoundLimiter();
    const t = 5000;
    const normal: SoundId[] = ['buildingDone', 'researchDone', 'allianceRequest', 'allianceFormed', 'allianceBroken', 'allianceExpired', 'shipHorn', 'eliminated'];
    for (const id of normal) expect(lim.accept(id, t)).toBe(true);
    expect(lim.active(t)).toBe(SOFT_VOICES);
    expect(lim.accept('tradeCoin', t)).toBe(false);
    expect(lim.accept('explosion', t)).toBe(true);
  });

  it('muted or zero volume plays nothing and does not use up the gap', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    a.setMuted(true);
    expect(a.play('victory')).toBe(false);
    a.setMuted(false);
    expect(a.play('victory', { volume: 0 })).toBe(false);
    expect(a.play('victory')).toBe(true);
  });

  it('onGameEvent goes through the same limits', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    const e = ev('underAttack', [H], 'Me is under attack by You');
    expect(a.onGameEvent(e, H)).toBe('underAttack');
    expect(a.onGameEvent(e, H)).toBeNull();
    clock.advance(SOUND_INFO.underAttack.gapMs);
    expect(a.onGameEvent(e, H)).toBe('underAttack');
    expect(a.effectiveTension).toBeGreaterThan(0.5); // alarm raises the music tension
    clock.advance(120_000);
    expect(a.effectiveTension).toBeLessThan(0.1); // and it decays
  });
});

describe('settings persistence', () => {
  it('saves and loads volumes and mute', () => {
    const store = memStore();
    const a = new AudioManager({ storage: store });
    expect(a.getSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
    a.setVolume(0.25, 0.5, 0.1);
    a.setMuted(true);
    const b = new AudioManager({ storage: store });
    expect(b.getSettings()).toEqual({ master: 0.25, sfx: 0.5, music: 0.1, muted: true });
  });

  it('falls back to defaults on corrupt data and survives a throwing store', () => {
    const store = memStore();
    store.m.set(AUDIO_STORAGE_KEY, '{not json');
    expect(new AudioManager({ storage: store }).getSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const a = new AudioManager({ storage: bad });
    expect(() => a.setVolume(0.5)).not.toThrow();
    expect(a.getSettings().master).toBe(0.5);
  });
});

describe('update() with a real game state', () => {
  it('drains new events once, ignores the history of a new state, ticks the spawn countdown', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    const s = makeTestGame();
    const h = s.humanId;
    s.events.push(ev('researchDone', [h], 'Research complete: Agriculture'));
    a.update(s); // first look at this state: existing events are history
    expect(a.limiter.active(clock.now())).toBe(0);
    s.events.push(ev('researchDone', [h], 'Research complete: Metallurgy'));
    a.update(s);
    expect(a.limiter.active(clock.now())).toBe(1);
    clock.advance(5000);
    a.update(s); // already seen: nothing new
    expect(a.limiter.active(clock.now())).toBe(0);

    // Effects: a capture on the human's own tile sounds, one on someone else's does not.
    const w = s.map.width;
    let mineTile = -1;
    let otherTile = -1;
    for (let t = 0; t < s.map.owner.length; t++) {
      if (mineTile < 0 && s.map.owner[t] === h) mineTile = t;
      if (otherTile < 0 && s.map.owner[t] !== h) otherTile = t;
    }
    expect(mineTile).toBeGreaterThanOrEqual(0);
    const fxAt = (t: number): Effect => ({ kind: 'capture', x: (t % w) + 0.5, y: Math.floor(t / w) + 0.5, radius: 1.5, tick: s.tick });
    s.effects.push(fxAt(otherTile));
    a.update(s);
    expect(a.limiter.active(clock.now())).toBe(0);
    s.effects.push(fxAt(mineTile));
    a.update(s);
    expect(a.limiter.active(clock.now())).toBe(1);

    // Spawn countdown: ticks for 5..1, not for 10..6.
    clock.advance(5000);
    s.phase = 'spawn';
    let ticks = 0;
    for (let left = 10; left > 0; left -= 0.5) {
      s.spawnLeft = left;
      const before = a.limiter.active(clock.now());
      a.update(s);
      if (a.limiter.active(clock.now()) > before) ticks++;
      clock.advance(500);
    }
    expect(ticks).toBe(5);
  });

  it('pans with a view and never throws on an odd one', () => {
    const clock = fakeClock();
    const a = new AudioManager({ storage: null, now: clock.now });
    const s = makeTestGame();
    a.update(s);
    s.events.push(ev('bombing', [2, s.humanId], 'bombed', 5));
    const view = { viewW: 800, viewH: 600, tileToScreen: (x: number, y: number) => ({ x: x * 10, y: y * 10 }) };
    expect(() => a.update(s, view)).not.toThrow();
    const broken = {
      viewW: 0,
      viewH: 0,
      tileToScreen: () => {
        throw new Error('x');
      },
    };
    s.events.push(ev('bombing', [2, s.humanId], 'bombed', 5));
    expect(() => a.update(s, broken)).not.toThrow();
  });
});
