// The realistic crater fires and muzzle flashes (client/art/realistic/craters.ts, cannon.ts, fire.ts): bigger blasts
// leave more and longer fire, the motion presets order them from small and short to big and long, a fire goes out and
// leaves nothing of itself, the flash is thrown out along the line of fire, and every call is deterministic and safe
// without a canvas (node). Pictures are checked in the art lab, not here.
import { describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { realistic } from '../src/client/art/realistic';
import { muzzleFlash } from '../src/client/art/realistic/cannon';
import { craterFire } from '../src/client/art/realistic/craters';
import type { CraterDraw, MuzzleDraw } from '../src/client/art/types';

/** A 2D context that records what is called and set, and draws nothing. */
function recorder(): { ctx: CanvasRenderingContext2D; log: string[]; calls: { name: string; args: unknown[] }[] } {
  const log: string[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const grad = { addColorStop: () => undefined };
  const state: Record<string, unknown> = { globalAlpha: 1, imageSmoothingEnabled: false, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt' };
  const ctx = new Proxy(state, {
    get: (o, k) => {
      if (k in o) return o[k as string];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return (...args: unknown[]) => {
        calls.push({ name: String(k), args });
        log.push(`${String(k)}(${args.map((a) => (typeof a === 'number' ? a.toFixed(3) : typeof a)).join(',')})`);
      };
    },
    set: (o, k, v) => {
      o[k as string] = v;
      log.push(`${String(k)}=${typeof v === 'number' ? v.toFixed(4) : String(v)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, log, calls };
}

const [subtle, lively, cinematic] = (['subtle', 'lively', 'cinematic'] as const).map((p) => motionParams(p, false));

/** The game's crater radii (tiles): a shell, a bomb, a missile, an atom bomb. */
const SHELL = 0.5;
const BOMB = 0.9;
const MISSILE = 2.1;
const ATOM = 11.2;

const crater = (rt: number, q: number, zoom = 14, over: Partial<CraterDraw> = {}): CraterDraw => ({ x: 200, y: 150, radiusPx: rt * zoom, q, zoom, scale: 2, seed: 0.37, dpr: 1, ...over });

describe('realistic crater fires', () => {
  it('leaves more spots, taller flames and a longer fire after a bigger blast', () => {
    const f = [SHELL, BOMB, MISSILE, ATOM].map((rt) => craterFire(rt * 8, 8, lively));
    for (let i = 1; i < f.length; i++) {
      expect(f[i].spots, `spots ${i}`).toBeGreaterThan(f[i - 1].spots);
      expect(f[i].burn, `burn ${i}`).toBeGreaterThan(f[i - 1].burn);
      expect(f[i].flameH, `flame ${i}`).toBeGreaterThan(f[i - 1].flameH);
    }
    // a shell's fire is small and brief: one spot, out within the first sixth of the crater's life
    expect(f[0].spots).toBe(1);
    expect(f[0].burn).toBeLessThan(1 / 6);
    // an atom bomb's burns through a good part of it, and every fire's embers are out before the crater fades
    expect(f[3].burn).toBeGreaterThan(0.2);
    for (const m of [subtle, lively, cinematic]) expect(craterFire(ATOM * 3, 3, m).burn * 1.8).toBeLessThan(0.62);
  });

  it('orders the fires from subtle (small, short) to cinematic (big, long)', () => {
    for (const rt of [SHELL, BOMB, MISSILE, ATOM]) {
      const f = [subtle, lively, cinematic].map((m) => craterFire(rt * 8, 8, m));
      expect(f[0].burn, `burn ${rt}`).toBeLessThan(f[1].burn);
      expect(f[1].burn, `burn ${rt}`).toBeLessThan(f[2].burn);
      expect(f[0].flameH, `flame ${rt}`).toBeLessThan(f[1].flameH);
      expect(f[1].flameH, `flame ${rt}`).toBeLessThan(f[2].flameH);
      // subtle still burns (smaller and shorter, never none)
      expect(f[0].burn).toBeGreaterThan(0);
    }
  });

  it('glows with embers while fresh, leaves nothing of the fire once it is out, and restores the context', () => {
    const m = lively;
    for (const rt of [SHELL, BOMB, MISSILE, ATOM]) {
      const zoom = rt === ATOM ? 3 : 14;
      const { burn } = craterFire(rt * zoom, zoom, m);
      const fresh = recorder();
      realistic.craters.draw(fresh.ctx, crater(rt, burn * 0.3, zoom), m);
      expect(fresh.calls.filter((c) => c.name === 'fillRect').length, `embers ${rt}`).toBeGreaterThan(0);
      const out = recorder();
      realistic.craters.draw(out.ctx, crater(rt, Math.min(0.99, burn * 2.55), zoom), m);
      expect(out.calls.filter((c) => c.name === 'fillRect'), `out ${rt}`).toEqual([]);
      for (const r of [fresh, out]) {
        expect(r.ctx.globalAlpha).toBeCloseTo(1, 6);
        expect(r.ctx.globalCompositeOperation).toBe('source-over');
      }
    }
  });

  it('keeps the far view to a point of fire (two fills) and nothing once it is out', () => {
    const far = recorder();
    realistic.craters.draw(far.ctx, crater(SHELL, 0.02, 3.5), lively);
    expect(far.calls.filter((c) => c.name === 'fillRect').length).toBe(2);
    expect(far.calls.filter((c) => c.name === 'drawImage')).toEqual([]);
    const late = recorder();
    realistic.craters.draw(late.ctx, crater(SHELL, 0.5, 3.5), lively);
    expect(late.calls.filter((c) => c.name === 'fillRect')).toEqual([]);
    expect(far.ctx.globalAlpha).toBeCloseTo(1, 6);
  });

  it('draws the same fire for the same arguments, and a still one with reduced motion', () => {
    const a = recorder();
    const b = recorder();
    realistic.craters.draw(a.ctx, crater(MISSILE, 0.06), cinematic);
    realistic.craters.draw(b.ctx, crater(MISSILE, 0.06), cinematic);
    expect(a.log).toEqual(b.log);
    // reduced motion: the embers of a spot glow evenly; with motion they twinkle, each its own way
    const emberAlphas = (r: ReturnType<typeof recorder>): string[] => {
      const out: string[] = [];
      let last = '';
      for (const l of r.log) {
        if (l.startsWith('globalAlpha=')) last = l;
        else if (l.startsWith('fillRect(')) out.push(last);
      }
      return out;
    };
    const still = recorder();
    realistic.craters.draw(still.ctx, crater(MISSILE, 0.06), motionParams('cinematic', true));
    const se = emberAlphas(still);
    expect(se.length).toBeGreaterThanOrEqual(3);
    expect(new Set(se.slice(0, 3)).size).toBe(1);
    const moving = emberAlphas(a);
    expect(new Set(moving.slice(0, 3)).size).toBeGreaterThan(1);
  });
});

describe('realistic muzzle flash', () => {
  const muzzle = (t: number, over: Partial<MuzzleDraw> = {}): MuzzleDraw => ({ x: 100, y: 100, aim: 0.6, t, zoom: 14, scale: 2, seed: 0.3, dpr: 1, ...over });

  it('is a flash out of every barrel of a turret, longer than it is wide, growing with flashSize and the map scale', () => {
    const f = [subtle, lively, cinematic].map((m) => muzzleFlash(2, m));
    expect(f[1].barrels).toBe(3);
    for (const x of f) {
      expect(x.length).toBeGreaterThan(x.width);
      expect(x.tongue).toBeGreaterThan(x.width);
    }
    expect(f[0].length).toBeLessThan(f[1].length);
    expect(f[1].length).toBeLessThan(f[2].length);
    expect(muzzleFlash(4, lively).length).toBeGreaterThan(muzzleFlash(2, lively).length);
    // still readable at mid zoom (map scale 1): several px long
    expect(muzzleFlash(1, lively).length).toBeGreaterThan(10);
  });

  it('sends the shell out of the muzzle along the line of fire', () => {
    for (const aim of [0, 0.6, 2.4, -1.9]) {
      const total = realistic.cannonFire.flashMs(lively);
      const r = recorder();
      realistic.cannonFire.drawMuzzle(r.ctx, muzzle(25 / total, { aim }), lively);
      const mv = r.calls.find((c) => c.name === 'moveTo');
      const ln = r.calls.find((c) => c.name === 'lineTo');
      expect(mv && ln, `slug ${aim}`).toBeTruthy();
      const dx = (ln!.args[0] as number) - (mv!.args[0] as number);
      const dy = (ln!.args[1] as number) - (mv!.args[1] as number);
      const L = Math.hypot(dx, dy);
      expect(L).toBeGreaterThan(0);
      expect((dx * Math.cos(aim) + dy * Math.sin(aim)) / L).toBeGreaterThan(0.99);
      // and the slug's head is out ahead of the gun
      const hx = (ln!.args[0] as number) - 100;
      const hy = (ln!.args[1] as number) - 100;
      expect(hx * Math.cos(aim) + hy * Math.sin(aim)).toBeGreaterThan(0);
    }
  });

  it('is gone by the end, deterministic, and restores the context', () => {
    for (const m of [subtle, lively, cinematic]) {
      const a = recorder();
      const b = recorder();
      for (const t of [0, 0.02, 0.1, 0.5, 0.9]) {
        realistic.cannonFire.drawMuzzle(a.ctx, muzzle(t), m);
        realistic.cannonFire.drawMuzzle(b.ctx, muzzle(t), m);
      }
      expect(a.log).toEqual(b.log);
      expect(a.ctx.globalAlpha).toBeCloseTo(1, 6);
      expect(a.ctx.globalCompositeOperation).toBe('source-over');
      expect(a.ctx.lineCap).toBe('butt');
      const end = recorder();
      realistic.cannonFire.drawMuzzle(end.ctx, muzzle(1), m);
      expect(end.calls.filter((c) => c.name === 'stroke' || c.name === 'fill' || c.name === 'fillRect')).toEqual([]);
    }
  });
});
