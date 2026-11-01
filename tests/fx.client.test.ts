// Battle effects (src/client/fx): event mapping, rate limits, the pool, and the director reading a real game state
// without writing to it. No DOM: drawing is not called here (the Playwright run covers it).
import { describe, expect, it } from 'vitest';
import { BattleFx } from '../src/client/fx/battleFx';
import { FX_CAP, FxPool } from '../src/client/fx/layer';
import { FX_INFO, FX_KINDS, FxLimiter, fxForEffect, fxForEvent, fxLabel } from '../src/client/fx/map';
import { setFxEnabled } from '../src/client/fx/settings';
import { soundForEvent, SOUND_IDS } from '../src/client/audio';
import { hashState } from '../src/sim/hash';
import type { Building, Effect, GameEvent, GameEventKind, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const H = 1;
const ev = (kind: GameEventKind, players: number[], tile: number, message = '', tick = 0): GameEvent => ({ tick, kind, players, tile, message });
const fx = (kind: Effect['kind'], x: number, y: number, radius: number, tick = 0): Effect => ({ kind, x, y, radius, tick });

/** Camera on tile (20, 15) at 8 px per tile in an 800 x 600 view. */
const cam = (cx = 20, cy = 15, zoom = 8) => ({
  zoom,
  viewW: 800,
  viewH: 600,
  tileToScreen: (x: number, y: number) => ({ x: (x - cx) * zoom + 400, y: (y - cy) * zoom + 300 }),
});

describe('fx event mapping', () => {
  it('ripples only your own captures', () => {
    expect(fxForEffect(fx('capture', 3.5, 4.5, 1.5), true)?.kind).toBe('ripple');
    expect(fxForEffect(fx('capture', 3.5, 4.5, 1.5), false)).toBeNull();
  });

  it('maps blasts by size and the unit that died there', () => {
    expect(fxForEffect(fx('nuke', 1, 1, 35))).toMatchObject({ kind: 'nukeWave', r: 35 });
    expect(fxForEffect(fx('barrage', 1, 1, 6))).toMatchObject({ kind: 'dust', r: 6 });
    expect(fxForEffect(fx('explosion', 1, 1, 7))?.kind).toBe('shockwave');
    expect(fxForEffect(fx('explosion', 1, 1, 1.5), false, 'warship')?.kind).toBe('splash');
    expect(fxForEffect(fx('explosion', 1, 1, 1.5), false, 'transport')?.kind).toBe('splash');
    expect(fxForEffect(fx('explosion', 1, 1, 1.5), false, 'bomber')?.kind).toBe('smoke');
    expect(fxForEffect(fx('explosion', 1, 1, 1.5), false, 'tankDivision')).toBeNull();
    expect(fxForEffect(fx('explosion', 1, 1, 1.5))).toBeNull();
    expect(fxForEffect(fx('shot', 1, 1, 0.5))).toBeNull();
  });

  it('pulses cities and capitals you take or lose, nothing else', () => {
    const w = 40;
    const tile = 5 * w + 7;
    expect(fxForEvent(ev('buildingCaptured', [H, 2], tile), H, 'city', w)).toEqual({ kind: 'cityTaken', x: 7.5, y: 5.5, r: 0 });
    expect(fxForEvent(ev('buildingCaptured', [2, H], tile), H, 'city', w)?.kind).toBe('cityLost');
    expect(fxForEvent(ev('buildingCaptured', [H, 2], tile), H, 'farm', w)).toBeNull();
    expect(fxForEvent(ev('buildingCaptured', [2, 3], tile), H, 'city', w)).toBeNull();
    expect(fxForEvent(ev('capitalLost', [H, 2], tile), H, null, w)?.kind).toBe('capitalLost');
    expect(fxForEvent(ev('capitalLost', [2, H], tile), H, null, w)?.kind).toBe('capitalTaken');
    expect(fxForEvent(ev('capitalLost', [H, 2], -1), H, null, w)).toBeNull();
    expect(fxForEvent(ev('buildingCaptured', [H, 2], tile), 0, 'city', w)).toBeNull(); // spectator
    for (const k of FX_KINDS) expect(FX_INFO[k].dur, k).toBeGreaterThan(0);
    expect(fxLabel('cityLost')).toBe('City lost');
    expect(fxLabel('cityTaken')).toBeNull(); // the HUD's "+City" floater says it
    expect(fxLabel('ripple')).toBeNull();
  });

  it('gives cities and sunk ships their own sounds, silent far off screen', () => {
    const city = ev('buildingCaptured', [H, 2], 10, 'Me captured a City of You');
    expect(soundForEvent(city, H)?.id).toBe('cityTaken');
    expect(soundForEvent(ev('buildingCaptured', [2, H], 10, 'You captured a City of Me'), H)?.id).toBe('cityLost');
    expect(soundForEvent(city, H, false)).toBeNull();
    expect(soundForEvent(ev('buildingCaptured', [H, 2], 10, 'Me captured a Farm of You'), H)?.id).toBe('buildingDone');
    const sunk = ev('unitLost', [H, 2], 10, "Me lost a transport with 300 troops to You's warship");
    expect(soundForEvent(sunk, H)?.id).toBe('shipSunk');
    expect(soundForEvent(sunk, H, false)).toBeNull();
    expect(soundForEvent(ev('unitLost', [2, H], 10, "You's warship hit a mine off Me's coast and sank"), H)?.id).toBe('shipSunk');
    expect(soundForEvent(ev('unitLost', [H, 2], 10, "You's fighters shot down a bomber of Me"), H)?.id).toBe('unitLost');
    for (const id of ['cityTaken', 'cityLost', 'shipSunk'] as const) expect(SOUND_IDS).toContain(id);
  });
});

describe('fx rate limits and pool', () => {
  it('keeps the per-kind gap and live cap', () => {
    const l = new FxLimiter();
    expect(l.accept('ripple', 0, 0, 0, 40)).toBe(true);
    expect(l.accept('ripple', 50, 1, 1, 40)).toBe(false); // gap 90 ms
    expect(l.accept('ripple', 100, 1, 1, 40)).toBe(true);
    expect(l.accept('ripple', 1000, FX_INFO.ripple.maxLive, 8, 40)).toBe(false);
    // a burst of 100 captures in one second gives at most 1000 / gap ripples
    const l2 = new FxLimiter();
    let n = 0;
    for (let t = 0; t < 1000; t += 10) if (l2.accept('ripple', t, 0, 0, 40)) n++;
    expect(n).toBeLessThanOrEqual(Math.ceil(1000 / FX_INFO.ripple.gapMs));
  });

  it('drops cosmetic effects first, lets news in with a full pool', () => {
    const l = new FxLimiter();
    expect(l.accept('dust', 0, 0, 30, 40)).toBe(false); // pool 75% busy
    expect(l.accept('splash', 0, 0, 39, 40)).toBe(true);
    expect(l.accept('shockwave', 0, 0, 40, 40)).toBe(false);
    expect(l.accept('cityLost', 0, 0, 40, 40)).toBe(true);
  });

  it('reuses its records and replaces the oldest cosmetic one when full', () => {
    const p = new FxPool(3);
    expect(p.add('ripple', 0, 0, 0, 0)).toBe(true);
    expect(p.add('splash', 0, 0, 0, 10)).toBe(true);
    expect(p.add('ripple', 0, 0, 0, 20)).toBe(true);
    const recs = new Set(p.recs);
    expect(p.add('cityTaken', 0, 0, 0, 30)).toBe(true);
    expect(p.countOf('ripple')).toBe(1);
    expect(p.countOf('cityTaken')).toBe(1);
    expect(new Set(p.recs)).toEqual(recs); // no new objects
    p.prune(30 + FX_INFO.ripple.dur + 1);
    expect(p.countOf('ripple')).toBe(0);
    expect(p.live).toBe(2);
    p.prune(30 + FX_INFO.cityTaken.dur + 1);
    expect(p.live).toBe(0);
    expect(new FxPool().cap).toBe(FX_CAP);
  });
});

describe('BattleFx director', () => {
  const game = () => {
    const s = makeFlatGame(40, 30, 2, { human: true });
    claimRect(s, 1, 10, 10, 25, 20);
    claimRect(s, 2, 26, 10, 35, 20);
    return s;
  };

  it('treats what is already there as history and never writes to the state', () => {
    const s = game();
    s.effects.push(fx('nuke', 20.5, 15.5, 35, s.tick));
    s.events.push(ev('capitalLost', [H, 2], 15 * 40 + 20, 'x', s.tick));
    const b = new BattleFx();
    b.update(s, cam(), 1000);
    expect(b.spawned).toBe(0);
    expect(b.shake(1010)).toEqual({ x: 0, y: 0 });
    // new things after the first frame do count
    s.tick += 1;
    s.effects.push(fx('capture', 20.5, 15.5, 1.5, s.tick));
    s.events.push(ev('capitalLost', [2, H], 15 * 40 + 28, 'x', s.tick));
    const before = hashState(s);
    b.update(s, cam(), 1100);
    expect(b.pool.countOf('ripple')).toBe(1);
    expect(b.pool.countOf('capitalTaken')).toBe(1);
    expect(hashState(s)).toBe(before);
    expect(s.effects.length).toBe(2);
    expect(s.events.length).toBe(2);
  });

  it('skips a catch-up jump and things off screen', () => {
    const s = game();
    const b = new BattleFx();
    b.update(s, cam(), 0);
    s.tick += 100; // replayed turns
    s.effects.push(fx('nuke', 20.5, 15.5, 35, s.tick));
    b.update(s, cam(), 16);
    expect(b.spawned).toBe(0);
    s.tick += 1;
    s.effects.push(fx('explosion', 300, 300, 7, s.tick)); // far away
    b.update(s, cam(), 32);
    expect(b.spawned).toBe(0);
  });

  it('splashes a sunk ship and smokes a downed plane, not a ship that just arrived', () => {
    const s = game();
    const unit = (id: number, type: Unit['type'], x: number, y: number) => ({ id, type, owner: 2, x, y, hp: 1 }) as unknown as Unit;
    const ship = unit(1, 'warship', 18, 14);
    const plane = unit(2, 'bomber', 22, 16);
    const arrived = unit(3, 'transport', 21, 13);
    s.units.push(ship, plane, arrived);
    const b = new BattleFx();
    b.update(s, cam(), 0);
    s.tick += 1;
    ship.hp = 0;
    plane.hp = 0;
    s.units = [];
    s.effects.push(fx('explosion', 18.5, 14.5, 1.5, s.tick), fx('explosion', 22.5, 16.5, 1.5, s.tick));
    b.update(s, cam(), 200);
    expect(b.pool.countOf('splash')).toBe(1);
    expect(b.pool.countOf('smoke')).toBe(1);
    expect(b.spawned).toBe(2);
  });

  it('raises dust where a fort disappears and pulses a city you take', () => {
    const s = game();
    const tile = 15 * 40 + 18;
    const fort = { id: 7, type: 'fort', owner: 1, tile } as unknown as Building;
    s.buildings.set(7, fort);
    const b = new BattleFx();
    b.update(s, cam(), 0);
    s.tick += 1;
    s.buildings.delete(7);
    const cityTile = 12 * 40 + 22;
    s.buildings.set(8, { id: 8, type: 'city', owner: 1, tile: cityTile } as unknown as Building);
    s.map.building[cityTile] = 9;
    s.events.push(ev('buildingCaptured', [H, 2], cityTile, 'x', s.tick));
    b.update(s, cam(), 300);
    expect(b.pool.countOf('fortDust')).toBe(1);
    expect(b.pool.countOf('cityTaken')).toBe(1);
  });

  it('shakes only for a nuke near the camera, and stops by itself', () => {
    const s = game();
    const b = new BattleFx();
    b.update(s, cam(), 0);
    s.tick += 1;
    s.effects.push(fx('nuke', 400, 400, 35, s.tick)); // far off
    b.update(s, cam(), 100);
    expect(b.shake(110)).toEqual({ x: 0, y: 0 });
    s.tick += 1;
    s.effects.push(fx('nuke', 21.5, 15.5, 35, s.tick));
    b.update(s, cam(), 400);
    const o = b.shake(430);
    expect(Math.hypot(o.x, o.y)).toBeGreaterThan(0);
    expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(6);
    expect(b.shake(1100)).toEqual({ x: 0, y: 0 });
  });

  it('does nothing while switched off', () => {
    const s = game();
    const b = new BattleFx();
    b.update(s, cam(), 0);
    setFxEnabled(false);
    try {
      s.tick += 1;
      s.effects.push(fx('nuke', 20.5, 15.5, 35, s.tick));
      b.update(s, cam(), 16);
      expect(b.spawned).toBe(0);
      expect(b.shake(20)).toEqual({ x: 0, y: 0 });
    } finally {
      setFxEnabled(true);
    }
    // switched back on: the old nuke is history
    b.update(s, cam(), 32);
    expect(b.spawned).toBe(0);
  });
});
