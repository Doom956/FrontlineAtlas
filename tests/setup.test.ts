// Game setup (src/sim/setup.ts) and modifiers / teams in play (src/sim/rules.ts): validation, presets, every
// modifier's effect, team rules and real-world map games.
import { applyAction } from '../src/sim/actions';
import { BUILDINGS, START_GOLD, TECH_ORDER, TICKS_PER_SECOND } from '../src/sim/config';
import { growthBonus, goldIncome } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import { atPeace, buildSeconds, frontRate, peaceSecondsLeft, sameTeam } from '../src/sim/rules';
import {
  activeModifiers,
  applyPreset,
  cloneSetup,
  DEFAULT_MODIFIERS,
  DEFAULT_SETUP,
  defaultTribeCount,
  matchPreset,
  mergeSetup,
  modifierSummary,
  PRESETS,
  sanitizeSetup,
  sizeClassForLand,
  STARTING_GOLD,
  validateSetup,
} from '../src/sim/setup';
import { tick } from '../src/sim/sim';
import { annexEnclaves } from '../src/sim/endgame';
import { autoSpawnRemaining, createGame, gameSeconds, setOwner } from '../src/sim/state';
import { isTribe } from '../src/sim/types';
import type { GameState, Modifiers } from '../src/sim/types';
import { victoryShareNow } from '../src/sim/victory';
import { getWorldMap, loadWorldMap } from '../src/sim/worldmaps';
import { claimRect, makeFlatGame, testSettings } from './helpers';

const inf = (n: number) => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** Two neighbouring nations (1 human, 2 AI) and a tribe (3) on a flat map, with modifiers. */
function duel(mods: Partial<Modifiers> = {}): GameState {
  const s = makeFlatGame(60, 30, 3, { human: true });
  s.players[3].personality = 'tribe';
  s.settings.modifiers = { ...DEFAULT_MODIFIERS, ...mods };
  claimRect(s, 1, 0, 0, 19, 29);
  claimRect(s, 2, 20, 0, 39, 14);
  claimRect(s, 3, 20, 15, 39, 29);
  s.playStartTick = s.tick;
  return s;
}

describe('setup: validation', () => {
  it('accepts the defaults and every preset, rejects bad values and unknown fields', () => {
    expect(validateSetup(DEFAULT_SETUP, false)).toBeNull();
    for (const p of PRESETS) expect(validateSetup(applyPreset(p.id, DEFAULT_SETUP, () => 0.5), false)).toBeNull();
    expect(validateSetup({ aiCount: 41 })).toMatch(/aiCount/);
    expect(validateSetup({ tribeCount: -2 })).toMatch(/tribeCount/);
    expect(validateSetup({ map: { kind: 'world', id: 'atlantis' } })).toMatch(/world map/);
    expect(validateSetup({ map: { kind: 'generated', type: 'continents', size: 'tiny' } })).toMatch(/size/);
    expect(validateSetup({ modifiers: { peaceMinutes: 3 } })).toMatch(/peaceMinutes/);
    expect(validateSetup({ modifiers: { goldMultiplier: 10 } })).toMatch(/goldMultiplier/);
    expect(validateSetup({ modifiers: { noNukes: 'yes' } })).toMatch(/noNukes/);
    expect(validateSetup({ modifiers: { hack: true } })).toMatch(/unknown modifier/);
    expect(validateSetup({ hack: 1 })).toMatch(/unknown setting/);
    expect(validateSetup({ timeLimit: 61 })).toMatch(/timeLimit/);
    expect(validateSetup({ timeLimit: 15 * 60, victoryLandShare: 0.6, modifiers: { fastGame: true } })).toBeNull();
    expect(validateSetup({ aiCount: 3 }, false)).toMatch(/missing/);
  });

  it('sanitizes saved settings and merges partial patches', () => {
    const s = sanitizeSetup({ aiCount: 7.6, difficulty: 'insane', map: { kind: 'world', id: 'europe' }, modifiers: { noAir: true, troopGrowth: 7 } });
    expect(s.aiCount).toBe(8);
    expect(s.difficulty).toBe('normal');
    expect(s.map).toEqual({ kind: 'world', id: 'europe' });
    expect(s.modifiers.noAir).toBe(true);
    expect(s.modifiers.troopGrowth).toBe(1);
    expect(sanitizeSetup('junk')).toEqual(DEFAULT_SETUP);
    const m = mergeSetup(DEFAULT_SETUP, { modifiers: { peaceMinutes: 4 }, aiCount: 2 });
    expect(m.modifiers).toEqual({ ...DEFAULT_MODIFIERS, peaceMinutes: 4 });
    expect(m.aiCount).toBe(2);
    expect(DEFAULT_SETUP.modifiers.peaceMinutes).toBe(0); // not shared
  });

  it('defaults: few nations, tribes by the land of the map', () => {
    expect(DEFAULT_SETUP.aiCount).toBe(8);
    expect(defaultTribeCount({ kind: 'generated', type: 'continents', size: 'small' }, false)).toBe(120);
    expect(defaultTribeCount({ kind: 'generated', type: 'continents', size: 'medium' }, false)).toBe(200);
    expect(defaultTribeCount({ kind: 'generated', type: 'continents', size: 'huge' }, false)).toBe(300);
    expect(defaultTribeCount({ kind: 'world', id: 'world' }, false)).toBe(300);
    // compact: a quarter of the land, so fewer tribes
    expect(defaultTribeCount({ kind: 'generated', type: 'continents', size: 'large' }, true)).toBe(120);
    expect(sizeClassForLand(300_000)).toBe('small');
    expect(sizeClassForLand(2_000_000)).toBe('huge');
  });
});

