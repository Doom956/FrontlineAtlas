// Recorded sound and music (client only, Node): variant picks, the zoom and on-screen gating, the music's mood
// machine, the settings migration, the file table and the server's byte ranges for streaming.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIO_STORAGE_KEY, AudioManager, DEFAULT_AUDIO_SETTINGS, LEGACY_AUDIO_STORAGE_KEY, SOUND_INFO, SoundLimiter, migrateAudioSettings, takeTrim } from '../src/client/audio';
import { LOUDNESS } from '../src/client/sound/loudness.gen';
import type { SoundId } from '../src/client/audio';
import { audioFormats, audioUrl, MUSIC, musicFileIds, sfxFileIds, SFX } from '../src/client/sound/library';
import { BATTLE_OFF, BATTLE_ON, CALM_MS, ESCALATE_MS, initialMood, MIN_DWELL_MS, nextTrack, stepMood, wantedMood, type MusicInput } from '../src/client/sound/music';
import { BIG_FLOOR, gunfireLevel, pickVariant, playVariation, screenGain, spatialGain, ZOOM_FULL, ZOOM_SILENT, zoomGain } from '../src/client/sound/spatial';
import { byteRange } from '../server/static';
import { CC_BY_CREDITS } from '../src/client/sound/credits.gen';
import type { Effect } from '../src/sim/types';
import { makeTestGame } from './helpers';

function seq(xs: number[]): () => number {
  let i = 0;
  return () => xs[i++ % xs.length];
}

describe('variants', () => {
  it('never picks the same variant twice in a row when there are several', () => {
    let r = 0.123;
    const next = () => (r = (r * 9301 + 0.49297) % 1);
    for (const n of [2, 3, 4]) {
      let last = -1;
      const seen = new Set<number>();
      for (let i = 0; i < 500; i++) {
        const v = pickVariant(n, last, next());
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(n);
        expect(v).not.toBe(last);
        seen.add(v);
        last = v;
      }
      expect(seen.size).toBe(n); // and every take gets its turn
    }
  });

  it('one take: always 0; odd input does not break it', () => {
    expect(pickVariant(1, 0, 0.7)).toBe(0);
    expect(pickVariant(0, -1, 0.7)).toBe(0);
    expect(pickVariant(3, 1, NaN)).not.toBe(1);
    expect(pickVariant(3, 2, 1)).toBeLessThan(3);
  });

  it('varies the rate within the spread and the gain within +-2 dB', () => {
    expect(playVariation(0.06, 2, 0, 0).rate).toBeCloseTo(0.94);
    expect(playVariation(0.06, 2, 1, 1).rate).toBeCloseTo(1.06);
    expect(playVariation(0.06, 2, 0, 0).gain).toBeCloseTo(Math.pow(10, -2 / 20));
    expect(playVariation(0.06, 2, 0.5, 1).gain).toBeCloseTo(Math.pow(10, 2 / 20));
    expect(playVariation(0, 0, 0.9, 0.9)).toEqual({ rate: 1, gain: 1 });
  });

  it('every recorded effect varies its pitch by 4 to 7 percent (stings stay in tune)', () => {
    for (const [id, set] of Object.entries(SFX)) {
      if (!set) continue;
      const p = set.pitch ?? 0.05;
      if (set.sting) expect(p, id).toBe(0);
      else if (['countdown', 'capitalLost', 'cityLost', 'capitalTaken', 'cityTaken', 'allianceRequest', 'allianceBroken', 'allianceExpired', 'allianceFormed', 'researchDone', 'buildingDone', 'underAttack'].includes(id)) expect(p, id).toBeGreaterThanOrEqual(0.02);
      else {
        expect(p, id).toBeGreaterThanOrEqual(0.04);
        expect(p, id).toBeLessThanOrEqual(0.07);
      }
    }
  });
});

