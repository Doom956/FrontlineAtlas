// Round 2 open-list fixes: AI air wings strike through carriers, recon refuses a knocked-out airfield, submarine
// hiding (sim visibility and the map layer), and the recon-intel cache not leaking client reads into the sim.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiAirWings, airMissionOf, airWingRange, wingOf } from '../src/sim/airwings';
import { hasIntel, markBuildingsChanged } from '../src/sim/buildings';
import { ARSENAL, TECH_EFFECTS } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { newId, setOwner } from '../src/sim/state';
import { unitVisibleTo } from '../src/sim/techtree';
import { spawnWarshipAt } from '../src/sim/units';
import { applyWarshipVariant, arsenalState, canReconFlight, revealIntel } from '../src/sim/variants';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, TechId, Unit } from '../src/sim/types';
import { UnitLayer } from '../src/client/render/units';
import { Camera } from '../src/client/camera';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function give(s: GameState, pid: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[pid].techs.includes(t)) s.players[pid].techs.push(t);
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** width x 40: land y 0..19 (player 1 x 0..split-1, player 2 the rest, player 3 nothing), sea y 20..39; AIs frozen. */
function coastGame(width = 80, split = 40): GameState {
  const s = makeFlatGame(width, 40, 3, { human: true, seed: 4 });
  for (let y = 20; y < 40; y++) for (let x = 0; x < width; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, split - 1, 19);
  claimRect(s, 2, split, 0, width - 1, 19);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players.slice(1)) {
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
  }
  return s;
}
function ship(s: GameState, owner: number, x: number, y: number, v?: 'destroyer' | 'submarine' | 'carrier'): Unit {
  const u = spawnWarshipAt(s, owner, at(s, owner === 1 ? 20 : s.map.width - 20, 19), at(s, x, y));
  applyWarshipVariant(u, v);
  return u;
}

describe('AI air wings and carriers', () => {
  it('a wing whose airfield is out of reach strikes a city an own carrier has in reach', () => {
    const s = coastGame(240, 40);
    give(s, 1, 'flight', 'strategicBombing');
    const af = addBuilding(s, 'airfield', 1, at(s, 2, 2));
    af.bombers = 4;
    const city = addBuilding(s, 'city', 2, at(s, 220, 10));
    expect((220 - 2) ** 2 + 8 ** 2).toBeGreaterThan(airWingRange(af, s) ** 2); // the airfield alone can't reach it
    aiAirWings(s, 1, [2], false);
    expect(airMissionOf(s, af)).toBe('idle');
    const c = ship(s, 1, 200, 30, 'carrier');
    expect((200 - 220) ** 2 + 20 ** 2).toBeLessThanOrEqual(ARSENAL.carrierAirRange ** 2);
    expect(aiAirWings(s, 1, [2], false)).toBe(1);
    expect(airMissionOf(s, af)).toBe('strategic');
    expect(wingOf(s, af)?.target).toBe(city.tile);
    // A plain warship there is no carrier.
    const s2 = coastGame(240, 40);
    give(s2, 1, 'flight', 'strategicBombing');
    const af2 = addBuilding(s2, 'airfield', 1, at(s2, 2, 2));
    addBuilding(s2, 'city', 2, at(s2, 220, 10));
    ship(s2, 1, c.x, c.y);
    aiAirWings(s2, 1, [2], false);
    expect(airMissionOf(s2, af2)).toBe('idle');
  });
});

describe('recon flights and knocked-out airfields', () => {
  it('refuses an airfield that is knocked out, with and without a named airfield, until it works again', () => {
    const s = coastGame();
    give(s, 1, 'flight', 'reconPlanes');
    const af = addBuilding(s, 'airfield', 1, at(s, 30, 10));
    const target = at(s, 50, 10);
    af.disabledUntil = s.tick + 50;
    expect(canReconFlight(s, 1, af.tile, target).reason).toMatch(/knocked out/);
    expect(canReconFlight(s, 1, -1, target).reason).toMatch(/knocked out/);
    const g0 = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: -1, tile: target }).ok).toBe(false);
    expect(s.players[1].gold).toBe(g0);
    // A second, working airfield is picked instead.
    const af2 = addBuilding(s, 'airfield', 1, at(s, 10, 10));
    expect(canReconFlight(s, 1, -1, target)).toMatchObject({ ok: true, airfield: af2.tile });
    s.tick += 50;
    expect(canReconFlight(s, 1, af.tile, target).ok).toBe(true);
  });
});