describe('setup: presets and labels', () => {
  it('presets set what they promise and are recognised again; any change makes it custom', () => {
    const q = applyPreset('quickConquest', DEFAULT_SETUP);
    expect(q.map).toEqual({ kind: 'generated', type: 'continents', size: 'small' });
    expect(q.modifiers.fastGame).toBe(true);
    expect(q.tribeCount).toBeGreaterThan(q.aiCount * 20);
    expect(matchPreset(q)).toBe('quickConquest');
    const g = applyPreset('grandWar', DEFAULT_SETUP);
    expect(g.map.kind).toBe('world');
    expect(g.aiCount).toBeGreaterThan(DEFAULT_SETUP.aiCount);
    const i = applyPreset('islandHopping', { ...cloneSetup(DEFAULT_SETUP), difficulty: 'hard', mode: 'teams', teamCount: 3 });
    expect(i.map).toMatchObject({ type: 'archipelago' });
    expect(i.modifiers.noAir).toBe(true);
    expect([i.difficulty, i.mode, i.teamCount]).toEqual(['hard', 'teams', 3]); // kept
    expect(matchPreset({ ...cloneSetup(i), aiCount: 3 })).toBe('custom');
    expect(matchPreset(DEFAULT_SETUP)).toBe('classic');
  });

  it('chaos rolls 2-4 modifiers, never two values of one modifier', () => {
    let seed = 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 40; k++) {
      const c = applyPreset('chaos', DEFAULT_SETUP, rand);
      const changed = (Object.keys(DEFAULT_MODIFIERS) as (keyof Modifiers)[]).filter((f) => c.modifiers[f] !== DEFAULT_MODIFIERS[f]);
      expect(changed.length).toBeGreaterThanOrEqual(2);
      expect(changed.length).toBeLessThanOrEqual(4);
      expect(validateSetup(c, false)).toBeNull();
    }
  });

  it('describes the active modifiers in plain words', () => {
    expect(modifierSummary(DEFAULT_SETUP)).toBe('Standard rules');
    const s = mergeSetup(DEFAULT_SETUP, { modifiers: { peaceMinutes: 4, noNukes: true, fastGame: true }, timeLimit: 1800 });
    const labels = activeModifiers(s).map((m) => m.label);
    expect(labels).toEqual(expect.arrayContaining(['Peace 4 min', 'No atom bombs', 'Fast game', '30 min limit']));
    for (const m of activeModifiers(s)) expect(m.detail.length).toBeGreaterThan(10);
  });
});

