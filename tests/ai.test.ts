// AI nations (WP-E): spawning, a whole AI-only game, alliance answers, determinism, hands off the human.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiSpawn, aiWantsAlliance, DIFFICULTY, updateAI } from '../src/sim/ai';
import { SPAWN_SECONDS, TICKS_PER_SECOND, VICTORY_LAND_SHARE } from '../src/sim/config';
import { launchAttack } from '../src/sim/combat';
import { breakAlliance, formAlliance } from '../src/sim/diplomacy';
import { tick } from '../src/sim/sim';
import { canSpawnAt, createGame, spawnMinDistance } from '../src/sim/state';
import type { BuildingType, Difficulty, GameSettings, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame, testSettings } from './helpers';

function aiSettings(seed: number, overrides: Partial<GameSettings> = {}): GameSettings {
  return testSettings({ seed, aiCount: 4, playerName: 'Nobody', humanPlayer: false, victoryLandShare: VICTORY_LAND_SHARE, tribeCount: 0, ...overrides });
}

/** Runs the spawn phase to its end (the tick that starts the game). */
function runSpawnPhase(state: GameState): void {
  while (state.phase === 'spawn') tick(state);
}

describe('aiSpawn', () => {
  it('places every AI during the spawn phase, apart from each other', () => {
    const state = createGame(aiSettings(7));
    // Every AI picks its own moment within the first ~70% of the phase; stop before autoSpawnRemaining runs.
    const ticks = Math.round((SPAWN_SECONDS - 1) * TICKS_PER_SECOND);
    for (let k = 0; k < ticks; k++) tick(state);
    expect(state.phase).toBe('spawn');
    const ais = state.players.filter((p) => p.id !== 0);
    for (const p of ais) {
      expect(p.spawned).toBe(true);
      expect(p.tiles).toBeGreaterThan(10);
    }
    const w = state.map.width;
    for (const a of ais) {
      for (const b of ais) {
        if (a.id >= b.id) continue;
        const dx = (a.capital % w) - (b.capital % w);
        const dy = ((a.capital / w) | 0) - ((b.capital / w) | 0);
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(spawnMinDistance(state));
      }
    }
  });

  it('on Easy, AI starts keep more room around a human start than on Hard', () => {
    const nearest = (difficulty: Difficulty, seed: number): number => {
      const state = createGame(aiSettings(seed, { humanPlayer: true, aiCount: 6, difficulty }));
      const w = state.map.width;
      // The human picks a start first (the middle-most valid tile), then the AIs come.
      let tile = -1;
      for (let r = 0; r < w && tile < 0; r++) {
        const t = ((state.map.height / 2) | 0) * w + ((w / 2) | 0) + r;
        if (canSpawnAt(state, 1, t)) tile = t;
      }
      expect(applyAction(state, 1, { type: 'spawn', tile }).ok).toBe(true);
      const ticks = Math.round((SPAWN_SECONDS - 1) * TICKS_PER_SECOND);
      for (let k = 0; k < ticks; k++) tick(state);
      let best = Infinity;
      for (const p of state.players) {
        if (p.id <= 1 || !p.spawned) continue;
        const dx = (p.capital % w) - (tile % w);
        const dy = ((p.capital / w) | 0) - ((tile / w) | 0);
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
      }
      return best;
    };
    expect(DIFFICULTY.easy.humanRoom).toBeGreaterThan(1);
    for (const d of ['normal', 'hard', 'brutal'] as const) expect(DIFFICULTY[d].humanRoom).toBe(1);
    let easy = 0;
    let hard = 0;
    for (const seed of [11, 12, 13]) {
      easy += nearest('easy', seed);
      hard += nearest('hard', seed);
    }
    expect(easy).toBeGreaterThan(hard);
  });

  it('does nothing outside the spawn phase or for the human', () => {
    const state = createGame(aiSettings(3, { humanPlayer: true, aiCount: 2 }));
    for (let k = 0; k < SPAWN_SECONDS * TICKS_PER_SECOND - 5; k++) {
      state.spawnLeft -= 0.1;
      aiSpawn(state);
    }
    expect(state.players[1].spawned).toBe(false); // the human chooses (or is auto-placed at the end)
    expect(state.players[2].spawned && state.players[3].spawned).toBe(true);
  });
});

