// Tank divisions fighting (client/fx/tankFire.ts): who fights, the turret on the enemy, fire timing per gun, the fog of
// war, the caps, the sound heard with each shot, and reading the game without writing to it. No DOM: drawing is not
// called here.
import { describe, expect, it } from 'vitest';
import { M_MASTERY, M_PATH3 } from '../src/client/art/shared/keys';
import type { FxCam, UnitPoses } from '../src/client/fx/pixelFx';
import { BLITZ_FIRE_MUL, engagementOf, fireInterval, fireSeen, gunOf, nextShotIn, REDUCED_FIRE_MUL, SHOT_CAP, SHOTS_PER_FRAME, TankFire, tankFxLevel, TankShotBus, warPairs } from '../src/client/fx/tankFire';
import { BattleEars, type BattleCue } from '../src/client/sound/battle';
import { hashState } from '../src/sim/hash';
import type { Attack, GameState, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

/** 60 x 40 plains: player 1 holds x < 30, player 2 holds x >= 30. */
function game(): GameState {
  const s = makeFlatGame(60, 40, 2, { human: true });
  claimRect(s, 1, 0, 0, 29, 39);
  claimRect(s, 2, 30, 0, 59, 39);
  return s;
}
const war = (s: GameState, attacker = 1, target = 2): void => {
  s.attacks.push({ id: 1, attacker, target, troops: { infantry: 100, armor: 0, artillery: 0 }, focusTile: 0, progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 } as unknown as Attack);
};
let nextId = 1;
const tank = (owner: number, x: number, y: number, extra: Partial<Unit> = {}): Unit =>
  ({ id: nextId++, type: 'tankDivision', owner, x, y, hp: 1, state: 0, target: Math.round(y) * 60 + Math.round(x), targetOwner: 0, troops: { infantry: 100, armor: 400, artillery: 50 }, path: [], pathPos: 0, cargo: 0, home: 0, ...extra }) as unknown as Unit;

const cam: FxCam = { zoom: 12, x: 30, y: 20, viewW: 1200, viewH: 800 };
/** The unit layer as the renderer gives it: where each tank is on screen, its hull facing north. */
function poses(s: GameState, hull = -Math.PI / 2): UnitPoses {
  const ox = cam.viewW / 2 - cam.x * cam.zoom;
  const oy = cam.viewH / 2 - cam.y * cam.zoom;
  return {
    screenOf: (id) => {
      const u = s.units.find((q) => q.id === id);
      return u ? { x: ox + (u.x + 0.5) * cam.zoom, y: oy + (u.y + 0.5) * cam.zoom } : null;
    },
    headingOf: () => hull,
    angleOf: () => hull,
  };
}
/** Runs `ms` of frames 16 ms apart (game clock and frame clock together, ticks every 100 ms). */
function run(f: TankFire, s: GameState, from: number, ms: number, p = poses(s), each?: () => void): number {
  for (let t = from; t <= from + ms; t += 16) {
    s.tick = Math.floor(t / 100);
    f.update(s, cam, t, t, p);
    each?.();
  }
  return from + ms;
}

describe('tank guns', () => {
  it('light tanks fire small and quick, heavy and siege tanks big and slow', () => {
    const light = gunOf('lightTank', 0);
    const medium = gunOf(undefined, 0);
    const heavy = gunOf('heavyTank', 0);
    const siege = gunOf('heavyTank', M_PATH3);
    expect([light.gun, medium.gun, heavy.gun, siege.gun]).toEqual(['light', 'medium', 'heavy', 'siege']);
    expect(light.attackMs).toBeLessThan(medium.attackMs);
    expect(medium.attackMs).toBeLessThan(heavy.attackMs);
    expect(heavy.attackMs).toBeLessThan(siege.attackMs);
    expect(light.size).toBeLessThan(medium.size);
    expect(medium.size).toBeLessThan(heavy.size);
    expect(heavy.size).toBeLessThan(siege.size);
    // attacking fires more often than holding
    for (const g of [light, medium, heavy, siege]) expect(fireInterval(g, true)).toBeLessThan(fireInterval(g, false) / 2 + 1);
    // Armor Mastery's long gun: a sharp flash (not on the siege howitzer)
    expect(gunOf(undefined, M_MASTERY).sharp).toBe(true);
    expect(gunOf('heavyTank', M_MASTERY | M_PATH3).sharp).toBe(false);
    expect(medium.sharp).toBe(false);
  });

  it('spaces shots out at random round the mean, and reduced motion fires fewer', () => {
    const g = gunOf(undefined, 0);
    const mean = fireInterval(g, true);
    expect(nextShotIn(g, true, false, 0)).toBeCloseTo(mean * 0.6, 6);
    expect(nextShotIn(g, true, false, 0.999)).toBeLessThan(mean * 1.4);
    expect(fireInterval(g, true, true)).toBeCloseTo(mean * REDUCED_FIRE_MUL, 6);
  });

  it('draws nothing far out and only a faint blink until the sprites show', () => {
    expect(tankFxLevel(1)).toBe('none');
    expect(tankFxLevel(3)).toBe('faint');
    expect(tankFxLevel(8)).toBe('full');
  });
});

describe('who fights', () => {
  it('a spearhead fires at the first enemy land ahead of its head', () => {
    const s = game();
    const u = tank(1, 27, 20, { state: 3, launch: 20 * 60 + 25, target: 20 * 60 + 50 });
    const e = engagementOf(s, u, warPairs(s));
    expect(e).not.toBeNull();
    expect(e!.attacking).toBe(true);
    expect(e!.x).toBeCloseTo(30.5, 6);
    expect(e!.y).toBeCloseTo(20.5, 6);
    expect(e!.foe).toBe(2);
    expect(e!.blitz).toBe(false);
    // a Breakthrough (Unit.blitz) is a spearhead too, and fires more often
    const b = engagementOf(s, { ...u, blitz: 1 }, warPairs(s));
    expect(b!.attacking).toBe(true);
    expect(b!.blitz).toBe(true);
    const g = gunOf(undefined, 0);
    expect(BLITZ_FIRE_MUL).toBeLessThan(1);
    expect(fireInterval(g, true, false, true)).toBeCloseTo(fireInterval(g, true) * BLITZ_FIRE_MUL, 6);
    expect(fireInterval(g, false, false, true)).toBe(fireInterval(g, false)); // only an attacking spearhead
    // into empty land: no one to fight
    const s2 = makeFlatGame(60, 40, 2, { human: true });
    claimRect(s2, 1, 0, 0, 29, 39);
    expect(engagementOf(s2, tank(1, 27, 20, { state: 3, launch: 20 * 60 + 25, target: 20 * 60 + 50 }), warPairs(s2))).toBeNull();
  });

  it('a holding division fights only a nation it is at war with, within its defence reach', () => {
    const s = game();
    const u = tank(1, 27, 12);
    expect(engagementOf(s, u, warPairs(s))).toBeNull(); // at peace
    war(s, 2, 1); // the other side attacks: it defends
    const e = engagementOf(s, u, warPairs(s));
    expect(e).not.toBeNull();
    expect(e!.attacking).toBe(false);
    expect(e!.x).toBeCloseTo(30.5, 6);
    expect(e!.y).toBeCloseTo(12.5, 6);
    expect(engagementOf(s, tank(1, 10, 12), warPairs(s))).toBeNull(); // far behind the front
    // the attack is over but the war goes on a while (the sim's war memory): still fighting; allies never
    s.attacks.length = 0;
    expect(engagementOf(s, u, warPairs(s))).toBeNull();
    s.warMemory = [1, 2, s.tick + 50];
    expect(engagementOf(s, u, warPairs(s))).not.toBeNull();
    s.warMemory = [1, 2, s.tick];
    expect(engagementOf(s, u, warPairs(s))).toBeNull();
  });
});

describe('tank fire', () => {
  it('turns the turret onto the enemy, then fires with the sound, without writing to the state', () => {
    const s = game();
    war(s);
    const u = tank(1, 27, 20, { state: 3, launch: 20 * 60 + 25, target: 22 * 60 + 50 });
    s.units.push(u);
    const bus = new TankShotBus();
    const f = new TankFire(Math.random, bus);
    const tick0 = s.tick;
    const before = hashState(s);
    run(f, s, 0, 120);
    // still swinging round from the hull's heading (north): no shot yet
    const aim = f.aimOf(u.id);
    expect(aim).not.toBeNull();
    expect(aim!).toBeLessThan(-0.8);
    expect(f.fired).toBe(0);
    run(f, s, 136, 4000);
    const tick = s.tick;
    s.tick = tick0; // the test's clock moved it, nothing else did
    expect(hashState(s)).toBe(before);
    s.tick = tick;
    // on the enemy: the bearing to the enemy tile ahead
    const e = engagementOf(s, u, warPairs(s))!;
    expect(f.aimOf(u.id)!).toBeCloseTo(Math.atan2(e.y - (u.y + 0.5), e.x - (u.x + 0.5)), 2);
    expect(f.fired).toBeGreaterThanOrEqual(2);
    expect(bus.size).toBe(f.fired);
    // the sound hears each shot once
    const ears = new BattleEars(bus);
    const out: BattleCue[] = [];
    ears.tick(s, out);
    expect(out.filter((c) => c.id === 'tankShot').length).toBe(f.fired);
    expect(bus.size).toBe(0);
  });

  it('attacking fires more often than holding', () => {
    const shotsOf = (attack: boolean): number => {
      const s = game();
      war(s);
      for (let i = 0; i < 10; i++) s.units.push(attack ? tank(1, 27, 4 + i * 3, { state: 3, launch: (4 + i * 3) * 60 + 25, target: (4 + i * 3) * 60 + 50 }) : tank(1, 28, 4 + i * 3));
      const f = new TankFire(Math.random, new TankShotBus());
      run(f, s, 0, 30000);
      return f.fired;
    };
    expect(shotsOf(true)).toBeGreaterThan(shotsOf(false) * 1.5);
  });

  it('never shows (or sounds) enemy fire the player cannot see', () => {
    const s = game();
    war(s);
    const mine = tank(1, 28, 10);
    const theirs = tank(2, 31, 30);
    s.units.push(mine, theirs);
    const fog = { active: true, unitShown: (_s: GameState, u: Unit) => u.owner === 1 };
    expect(fireSeen(fog, s, mine)).toBe(true);
    expect(fireSeen(fog, s, theirs)).toBe(false);
    expect(fireSeen(null, s, theirs)).toBe(true);
    const bus = new TankShotBus();
    const f = new TankFire(Math.random, bus);
    f.fog = fog as never;
    const seen: { x: number }[] = [];
    run(f, s, 0, 20000, poses(s), () => bus.drain(s, (c) => seen.push(c)));
    expect(f.aimOf(theirs.id)).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c.x === mine.x + 0.5)).toBe(true);
  });

  it('caps new shots per frame and shots on screen in a huge battle', () => {
    const s = game();
    war(s);
    for (let y = 0; y < 40; y++) for (let x = 24; x < 30; x++) s.units.push(tank(1, x, y, { state: 3, launch: y * 60 + 20, target: y * 60 + 55 }));
    expect(s.units.length).toBe(240);
    const f = new TankFire(Math.random, new TankShotBus());
    let most = 0;
    let live = 0;
    let last = 0;
    let t = 0;
    for (; t < 8000; t += 16) {
      s.tick = Math.floor(t / 100);
      f.update(s, cam, t, t, poses(s));
      most = Math.max(most, f.fired - last);
      last = f.fired;
      live = Math.max(live, f.liveShots(t));
    }
    expect(most).toBeLessThanOrEqual(SHOTS_PER_FRAME);
    expect(most).toBe(SHOTS_PER_FRAME); // the cap is reached in a battle this big
    expect(live).toBeLessThanOrEqual(SHOT_CAP);
    expect(f.fighting).toBe(240);
  });

  it('forgets a division once its fight is over: the turret swings back along the hull', () => {
    const s = game();
    war(s);
    const u = tank(1, 28, 10);
    s.units.push(u);
    const f = new TankFire(Math.random, new TankShotBus());
    run(f, s, 0, 1500);
    expect(f.aimOf(u.id)).not.toBeNull();
    s.attacks.length = 0; // peace
    run(f, s, 1516, 3000);
    expect(f.aimOf(u.id)).toBeNull();
  });
});