describe('modifiers in play', () => {
  it('starting gold, all techs unlocked, and no research', () => {
    const rich = createGame(testSettings({ mods: { startingGold: 'veryHigh', research: 'allUnlocked' } }));
    const nations = rich.players.filter((p) => p.id > 0 && !isTribe(p));
    expect(nations.every((p) => p.gold === STARTING_GOLD.veryHigh)).toBe(true);
    expect(nations.every((p) => p.techs.length === TECH_ORDER.length)).toBe(true);
    expect(createGame(testSettings()).players[1].gold).toBe(START_GOLD);
    const s = duel({ research: 'off' });
    s.players[1].gold = 1e6;
    expect(applyAction(s, 1, { type: 'research', tech: 'agriculture' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Research is off/) });
    expect(applyAction(s, 1, { type: 'build', building: 'hospital', tile: at(s, 5, 5) }).reason).toMatch(/Research is off/);
    expect(applyAction(s, 1, { type: 'build', building: 'city', tile: at(s, 5, 5) }).ok).toBe(true);
    // labs only make science: useless (and refused) when research is off or everything is unlocked
    expect(applyAction(s, 1, { type: 'build', building: 'lab', tile: at(s, 6, 6) }).reason).toMatch(/labs have no use/);
    expect(applyAction(duel({ research: 'allUnlocked' }), 1, { type: 'build', building: 'lab', tile: at(s, 6, 6) }).reason).toMatch(/labs have no use/);
  });

  it('gold income, troop growth and fast game scale the rates', () => {
    const s = duel();
    const gold = goldIncome(s, s.players[1]);
    const growth = growthBonus(s, s.players[1]);
    s.settings.modifiers.goldMultiplier = 3;
    s.settings.modifiers.troopGrowth = 0.5;
    expect(goldIncome(s, s.players[1])).toBeCloseTo(gold * 3, 6);
    expect(growthBonus(s, s.players[1])).toBeCloseTo(growth * 0.5, 6);
    s.settings.modifiers.fastGame = true;
    expect(goldIncome(s, s.players[1])).toBeCloseTo(gold * 6, 6);
    expect(growthBonus(s, s.players[1])).toBeCloseTo(growth, 6);
    expect(frontRate(s)).toBe(2);
    expect(buildSeconds(s, 30)).toBe(15);
  });

  it('build speed: fast takes a third, instant finishes on the next tick', () => {
    for (const [speed, expected] of [['normal', BUILDINGS.city.buildTime], ['fast', BUILDINGS.city.buildTime / 3], ['instant', 0.1]] as const) {
      const s = duel({ buildSpeed: speed });
      s.players[1].gold = 1e6;
      expect(applyAction(s, 1, { type: 'build', building: 'city', tile: at(s, 8, 8) }).ok).toBe(true);
      const b = [...s.buildings.values()][0];
      expect(b.buildLeft).toBeCloseTo(expected, 6);
      if (speed === 'instant') {
        tick(s);
        expect(b.buildLeft).toBe(0);
        expect(s.events.some((e) => e.kind === 'buildingDone')).toBe(true);
      }
    }
  });

  it('peace time: no attacks between nations (tribes and the wilderness are fine) until it runs out', () => {
    const s = duel({ peaceMinutes: 2 });
    expect(peaceSecondsLeft(s)).toBe(120);
    expect(atPeace(s, 1, 2)).toBe(true);
    expect(atPeace(s, 1, 3)).toBe(false); // a tribe
    const r = applyAction(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(5000) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Peace time/);
    expect(applyAction(s, 2, { type: 'attack', tile: at(s, 19, 5), troops: inf(5000) }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 20, 20), troops: inf(5000) }).ok).toBe(true); // tribe
    s.tick = s.playStartTick + 120 * TICKS_PER_SECOND;
    expect(peaceSecondsLeft(s)).toBe(0);
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(5000) }).ok).toBe(true);
  });

  it('peace time: AI nations leave each other alone and announce the end', () => {
    const s = createGame(testSettings({ humanPlayer: false, aiCount: 6, tribeCount: 20, seed: 9, mods: { peaceMinutes: 2 } }));
    let nationWar = false;
    while (s.phase !== 'over' && gameSeconds(s) < 125) {
      tick(s);
      for (const a of s.attacks) if (a.target > 0 && !isTribe(s.players[a.target]) && !isTribe(s.players[a.attacker]) && gameSeconds(s) < 120) nationWar = true;
    }
    expect(nationWar).toBe(false);
    expect(s.events.some((e) => /Peace time is over/.test(e.message))).toBe(true);
  });

  it('no alliances, no atom bombs, no air force, no warships, no SAM sites', () => {
    const s = duel({ noAlliances: true, noNukes: true, noAir: true, noNavy: true, noSams: true, research: 'allUnlocked' });
    s.players[1].techs = TECH_ORDER.slice();
    s.players[1].gold = 1e7;
    s.players[1].iron = 1e6;
    s.players[1].oil = 1e6;
    expect(applyAction(s, 1, { type: 'requestAlliance', to: 2 }).reason).toMatch(/Alliances are off/);
    expect(applyAction(s, 1, { type: 'launchMissile', silo: at(s, 4, 4), kind: 'atomBomb', tile: at(s, 30, 5) }).reason).toMatch(/Atom bombs are off/);
    expect(applyAction(s, 1, { type: 'build', building: 'airfield', tile: at(s, 6, 6) }).reason).toMatch(/air force/);
    expect(applyAction(s, 1, { type: 'build', building: 'sam', tile: at(s, 6, 20) }).reason).toMatch(/SAM/);
    expect(applyAction(s, 1, { type: 'paradrop', airfield: at(s, 4, 4), tile: at(s, 30, 5), troops: 1000 }).reason).toMatch(/air force/);
    expect(applyAction(s, 1, { type: 'buildAircraft', airfield: at(s, 4, 4), kind: 'bomber' }).reason).toMatch(/air force/);
    expect(applyAction(s, 1, { type: 'buildWarship', port: at(s, 4, 4) }).reason).toMatch(/Warships are off/);
    // the rest still works
    expect(applyAction(s, 1, { type: 'build', building: 'silo', tile: at(s, 10, 10) }).ok).toBe(true);
  });

  it('random spawn places the human at once and refuses picking a start', () => {
    const s = createGame(testSettings({ mods: { randomSpawn: true } }));
    expect(applyAction(s, 1, { type: 'spawn', tile: 0 }).reason).toMatch(/Random starts/);
    tick(s);
    expect(s.players[1].spawned).toBe(true);
    expect(applyAction(s, 1, { type: 'startNow' }).ok).toBe(true);
  });

  it('compact map: half the width and height', () => {
    const full = createGame(testSettings({ mapSize: 'small' }));
    const compact = createGame(testSettings({ mapSize: 'small', mods: { compactMap: true } }));
    expect(compact.map.width).toBe(full.map.width / 2);
    expect(compact.map.height).toBe(full.map.height / 2);
    expect(compact.map.landTileCount).toBeLessThan(full.map.landTileCount * 0.4);
    expect(compact.mapClass).toBe('small');
  });

  it('victory share and time limit come from the settings', () => {
    const s = duel();
    s.settings.victoryLandShare = 0.6;
    expect(victoryShareNow(s)).toBe(0.6);
  });

  it('same settings and modifiers give the same game', () => {
    const settings = testSettings({ seed: 77, aiCount: 4, tribeCount: 8, humanPlayer: false, mods: { fastGame: true, peaceMinutes: 2, goldMultiplier: 2, buildSpeed: 'fast' } });
    const a = createGame(settings);
    const b = createGame(cloneSetup(settings));
    for (let k = 0; k < 900; k++) {
      tick(a);
      tick(b);
    }
    expect(hashState(a)).toBe(hashState(b));
  });
});