describe('zoom and on-screen gating', () => {
  it('full close up, silent far out for small sounds, a faint floor for big ones', () => {
    expect(zoomGain('small', 40)).toBe(1);
    expect(zoomGain('small', ZOOM_FULL.small)).toBe(1);
    expect(zoomGain('small', ZOOM_SILENT.small)).toBe(0);
    expect(zoomGain('small', 1)).toBe(0);
    expect(zoomGain('medium', 1)).toBe(0);
    expect(zoomGain('big', 0.7)).toBeCloseTo(BIG_FLOOR);
    expect(zoomGain('big', 10)).toBe(1);
    const mid = zoomGain('small', 4);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // falls steadily as the camera pulls back
    let prev = 2;
    for (let z = 40; z > 0.5; z *= 0.8) {
      const g = zoomGain('medium', z);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
    expect(zoomGain('small', undefined)).toBe(1); // unknown zoom: as close up
  });

  it('heard on screen and just off it, not further', () => {
    expect(screenGain('small', 400, 300, 800, 600)).toBe(1);
    expect(screenGain('small', 0, 0, 800, 600)).toBe(1);
    const edge = screenGain('small', 820, 300, 800, 600);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    expect(screenGain('small', 1000, 300, 800, 600)).toBe(0);
    expect(screenGain('big', 950, 300, 800, 600)).toBeGreaterThan(0); // big ones reach further
    expect(screenGain('big', 3000, 300, 800, 600)).toBe(0);
    expect(screenGain('small', NaN, 0, 800, 600)).toBe(0);
    expect(screenGain('small', 10, 10, 0, 0)).toBe(0);
    expect(spatialGain('small', 2, 400, 300, 800, 600)).toBe(0);
    expect(spatialGain('big', 1, 400, 300, 800, 600)).toBeCloseTo(BIG_FLOOR);
    expect(spatialGain('big', 1, 5000, 300, 800, 600)).toBe(0);
  });

  it('the gunfire bed follows the fighting in view, close up only', () => {
    expect(gunfireLevel(0, 10)).toBe(0);
    expect(gunfireLevel(5, 2)).toBe(0);
    expect(gunfireLevel(5, 10)).toBeGreaterThan(0.5);
    expect(gunfireLevel(20, 10)).toBeGreaterThan(gunfireLevel(2, 10));
    expect(gunfireLevel(5, 3.5)).toBeLessThan(gunfireLevel(5, 5));
    expect(gunfireLevel(1e9, 40)).toBeLessThanOrEqual(1);
  });

  it('every fighting sound is positional; your nation\'s news and the UI are not', () => {
    const spatial: SoundId[] = ['shot', 'explosion', 'explosionBig', 'atomBomb', 'tankShot', 'tankDestroyed', 'planeCrash', 'shipSunk', 'missileLaunch', 'sonarPing', 'bombard'];
    for (const id of spatial) expect(SOUND_INFO[id].spatial, id).toBeDefined();
    const news: SoundId[] = ['underAttack', 'capitalLost', 'cityLost', 'allianceRequest', 'allianceFormed', 'allianceBroken', 'researchDone', 'victory', 'defeat', 'uiClick', 'uiError'];
    for (const id of news) expect(SOUND_INFO[id].spatial, id).toBeUndefined();
    expect(SOUND_INFO.shot.spatial).toBe('small');
    expect(SOUND_INFO.atomBomb.spatial).toBe('big');
  });

  it('caps the copies of one sound at once', () => {
    const lim = new SoundLimiter();
    let t = 0;
    let ok = 0;
    // a big battle: an explosion every gap for 0.5 s; only `cap` of them overlap
    for (let i = 0; i < 5; i++) {
      if (lim.accept('explosion', t)) ok++;
      expect(lim.activeOf('explosion', t)).toBeLessThanOrEqual(SOUND_INFO.explosion.cap!);
      t += SOUND_INFO.explosion.gapMs;
    }
    expect(ok).toBe(SOUND_INFO.explosion.cap!);
    t += 5000;
    expect(lim.accept('explosion', t)).toBe(true);
  });

  it('update(): fighting is heard close up and on screen, not zoomed far out or off screen', () => {
    let now = 1000;
    const a = new AudioManager({ storage: null, now: () => now });
    const s = makeTestGame();
    s.fog = undefined;
    a.update(s);
    const blast = (x: number, y: number): Effect => ({ kind: 'explosion', x, y, radius: 6, tick: s.tick });
    const view = (zoom: number) => ({ viewW: 800, viewH: 600, zoom, tileToScreen: (x: number, y: number) => ({ x: (x - 50) * zoom + 400, y: (y - 50) * zoom + 300 }) });
    const heard = (fx: Effect, z: number) => {
      now += 10_000;
      const before = a.limiter.activeOf('explosionBig', now);
      s.effects.push(fx);
      a.update(s, view(z));
      return a.limiter.activeOf('explosionBig', now) > before;
    };
    expect(heard(blast(50, 50), 8)).toBe(true); // close up, centre
    expect(heard(blast(50, 50), 1.2)).toBe(true); // a big blast is heard faintly from far, on screen
    expect(heard(blast(900, 50), 8)).toBe(false); // off screen
    const shot = (): Effect => ({ kind: 'shot', x: 50, y: 50, x2: 52, y2: 50, radius: 0.5, tick: s.tick });
    now += 10_000;
    s.effects.push(shot());
    a.update(s, view(1.5));
    expect(a.limiter.activeOf('shot', now)).toBe(0); // small sounds are silent zoomed out
    now += 10_000;
    s.effects.push(shot());
    a.update(s, view(10));
    expect(a.limiter.activeOf('shot', now)).toBe(1);
  });
});

describe('music mood machine', () => {
  const I = (o: Partial<MusicInput> = {}): MusicInput => ({ inGame: true, atWar: false, tension: 0, ...o });

  it('asks for menu, peace, war and battle, with hysteresis on battle', () => {
    expect(wantedMood('peace', I({ inGame: false }))).toBe('menu');
    expect(wantedMood('menu', I())).toBe('peace');
    expect(wantedMood('peace', I({ atWar: true }))).toBe('war');
    expect(wantedMood('war', I({ atWar: true, tension: BATTLE_ON }))).toBe('battle');
    expect(wantedMood('war', I({ atWar: true, tension: (BATTLE_ON + BATTLE_OFF) / 2 }))).toBe('war');
    expect(wantedMood('battle', I({ atWar: true, tension: (BATTLE_ON + BATTLE_OFF) / 2 }))).toBe('battle');
    expect(wantedMood('battle', I({ atWar: true, tension: BATTLE_OFF - 0.01 }))).toBe('war');
  });

  it('goes to and from the menu at once, up quickly, down slowly', () => {
    let s = initialMood(0);
    s = stepMood(s, I(), 0);
    expect(s.mood).toBe('peace');
    s = stepMood(s, I({ atWar: true }), 1000);
    expect(s.mood).toBe('peace'); // must hold a moment
    s = stepMood(s, I({ atWar: true }), 1000 + ESCALATE_MS);
    expect(s.mood).toBe('war');
    const warAt = 1000 + ESCALATE_MS;
    s = stepMood(s, I({ atWar: true, tension: 0.9 }), warAt + 100);
    s = stepMood(s, I({ atWar: true, tension: 0.9 }), warAt + 100 + ESCALATE_MS);
    expect(s.mood).toBe('battle');
    const battleAt = warAt + 100 + ESCALATE_MS;
    // a short lull does not drop it
    s = stepMood(s, I({ atWar: true, tension: 0.1 }), battleAt + 1000);
    s = stepMood(s, I({ atWar: true, tension: 0.9 }), battleAt + 5000);
    s = stepMood(s, I({ atWar: true, tension: 0.1 }), battleAt + 6000);
    s = stepMood(s, I({ atWar: true, tension: 0.1 }), battleAt + 6000 + CALM_MS - 1);
    expect(s.mood).toBe('battle');
    s = stepMood(s, I({ atWar: true, tension: 0.1 }), battleAt + Math.max(6000 + CALM_MS, MIN_DWELL_MS));
    expect(s.mood).toBe('war');
    s = stepMood(s, I({ inGame: false }), battleAt + 40_000);
    expect(s.mood).toBe('menu');
  });

  it('does not flip back and forth on a tension that wobbles around the bar', () => {
    let s = stepMood(initialMood(0), I({ atWar: true }), 0);
    s = stepMood(s, I({ atWar: true }), ESCALATE_MS);
    let changes = 0;
    let mood = s.mood;
    for (let t = ESCALATE_MS; t < 300_000; t += 250) {
      const wobble = BATTLE_ON + (Math.sin(t / 900) > 0 ? 0.05 : -0.2);
      s = stepMood(s, I({ atWar: true, tension: wobble }), t);
      if (s.mood !== mood) {
        changes++;
        mood = s.mood;
      }
    }
    expect(changes).toBeLessThanOrEqual(2);
  });

  it('rotates tracks and never repeats the last one', () => {
    for (const pool of Object.values(MUSIC)) {
      let last: string | null = null;
      const r = seq([0, 0.3, 0.6, 0.99, 0.5, 0.1]);
      for (let i = 0; i < 30; i++) {
        const t = nextTrack(pool, last, r());
        expect(pool).toContain(t);
        if (pool.length > 1) expect(t).not.toBe(last);
        last = t;
      }
    }
    expect(nextTrack([], null, 0.5)).toBeNull();
    expect(nextTrack(['a'], 'a', 0.5)).toBe('a');
  });
});

describe('settings migration', () => {
  function memStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  }

  it('music is on by default at a moderate level', () => {
    expect(DEFAULT_AUDIO_SETTINGS.music).toBeGreaterThan(0.2);
    expect(DEFAULT_AUDIO_SETTINGS.music).toBeLessThan(0.8);
  });

  it('version 1 settings keep master, effects and mute, and get music', () => {
    expect(migrateAudioSettings({ master: 0.3, sfx: 0.9, music: 0, muted: true })).toEqual({ master: 0.3, sfx: 0.9, music: DEFAULT_AUDIO_SETTINGS.music, muted: true });
    expect(migrateAudioSettings({ master: 0.3, sfx: 0.9, music: 0.8, muted: false }).music).toBe(0.8); // turned up on purpose
    expect(migrateAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(migrateAudioSettings({ master: 'x', music: NaN })).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('migrates once through the manager, then the new key wins', () => {
    const store = memStore();
    store.m.set(LEGACY_AUDIO_STORAGE_KEY, JSON.stringify({ master: 0.4, sfx: 0.7, music: 0, muted: false }));
    const a = new AudioManager({ storage: store });
    expect(a.getSettings()).toEqual({ master: 0.4, sfx: 0.7, music: DEFAULT_AUDIO_SETTINGS.music, muted: false });
    expect(store.m.has(AUDIO_STORAGE_KEY)).toBe(true);
    a.setVolume(undefined, undefined, 0); // the player turns music off: that sticks
    expect(new AudioManager({ storage: store }).getSettings().music).toBe(0);
    store.m.set(LEGACY_AUDIO_STORAGE_KEY, '{broken');
    expect(new AudioManager({ storage: store }).getSettings().music).toBe(0);
    const fresh = memStore();
    fresh.m.set(LEGACY_AUDIO_STORAGE_KEY, '{broken');
    expect(new AudioManager({ storage: fresh }).getSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
  });
});

describe('files', () => {
  it('every file in the table is in public/audio in both formats', () => {
    for (const id of sfxFileIds()) for (const f of ['ogg', 'm4a'] as const) expect(existsSync(join('public', audioUrl('sfx', id, f))), `${id}.${f}`).toBe(true);
    for (const id of musicFileIds()) for (const f of ['ogg', 'm4a'] as const) expect(existsSync(join('public', audioUrl('music', id, f))), `${id}.${f}`).toBe(true);
  });

  it('every sound id with a file is a real sound, and the bed is there', () => {
    for (const k of Object.keys(SFX)) expect(k === 'frontGunfire' || k in SOUND_INFO, k).toBe(true);
    expect(SFX.frontGunfire?.files.length).toBeGreaterThan(0);
  });

  it('picks Ogg Opus where the browser plays it, AAC otherwise', () => {
    expect(audioFormats((t) => (t.includes('opus') ? 'probably' : ''))).toEqual(['ogg', 'm4a']);
    expect(audioFormats(() => '')).toEqual(['m4a', 'ogg']);
    expect(audioFormats(null)).toEqual(['m4a', 'ogg']);
    expect(audioFormats(() => {
      throw new Error('x');
    })).toEqual(['m4a', 'ogg']);
    expect(audioUrl('music', 'a', 'ogg')).toBe('audio/music/a.ogg'); // relative: works under the Pages subpath
  });

  it('each sound plays exactly the takes the owner kept', () => {
    const want: Record<string, string[]> = {
      shot: ['sfx-artillery-fs239137', 'sfx-artillery-fs239137-v2'],
      bombard: ['sfx-artillery-fs239137', 'sfx-artillery-fs239137-v2'],
      explosion: ['sfx-explosion-fs182429', 'sfx-explosion-fs182429-v2', 'sfx-explosion-fs182429-v4', 'sfx-explosion-fs182429-v5', 'sfx-explosion-fs182431'],
      explosionBig: ['sfx-explosion-big-fs741173', 'sfx-explosion-big-fs741173-v2', 'sfx-explosion-big-fs741173-v4'],
      atomBomb: ['sfx-atom-r2-windy'],
      missileLaunch: ['sfx-missile-fs854476-v2', 'sfx-missile-fs854476-v3', 'sfx-missile-fs854476-v4'],
      shipHorn: ['sfx-ship-horn-fs261846', 'sfx-ship-horn-fs636075'],
      planeCrash: ['sfx-plane-crash-fs861876', 'sfx-plane-crash-fs861876-v3'],
      tankShot: ['sfx-tank-shot-fs127845', 'sfx-tank-shot-fs127845-v2', 'sfx-tank-shot-fs127845-v3', 'sfx-tank-shot-fs127845-v4'],
      tankDestroyed: ['sfx-tank-destroyed-fs209772'],
      unitLost: ['sfx-tank-destroyed-fs209772'],
      sonarPing: ['sfx-sonar-fs12677', 'sfx-sonar-fs12677-v2', 'sfx-sonar-fs12677-v3', 'sfx-sonar-fs12677-v5'],
      frontGunfire: ['sfx-front-gunfire-fs840492', 'sfx-front-gunfire-fs840492-v4'],
      uiClick: ['ui-click-kenney-click3', 'ui-click-kenney-click3-v2', 'ui-click-kenney-click3-v3'],
      uiError: ['ui-error-kenney-error-008'],
      buildPlaced: ['build-placed-fs449955'],
      allianceRequest: ['alliance-request-fs198874'],
      allianceBroken: ['alliance-broken-fs790253', 'alliance-broken-fs790253-v3'],
      allianceExpired: ['alliance-broken-fs790253', 'alliance-broken-fs790253-v3'],
      cityTaken: ['city-taken-fs592096-short', 'city-taken-fs592096-short-v2'],
      capitalTaken: ['city-taken-fs592096-short', 'city-taken-fs592096-short-v2'],
      capitalLost: ['capital-lost-fs374271'],
      cityLost: ['capital-lost-fs374271'],
      tradeCoin: ['trade-coin-fs223344'],
      countdown: ['countdown-fs361783'],
      underAttack: ['under-attack-r2-air-raid-test'],
      victory: ['sting-victory-fs470083'],
      defeat: ['sting-defeat-oga-the-fallen'],
    };
    const have: Record<string, string[]> = {};
    for (const [k, set] of Object.entries(SFX)) if (set) have[k] = [...set.files];
    expect(have).toEqual(want);
    // synthesized on purpose
    for (const id of ['uiHover', 'buildingLost', 'attackLaunched', 'capture', 'eliminated', 'shipSunk', 'buildingDone', 'researchDone', 'allianceFormed', 'countdownGo'] as const) expect(SFX[id], id).toBeUndefined();
    expect(sfxFileIds().length).toBe(45);
    expect(SFX.atomBomb?.files).not.toContain('sfx-atom-fs741175');
    expect(SFX.missileLaunch?.files).not.toContain('sfx-missile-fs854476');
  });

  it('the mix: the atom bomb is the loudest, the siren clear but well below it', () => {
    // effective level of a sound's first take: its gain on the bus and the file's loudness
    const level = (id: keyof typeof SFX) => {
      const s = SFX[id]!;
      return 20 * Math.log10(s.gain) + (LOUDNESS[s.files[0]] ?? -16);
    };
    const atom = level('atomBomb');
    for (const id of Object.keys(SFX) as (keyof typeof SFX)[]) if (id !== 'atomBomb') expect(level(id), id).toBeLessThan(atom);
    expect(level('underAttack')).toBeLessThan(atom - 4);
  });

  it('evens out quieter takes, by 4 dB at most', () => {
    for (const s of Object.values(SFX)) {
      if (!s) continue;
      expect(takeTrim(s, s.files[0])).toBeCloseTo(1);
      for (const f of s.files) {
        const t = takeTrim(s, f);
        expect(t).toBeGreaterThanOrEqual(Math.pow(10, -4 / 20) - 1e-9);
        expect(t).toBeLessThanOrEqual(Math.pow(10, 4 / 20) + 1e-9);
      }
    }
    expect(takeTrim({ files: ['nope'], gain: 1 }, 'nope')).toBe(1);
  });

  it('credits list the CC BY lines', () => {
    expect(CC_BY_CREDITS.length).toBeGreaterThan(0);
    for (const c of CC_BY_CREDITS) expect(c).toMatch(/licensed under CC BY/);
  });
});

describe('server byte ranges (Safari streams music only with them)', () => {
  it('parses one range', () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange('bytes=0-', 100)).toEqual([0, 99]);
    expect(byteRange('bytes=0-1', 100)).toEqual([0, 1]);
    expect(byteRange('bytes=10-500', 100)).toEqual([10, 99]);
    expect(byteRange('bytes=-10', 100)).toEqual([90, 99]);
    expect(byteRange('bytes=100-', 100)).toBe('bad');
    expect(byteRange('bytes=5-2', 100)).toBe('bad');
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(byteRange('items=0-1', 100)).toBeNull();
  });
});
