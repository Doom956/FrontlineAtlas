// The turning guns of the Defense row: where a head points (toward its target, idle without one), the smooth turn, the
// quantized heading in the sprite cache key, the cached head sprites, the mounts of each building.
import { describe, expect, it } from 'vitest';
import { AIM_HOLD_MS, aimAngle, FLAK_FLASH_GAP_MS, facingHeading, GunAim, idleAngle, modelHeading, quantFacing, TRAVERSE, turnToward, wrapAngle } from '../src/client/fx/gunAim';
import { GUN_BAKES_PER_FRAME, gunKey, GunSprites } from '../src/client/render/gunLayer';
import { GUN_FACINGS, gunHead } from '../src/client/art/detailed/guns';
import { gunMounts, modelExtent } from '../src/client/art/detailed/buildings';
import { FORE } from '../src/client/art/detailed/bake';
import type { BakedGun } from '../src/client/art/detailed/guns';

const close = (a: number, b: number, e = 1e-9): void => expect(Math.abs(wrapAngle(a - b))).toBeLessThan(e);

describe('aim maths', () => {
  it('points from the mount toward the target (screen angle, clockwise from east)', () => {
    close(aimAngle(10, 10, 20, 10), 0);
    close(aimAngle(10, 10, 10, 20), Math.PI / 2);
    close(aimAngle(10, 10, 0, 10), Math.PI);
    close(aimAngle(10, 10, 10, 0), -Math.PI / 2);
    close(aimAngle(0, 0, 5, 5), Math.PI / 4);
  });

  it('has an idle pose without a target: flak up and to the right, coastal guns out to sea', () => {
    const f = idleAngle('flak');
    expect(Math.cos(f)).toBeGreaterThan(0);
    expect(Math.sin(f)).toBeLessThan(0);
    close(idleAngle('coastal', 0), 0);
    close(idleAngle('coastal', Math.PI / 2), Math.PI / 2);
  });

  it('quantizes a heading to one of the baked facings, and the facing tells the cache key', () => {
    expect(GUN_FACINGS).toBe(32);
    for (let i = 0; i < 360; i += 7) {
      const f = quantFacing((i * Math.PI) / 180);
      expect(Number.isInteger(f) && f >= 0 && f < GUN_FACINGS).toBe(true);
    }
    expect(quantFacing(0)).toBe(0);
    expect(quantFacing(Math.PI)).toBe(GUN_FACINGS / 2);
    expect(quantFacing(-Math.PI / 2)).toBe(GUN_FACINGS * 0.75);
    // two angles a hair apart share a facing, two far apart do not
    expect(quantFacing(0.01)).toBe(quantFacing(0));
    expect(quantFacing(1.0)).not.toBe(quantFacing(0));
    // the foreshortening: a screen angle of 45 degrees is a model heading steeper than that
    expect(modelHeading(Math.PI / 4)).toBeCloseTo(Math.atan2(1 / FORE, 1), 9);
    // a baked facing points where its heading says
    for (let f = 0; f < GUN_FACINGS; f++) expect(quantFacing(Math.atan2(Math.sin(facingHeading(f)) * FORE, Math.cos(facingHeading(f))))).toBe(f);
    const key = (f: number): string => gunKey('flak', [64, 160, 255], 'far', 1.5, 2, f);
    expect(key(3)).toBe(key(3));
    expect(key(3)).not.toBe(key(4));
    expect(gunKey('coastal', [64, 160, 255], 'far', 1.5, 2, 3)).not.toBe(key(3));
    expect(gunKey('flak', [226, 74, 60], 'far', 1.5, 2, 3)).not.toBe(key(3));
    expect(gunKey('flak', [64, 160, 255], 'close', 1.5, 2, 3)).not.toBe(key(3));
  });

  it('turns the short way, never faster than the traverse', () => {
    expect(turnToward(0, 1, 0.25)).toBeCloseTo(0.25, 9);
    expect(turnToward(0, 1, 5)).toBe(1);
    // from just below +PI to just above -PI is a small turn the positive way
    expect(turnToward(Math.PI - 0.1, -Math.PI + 0.1, 0.05)).toBeCloseTo(Math.PI - 0.05, 9);
    expect(turnToward(0.1, -0.1, 0.05)).toBeCloseTo(0.05, 9);
  });
});