describe('teams', () => {
  it('deals nations round-robin with the human on team 1, teammates share a colour family', () => {
    const s = createGame(testSettings({ aiCount: 5, tribeCount: 4, mode: 'teams', teamCount: 2 }));
    expect(s.teams.slice(1, 7)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(s.players.filter((p) => isTribe(p)).every((p) => s.teams[p.id] === 0)).toBe(true);
    expect(sameTeam(s, 1, 3)).toBe(true);
    expect(sameTeam(s, 1, 2)).toBe(false);
    expect(s.players[1].color).toEqual(s.settings.playerColor);
    expect(createGame(testSettings({ aiCount: 5 })).teams.every((t) => t === 0)).toBe(true);
  });

  it('teammates are allied for good: no attacks, no breaking up; the team wins together', () => {
    const s = duel();
    s.settings.mode = 'teams';
    s.settings.teamCount = 2;
    s.teams = [0, 1, 1, 0];
    claimRect(s, 2, 40, 0, 59, 29);
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(5000) }).reason).toMatch(/teammate/);
    expect(applyAction(s, 1, { type: 'breakAlliance', with: 2 }).reason).toMatch(/Teammates/);
    expect(applyAction(s, 1, { type: 'requestAlliance', to: 2 }).reason).toMatch(/same team/);
    // 1 + 2 hold a third and a half of the land: neither wins alone at 75%, together they do
    s.settings.victoryLandShare = 0.75;
    s.tick = s.playStartTick + TICKS_PER_SECOND * 10;
    tick(s);
    expect(s.phase).toBe('over');
    expect(s.winnerTeam).toBe(1);
    expect([1, 2]).toContain(s.winner);
  });
});

