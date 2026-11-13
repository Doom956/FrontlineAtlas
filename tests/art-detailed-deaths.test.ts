// Deaths (client/fx/deaths.ts, fx/pixelFx.ts, art/detailed/deaths.ts and wrecks.ts): a unit the sim destroys plays its
// death once, where it was; a unit that lands, docks, unloads or goes home does not; the detailed deaths draw over
// their whole life at every motion preset and zoom without throwing; the wrecks burn and sink as they should.
// No DOM: the drawing runs against a stand-in context that records nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { setArtStyle } from '../src/client/art/artStyle';
import { motionParams } from '../src/client/art/motion';
import { styleModule } from '../src/client/art/registry';
import { ART_STYLES } from '../src/client/art/artStyle';
import { rasterize, solidCount } from '../src/client/art/detailed/bake';
import { deathTimesOf } from '../src/client/art/detailed/deaths';
import { flashAt } from '../src/client/art/detailed/explosions';
import { unitModel } from '../src/client/art/detailed/models';
import { CHAR_STEPS, charOf, heelOf, SINK_STEPS, sinkOf } from '../src/client/art/detailed/wrecks';
import { DEATH_KINDS, type DeathDraw, type DeathKind, type DeathLayer } from '../src/client/art/types';
import type { SpriteKey } from '../src/client/art/shared/keys';
import { BattleFx } from '../src/client/fx/battleFx';
import { DeathWatch, deathKindOf } from '../src/client/fx/deaths';
import { PixelFx } from '../src/client/fx/pixelFx';
import { UnitLayer } from '../src/client/render/units';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TANK_DIVISION_TROOPS } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { bombDivisions, spawnTankDivision } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, Unit, UnitType } from '../src/sim/types';
import { launchBomber, launchParadrop, launchTransport, shotDown, spawnWarshipAt, updateUnits } from '../src/sim/units';
import { claimRect, makeFlatGame } from './helpers';

afterEach(() => {
  setArtStyle('all', 'detailed');
  setArtStyle('cannonFire', 'realistic');
});

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 140 x 40: land x 0..19 (player 1, human), sea x 20..119, land x 120..139 (player 2). */
function seaGame(): GameState {
  const s = makeFlatGame(140, 40, 2, { human: true, seed: 7 });
  for (let y = 0; y < 40; y++) for (let x = 20; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 39);
  claimRect(s, 2, 120, 0, 139, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
  }
  return s;
}

/** 60 x 30 of land: player 1 west, player 2 east. */
function landGame(): GameState {
  const s = makeFlatGame(60, 30, 2, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
  s.players[1].techs.push('mechanization');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 0 };
  return s;
}

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

const live = (p: PixelFx): PixelFx['deaths'] => p.deaths.filter((d) => d.live);

/** Runs the sim one tick at a time (100 ms of clock each), the effects reading every tick, until `done` or `max`. */
function play(s: GameState, p: PixelFx, clock: { now: number }, done: () => boolean, max = 3000, step: (s: GameState) => void = tick): number {
  let k = 0;
  for (; k < max && !done(); k++) {
    step(s);
    clock.now += 100;
    p.update(s, clock.now);
  }
  return k;
}
const simStep = (s: GameState): void => {
  updateUnits(s);
  s.tick++;
};