describe('GunAim', () => {
  const T = 1234;
  it('points at the idle pose with no target and turns toward a plane under fire at the traverse speed', () => {
    const g = new GunAim();
    g.setReduced(false);
    const idle = idleAngle('flak');
    expect(g.headingOf(T, 'flak', 0, 10, 10, idle, 0)).toBe(idle);
    // a plane to the south-west of the pit
    g.aimAt(T, 'flak', 10, 10, 4, 14, 100);
    const want = aimAngle(10, 10, 4, 14);
    const h1 = g.headingOf(T, 'flak', 0, 10, 10, idle, 100);
    const h2 = g.headingOf(T, 'flak', 0, 10, 10, idle, 200);
    expect(Math.abs(wrapAngle(want - h2))).toBeLessThan(Math.abs(wrapAngle(want - h1)));
    // 100 ms of traverse
    expect(Math.abs(wrapAngle(h2 - h1))).toBeCloseTo(TRAVERSE.flak * 0.1, 6);
    // given long enough it lines up
    let h = h2;
    for (let t = 300; t <= 1500; t += 100) {
      g.aimAt(T, 'flak', 10, 10, 4, 14, t);
      h = g.headingOf(T, 'flak', 0, 10, 10, idle, t);
    }
    close(h, want, 1e-6);
  });

  it('trains on the nearest of several planes', () => {
    const g = new GunAim();
    g.aimAt(T, 'flak', 10, 10, 30, 10, 500);
    g.aimAt(T, 'flak', 10, 10, 12, 10, 500);
    g.aimAt(T, 'flak', 10, 10, 20, 10, 500);
    expect(g.targetOf(T, 500)).toEqual({ x: 12, y: 10 });
    // next frame, the far one alone
    g.aimAt(T, 'flak', 10, 10, 30, 10, 516);
    expect(g.targetOf(T, 516)).toEqual({ x: 30, y: 10 });
  });

  it('swings back to the idle pose once the target is gone', () => {
    const g = new GunAim();
    g.setReduced(false);
    const idle = idleAngle('coastal', 0);
    g.fireCoastal(T, 10, 30, 0);
    expect(g.targetOf(T, AIM_HOLD_MS - 1)).not.toBeNull();
    expect(g.targetOf(T, AIM_HOLD_MS + 1)).toBeNull();
    let h = idle;
    for (let t = 0; t <= 1400; t += 50) h = g.headingOf(T, 'coastal', 0, 10, 10, idle, t);
    expect(Math.abs(wrapAngle(h - aimAngle(10, 10, 10, 30)))).toBeLessThan(1e-6);
    for (let t = 1450; t <= 8000; t += 50) h = g.headingOf(T, 'coastal', 0, 10, 10, idle, t);
    close(h, idle, 1e-6);
  });

  it('snaps to its target with reduced motion', () => {
    const g = new GunAim();
    g.setReduced(true);
    g.aimAt(T, 'flak', 10, 10, 4, 14, 100);
    close(g.headingOf(T, 'flak', 0, 10, 10, idleAngle('flak'), 100), aimAngle(10, 10, 4, 14));
    // and no recoil
    g.flakFire(T, 100);
    expect(g.recoilOf(T, 'flak', 0, 110)).toBe(0);
  });

  it('flak pits flash with the bursts, at most once per gap, and each shot is taken once per mount', () => {
    const g = new GunAim();
    g.setReduced(false);
    g.aimAt(T, 'flak', 10, 10, 4, 14, 1000);
    g.flakFire(T, 1000);
    g.flakFire(T, 1000 + FLAK_FLASH_GAP_MS - 10);
    expect(g.takeShot(T, 0, 2, 1010)).toBe(true);
    expect(g.takeShot(T, 1, 2, 1010)).toBe(true);
    // both mounts have seen it: it is spent, and the burst inside the gap made no second one
    expect(g.takeShot(T, 0, 2, 1020)).toBe(false);
    g.flakFire(T, 1000 + FLAK_FLASH_GAP_MS + 5);
    expect(g.takeShot(T, 0, 2, 1000 + FLAK_FLASH_GAP_MS + 10)).toBe(true);
    // a shot nobody drew (the building was off screen) goes stale
    g.flakFire(T, 5000 + 1000);
    expect(g.takeShot(T, 0, 2, 9000)).toBe(false);
    // the recoil of a gun that fired is strongest right then and fades
    g.flakFire(T, 20000);
    g.takeShot(T, 0, 2, 20001);
    expect(g.recoilOf(T, 'flak', 0, 20001)).toBeGreaterThan(0.8);
    expect(g.recoilOf(T, 'flak', 0, 20500)).toBe(0);
  });

  it('coastal batteries take turns, one gun a shot, and the flash is capped', () => {
    const g = new GunAim();
    g.fireCoastal(T, 20, 20, 0);
    expect(g.takeShot(T, 0, 2, 10)).toBe(true);
    expect(g.takeShot(T, 1, 2, 10)).toBe(false);
    g.fireCoastal(T, 20, 20, 2000);
    expect(g.takeShot(T, 0, 2, 2010)).toBe(false);
    expect(g.takeShot(T, 1, 2, 2010)).toBe(true);
    for (let i = 0; i < 100; i++) g.addFlash(T, 'coastal', i, i, 0, i);
    expect(g.flashes.filter((f) => f.live).length).toBeLessThanOrEqual(g.flashes.length);
    expect(g.muzzleOf(T, 100)).toEqual(expect.objectContaining({ x: 99, y: 99 }));
  });
});