describe('tribes walled in', () => {
  it('a tribe surrounded by one nation is absorbed whatever its size; one by the sea stays', () => {
    const s = makeFlatGame(60, 40, 2);
    s.players[2].personality = 'tribe';
    claimRect(s, 1, 0, 0, 59, 39);
    claimRect(s, 2, 15, 8, 44, 31); // 720 tiles, more than TRIBE_ANNEX_TILES
    expect(annexEnclaves(s)).toBe(720);
    expect(s.players[2].alive).toBe(false);
    const t = makeFlatGame(60, 40, 2);
    t.players[2].personality = 'tribe';
    claimRect(t, 1, 0, 0, 59, 39);
    claimRect(t, 2, 15, 8, 44, 31);
    setOwner(t, at(t, 30, 20), 0); // a hole of free land inside: open, not walled in
    expect(annexEnclaves(t)).toBe(0);
    expect(t.players[2].alive).toBe(true);
  });
});

describe('real-world map games', () => {
  it('AI nations are the real countries and start at their capitals', async () => {
    const info = getWorldMap('british-isles')!;
    const settings = testSettings({ map: { kind: 'world', id: info.id }, aiCount: 6, tribeCount: 30, humanPlayer: false, seed: 3 });
    expect(() => createGame(settings)).toThrow(/load the world map/);
    const s = createGame(settings, await loadWorldMap(info.id));
    expect(s.map.width).toBe(info.width);
    for (let k = 0; k < 6; k++) {
      const p = s.players[1 + k];
      expect(p.name).toBe(info.spawns[k].name);
      expect(s.spawnPoints[p.id]).toBe(info.spawns[k].tile);
    }
    autoSpawnRemaining(s);
    const w = s.map.width;
    for (let k = 0; k < 6; k++) {
      const p = s.players[1 + k];
      expect(p.spawned).toBe(true);
      const dx = (p.capital % w) - (info.spawns[k].tile % w);
      const dy = Math.floor(p.capital / w) - Math.floor(info.spawns[k].tile / w);
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(12);
    }
    expect(s.players.filter((p) => isTribe(p) && p.spawned).length).toBeGreaterThan(20);
  });

  it('compact and random-spawn world games still work', async () => {
    const map = await loadWorldMap('scandinavia');
    const s = createGame(testSettings({ map: { kind: 'world', id: 'scandinavia' }, aiCount: 4, tribeCount: -1, humanPlayer: false, mods: { compactMap: true } }), map);
    expect(s.map.width).toBe(Math.floor(map.width / 2));
    expect(s.spawnPoints.slice(1, 5).every((t) => t >= 0 && t < s.map.width * s.map.height)).toBe(true);
    const r = createGame(testSettings({ map: { kind: 'world', id: 'scandinavia' }, aiCount: 4, humanPlayer: false, mods: { randomSpawn: true } }), await loadWorldMap('scandinavia'));
    expect(r.spawnPoints.every((t) => t === -1)).toBe(true);
    for (let k = 0; k < 13 * TICKS_PER_SECOND; k++) tick(r);
    expect(r.phase).toBe('playing');
    expect(r.players.slice(1, 5).every((p) => p.spawned)).toBe(true);
  });
});
