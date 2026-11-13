// Pixel battle effects (client/fx/pixelFx.ts): explosions by event, ship cannon fire, craters in a capped ring
// buffer, and reading the game without writing to it. No DOM: drawing is not called here.
import { describe, expect, it } from 'vitest';
import { CRATER_CAP, PixelFx, turretCount } from '../src/client/fx/pixelFx';
import { craterBitmap } from '../src/client/art/refined/craters';
import { hashState } from '../src/sim/hash';
import type { Effect, Unit } from '../src/sim/types';
import { makeFlatGame } from './helpers';

const fx = (kind: Effect['kind'], x: number, y: number, radius: number, tick: number, x2?: number, y2?: number): Effect => ({ kind, x, y, radius, tick, ...(x2 !== undefined ? { x2, y2 } : {}) });

/** 40 x 30, land on the left (x < 20), sea on the right. */
function game() {
  const s = makeFlatGame(40, 30, 2, { human: true });
  for (let y = 0; y < 30; y++) for (let x = 20; x < 40; x++) s.map.terrain[y * 40 + x] = 0;
  return s;
}
const unit = (id: number, type: Unit['type'], x: number, y: number, extra: Partial<Unit> = {}) => ({ id, type, owner: 2, x, y, hp: 1, target: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, ...extra }) as unknown as Unit;

describe('pixel effects', () => {
  it('treats what is already there as history and never writes to the state', () => {
    const s = game();
    s.effects.push(fx('nuke', 10.5, 10.5, 35, s.tick));
    const p = new PixelFx();
    p.update(s, 1000);
    expect(p.spawned).toBe(0);
    s.tick += 1;
    s.effects.push(fx('barrage', 8.5, 8.5, 6, s.tick));
    const before = hashState(s);
    p.update(s, 1100);
    expect(hashState(s)).toBe(before);
    expect(s.effects.length).toBe(2);
    expect(p.liveCounts().blasts).toBeGreaterThanOrEqual(5); // a ripple of shells over the disc
    expect(p.liveCounts().craters).toBeGreaterThanOrEqual(5);
  });

  it('fires every turret of a warship, splashes on water, explodes and scars land', () => {
    const s = game();
    const bb = unit(1, 'warship', 30, 15, { variant: 'battleship' });
    s.units.push(bb);
    const p = new PixelFx();
    p.update(s, 0);
    s.tick += 1;
    s.effects.push(fx('shot', 30.5, 15.5, 0.5, s.tick, 12.5, 15.5)); // at the coast: land
    p.update(s, 100);
    expect(p.liveCounts().flashes).toBe(turretCount('battleship'));
    expect(p.liveCounts().shells).toBe(3);
    const craters = p.liveCounts().craters;
    p.update(s, 3000); // all shells have landed
    expect(p.liveCounts().craters).toBe(craters + 3);
    // at a ship out at sea: splashes, no craters
    s.tick += 1;
    s.effects.push(fx('shot', 30.5, 15.5, 0.5, s.tick, 36.5, 20.5));
    p.update(s, 3100);
    p.update(s, 6000);
    expect(p.liveCounts().craters).toBe(craters + 3);
    expect(turretCount('destroyer')).toBeLessThan(turretCount('battleship'));
    expect(turretCount('submarine')).toBe(0);
  });

  it('tells a missile from a bomb run and makes the atom bomb crater bigger', () => {
    const s = game();
    const target = 10 * 40 + 5;
    s.units.push(unit(9, 'rocket', 2, 2, { target }));
    const p = new PixelFx();
    p.update(s, 0);
    s.tick += 1;
    s.units = [];
    s.effects.push(fx('explosion', 5.5, 10.5, 7, s.tick)); // where the rocket was going: one big blast
    p.update(s, 50);
    expect(p.blasts.filter((b) => b.live && b.kind === 'missile').length).toBe(1);
    s.tick += 1;
    s.effects.push(fx('explosion', 12.5, 20.5, 5, s.tick)); // no missile there: a stick of bombs
    p.update(s, 100);
    expect(p.blasts.filter((b) => b.live && b.kind === 'bomb').length).toBeGreaterThanOrEqual(3);
    s.tick += 1;
    s.effects.push(fx('nuke', 8.5, 8.5, 35, s.tick));
    p.update(s, 150);
    const atom = p.craters[p.craters.length - 1];
    expect(atom.r).toBeGreaterThan(4);
    expect(atom.life).toBeGreaterThan(p.craters[0].life);
    // the atom bomb's mark is told apart, so a style can spread its blast zone (CraterDraw.atom)
    expect(atom.atom).toBe(true);
    expect(p.craters[0].atom).toBe(false);
  });

  it('leaves craters only inland: none at the water line, and those reaching water are marked to clip to land', () => {
    const s = game();
    const p = new PixelFx();
    p.update(s, 0);
    // a ship and fort hit right at the coast (x 19 is the last land column): a blast, no crater
    s.tick += 1;
    s.effects.push(fx('explosion', 19.5, 10.5, 0.5, s.tick));
    p.update(s, 100);
    expect(p.liveCounts().craters).toBe(0);
    // two tiles in: a crater whose scorch would reach the sea, drawn clipped to the land tiles
    s.tick += 1;
    s.effects.push(fx('explosion', 18.5, 10.5, 0.5, s.tick));
    p.update(s, 200);
    expect(p.liveCounts().craters).toBe(1);
    expect(p.craters[0].coast).toBe(true);
    // far inland: no clipping needed
    s.tick += 1;
    s.effects.push(fx('explosion', 6.5, 10.5, 0.5, s.tick));
    p.update(s, 300);
    expect(p.craters[1].coast).toBe(false);
    // an atom bomb on the sea leaves no crater
    s.tick += 1;
    s.effects.push(fx('nuke', 30.5, 10.5, 35, s.tick));
    p.update(s, 400);
    expect(p.liveCounts().craters).toBe(2);
  });

  it('keeps at most CRATER_CAP craters, the newest replacing the oldest', () => {
    const p = new PixelFx();
    for (let i = 0; i < CRATER_CAP + 50; i++) p.crater(i, 0, 1, i, 600);
    expect(p.craters.length).toBe(CRATER_CAP);
    expect(Math.max(...p.craters.map((c) => c.x))).toBe(CRATER_CAP + 49);
    expect(p.craters.some((c) => c.x === 0)).toBe(false);
  });

  it('draws a crater as a dark pit with a lighter rim', () => {
    const b = craterBitmap(6, 0);
    const at = (x: number, y: number) => {
      const o = (y * b.w + x) * 4;
      return b.data[o] + b.data[o + 1] + b.data[o + 2];
    };
    const cx = Math.floor(b.w / 2);
    const cy = Math.floor(b.h / 2);
    let rim = 0;
    for (let x = 0; x < cx; x++) rim = Math.max(rim, at(x, cy - 2));
    expect(at(cx - 1, cy - 1)).toBeLessThan(rim);
    expect(b.data[(cy * b.w + cx) * 4 + 3]).toBeGreaterThan(200);
  });
});