describe('gun sprites', () => {
  const fake = (): BakedGun => ({ canvas: null as never, w: 1, h: 1, ox: 0, oy: 0 });
  it('bakes a heading once, limits bakes per frame, and keeps what is cached', () => {
    const c = new GunSprites();
    let n = 0;
    const mk = (): BakedGun => (n++, fake());
    c.newFrame();
    expect(c.get('a', mk)).not.toBeNull();
    expect(c.get('a', mk)).not.toBeNull();
    expect(n).toBe(1);
    for (let i = 0; i < GUN_BAKES_PER_FRAME + 3; i++) c.get('k' + i, mk);
    expect(n).toBe(GUN_BAKES_PER_FRAME);
    expect(c.get('zzz', mk)).toBeNull();
    expect(c.get('zzz', mk, true)).not.toBeNull();
    expect(c.peek('a')).not.toBeNull();
  });
});

describe('gun mounts', () => {
  it('has two mounts per flak or coastal building and none without the add-on', () => {
    for (const lv of [1, 2, 3, 4, 5]) {
      expect(gunMounts({ type: 'fort', level: lv, addon: 'flak' })).toHaveLength(2);
      expect(gunMounts({ type: 'fort', level: lv, addon: 'guns' })).toHaveLength(2);
      expect(gunMounts({ type: 'city', level: lv, addon: 'flak' })).toHaveLength(2);
      expect(gunMounts({ type: 'port', level: lv, addon: 'guns' })).toHaveLength(2);
      expect(gunMounts({ type: 'fort', level: lv, addon: null })).toHaveLength(0);
      expect(gunMounts({ type: 'fort', level: lv, addon: 'traps' })).toHaveLength(0);
      expect(gunMounts({ type: 'sam', level: Math.min(lv, 3), addon: 'radar' })).toHaveLength(0);
    }
    expect(gunMounts({ type: 'fort', level: 2, addon: 'flak' }).every((m) => m.kind === 'flak')).toBe(true);
    expect(gunMounts({ type: 'port', level: 2, addon: 'guns' }).every((m) => m.kind === 'coastal')).toBe(true);
  });

  it('keeps the turning heads out of the cached building sprite (the static extent has no barrel)', () => {
    // the head is much longer than the pit: the building's own reach must not grow by it
    const base = modelExtent({ type: 'fort', level: 3, addon: null }, 'close');
    const flak = modelExtent({ type: 'fort', level: 3, addon: 'flak' }, 'close');
    expect(flak.r).toBeLessThan(base.r + 12);
    expect(gunHead('flak', false).length).toBeGreaterThan(8);
    expect(gunHead('coastal', true).length).toBeGreaterThan(6);
  });
});