describe('deaths: telling a destroyed unit from one that arrived', () => {
  it('knows which units die which death', () => {
    const kinds: Partial<Record<UnitType, DeathKind>> = { bomber: 'plane', fighter: 'plane', transportPlane: 'plane', reconPlane: 'plane', rocket: 'missile', atomBomb: 'missile', tankDivision: 'tank', transport: 'ship', warship: 'ship', tradeShip: 'ship' };
    for (const [t, k] of Object.entries(kinds)) expect(deathKindOf(t as UnitType), t).toBe(k);
    for (const k of DEATH_KINDS) expect(Object.values(kinds)).toContain(k);
  });

  it('plays a ship sunk in a duel once, where it went down, and never writes to the state', () => {
    const s = seaGame();
    const hunter = spawnWarshipAt(s, 2, at(s, 119, 2), at(s, 70, 2));
    const prey = spawnWarshipAt(s, 1, at(s, 20, 38), at(s, 70, 32));
    prey.hp = 0.5;
    prey.path = [];
    const p = new PixelFx();
    const clock = { now: 0 };
    p.update(s, 0);
    let deathsAt = -1;
    play(
      s,
      p,
      clock,
      () => {
        if (deathsAt < 0 && live(p).length) deathsAt = s.tick;
        return !s.units.includes(prey);
      },
      1500,
      simStep,
    );
    expect(s.units.includes(prey)).toBe(false);
    p.update(s, clock.now);
    const d = live(p);
    expect(d.length).toBe(1);
    expect(d[0].kind).toBe('ship');
    expect(d[0].key).toBe('warship');
    expect(d[0].water).toBe(true);
    expect(Math.abs(d[0].x - (prey.x + 0.5)) + Math.abs(d[0].y - (prey.y + 0.5))).toBeLessThan(0.01);
    // its kill blast was the death: no extra hit blast there
    expect(p.blasts.filter((b) => b.live && b.kind === 'hit').length).toBe(0);
    // more ticks: still one, never fired again; the state is untouched by reading it
    const before = hashState(s);
    p.update(s, clock.now + 16);
    expect(hashState(s)).toBe(before);
    play(s, p, clock, () => false, 20, simStep);
    expect(p.deaths.filter((x) => x.live && x.kind === 'ship').length).toBe(1);
    expect(hunter.hp).toBeGreaterThan(0);
  });

  it('does not play a death for a transport that lands its troops', () => {
    const s = seaGame();
    const p = new PixelFx();
    const clock = { now: 0 };
    p.update(s, 0);
    const res = launchTransport(s, 1, at(s, 19, 20), at(s, 120, 20), { infantry: 500, armor: 0, artillery: 0 });
    expect(res.ok, res.reason).toBe(true);
    const tr = s.units.find((u) => u.type === 'transport')!;
    play(s, p, clock, () => !s.units.includes(tr), 3000, simStep);
    expect(s.units.includes(tr)).toBe(false);
    play(s, p, clock, () => false, 3, simStep);
    expect(live(p).length).toBe(0);
  });

  it('plays a bomber shot down once (a crater where it crashes on land), but not one that flies home and lands', () => {
    const s = landGame();
    const af = addBuilding(s, 'airfield', 1, at(s, 10, 15));
    af.bombers = 2;
    const p = new PixelFx();
    const clock = { now: 0 };
    p.update(s, 0);
    // one bomber over the enemy, home again and stored: no death
    expect(launchBomber(s, 1, af.tile, at(s, 34, 15)).ok).toBe(true);
    const home = s.units.find((u) => u.type === 'bomber')!;
    play(s, p, clock, () => !s.units.includes(home), 3000);
    expect(s.units.includes(home)).toBe(false);
    expect(af.bombers).toBe(2);
    expect(live(p).length).toBe(0);
    // another shot down on its way (the sim's own shotDown, then its tick drops it)
    expect(launchBomber(s, 1, af.tile, at(s, 34, 15)).ok).toBe(true);
    const b = s.units.find((u) => u.type === 'bomber')!;
    play(s, p, clock, () => b.x > 20, 400);
    const craters = p.liveCounts().craters;
    shotDown(s, b, 2, 'SAM site');
    play(s, p, clock, () => !s.units.includes(b), 5);
    const d = live(p);
    expect(d.length).toBe(1);
    expect(d[0].kind).toBe('plane');
    expect(d[0].water).toBe(false);
    expect(p.liveCounts().craters).toBe(craters + 1);
    // the old small blast in the air is not drawn as well
    expect(p.blasts.filter((x) => x.live && x.kind === 'air').length).toBe(0);
    play(s, p, clock, () => false, 10);
    expect(live(p).length).toBe(1);
  });

  it('does not play a death for a cargo plane that drops its paratroopers', () => {
    const s = landGame();
    s.players[1].techs.push('flight');
    const af = addBuilding(s, 'airfield', 1, at(s, 24, 15));
    const p = new PixelFx();
    const clock = { now: 0 };
    p.update(s, 0);
    const res = launchParadrop(s, 1, af.tile, at(s, 33, 15), 500);
    expect(res.ok, res.reason).toBe(true);
    const plane = s.units.find((u) => u.type === 'transportPlane')!;
    play(s, p, clock, () => !s.units.includes(plane), 2000);
    expect(s.units.includes(plane)).toBe(false);
    expect(live(p).length).toBe(0);
  });

  it('plays a tank division bombed to pieces once, but not one overrun that falls back home', () => {
    const s = landGame();
    const p = new PixelFx();
    const clock = { now: 0 };
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    p.update(s, 0);
    // weak and on the move: a bomber finishes it (it keeps its last few troops aboard)
    d.state = 1;
    const full = TANK_DIVISION_TROOPS.infantry + TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.artillery;
    d.troops = { infantry: 0, armor: full * 0.055, artillery: 0 };
    bombDivisions(s, 2, at(s, 25, 15));
    expect(d.hp).toBe(0);
    play(s, p, clock, () => !s.units.includes(d), 3);
    expect(live(p).map((x) => x.kind)).toEqual(['tank']);
    play(s, p, clock, () => false, 5);
    expect(live(p).length).toBe(1);

    // a weak division whose ground is taken, with no own land near: beaten, it goes home with its troops
    const s2 = landGame();
    const p2 = new PixelFx();
    const e = spawnTankDivision(s2, 1, at(s2, 28, 15));
    e.troops = { infantry: 0, armor: full * 0.06, artillery: 0 };
    p2.update(s2, 0);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) if (Math.abs(x - 28) + Math.abs(y - 15) < 12) s2.map.owner[at(s2, x, y)] = 2;
    const c2 = { now: 0 };
    play(s2, p2, c2, () => !s2.units.includes(e), 5);
    expect(s2.units.includes(e)).toBe(false);
    expect(live(p2).length).toBe(0);
  });

  it('a style without death animations shows its small blast instead (the plane bursting in the air)', () => {
    setArtStyle('explosions', 'refined');
    const s = landGame();
    const af = addBuilding(s, 'airfield', 1, at(s, 10, 15));
    af.bombers = 1;
    const p = new PixelFx();
    const clock = { now: 0 };
    p.update(s, 0);
    expect(launchBomber(s, 1, af.tile, at(s, 34, 15)).ok).toBe(true);
    const b = s.units.find((u) => u.type === 'bomber')!;
    play(s, p, clock, () => b.x > 20, 400);
    shotDown(s, b, 2, 'fighters');
    play(s, p, clock, () => !s.units.includes(b), 5);
    expect(live(p).length).toBe(0);
    expect(p.blasts.filter((x) => x.live && x.kind === 'air').length).toBe(1);
  });

  it('leaves the sunk ship and the downed plane to the death animation, not the old splash and smoke', () => {
    const s = seaGame();
    const ship = spawnWarshipAt(s, 1, at(s, 19, 20), at(s, 40, 20));
    const b = new BattleFx();
    const cam = { zoom: 8, viewW: 1200, viewH: 400, tileToScreen: (x: number, y: number) => ({ x: x * 8, y: y * 8 }) };
    b.update(s, cam, 0);
    s.tick += 1;
    ship.hp = 0;
    s.units = s.units.filter((u) => u !== ship);
    s.effects.push({ kind: 'explosion', x: ship.x + 0.5, y: ship.y + 0.5, radius: 1.5, tick: s.tick });
    b.update(s, cam, 200);
    expect(b.pool.countOf('splash')).toBe(0);
  });

  it('drops no paratroopers where a cargo plane was shot down near its drop point, only where it got there', () => {
    const drops = (l: UnitLayer): number => (l as unknown as { drops: unknown[] }).drops.length;
    for (const shot of [true, false]) {
      const s = landGame();
      const plane = { id: 77, type: 'transportPlane', owner: 1, x: 30, y: 15, target: at(s, 32, 15), home: at(s, 10, 15), state: 0, hp: 1, path: [], pathPos: 0, cargo: 0, targetOwner: 2, troops: { infantry: 500, armor: 0, artillery: 0 } } as unknown as Unit;
      s.units.push(plane);
      const layer = new UnitLayer();
      layer.reset(s.map.width);
      layer.track(s, 0);
      s.tick += 1;
      plane.hp = 0;
      s.units = [];
      if (shot) s.effects.push({ kind: 'explosion', x: 30.5, y: 15.5, radius: 1.5, tick: s.tick });
      layer.track(s, 100);
      expect(drops(layer), shot ? 'shot down' : 'dropped').toBe(shot ? 0 : 1);
    }
  });

  it('matches each kill blast to one unit only: two ships sunk side by side are two deaths', () => {
    const w = new DeathWatch();
    const s = seaGame();
    const a = spawnWarshipAt(s, 1, at(s, 19, 20), at(s, 50, 20));
    const c = spawnWarshipAt(s, 1, at(s, 19, 21), at(s, 50, 21));
    w.reset(s);
    a.hp = 0;
    c.hp = 0;
    s.units = s.units.filter((u) => u.hp > 0);
    w.blast(a.x + 0.5, a.y + 0.5);
    const out: Unit[] = [];
    // one blast: one of them
    expect(w.scan(s, out)).toBe(1);
    w.endTick();
    // with both blasts both
    w.reset(null);
    const s2 = seaGame();
    const a2 = spawnWarshipAt(s2, 1, at(s2, 19, 20), at(s2, 50, 20));
    const c2 = spawnWarshipAt(s2, 1, at(s2, 19, 21), at(s2, 50, 21));
    w.reset(s2);
    a2.hp = 0;
    c2.hp = 0;
    s2.units = [];
    w.blast(a2.x + 0.5, a2.y + 0.5);
    w.blast(c2.x + 0.5, c2.y + 0.5);
    expect(w.scan(s2, out)).toBe(2);
    expect(new Set(out.map((u) => u.id)).size).toBe(2);
  });

  it('gives a kill blast only to the unit that died on that spot, not a neighbour arriving in the same tick', () => {
    // a transport landing its troops right beside its escort as the escort is sunk 0.5 tiles away, the transport
    // first in the list: only the escort plays a death
    const w = new DeathWatch();
    const s = seaGame();
    const transport = { id: 901, type: 'transport', owner: 1, x: 40, y: 20, hp: 1, troops: { infantry: 500, armor: 0, artillery: 0 } } as unknown as Unit;
    const escort = { id: 902, type: 'warship', owner: 1, x: 40.5, y: 20, hp: 1, troops: { infantry: 0, armor: 0, artillery: 0 } } as unknown as Unit;
    s.units.push(transport, escort);
    w.reset(s);
    s.tick += 1;
    transport.hp = 0;
    escort.hp = 0;
    s.units = s.units.filter((u) => u !== transport && u !== escort);
    w.blast(escort.x + 0.5, escort.y + 0.5);
    const out: Unit[] = [];
    expect(w.scan(s, out)).toBe(1);
    expect(out[0].id).toBe(902);
    expect(w.wasDeath(0)).toBe(true);
    w.endTick();
    // a blast of a unit that came and went between two looks (not in the last list) is nobody's: no false death
    const s2 = seaGame();
    const arrive = { id: 903, type: 'tradeShip', owner: 1, x: 50, y: 10, hp: 1, troops: { infantry: 0, armor: 0, artillery: 0 } } as unknown as Unit;
    s2.units.push(arrive);
    w.reset(s2);
    arrive.hp = 0;
    s2.units = [];
    w.blast(50.2, 10.6);
    expect(w.scan(s2, out)).toBe(0);
    expect(w.wasDeath(0)).toBe(false);
  });

  it('keeps the parachutes of a cargo plane that drops beside another shot down over the same drop tile', () => {
    const drops = (l: UnitLayer): { x: number; y: number }[] => (l as unknown as { drops: { x: number; y: number }[] }).drops;
    const s = landGame();
    const mk = (id: number, x: number, y: number): Unit => ({ id, type: 'transportPlane', owner: 1, x, y, target: at(s, 32, 15), home: at(s, 10, 15), state: 0, hp: 1, path: [], pathPos: 0, cargo: 0, targetOwner: 2, troops: { infantry: 500, armor: 0, artillery: 0 } }) as unknown as Unit;
    const shot = mk(81, 31.2, 15.1);
    const dropper = mk(82, 31.6, 14.8);
    s.units.push(shot, dropper);
    const layer = new UnitLayer();
    layer.reset(s.map.width);
    layer.track(s, 0);
    // the sim's tick: the one shot down gets its kill blast where it is, both leave the map
    s.effects.push({ kind: 'explosion', x: shot.x + 0.5, y: shot.y + 0.5, radius: 1.5, tick: s.tick });
    shot.hp = 0;
    dropper.hp = 0;
    s.units = [];
    s.tick += 1;
    layer.track(s, 100);
    expect(drops(layer).length).toBe(1);
    expect(drops(layer)[0].x).toBeCloseTo(32.5);
    // a kill blast left over from an earlier tick on the dropper's spot is not its own either
    const s2 = landGame();
    const d2 = mk(83, 31.6, 14.8);
    s2.units.push(d2);
    const l2 = new UnitLayer();
    l2.reset(s2.map.width);
    s2.effects.push({ kind: 'explosion', x: 32.1, y: 15.3, radius: 1.5, tick: s2.tick });
    s2.tick += 1;
    l2.track(s2, 0);
    d2.hp = 0;
    s2.units = [];
    s2.tick += 1;
    l2.track(s2, 100);
    expect(drops(l2).length).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------- drawing

/** A context that takes every call and records nothing. */
function nullCtx(): CanvasRenderingContext2D {
  const o: Record<string, unknown> = { globalAlpha: 1, imageSmoothingEnabled: true, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  return new Proxy(o, { get: (t, k) => (k in t ? t[k as string] : () => undefined), set: (t, k, v) => ((t[k as string] = v), true) }) as unknown as CanvasRenderingContext2D;
}

const CASES: [DeathKind, SpriteKey, boolean][] = [
  ['plane', 'fighter', false],
  ['plane', 'bomber', true],
  ['plane', 'transportPlane', true],
  ['plane', 'reconPlane', false],
  ['plane', 'heavyBomber', false],
  ['missile', 'rocket', false],
  ['missile', 'atomBomb', true],
  ['tank', 'tankDivision', false],
  ['tank', 'heavyTank', false],
  ['tank', 'lightTank', false],
  ['ship', 'warship', true],
  ['ship', 'battleship', true],
  ['ship', 'carrier', true],
  ['ship', 'transport', true],
  ['ship', 'tradeShip', true],
];

describe('detailed deaths: drawing', () => {
  it('draws every death over its whole life at every motion, zoom and with reduced motion, without throwing', () => {
    const art = styleModule('detailed').explosions;
    expect(typeof art.drawDeath).toBe('function');
    const ctx = nullCtx();
    for (const preset of ['subtle', 'lively', 'cinematic'] as const) {
      for (const reduced of [false, true]) {
        const m = motionParams(preset, reduced);
        for (const [kind, key, water] of CASES) {
          const T = art.deathTimes!(kind, m);
          for (const zoom of [2.5, 6, 14, 26]) {
            const scale = zoom < 11 ? 1 : zoom < 22 ? 2 : 3;
            for (let i = 0; i <= 24; i++) {
              const t = i / 24;
              const d: DeathDraw = { kind, key, mods: 0, owner: [226, 74, 60], x: 300, y: 200, angle: 0.4 * i, water, t, ageMs: t * T.durMs, durMs: T.durMs, zoom, scale, seed: (i * 0.137) % 1, reduced, dpr: zoom === 14 ? 2 : 1 };
              expect(() => art.drawDeath!(ctx, d, m), `${preset} ${kind} ${key} z${zoom} t${t}`).not.toThrow();
              expect(ctx.globalAlpha, `${kind} ${key} restores its alpha`).toBe(1);
            }
          }
        }
      }
    }
  });

  it('times every death from the motion: longer under cinematic, shorter under subtle, down before it is over', () => {
    const [s, l, c] = (['subtle', 'lively', 'cinematic'] as const).map((p) => motionParams(p, false));
    for (const k of DEATH_KINDS) {
      const ts = { ...deathTimesOf(k, s) };
      const tl = { ...deathTimesOf(k, l) };
      const tc = { ...deathTimesOf(k, c) };
      expect(ts.durMs, k).toBeLessThan(tl.durMs);
      expect(tl.durMs, k).toBeLessThan(tc.durMs);
      for (const t of [ts, tl, tc]) {
        expect(t.impactMs, k).toBeGreaterThanOrEqual(0);
        expect(t.impactMs, k).toBeLessThan(t.durMs);
      }
      // a plane falls for a moment before it hits; a ship floats a while before it is under
      if (k === 'plane' || k === 'ship') expect(tl.impactMs, k).toBeGreaterThan(1000);
    }
  });

  it('a blast timed to come later throws no light yet (the second blast on a big ship once flashed huge too early)', () => {
    const m = motionParams('lively', false);
    for (const k of ['bomb', 'hit', 'missile', 'air'] as const) {
      const f = { ...flashAt(k, -200, m) };
      expect(f.coreA, k).toBe(0);
      expect(f.glowA, k).toBe(0);
      expect(f.coreR, k).toBe(0);
    }
    expect(flashAt('bomb', 10, m).coreA).toBeGreaterThan(0);
  });

  it('draws what lies on the ground under the units and the rest over them: two layers, one pass each', () => {
    const art = styleModule('detailed').explosions;
    const real = art.drawDeath!;
    const seen: (DeathLayer | undefined)[] = [];
    art.drawDeath = (_ctx, d) => void seen.push(d.layer);
    try {
      const s = landGame();
      const af = addBuilding(s, 'airfield', 1, at(s, 10, 15));
      af.bombers = 1;
      const p = new PixelFx();
      const clock = { now: 0 };
      p.update(s, 0);
      expect(launchBomber(s, 1, af.tile, at(s, 34, 15)).ok).toBe(true);
      const b = s.units.find((u) => u.type === 'bomber')!;
      play(s, p, clock, () => b.x > 20, 400);
      shotDown(s, b, 2, 'SAM site');
      play(s, p, clock, () => !s.units.includes(b), 5);
      expect(live(p).length).toBe(1);
      const cam = { zoom: 20, x: b.x, y: b.y, viewW: 1200, viewH: 800 };
      const ctx = nullCtx();
      p.drawGround(ctx, cam, s.tick, 1, clock.now, null);
      expect(seen).toEqual(['ground']);
      p.drawAir(ctx, cam, clock.now, null, 1, null);
      expect(seen).toEqual(['ground', 'air']);
      // without the clock (an older caller) the ground pass draws the craters only
      p.drawGround(ctx, cam, s.tick, 1);
      expect(seen.length).toBe(2);
      // far out only the blink, in the air pass
      seen.length = 0;
      p.drawGround(ctx, { ...cam, zoom: 1.7 }, s.tick, 1, clock.now, null);
      p.drawAir(ctx, { ...cam, zoom: 1.7 }, clock.now, null, 1, null);
      expect(seen.length).toBe(0);
    } finally {
      art.drawDeath = real;
    }
    // every death draws in either layer alone without throwing
    const ctx = nullCtx();
    const m = motionParams('lively', false);
    for (const [kind, key, water] of CASES) {
      const T = art.deathTimes!(kind, m);
      for (const layer of ['ground', 'air'] as const) {
        for (let i = 0; i <= 12; i++) {
          const d: DeathDraw = { kind, key, mods: 0, owner: [226, 74, 60], x: 300, y: 200, angle: 0.3, water, t: i / 12, ageMs: (i / 12) * T.durMs, durMs: T.durMs, zoom: 26, scale: 3, seed: 0.4, reduced: false, dpr: 1, layer };
          expect(() => real(ctx, d, m)).not.toThrow();
          expect(ctx.globalAlpha).toBe(1);
        }
      }
    }
  });

  it('only the detailed style animates deaths; the others keep their small blasts', () => {
    for (const st of ART_STYLES) {
      const e = styleModule(st).explosions;
      if (st === 'detailed') expect(typeof e.drawDeath).toBe('function');
      else expect(e.drawDeath).toBeUndefined();
    }
  });
});

describe('detailed wrecks', () => {
  const tank = (): ReturnType<typeof rasterize> => rasterize(unitModel('tankDivision', 0).model, 2, 3, { facings: 32, owner: [64, 160, 255] });
  const ship = (): ReturnType<typeof rasterize> => rasterize(unitModel('warship', 0).model, 2, 0, { facings: 64, owner: [64, 160, 255] });
  const lum = (d: Uint8ClampedArray): number => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 250) continue;
      s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      n++;
    }
    return s / Math.max(1, n);
  };

  it('burns a hull black in steps, keeping its shape', () => {
    const b = tank();
    let last = lum(b.data);
    for (let k = 1; k <= CHAR_STEPS; k++) {
      const c = charOf(b, k);
      expect(solidCount(c)).toBe(solidCount(b));
      const l = lum(c.data);
      expect(l).toBeLessThan(last);
      last = l;
    }
    // burnt through: near black all over
    expect(last).toBeLessThan(50);
  });

  it('a burnt light tank keeps its shape readable: several tones, its outline lighter than its plates', () => {
    for (const key of ['lightTank', 'tankDivision'] as const) {
      const b = rasterize(unitModel(key, 0).model, 2, 3, { facings: 32, owner: [64, 160, 255] });
      const c = charOf(b, CHAR_STEPS);
      const tones = new Set<number>();
      let edge = 0;
      let ne = 0;
      let inner = 0;
      let ni = 0;
      const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < c.w && y < c.h && c.data[(y * c.w + x) * 4 + 3] >= 250;
      for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) {
          if (!solid(x, y)) continue;
          const o = (y * c.w + x) * 4;
          tones.add((c.data[o] << 16) | (c.data[o + 1] << 8) | c.data[o + 2]);
          const l = c.data[o] * 0.3 + c.data[o + 1] * 0.59 + c.data[o + 2] * 0.11;
          if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)) {
            edge += l;
            ne++;
          } else {
            inner += l;
            ni++;
          }
        }
      expect(tones.size, key).toBeGreaterThanOrEqual(4);
      expect(edge / ne, key).toBeGreaterThan(inner / ni);
    }
  });

  it('a listing ship shows it: its low side darker and narrower than its high side', () => {
    const b = ship();
    const h = heelOf(b, 0, 2, 1, 2);
    // heading east, right side down: the low side is the lower half on screen. It loses pixels at its edge, and what
    // stays of it is darker; the high side is not darker
    const count = (bb: typeof b, low: boolean): number => {
      let n = 0;
      for (let y = 0; y < bb.h; y++) for (let x = 0; x < bb.w; x++) if (bb.data[(y * bb.w + x) * 4 + 3] >= 250 && y >= bb.oy === low) n++;
      return n;
    };
    const ratio = (low: boolean): number => {
      let l0 = 0;
      let l1 = 0;
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++) {
          const o = (y * b.w + x) * 4;
          // the low half below the origin, the high side well above it (the hull's middle line lies a little above)
          if (b.data[o + 3] < 250 || h.data[o + 3] < 250 || (low ? y < b.oy : y >= b.oy - 4)) continue;
          l0 += b.data[o] * 0.3 + b.data[o + 1] * 0.59 + b.data[o + 2] * 0.11;
          l1 += h.data[o] * 0.3 + h.data[o + 1] * 0.59 + h.data[o + 2] * 0.11;
        }
      return l1 / Math.max(1, l0);
    };
    expect(count(h, true)).toBeLessThan(count(b, true));
    expect(ratio(true)).toBeLessThan(0.85);
    expect(ratio(false)).toBeGreaterThanOrEqual(1);
  });

  it('takes a ship under from one end: afloat at 0, see-through under the surface, gone at the last step', () => {
    const b = ship();
    const th = 0;
    const same = sinkOf(b, 0, th, 2, -1, 0);
    expect(solidCount(same)).toBeGreaterThan(solidCount(b) * 0.9);
    const half = sinkOf(b, SINK_STEPS / 2, th, 2, -1, 0);
    let ghost = 0;
    for (let i = 3; i < half.data.length; i += 4) if (half.data[i] > 0 && half.data[i] < 250) ghost++;
    expect(ghost).toBeGreaterThan(0);
    expect(solidCount(half)).toBeLessThan(solidCount(b));
    // stern first (heading east: the stern is on the left): the left end goes first
    const colSolid = (bb: typeof b, x: number): number => {
      let n = 0;
      for (let y = 0; y < bb.h; y++) if (bb.data[(y * bb.w + x) * 4 + 3] >= 250) n++;
      return n;
    };
    let left = 0;
    let right = 0;
    for (let x = 0; x < half.w; x++) (x < half.ox ? (left += colSolid(half, x)) : (right += colSolid(half, x)));
    expect(left).toBeLessThan(right);
    const gone = sinkOf(b, SINK_STEPS, th, 2, -1, 0);
    let any = 0;
    for (let i = 3; i < gone.data.length; i += 4) if (gone.data[i] > 0) any++;
    expect(any).toBe(0);
  });
});
