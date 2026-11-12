// The realistic art style (client/art/realistic/): every category is its own (no stub left), units are told apart by
// size, the motion presets order the effects from calm to big, the salvo guns sit on the turrets, and every drawing
// call is deterministic and safe without a canvas (node). Pictures are checked in the art lab, not here.
import { describe, expect, it } from 'vitest';
import { ART_CATEGORIES } from '../src/client/art/artStyle';
import { motionParams } from '../src/client/art/motion';
import { refined } from '../src/client/art/refined';
import { realistic } from '../src/client/art/realistic';
import { ALL_MODS, SPRITE_KEYS, unitCategoryOf, type SpriteKey } from '../src/client/art/shared/keys';
import { BLAST_KINDS, MAP_FX_KINDS, type TrailUnit, type UnitDraw } from '../src/client/art/types';

/** A 2D context that records what is called and set, and draws nothing. */
function recorder(): { ctx: CanvasRenderingContext2D; log: string[] } {
  const log: string[] = [];
  const grad = { addColorStop: () => undefined };
  const state: Record<string, unknown> = { globalAlpha: 1, imageSmoothingEnabled: false, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
  const ctx = new Proxy(state, {
    get: (o, k) => {
      if (k in o) return o[k as string];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      return (...args: unknown[]) => {
        log.push(`${String(k)}(${args.map((a) => (typeof a === 'number' ? a.toFixed(2) : typeof a)).join(',')})`);
      };
    },
    set: (o, k, v) => {
      o[k as string] = v;
      log.push(`${String(k)}=${typeof v === 'number' ? v.toFixed(3) : String(v)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, log };
}

const [subtle, lively, cinematic] = (['subtle', 'lively', 'cinematic'] as const).map((p) => motionParams(p, false));

function unit(key: SpriteKey, over: Partial<UnitDraw> = {}): UnitDraw {
  return { key, mods: 0, owner: [64, 160, 255], x: 100, y: 80, angle: 0.3, zoom: 14, scale: 2, lod: 'near', dpr: 1, timeMs: 1234, turnRate: 0.4, speed: 2, moving: true, seed: 7, alpha: 1, shadow: true, ...over };
}

describe('realistic art style', () => {
  it('draws every category itself (no stub left)', () => {
    expect(realistic.id).toBe('realistic');
    for (const c of ART_CATEGORIES) {
      expect(realistic[c], c).toBeTruthy();
      expect(realistic[c], c).not.toBe(refined[c]);
    }
  });

  it('tells units apart by size: carrier biggest, then battleship; heavy tank over medium over light; heavy bomber widest', () => {
    const L = (k: SpriteKey): number => realistic[unitCategoryOf(k)].lengthPx(k, 0, 1);
    for (const k of SPRITE_KEYS) expect(L(k), k).toBeGreaterThan(8);
    expect(L('carrier')).toBeGreaterThan(L('battleship'));
    expect(L('battleship')).toBeGreaterThan(L('tradeShip'));
    expect(L('tradeShip')).toBeGreaterThan(L('warship'));
    expect(L('warship')).toBeGreaterThan(L('destroyer'));
    expect(L('heavyTank')).toBeGreaterThan(L('tankDivision'));
    expect(L('tankDivision')).toBeGreaterThan(L('lightTank'));
    expect(L('heavyBomber')).toBeGreaterThan(L('bomber'));
    expect(L('bomber')).toBeGreaterThan(L('fighter'));
    expect(L('atomBomb')).toBeGreaterThan(L('rocket'));
    // lengths scale with the map's pixel size
    expect(realistic.ships.lengthPx('battleship', 0, 3)).toBeCloseTo(L('battleship') * 3, 5);
  });

  it('orders every effect from subtle to cinematic through the motion numbers', () => {
    for (const k of BLAST_KINDS) {
      const d = [subtle, lively, cinematic].map((m) => realistic.explosions.durationMs(k, m));
      expect(d[0], k).toBeLessThan(d[1]);
      expect(d[1], k).toBeLessThan(d[2]);
    }
    const f = [subtle, lively, cinematic].map((m) => realistic.cannonFire.flashMs(m));
    expect(f[0]).toBeLessThan(f[1]);
    expect(f[1]).toBeLessThan(f[2]);
    expect(realistic.paradrop.durationMs(lively)).toBeGreaterThan(1000);
    expect(realistic.paradrop.reachPx(14)).toBeGreaterThan(realistic.paradrop.reachPx(3));
  });

  it('puts the salvo guns on the turrets, turning with the ship', () => {
    const at = (i: number, a: number): { x: number; y: number } => realistic.ships.turretPoint('battleship', 0, i, 0, 0, a, 2);
    // facing east: two turrets forward of the centre, one aft
    expect(at(0, 0).x).toBeGreaterThan(at(1, 0).x);
    expect(at(1, 0).x).toBeGreaterThan(0);
    expect(at(2, 0).x).toBeLessThan(0);
    // facing south (clockwise on screen): forward is +y
    expect(at(0, Math.PI / 2).y).toBeGreaterThan(10);
    expect(Math.abs(at(0, Math.PI / 2).x)).toBeLessThan(1e-6);
    // a destroyer's one turret fires twice; a tank fires from its centre
    expect(realistic.ships.turretPoint('destroyer', 0, 0, 5, 5, 0, 1)).toEqual(realistic.ships.turretPoint('destroyer', 0, 1, 5, 5, 0, 1));
    expect(realistic.land.turretPoint('tankDivision', 0, 0, 5, 6, 1, 2)).toEqual({ x: 5, y: 6 });
  });

  it('reports a unit it cannot draw (no canvas in node) without touching the context', () => {
    for (const key of SPRITE_KEYS) {
      const { ctx, log } = recorder();
      expect(realistic[unitCategoryOf(key)].drawUnit(ctx, unit(key, { mods: ALL_MODS }), lively), key).toBe(false);
      expect(log.filter((l) => l.startsWith('drawImage')), key).toEqual([]);
      expect(ctx.globalAlpha).toBe(1);
    }
    const { ctx } = recorder();
    expect(realistic.ships.drawPortrait(ctx, { key: 'carrier', mods: 0, owner: [200, 50, 50], x: 20, y: 20, boxPx: 40, angle: 0, alpha: 1 })).toBe(false);
    expect(realistic.troopIcons.draw(ctx, 'infantry', 0, 0, [64, 160, 255], 16)).toBe(0);
  });

  it('draws every blast and aftermath safely and the same way twice, and leaves the context as it found it', () => {
    for (const reduced of [false, true]) {
      for (const kind of BLAST_KINDS) {
        for (const t of [0, 0.05, 0.3, 0.7, 0.99]) {
          const runs = [0, 1].map(() => {
            const { ctx, log } = recorder();
            const dur = realistic.explosions.durationMs(kind, cinematic);
            realistic.explosions.draw(ctx, { kind, x: 50, y: 50, t, ageMs: t * dur, durMs: dur, zoom: 14, scale: 2, rt: kind === 'atom' ? 35 : kind === 'missile' ? 7 : 0, seed: 0.42, reduced, dpr: 1 }, cinematic);
            expect(ctx.globalAlpha, `${kind} ${t}`).toBeCloseTo(1, 6);
            expect(ctx.globalCompositeOperation).toBe('source-over');
            return log.join('|');
          });
          expect(runs[0]).toBe(runs[1]);
        }
      }
    }
    for (const kind of MAP_FX_KINDS)
      for (const t of [0.1, 0.5, 0.9]) {
        const { ctx } = recorder();
        realistic.explosions.drawMapFx(ctx, { kind, x: 30, y: 30, t, zoom: 8, seed: 0.3, rt: 2, dpr: 1 }, lively);
        expect(ctx.globalAlpha).toBeCloseTo(1, 6);
      }
  });

  it('draws craters, cannon fire and paratroopers, and nothing once they are over', () => {
    const { ctx } = recorder();
    for (const q of [0, 0.5, 0.95]) realistic.craters.draw(ctx, { x: 10, y: 10, radiusPx: 7, q, zoom: 14, scale: 2, seed: 0.2, dpr: 1 }, cinematic);
    // far out a crater is one small picture (no smoke wisps or glow)
    const small = recorder();
    for (const q of [0, 0.05, 0.5]) realistic.craters.draw(small.ctx, { x: 10, y: 10, radiusPx: 1.6, q, zoom: 1.6, scale: 1, seed: 0.2, dpr: 1 }, cinematic);
    expect(small.log.filter((l) => l.startsWith('drawImage'))).toEqual([]);
    expect(small.ctx.globalAlpha).toBe(1);
    expect(ctx.globalAlpha).toBeCloseTo(1, 6);
    for (const kind of ['cannon', 'tracer', 'torpedo'] as const) for (const t of [0, 0.5, 1]) realistic.cannonFire.drawShell(ctx, { kind, x0: 0, y0: 0, x1: 100, y1: 40, t, zoom: 14, scale: 2, seed: 0.5, dpr: 1 }, lively);
    for (const t of [0, 0.1, 0.6]) realistic.cannonFire.drawMuzzle(ctx, { x: 5, y: 5, aim: 1, t, zoom: 14, scale: 2, seed: 0.3, dpr: 1 }, cinematic);
    expect(ctx.globalAlpha).toBeCloseTo(1, 6);
    // far out a drop is small cloth canopies with the owner's muted colour at the crown (never the raw colour); at the
    // end nothing is drawn
    const dur = realistic.paradrop.durationMs(lively);
    const far = recorder();
    realistic.paradrop.draw(far.ctx, { x: 50, y: 50, owner: [226, 74, 60], ageMs: dur * 0.4, durMs: dur, t: 0.4, count: 6, zoom: 2, scale: 1, seed: 0.3, dpr: 1 }, lively);
    expect(far.log.some((l) => l.startsWith('fillStyle=rgb(226,74,60)'))).toBe(false);
    expect(far.log.filter((l) => l.startsWith('fill(')).length).toBeGreaterThan(6);
    expect(far.ctx.globalAlpha).toBe(1);
    const done = recorder();
    realistic.paradrop.draw(done.ctx, { x: 50, y: 50, owner: [226, 74, 60], ageMs: dur, durMs: dur, t: 1, count: 6, zoom: 14, scale: 2, seed: 0.3, dpr: 1 }, lively);
    expect(done.log.filter((l) => l.startsWith('fill(') || l.startsWith('stroke('))).toEqual([]);
  });

  it('lays world-anchored wakes behind moving ships only, contrails behind planes, and forgets them on clear', () => {
    const view = { ox: 0, oy: 0, zoom: 14, scale: 2, now: 0, viewW: 800, viewH: 600, dpr: 1, full: true };
    const ship = (id: number, x: number, moving: boolean): TrailUnit => ({ id, key: 'destroyer', x: x * 14, y: 140, tx: x, ty: 10, angle: 0, half: 24, moving, speed: moving ? 2.4 : 0, turnRate: 0, motion: lively });
    const wakes = realistic.wakes.createLayer();
    const still = recorder();
    for (let f = 0; f < 20; f++) wakes.frame(still.ctx, [ship(1, 10, false)], { ...view, now: f * 16 });
    expect(still.log.filter((l) => l.startsWith('fill(') || l.startsWith('stroke('))).toEqual([]);
    const moving = recorder();
    for (let f = 0; f < 40; f++) wakes.frame(moving.ctx, [ship(2, 10 + f * 0.04, true)], { ...view, now: f * 16 });
    expect(moving.log.filter((l) => l.startsWith('fill(') || l.startsWith('stroke(')).length).toBeGreaterThan(0);
    wakes.clear();
    const after = recorder();
    wakes.frame(after.ctx, [], { ...view, now: 700 });
    expect(after.log.filter((l) => l.startsWith('fill(') || l.startsWith('stroke('))).toEqual([]);
    // far out, planes lay no contrail
    const con = realistic.contrails.createLayer();
    const farLog = recorder();
    for (let f = 0; f < 30; f++) con.frame(farLog.ctx, [{ id: 9, key: 'bomber', x: f * 3, y: 50, tx: f * 0.2, ty: 4, angle: 0, half: 12, moving: true, speed: 4, turnRate: 0, motion: lively }], { ...view, zoom: 1.5, full: false, now: f * 16 });
    expect(farLog.log.filter((l) => l.startsWith('stroke('))).toEqual([]);
  });

  it('keeps a wake and a contrail to a few draw calls at mid zoom (hundreds of ships and planes on screen)', () => {
    const view = { ox: 0, oy: 0, zoom: 6, scale: 1, now: 0, viewW: 800, viewH: 600, dpr: 1, full: true };
    const calls = (log: string[]): number => log.filter((l) => l.startsWith('fill(') || l.startsWith('stroke(')).length;
    const wakes = realistic.wakes.createLayer();
    let last = recorder();
    for (let f = 0; f < 150; f++) {
      last = recorder();
      wakes.frame(last.ctx, [{ id: 3, key: 'battleship', x: 60 + f * 0.6, y: 120, tx: 10 + f * 0.1, ty: 20, angle: 0, half: 20, moving: true, speed: 3, turnRate: 0, motion: cinematic }], { ...view, now: f * 16 });
    }
    // the churned water; the Kelvin arms' faint band, young core and old broken foam (both arms in one call each); both
    // sides of the bow wave
    expect(calls(last.log)).toBeGreaterThan(0);
    expect(calls(last.log)).toBeLessThanOrEqual(5);
    const con = realistic.contrails.createLayer();
    for (let f = 0; f < 150; f++) {
      last = recorder();
      con.frame(last.ctx, [{ id: 4, key: 'heavyBomber', x: 60 + f, y: 80, tx: 10 + f * 0.15, ty: 13, angle: 0, half: 14, moving: true, speed: 3, turnRate: 0, motion: cinematic }], { ...view, now: f * 16 });
    }
    // the wide faint band and the narrow core, both engines' trails in one fill each
    expect(calls(last.log)).toBeGreaterThan(0);
    expect(calls(last.log)).toBeLessThanOrEqual(2);
  });
});
