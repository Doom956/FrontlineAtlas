// The realistic crater fires (client/art/realistic/craters.ts, fire.ts): bigger blasts leave more and longer fire, the
// motion presets order them from small and short to big and long, a fire goes out and leaves nothing of itself, and
// every call is deterministic and safe without a canvas (node). The muzzle flash and the shells are in
// art-realistic-cannon.test.ts. Pictures are checked in the art lab, not here.
import { describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { realistic } from '../src/client/art/realistic';
import { craterFire } from '../src/client/art/realistic/craters';
import type { CraterDraw } from '../src/client/art/types';

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
  it('leaves more patches of fire, taller flames and a longer fire after a bigger blast', () => {
    const f = [SHELL, BOMB, MISSILE, ATOM].map((rt) => craterFire(rt * 8, 8, lively));
    for (let i = 1; i < f.length; i++) {
      expect(f[i].clusters, `patches ${i}`).toBeGreaterThan(f[i - 1].clusters);
      expect(f[i].burn, `burn ${i}`).toBeGreaterThan(f[i - 1].burn);
      expect(f[i].flameH, `flame ${i}`).toBeGreaterThan(f[i - 1].flameH);
    }
    // a shell's fire is small and brief: one patch, out within the first tenth of the crater's life; an atom bomb's
    // four or five
    expect(f[0].clusters).toBe(1);
    expect(f[0].burn).toBeLessThan(0.1);
    expect(f[3].clusters).toBeGreaterThanOrEqual(4);
    // an atom bomb's fire clearly outlasts a missile's (still burning when the missile's is down to embers)
    expect(f[3].burn).toBeGreaterThan(f[2].burn * 1.25);
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
