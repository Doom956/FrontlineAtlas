// Single-player save and continue (src/client/save): a game rebuilt from its settings with the recorded actions
// replayed reaches the same state hash as the original at the save tick; the save format's checks and texts.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { canBuild } from '../src/sim/buildings';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { canSpawnAt, createGame } from '../src/sim/state';
import type { Action, BuildingType, GameSettings, GameState } from '../src/sim/types';
import { checkSave, clockText, loadNote, parseSave, saveBuildId, saveFacts, savedAgo, SAVE_FORMAT, type SaveData } from '../src/client/save/format';
import { GameRecorder, thinChecks } from '../src/client/save/recorder';
import { Replayer } from '../src/client/save/replay';
import { testSettings } from './helpers';

function settings(): GameSettings {
  return testSettings({ seed: 9090, aiCount: 4, tribeCount: 6, humanPlayer: true });
}

/** Small deterministic number source for the scripted player (not the sim's rng). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const BUILD_CYCLE: BuildingType[] = ['city', 'factory', 'airfield', 'port', 'barracks', 'mine', 'silo', 'market', 'fort'];

/**
 * A player that clicks a lot: spawn, start, money and techs from the owner console, buildings of many kinds,
 * finished at once, then tanks, aircraft, warships, attacks, bombs, research and a slider drag (many army mix
 * changes in one tick). Every action goes through `act` (like main.ts dispatch: recorded, then applied), refused
 * ones too.
 */
function script(state: GameState, act: (a: Action) => void, rnd: () => number): void {
  const me = state.players[1];
  const t = state.tick;
  const { width: w, height: h } = state.map;
  if (t === 3) {
    for (let r = 0; r < Math.max(w, h); r++) {
      let done = false;
      for (let dx = -r; dx <= r && !done; dx++) {
        const tile = ((h >> 1) + (r - Math.abs(dx))) * w + (w >> 1) + dx;
        if (tile >= 0 && tile < w * h && canSpawnAt(state, 1, tile)) {
          act({ type: 'spawn', tile });
          done = true;
        }
      }
      if (done) break;
    }
  }
  if (t === 20) act({ type: 'startNow' });
  if (state.phase !== 'playing' || !me.alive) return;
  const since = t - state.playStartTick;
  if (since === 2) {
    act({ type: 'admin', op: 'setResource', key: 'gold', amount: 5_000_000 });
    act({ type: 'admin', op: 'setResource', key: 'iron', amount: 50_000 });
    act({ type: 'admin', op: 'setResource', key: 'oil', amount: 50_000 });
    act({ type: 'admin', op: 'unlockAllTechs' });
  }
  const owned: number[] = [];
  if (since % 25 === 5 || since % 40 === 7) {
    for (let i = 0; i < state.map.owner.length; i++) if (state.map.owner[i] === 1) owned.push(i);
  }
  if (since % 25 === 5 && owned.length) {
    const type = BUILD_CYCLE[Math.floor(since / 25) % BUILD_CYCLE.length];
    // a few tries on random own tiles, as a player trying spots would
    for (let k = 0; k < 40; k++) {
      const tile = owned[Math.floor(rnd() * owned.length)];
      if (k < 39 && !canBuild(state, 1, type, tile).ok) continue;
      act({ type: 'build', building: type, tile });
      break;
    }
    act({ type: 'admin', op: 'finishConstructions' });
  }
  if (since % 40 === 7) {
    for (const b of state.buildings.values()) {
      if (!b || b.owner !== 1 || b.buildLeft > 0) continue;
      if (b.type === 'factory') act({ type: 'buildTankDivision', tile: b.tile });
      if (b.type === 'airfield') act({ type: 'buildAircraft', airfield: b.tile, kind: rnd() < 0.5 ? 'bomber' : 'fighter' });
      if (b.type === 'port') act({ type: 'buildWarship', port: b.tile });
    }
    // attack the first foreign land along our capital's row, and send tanks there
    for (let k = 1; k < w && me.capital >= 0; k++) {
      const tile = me.capital + k;
      if (tile >= state.map.owner.length) break;
      if (state.map.owner[tile] !== 1 && state.map.terrain[tile] > 1) {
        const n = Math.floor(me.troops.infantry * 0.25);
        if (n >= 50) act({ type: 'attack', tile, troops: { infantry: n, armor: 0, artillery: 0 } });
        const tanks = state.units.filter((u) => u && u.owner === 1 && u.type === 'tankDivision').map((u) => u.id);
        if (tanks.length) act({ type: 'moveTankDivision', unitIds: tanks.slice(0, 4), tile });
        act({ type: 'bomb', airfield: -1, tile, count: 0 });
        break;
      }
    }
  }
  if (since === 120) for (let k = 0; k < 6; k++) act({ type: 'setArmyMix', armor: 0.05 * k, artillery: 0.02 * k });
  if (since === 150) act({ type: 'setAuto', research: false });
  if (since === 300) act({ type: 'hireMercenaries', amount: 200 });
}

