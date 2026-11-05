// Fog of war (src/sim/fog.ts, game rule Modifiers.fogOfWar): vision sources, explored memory, allies, hashing, the
// setup rule, and AI / auto units that only aim at what they know.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { FOG, TICKS_PER_SECOND } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { createFog, fogOn, knownTile, unitSeen, updateFog, visibleTile } from '../src/sim/fog';
import { hashState } from '../src/sim/hash';
import { interceptStep } from '../src/sim/navy';
import { activeModifiers, DEFAULT_MODIFIERS, sanitizeSetup, validateSetup, DEFAULT_SETUP, cloneSetup } from '../src/sim/setup';
import { tick } from '../src/sim/sim';
import { createGame, newId, setOwner } from '../src/sim/state';
import { BLOCK } from '../src/sim/territory';
import type { Building, BuildingType, GameState, Unit, UnitType } from '../src/sim/types';
import { claimRect, makeFlatGame, testSettings } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 320 x 320 plains (20 x 20 blocks), 3 players; player 1 is human and owns block (0, 0) only. Fog on, playing. */
function fogGame(): GameState {
  const s = makeFlatGame(320, 320, 3, { human: true, seed: 5 });
  s.settings.modifiers = { ...s.settings.modifiers, fogOfWar: true };
  claimRect(s, 1, 0, 0, 15, 15);
  claimRect(s, 2, 288, 288, 319, 319);
  claimRect(s, 3, 288, 0, 319, 31);
  s.fog = createFog(s);
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function addUnit(s: GameState, type: UnitType, owner: number, x: number, y: number, extra: Partial<Unit> = {}): Unit {
  const u: Unit = {
    id: newId(s),
    type,
    owner,
    x,
    y,
    target: at(s, x, y),
    home: at(s, x, y),
    path: [],
    pathPos: 0,
    troops: { infantry: 0, armor: 0, artillery: 0 },
    hp: 1,
    cargo: at(s, x, y),
    state: 0,
    targetOwner: 0,
    ...extra,
  };
  s.units.push(u);
  return u;
}
/** True when block (bx, by) is in view for viewer. */
const inView = (s: GameState, viewer: number, bx: number, by: number): boolean => visibleTile(s, viewer, at(s, bx * BLOCK + 3, by * BLOCK + 3));
const explored = (s: GameState, viewer: number, bx: number, by: number): boolean => knownTile(s, viewer, at(s, bx * BLOCK + 3, by * BLOCK + 3));

describe('fog of war: the rule', () => {
  it('is off by default: no fog state, and the hash equals a game whose settings predate the rule', () => {
    const a = createGame(testSettings({ seed: 77 }));
    const old = testSettings({ seed: 77 });
    delete (old.modifiers as Partial<typeof old.modifiers>).fogOfWar; // a save or lobby from before the rule
    const b = createGame(old);
    expect(a.fog).toBeUndefined();
    expect(b.fog).toBeUndefined();
    for (let k = 0; k < 400; k++) {
      tick(a);
      tick(b);
    }
    expect(hashState(a)).toBe(hashState(b));
    expect(fogOn(a)).toBe(false);
    expect(visibleTile(a, 1, 0)).toBe(true);
  });

  it('validates, sanitizes to off and shows a chip', () => {
    expect(DEFAULT_MODIFIERS.fogOfWar).toBe(false);
    expect(validateSetup({ modifiers: { fogOfWar: true } })).toBeNull();
    expect(validateSetup({ modifiers: { fogOfWar: 'yes' } })).toMatch(/fogOfWar/);
    const full = cloneSetup(DEFAULT_SETUP);
    expect(validateSetup(full, false)).toBeNull();
    const partialMods = { ...full, modifiers: { ...full.modifiers } } as Record<string, unknown>;
    delete (partialMods.modifiers as Record<string, unknown>).fogOfWar;
    expect(sanitizeSetup(partialMods).modifiers.fogOfWar).toBe(false);
    expect(sanitizeSetup({ ...full, modifiers: { ...full.modifiers, fogOfWar: true } }).modifiers.fogOfWar).toBe(true);
    expect(activeModifiers(full).some((m) => m.id === 'fogOfWar')).toBe(false);
    const on = { ...full, modifiers: { ...full.modifiers, fogOfWar: true } };
    const chip = activeModifiers(on).find((m) => m.id === 'fogOfWar');
    expect(chip?.label).toBe('Fog of war');
    expect(chip?.detail).not.toMatch(/\u2014/);
  });

  it('is created with the game, lifts in the spawn phase, at the end and in a continued game', () => {
    const s = createGame(testSettings({ seed: 3, mods: { fogOfWar: true } }));
    expect(s.fog).toBeDefined();
    expect(s.fog!.now[0]).toBeNull();
    expect(s.phase).toBe('spawn');
    expect(fogOn(s)).toBe(false);
    s.phase = 'playing';
    expect(fogOn(s)).toBe(true);
    s.continued = true;
    expect(fogOn(s)).toBe(false);
    s.continued = false;
    s.phase = 'over';
    expect(fogOn(s)).toBe(false);
  });

  it('tribes have no vision arrays; spectators (viewer 0) see everything', () => {
    const s = createGame(testSettings({ seed: 3, tribeCount: 4, mods: { fogOfWar: true } }));
    const tribes = s.players.filter((p) => p.personality === 'tribe');
    expect(tribes.length).toBeGreaterThan(0);
    for (const t of tribes) expect(s.fog!.now[t.id]).toBeNull();
    s.phase = 'playing';
    expect(visibleTile(s, 0, 12345)).toBe(true);
  });
});

describe('fog of war: vision', () => {
  it('own land sees FOG.landBand past its edge; seen stays after the view moves on', () => {
    const s = fogGame();
    updateFog(s, true);
    expect(FOG.landBand).toBe(24);
    expect(inView(s, 1, 0, 0)).toBe(true);
    expect(inView(s, 1, 2, 0)).toBe(true); // gap 16
    expect(inView(s, 1, 2, 2)).toBe(true); // gap 16, 16: 512 <= 576
    expect(inView(s, 1, 3, 0)).toBe(false); // gap 32
    expect(inView(s, 1, 10, 10)).toBe(false);
    // A transport sails out to the middle: it sees around it, and the blocks stay explored after it is gone.
    const u = addUnit(s, 'transport', 1, 160, 160);
    updateFog(s, true);
    expect(inView(s, 1, 10, 10)).toBe(true);
    s.units.splice(s.units.indexOf(u), 1);
    updateFog(s, true);
    expect(inView(s, 1, 10, 10)).toBe(false);
    expect(explored(s, 1, 10, 10)).toBe(true);
  });

  it('land vision equals the full land band of every owned block (interior blocks skip their disc)', () => {
    const s = makeFlatGame(400, 320, 3, { human: true, seed: 9 });
    s.settings.modifiers = { ...s.settings.modifiers, fogOfWar: true };
    // irregular land: a big block with a hole, a thin strip, scattered single tiles
    claimRect(s, 1, 40, 40, 250, 200);
    for (let y = 100; y < 140; y++) for (let x = 120; x < 170; x++) setOwner(s, y * 400 + x, 2);
    claimRect(s, 1, 0, 300, 399, 303);
    for (let k = 0; k < 40; k++) setOwner(s, ((k * 7919) % 320) * 400 + ((k * 104729) % 400), 1);
    s.fog = createFog(s);
    updateFog(s, true);
    const f = s.fog!;
    const owned = new Set<number>();
    for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === 1) owned.add((((i / 400) | 0) >> 4) * f.bw + ((i % 400) >> 4));
    const want = new Uint32Array(f.words);
    const r = FOG.landBand;
    for (const b of owned) {
      const bx = b % f.bw;
      const by = (b - bx) / f.bw;
      for (let y = 0; y < f.bh; y++) {
        for (let x = 0; x < f.bw; x++) {
          const gx = Math.max(0, Math.abs(x - bx) - 1) * BLOCK;
          const gy = Math.max(0, Math.abs(y - by) - 1) * BLOCK;
          if (gx * gx + gy * gy <= r * r) want[(y * f.bw + x) >>> 5] |= 1 << ((y * f.bw + x) & 31);
        }
      }
    }
    expect([...f.now[1]!]).toEqual([...want]);
  });

  it('seen is monotonic over a played fog game', () => {
    const s = createGame(testSettings({ seed: 11, aiCount: 4, mods: { fogOfWar: true } }));
    let prev = s.fog!.seen.map((w) => (w ? w.slice() : null));
    for (let k = 0; k < 1200; k++) {
      tick(s);
      if (k % 50 !== 0) continue;
      for (let id = 0; id < prev.length; id++) {
        const a = prev[id];
        const b = s.fog!.seen[id];
        if (!a || !b) continue;
        for (let j = 0; j < a.length; j++) expect((a[j] & ~b[j]) >>> 0).toBe(0);
      }
      prev = s.fog!.seen.map((w) => (w ? w.slice() : null));
    }
    // Everyone alive and not a tribe sees its own capital.
    for (const p of s.players) if (p.alive && p.id > 0 && p.personality !== 'tribe' && p.capital >= 0) expect(visibleTile(s, p.id, p.capital)).toBe(true);
  });

  it('unit radii: a warship sees farther than a transport; a moving warship marks new blocks', () => {
    const s = fogGame();
    addUnit(s, 'warship', 1, 160, 160);
    updateFog(s, true);
    // 30 tiles from x 160: block 11 (starts at 176) and block 8 (ends at 143) are in view, 12 (192) and 7 (127) not;
    // a transport (12) sees only its own block's neighbours.
    expect(inView(s, 1, 8, 10)).toBe(true);
    expect(inView(s, 1, 11, 10)).toBe(true);
    expect(inView(s, 1, 12, 10)).toBe(false);
    expect(inView(s, 1, 7, 10)).toBe(false);
    addUnit(s, 'transport', 1, 160, 40);
    updateFog(s, true);
    expect(inView(s, 1, 9, 2)).toBe(true); // block 9 ends at 159: 1 tile away
    expect(inView(s, 1, 8, 2)).toBe(false); // block 8 ends at 143: 17 > 12

    const w = s.units[0];
    w.x = 250;
    updateFog(s, true);
    expect(inView(s, 1, 15, 10)).toBe(true);
    expect(inView(s, 1, 10, 10)).toBe(false);
    expect(explored(s, 1, 10, 10)).toBe(true);
  });

  it('watchtowers see watchtowerRadius x 0.5, ports FOG.portSea, unfinished ones nothing', () => {
    const s = fogGame();
    claimRect(s, 1, 0, 150, 15, 165);
    const t = addBuilding(s, 'watchtower', 1, at(s, 8, 158));
    t.buildLeft = 5;
    updateFog(s, true);
    expect(inView(s, 1, 4, 9)).toBe(false);
    t.buildLeft = 0;
    updateFog(s, true);
    expect(inView(s, 1, 3, 9)).toBe(true); // 40 tiles at level 1: x 8 -> block 3 starts at 48
    expect(inView(s, 1, 4, 9)).toBe(false);
    claimRect(s, 1, 150, 0, 159, 9);
    addBuilding(s, 'port', 1, at(s, 155, 5));
    updateFog(s, true);
    expect(inView(s, 1, 11, 0)).toBe(true); // 30 from x 155: block 11 starts at 176 (21 away)
  });

  it('recon reveals are vision for their owner while they last', () => {
    const s = fogGame();
    s.arsenal = { reveals: [{ owner: 1, tile: at(s, 200, 200), radius: 18, untilTick: s.tick + 50, kind: 1 }], holds: [], reconReady: [] };
    updateFog(s, true);
    expect(inView(s, 1, 12, 12)).toBe(true);
    expect(inView(s, 2, 0, 0)).toBe(false);
    s.tick += 60;
    updateFog(s, true);
    expect(inView(s, 1, 12, 12)).toBe(false);
    expect(explored(s, 1, 12, 12)).toBe(true);
  });

  it('allies share live vision; what an ally showed stays explored after the alliance', () => {
    const s = fogGame();
    updateFog(s, true);
    expect(inView(s, 1, 19, 19)).toBe(false);
    formAlliance(s, 1, 2);
    updateFog(s, true);
    expect(inView(s, 1, 19, 19)).toBe(true);
    expect(inView(s, 2, 0, 0)).toBe(true);
    s.alliances = [];
    updateFog(s, true);
    expect(inView(s, 1, 19, 19)).toBe(false);
    expect(explored(s, 1, 19, 19)).toBe(true);
  });

  it("the owner console's revealIntel lifts fog for that player only", () => {
    const s = fogGame();
    updateFog(s, true);
    expect(inView(s, 1, 19, 19)).toBe(false);
    s.admin = { aiPassive: [], godMode: [], aiFrozen: false, revealIntel: [1] };
    expect(inView(s, 1, 19, 19)).toBe(true);
    expect(inView(s, 3, 0, 19)).toBe(false);
  });

  it('enemy units are seen only in view; own and allied always; aircraft also on radar', () => {
    const s = fogGame();
    const ship = addUnit(s, 'warship', 2, 160, 160);
    const near = addUnit(s, 'warship', 2, 20, 20);
    updateFog(s, true);
    expect(unitSeen(s, 1, ship)).toBe(false);
    expect(unitSeen(s, 1, near)).toBe(true);
    expect(unitSeen(s, 2, ship)).toBe(true);
    expect(unitSeen(s, 0, ship)).toBe(true);
    const bomber = addUnit(s, 'bomber', 2, 160, 100);
    expect(unitSeen(s, 1, bomber)).toBe(false);
    claimRect(s, 1, 100, 100, 110, 110);
    addBuilding(s, 'sam', 1, at(s, 105, 105));
    expect(unitSeen(s, 1, bomber)).toBe(true); // SAM radar 60 tiles
  });
});