describe('AI-only game', () => {
  it('spawns, expands, builds, researches and goes to war within 6 minutes', () => {
    const state = createGame(aiSettings(2));
    runSpawnPhase(state);
    const ais = state.players.filter((p) => p.id !== 0);
    for (const p of ais) expect(p.spawned).toBe(true);
    const startTiles = ais.map((p) => p.tiles);

    const pvp = new Set<number>(); // attack ids between nations
    const kinds = new Map<number, Set<BuildingType>>();
    let ms = 0;
    const ticks = 6 * 60 * TICKS_PER_SECOND;
    for (let k = 0; k < ticks && state.phase === 'playing'; k++) {
      const t0 = performance.now();
      tick(state);
      ms += performance.now() - t0;
      for (const a of state.attacks) if (a.target !== 0) pvp.add(a.id);
      for (const b of state.buildings.values()) {
        if (!kinds.has(b.owner)) kinds.set(b.owner, new Set());
        kinds.get(b.owner)!.add(b.type);
      }
      state.events.length = 0;
    }

    // Wars are decisive now (a weak nation can fall to a gang-up), but most survive the first 6 minutes.
    expect(ais.filter((p) => p.alive).length).toBeGreaterThanOrEqual(ais.length - 1);
    ais.forEach((p, k) => {
      expect(p.stats.tilesMax).toBeGreaterThan(startTiles[k] * 5); // expanded
      expect(kinds.get(p.id)?.size ?? 0).toBeGreaterThanOrEqual(3); // several building types
      expect(p.techs.length + (p.researching ? 1 : 0) + (p.alive ? 0 : 1)).toBeGreaterThanOrEqual(1); // research
    });
    // At least two nations built cities.
    expect(ais.filter((p) => kinds.get(p.id)?.has('city')).length).toBeGreaterThanOrEqual(2);
    expect(pvp.size).toBeGreaterThanOrEqual(1);
    expect(ms / ticks).toBeLessThan(5);
  }, 60_000);

  it('is deterministic for a seed', () => {
    const run = (): GameState => {
      const s = createGame(aiSettings(5));
      runSpawnPhase(s);
      for (let k = 0; k < 90 * TICKS_PER_SECOND; k++) tick(s);
      return s;
    };
    const a = run();
    const b = run();
    expect(Array.from(a.map.owner)).toEqual(Array.from(b.map.owner));
    expect(a.players.map((p) => [p.tiles, Math.round(p.gold), Math.round(p.troops.infantry), p.techs.join()])).toEqual(
      b.players.map((p) => [p.tiles, Math.round(p.gold), Math.round(p.troops.infantry), p.techs.join()]),
    );
    expect(a.buildings.size).toBe(b.buildings.size);
  }, 60_000);

  it('never acts for the human player (with the advisor switched off)', () => {
    const state = createGame(aiSettings(4, { humanPlayer: true, aiCount: 3 }));
    runSpawnPhase(state);
    const human = state.players[1];
    expect(human.isHuman).toBe(true);
    expect(human.auto).toEqual({ mix: true, research: true }); // the default for humans
    expect(applyAction(state, human.id, { type: 'setAuto', mix: false, research: false }).ok).toBe(true);
    for (let k = 0; k < 60 * TICKS_PER_SECOND; k++) tick(state);
    expect(human.armyMix).toEqual({ armor: 0, artillery: 0 });
    expect(human.researching).toBeNull();
    expect(state.attacks.some((a) => a.attacker === human.id)).toBe(false);
    expect([...state.buildings.values()].some((b) => b.owner === human.id)).toBe(false);
    // ...while the AIs did act.
    expect([...state.buildings.values()].some((b) => b.owner !== human.id)).toBe(true);
  });
});

describe('aiWantsAlliance', () => {
  /** 3 AIs on a 60x20 plains strip: 1 | 2 | 3, everyone well stocked. */
  function strip(): GameState {
    const s = makeFlatGame(60, 20, 3);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    claimRect(s, 3, 40, 0, 59, 19);
    return s;
  }

  it('accepts a friend and refuses a disliked nation', () => {
    const s = strip();
    s.opinion[1][3] = 60;
    expect(aiWantsAlliance(s, 1, 3)).toBe(true);
    s.opinion[1][3] = -60;
    expect(aiWantsAlliance(s, 1, 3)).toBe(false);
  });

  it('refuses traitors and nations attacking it', () => {
    const s = strip();
    s.opinion[2][1] = 80;
    s.opinion[2][3] = 80;
    formAlliance(s, 1, 3);
    breakAlliance(s, 1, 3); // 1 is now a traitor
    s.opinion[2][1] = 80;
    expect(aiWantsAlliance(s, 2, 1)).toBe(false);
    expect(launchAttack(s, 3, 10 * 60 + 25, { infantry: 500, armor: 0, artillery: 0 }).ok).toBe(true);
    expect(aiWantsAlliance(s, 2, 3)).toBe(false);
  });

  it('answers pending requests on its next decision', () => {
    const s = strip();
    // A careful nation (equal neighbours are no prey for it), fond of player 1.
    s.players[2].personality = 'turtle';
    s.opinion[2][1] = 90;
    s.allianceRequests.push({ from: 1, to: 2, expiresTick: s.tick + 300 });
    for (let k = 0; k < 3 * TICKS_PER_SECOND; k++) {
      updateAI(s);
      s.tick++;
    }
    expect(s.allianceRequests.some((r) => r.from === 1 && r.to === 2)).toBe(false);
    expect(s.alliances.some((al) => al.a === 1 && al.b === 2)).toBe(true);
  });
});