interface Saved {
  save: SaveData;
  hash: number;
}

/** Plays `ticks` ticks with the script, saving (snapshot + JSON round trip, as storage does) at each tick in saveAt. */
function playAndSave(ticks: number, saveAt: number[]): { saves: Saved[]; state: GameState; recorder: GameRecorder } {
  const s = settings();
  const recorder = new GameRecorder(s);
  const state = createGame(s);
  const rnd = lcg(7);
  const act = (a: Action) => {
    recorder.record(state.tick, a);
    applyAction(state, state.humanId, a);
  };
  const saves: Saved[] = [];
  for (let k = 0; k < ticks; k++) {
    script(state, act, rnd);
    if (saveAt.includes(state.tick)) {
      // a save between two clicks of one tick, then the rest of that tick's clicks (as a page hide can land)
      const save = JSON.parse(JSON.stringify(recorder.snapshot(state, 2, 1000))) as SaveData;
      saves.push({ save, hash: hashState(state) });
      // one more click in the same tick, after the save: a later save replays it, this one stops before it
      act({ type: 'setAuto', mix: saves.length % 2 === 0 });
    }
    tick(state);
  }
  return { saves, state, recorder };
}

function replay(save: SaveData): { state: GameState; r: Replayer } {
  const state = createGame(save.settings);
  const r = new Replayer(state, save);
  for (let guard = 0; guard < 100_000 && !r.run(97); guard++);
  return { state, r };
}

describe('save and continue: replay', () => {
  it('replaying a recorded game reaches the same hash at every save tick', () => {
    const { saves, state, recorder } = playAndSave(1300, [150, 600, 1100]);
    expect(saves.length).toBe(3);
    const me = state.players[1];
    // the script really built, fought and made units
    expect([...state.buildings.values()].filter((b) => b.owner === 1).length).toBeGreaterThan(4);
    expect(state.units.some((u) => u && u.owner === 1)).toBe(true);
    expect(recorder.log.some(([, a]) => a.type === 'attack')).toBe(true);
    expect(me.alive).toBe(true);
    for (const { save, hash } of saves) {
      expect(checkSave(save).status).toBe('ok');
      const { state: again, r } = replay(save);
      expect(r.mismatch).toBeNull();
      expect(r.done).toBe(true);
      expect(again.tick).toBe(save.tick);
      expect(hashState(again)).toBe(hash);
      expect(r.checked).toBe(save.checks.length);
    }
  }, 120_000);

  it('a slider drag in one tick is kept as its last value', () => {
    const rec = new GameRecorder(settings());
    for (let k = 0; k < 5; k++) rec.record(10, { type: 'setArmyMix', armor: 0.1 * k, artillery: 0 });
    rec.record(11, { type: 'setArmyMix', armor: 0.7, artillery: 0 });
    expect(rec.log.length).toBe(2);
    expect(rec.log[0]).toEqual([10, { type: 'setArmyMix', armor: 0.4, artillery: 0 }]);
  });

  it('records a copy of each action (the UI may change its object later)', () => {
    const rec = new GameRecorder(settings());
    const a = { type: 'attack' as const, tile: 5, troops: { infantry: 10, armor: 0, artillery: 0 } };
    rec.record(4, a);
    a.troops.infantry = 99;
    expect((rec.log[0][1] as typeof a).troops.infantry).toBe(10);
  });

  it('stops at the first checkpoint that differs (a save from other code)', () => {
    const { saves } = playAndSave(700, [300, 650]);
    const save = saves[1].save;
    // pretend the code changed: one recorded hash is off
    save.checks[0].h = (save.checks[0].h + 1) >>> 0;
    const state = createGame(save.settings);
    const r = new Replayer(state, save);
    for (let guard = 0; guard < 100_000 && !r.run(50); guard++);
    expect(r.mismatch).toEqual({ tick: save.checks[0].t, kind: 'hash' });
    expect(r.done).toBe(false);
    // Load anyway: the rest plays without comparing
    r.keepGoing();
    for (let guard = 0; guard < 100_000 && !r.run(50); guard++);
    expect(r.done).toBe(true);
    expect(state.tick).toBe(save.tick);
    expect(hashState(state)).toBe(saves[1].hash);
  }, 120_000);

  it('a different seed in the save is caught by the hashes', () => {
    const { saves } = playAndSave(400, [350]);
    const save = saves[0].save;
    save.settings = { ...save.settings, seed: save.settings.seed + 1 };
    const { r } = replay(save);
    expect(r.mismatch).not.toBeNull();
  }, 60_000);
});