describe('submarine hiding', () => {
  // Player 1 owns x 0..39 of the coast, player 2 x 40..79; the sea is y 20..39.
  it('an enemy submarine far out at sea is hidden; owner, allies and spectators see it', () => {
    const s = coastGame();
    const sub = ship(s, 2, 15, 37, 'submarine'); // 18 tiles off player 1's coast
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
    expect(unitVisibleTo(s, 3, sub)).toBe(false); // a nation with no coast or ships
    expect(unitVisibleTo(s, 2, sub)).toBe(true);
    expect(unitVisibleTo(s, 0, sub)).toBe(true);
    const plain = ship(s, 2, 15, 36);
    expect(unitVisibleTo(s, 1, plain)).toBe(true); // only submarines hide
    formAlliance(s, 1, 2);
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
  });

  it('own coast and own ships within submarineRevealRange reveal it', () => {
    const s = coastGame();
    const r = TECH_EFFECTS.submarineRevealRange;
    const sub = ship(s, 2, 15, 19 + r + 2);
    applyWarshipVariant(sub, 'submarine');
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
    sub.y = 19 + r - 2; // close to player 1's coast
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
    sub.y = 37;
    const mine = ship(s, 1, 15, 37 - r + 2); // a plain warship of ours near it
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
    mine.hp = 0; // sunk ships see nothing
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
  });

  it('destroyer sonar, a recon circle and Early Warning reveal it, each only for its owner', () => {
    const s = coastGame();
    const sub = ship(s, 2, 15, 37, 'submarine');
    // Sonar: a destroyer within destroyerSonar (farther than submarineRevealRange).
    const dd = ship(s, 1, 15 + Math.min(ARSENAL.destroyerSonar - 2, 20), 37, 'destroyer');
    expect(Math.abs(dd.x - sub.x)).toBeGreaterThan(TECH_EFFECTS.submarineRevealRange);
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
    expect(unitVisibleTo(s, 3, sub)).toBe(false);
    dd.hp = 0;
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
    // Recon: a reveal circle over it, for its owner and only while it lasts.
    arsenalState(s).reveals.push({ owner: 1, tile: at(s, 15, 35), radius: ARSENAL.reconRadius, untilTick: s.tick + 10, kind: 1 });
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
    expect(unitVisibleTo(s, 3, sub)).toBe(false);
    s.tick += 10;
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
    // Early Warning: a longer reach from the coast (18 tiles out: beyond 12, within 24).
    give(s, 1, 'earlyWarning');
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
  });

  it('the map layer skips hidden enemy submarines and draws visible ones', () => {
    const s = coastGame();
    const sub = ship(s, 2, 15, 37, 'submarine');
    const cam = new Camera(s.map.width, s.map.height);
    cam.resize(800, 400);
    cam.zoom = 8;
    cam.x = 15;
    cam.y = 30;
    // A no-op 2D context: every method is a stub, every property write is accepted.
    const noop = (): void => undefined;
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : noop),
      set: (t, k, v) => {
        t[k] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    const colors = s.players.map((p) => p.color);
    const draw = (viewer: number): boolean => {
      const layer = new UnitLayer();
      layer.reset(s.map.width);
      layer.draw(ctx, s, cam, 1, colors, viewer, 1, 0);
      return layer.screenOf(sub.id) !== null;
    };
    expect(draw(1)).toBe(false); // hidden from the enemy
    expect(draw(2)).toBe(true); // its owner
    expect(draw(0)).toBe(true); // spectator
    ship(s, 1, 15, 36, 'destroyer');
    expect(draw(1)).toBe(true); // sonar shows it
  });
});

describe('recon-intel cache', () => {
  it('a read between ticks does not hand the sim stale intel', () => {
    const s = coastGame();
    // Player 1 sees x 50..70 of player 2's land; player 3 owns nothing yet.
    arsenalState(s).reveals.push({ owner: 1, tile: at(s, 60, 10), radius: ARSENAL.reconRadius, untilTick: s.tick + 1000, kind: 1 });
    expect(revealIntel(s, 1, 2)).toBe(true);
    expect(revealIntel(s, 1, 3)).toBe(false); // a client read fills the cache
    for (let y = 0; y < 20; y++) for (let x = 55; x < 66; x++) setOwner(s, at(s, x, y), 3);
    applyAction(s, 1, { type: 'reconFlight', airfield: -1, tile: 0 }); // any action (this one fails) starts sim work
    expect(revealIntel(s, 1, 3)).toBe(true);
    expect(hasIntel(s, 1, 3)).toBe(true);
    for (let y = 0; y < 20; y++) for (let x = 55; x < 66; x++) setOwner(s, at(s, x, y), 2);
    revealIntel(s, 1, 3);
    tick(s); // a tick starts with an empty cache too
    expect(revealIntel(s, 1, 3)).toBe(false);
  });

  it('two games stay in lockstep when one of them reads intel between every tick', () => {
    const mk = (): GameState => {
      const g = makeTestGame({ seed: 777, aiCount: 4 });
      for (const p of g.players) if (p.id > 0 && p.capital >= 0) arsenalState(g).reveals.push({ owner: p.id, tile: p.capital, radius: 60, untilTick: 1e9, kind: 1 });
      return g;
    };
    const a = mk();
    const b = mk();
    for (let k = 0; k < 400; k++) {
      for (const p of a.players) for (const q of a.players) if (p.id > 0 && q.id > 0) hasIntel(a, p.id, q.id);
      tick(a);
      tick(b);
    }
    expect(hashState(a)).toBe(hashState(b));
  });
});