describe('fog of war: lockstep', () => {
  const settings = () => testSettings({ seed: 21, aiCount: 5, tribeCount: 3, mapType: 'archipelago', mods: { fogOfWar: true } });
  it('two fog games hash the same; fog on and off differ; the hash covers the fog bits', () => {
    const a = createGame(settings());
    const b = createGame(settings());
    const off = createGame(testSettings({ seed: 21, aiCount: 5, tribeCount: 3, mapType: 'archipelago' }));
    for (let k = 0; k < 1500; k++) {
      tick(a);
      tick(b);
      tick(off);
      if (k % 100 === 99) expect(hashState(a)).toBe(hashState(b));
    }
    expect(hashState(a)).not.toBe(hashState(off));
    const h = hashState(a);
    const words = a.fog!.seen[1]!;
    words[words.length - 1] ^= 1 << 30;
    expect(hashState(a)).not.toBe(h);
  }, 120_000);
});

describe('fog of war: AI and auto units aim only at what they know', () => {
  it('AI strikes, drops, nukes and landings on nations only hit tiles they had explored', () => {
    const s = createGame(
      testSettings({
        seed: 8,
        aiCount: 6,
        tribeCount: 0,
        humanPlayer: false,
        mapType: 'archipelago',
        difficulty: 'hard',
        mods: { fogOfWar: true, research: 'allUnlocked', startingGold: 'veryHigh', fastGame: true },
      }),
    );
    const known = new Set<number>();
    let checked = 0;
    const bad: string[] = [];
    for (let k = 0; k < 8 * 60 * TICKS_PER_SECOND; k++) {
      // Snapshot of what each AI knew before this tick's decisions (vision refresh runs before updateAI).
      tick(s);
      for (const u of s.units) {
        if (known.has(u.id)) continue;
        known.add(u.id);
        const p = s.players[u.owner];
        if (!p || p.isHuman || p.personality === 'tribe') continue;
        const aimed = u.type === 'rocket' || u.type === 'atomBomb' || (u.type === 'bomber' && !u.mission) || u.type === 'transportPlane' || (u.type === 'transport' && s.map.owner[u.target] > 0 && s.players[s.map.owner[u.target]].personality !== 'tribe');
        if (!aimed || u.target < 0) continue;
        checked++;
        if (!knownTile(s, u.owner, u.target)) bad.push(`${u.type} of ${u.owner} at ${u.target} tick ${s.tick}`);
      }
    }
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  it('a hunting warship ignores enemy ships it can not see', () => {
    const s = makeFlatGame(320, 64, 2, { human: false, seed: 2 });
    s.map.terrain.fill(0); // all deep water: one sea
    s.settings.modifiers = { ...s.settings.modifiers, fogOfWar: true };
    s.fog = createFog(s);
    const hunter = addUnit(s, 'warship', 1, 10, 30);
    const prey = addUnit(s, 'warship', 2, 300, 30);
    updateFog(s, true);
    expect(visibleTile(s, 1, at(s, 300, 30))).toBe(false);
    const wars = new Set<number>([1 * 1024 + 2, 2 * 1024 + 1]);
    for (let t = 0; t < 40; t++) {
      s.tick = t;
      interceptStep(s, hunter, [hunter, prey], wars, 20, 40, true);
    }
    expect(hunter.state).not.toBe(2);
    // Without fog the same hunt chases it across the sea.
    s.fog = undefined;
    for (let t = 40; t < 80; t++) {
      s.tick = t;
      interceptStep(s, hunter, [hunter, prey], wars, 20, 40, true);
    }
    expect(hunter.state).toBe(2);
  });
});