describe('save format', () => {
  function base(): SaveData {
    return {
      format: SAVE_FORMAT,
      build: saveBuildId(),
      savedAt: 1000,
      settings: settings(),
      tick: 50,
      log: [
        [3, { type: 'spawn', tile: 10 }],
        [20, { type: 'startNow' }],
      ],
      checks: [{ t: 50, n: 2, h: 123 }],
      meta: { map: 'Continents, small', minutes: 0.3, land: 0.02, tickMs: 2 },
    };
  }

  it('accepts its own saves and rejects damaged ones', () => {
    expect(checkSave(base()).status).toBe('ok');
    expect(parseSave(JSON.stringify(base()))?.status).toBe('ok');
    expect(parseSave(null)).toBeNull();
    expect(parseSave('{not json')?.status).toBe('broken');
    expect(parseSave('[]')?.status).toBe('broken');
    const unordered = base();
    unordered.log.reverse();
    expect(checkSave(unordered).status).toBe('broken');
    const late = base();
    late.log.push([51, { type: 'startNow' }]);
    expect(checkSave(late).status).toBe('broken');
    const badCheck = base();
    badCheck.checks.push({ t: 50, n: 9, h: 1 });
    expect(checkSave(badCheck).status).toBe('broken');
    const noSettings = base() as unknown as Record<string, unknown>;
    delete noSettings.settings;
    expect(checkSave(noSettings).status).toBe('broken');
  });

  it('a save from another build or format is "old" and keeps its card text', () => {
    const other = { ...base(), build: 'cfg-00000000' };
    const slot = checkSave(other);
    expect(slot.status).toBe('old');
    if (slot.status === 'old') {
      expect(slot.meta?.map).toBe('Continents, small');
      expect(slot.savedAt).toBe(1000);
    }
    expect(checkSave({ ...base(), format: SAVE_FORMAT + 1 }).status).toBe('old');
    // even a future build's broken data is only offered for deleting
    expect(checkSave({ format: 99 }).status).toBe('old');
  });

  it('start page texts', () => {
    const now = 10_000_000;
    expect(savedAgo(now - 20_000, now)).toBe('Saved just now');
    expect(savedAgo(now - 5 * 60_000, now)).toBe('Saved 5 min ago');
    expect(savedAgo(now - 3 * 3600_000, now)).toBe('Saved 3 h ago');
    expect(savedAgo(now - 30 * 3600_000, now)).toBe('Saved yesterday');
    expect(savedAgo(now - 72 * 3600_000, now)).toBe('Saved 3 days ago');
    expect(saveFacts({ map: '', minutes: 24.7, land: 0.183, tickMs: 1 })).toBe('24 min played, 18% of the land');
    expect(saveFacts({ map: '', minutes: 75, land: 0.004, tickMs: 1 })).toBe('1 h 15 min played, <1% of the land');
    expect(saveFacts({ map: '', minutes: 0.2, land: 0, tickMs: 1 })).toBe('Just started, 0% of the land');
    expect(loadNote(20)).toBeNull();
    expect(loadNote(70)).toBe('Takes about 1 min to load');
    expect(loadNote(200)).toBe('Takes about 3 min to load');
    expect(clockText(65.2)).toBe('1:06');
  });

  it('thins old checkpoints and keeps the newest', () => {
    const checks = Array.from({ length: 40 }, (_, i) => ({ t: i * 10, n: i, h: i }));
    thinChecks(checks, 24);
    expect(checks.length).toBeLessThanOrEqual(24);
    expect(checks[checks.length - 1].t).toBe(390);
    expect(checks[0].t).toBe(0);
    for (let i = 1; i < checks.length; i++) expect(checks[i].t).toBeGreaterThan(checks[i - 1].t);
  });
});
