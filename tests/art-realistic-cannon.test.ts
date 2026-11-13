// The realistic cannon fire (client/art/realistic/cannon.ts), drawn in the game over the detailed pixel ships: the
// muzzle flash is big enough to read at mid zoom, holds its blast at full strength for a few frames (longer at
// Cinematic), is thrown out along the line of fire and is gone by its end; a shell in flight is a bright head with a
// trail of fire, lifted along its arc, hidden while it is still over the firing ship; every call is deterministic,
// safe without a canvas (node) and restores the context. Pictures are checked in the art lab, not here.
import { describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { realistic } from '../src/client/art/realistic';
import { flashState, muzzleFlash, muzzleTiming, shellClear, shellLook } from '../src/client/art/realistic/cannon';
import type { MuzzleDraw, ShellDraw } from '../src/client/art/types';

/** A 2D context that records what is called and set, and draws nothing. */
function recorder(): { ctx: CanvasRenderingContext2D; log: string[]; calls: { name: string; args: unknown[] }[]; sets: { name: string; value: unknown }[] } {
  const log: string[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const sets: { name: string; value: unknown }[] = [];
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
      sets.push({ name: String(k), value: v });
      log.push(`${String(k)}=${typeof v === 'number' ? v.toFixed(4) : String(v)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, log, calls, sets };
}

const [subtle, lively, cinematic] = (['subtle', 'lively', 'cinematic'] as const).map((p) => motionParams(p, false));
/** One frame at 60 fps (ms). */
const FRAME = 1000 / 60;

describe('realistic muzzle flash', () => {
  const muzzle = (t: number, over: Partial<MuzzleDraw> = {}): MuzzleDraw => ({ x: 100, y: 100, aim: 0.6, t, zoom: 14, scale: 2, seed: 0.3, dpr: 1, ...over });

  it('is a flash out of every barrel of a turret, longer than it is wide, big enough to read at mid zoom', () => {
    const f = [subtle, lively, cinematic].map((m) => muzzleFlash(2, m));
    expect(f[1].barrels).toBe(3);
    for (const x of f) {
      expect(x.length).toBeGreaterThan(x.width);
      expect(x.tongue).toBeGreaterThan(x.width);
    }
    expect(f[0].length).toBeLessThan(f[1].length);
    expect(f[1].length).toBeLessThan(f[2].length);
    expect(muzzleFlash(4, lively).length).toBeGreaterThan(muzzleFlash(2, lively).length);
    // at mid zoom (map scale 1, a battleship about 37 px long) the blast is about half a ship long
    expect(muzzleFlash(1, lively).length).toBeGreaterThan(15);
    expect(muzzleFlash(1, lively).width).toBeGreaterThan(10);
    expect(muzzleFlash(1, subtle).length).toBeGreaterThan(12);
    // below zoom 3 the ships are small far markers: the flash shrinks with them
    expect(muzzleFlash(1, lively, 2).length).toBeLessThan(muzzleFlash(1, lively, 3).length * 0.6);
    expect(muzzleFlash(1, lively, 3).length).toBeCloseTo(muzzleFlash(1, lively, 10).length, 6);
  });

  it('holds the blast at full strength for a few frames, longer at Cinematic, and lasts long enough to be seen', () => {
    const t = [subtle, lively, cinematic].map((m) => muzzleTiming(m));
    expect(t[0].hold).toBeGreaterThanOrEqual(2 * FRAME);
    expect(t[1].hold).toBeGreaterThanOrEqual(3 * FRAME - 0.1);
    expect(t[2].hold).toBeGreaterThanOrEqual(3.5 * FRAME);
    // the fire (blast and ball) a dozen frames at Lively
    expect(t[1].fire).toBeGreaterThanOrEqual(12 * FRAME);
    for (const k of ['hold', 'fire', 'total'] as const) {
      expect(t[0][k], k).toBeLessThan(t[1][k]);
      expect(t[1][k], k).toBeLessThan(t[2][k]);
    }
    for (const m of [subtle, lively, cinematic]) {
      expect(realistic.cannonFire.flashMs(m)).toBeCloseTo(muzzleTiming(m).total, 6);
      // the smoke outlasts the fire
      expect(muzzleTiming(m).total).toBeGreaterThan(muzzleTiming(m).fire * 2);
    }
  });

  it('opens with the blast, the core, the light and the ball at once, then cools and is gone', () => {
    const fire = muzzleTiming(lively).fire;
    const hold = muzzleTiming(lively).hold;
    for (const tt of [0, 5, 0.5 * hold, 0.78 * hold]) {
      const s = flashState(tt, lively);
      expect(s.blast, `blast ${tt}`).toBe(1);
      expect(s.core, `core ${tt}`).toBe(1);
      expect(s.light, `light ${tt}`).toBe(1);
      expect(s.ball, `ball ${tt}`).toBe(1);
      expect(s.cool, `cool ${tt}`).toBe(0);
    }
    // the blast dies after the hold, the ball rolls on, cooling
    const late = flashState(fire * 0.7, lively);
    expect(late.blast).toBe(0);
    expect(late.ball).toBeGreaterThan(0.2);
    expect(late.cool).toBeGreaterThan(0.3);
    const gone = flashState(fire + 1, lively);
    expect([gone.blast, gone.core, gone.light, gone.ball]).toEqual([0, 0, 0, 0]);
    // the ball is out ahead of the muzzles (its back edge too) and rolls on along the line of fire as it grows
    let lastD = 0;
    for (const tt of [0, 40, 100, 200]) {
      const s = flashState(tt, lively);
      expect(s.ballD, `ahead ${tt}`).toBeGreaterThan(s.ballR);
      expect(s.ballD).toBeGreaterThanOrEqual(lastD);
      lastD = s.ballD;
    }
    // a bigger flash at Cinematic
    expect(flashState(0, cinematic).ballR).toBeGreaterThan(flashState(0, lively).ballR);
    expect(flashState(0, lively).ballR).toBeGreaterThan(flashState(0, subtle).ballR);
  });

  it('throws the flash out along the line of fire', () => {
    for (const aim of [0, 0.6, 2.4, -1.9]) {
      const r = recorder();
      realistic.cannonFire.drawMuzzle(r.ctx, muzzle(10 / realistic.cannonFire.flashMs(lively), { aim }), lively);
      // the white-hot core is turned to the line of fire and lies out ahead of the gun
      const i = r.calls.findIndex((c) => c.name === 'rotate' && Math.abs((c.args[0] as number) - aim) < 1e-9);
      expect(i, `core ${aim}`).toBeGreaterThan(0);
      const tr = r.calls[i - 1];
      expect(tr.name).toBe('translate');
      const dx = (tr.args[0] as number) - 100;
      const dy = (tr.args[1] as number) - 100;
      expect(dx * Math.cos(aim) + dy * Math.sin(aim)).toBeGreaterThan(2);
      expect(Math.abs(-dx * Math.sin(aim) + dy * Math.cos(aim))).toBeLessThan(1e-6);
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
      expect(a.ctx.imageSmoothingEnabled).toBe(false);
      expect(a.ctx.lineCap).toBe('butt');
      const end = recorder();
      realistic.cannonFire.drawMuzzle(end.ctx, muzzle(1), m);
      expect(end.calls.filter((c) => c.name === 'stroke' || c.name === 'fill' || c.name === 'fillRect')).toEqual([]);
    }
  });
});

describe('realistic shells', () => {
  /** A shell 300 px across the screen at mid zoom (map scale 1), left to right. */
  const shell = (t: number, over: Partial<ShellDraw> = {}): ShellDraw => ({ kind: 'cannon', x0: 0, y0: 200, x1: 300, y1: 200, t, zoom: 6, scale: 1, seed: 0.4, dpr: 1, ...over });
  const heads = (r: ReturnType<typeof recorder>): number[][] => r.calls.filter((c) => c.name === 'arc').map((c) => c.args as number[]);

  it('is a bright head with a trail of fire, clear at mid zoom and bigger close up', () => {
    expect(shellLook(1).head).toBeGreaterThanOrEqual(1.2);
    expect(shellLook(1).trail).toBeGreaterThanOrEqual(12);
    expect(shellLook(2).head).toBeGreaterThan(shellLook(1).head);
    expect(shellLook(2).trail).toBeGreaterThan(shellLook(1).trail);
    const r = recorder();
    realistic.cannonFire.drawShell(r.ctx, shell(0.5), lively);
    const h = heads(r);
    expect(h.length).toBe(1);
    const [px, py, rad] = h[0];
    expect(rad).toBeGreaterThanOrEqual(1.2);
    // lifted up the screen with height at the top of its arc
    expect(py).toBeLessThan(200 - 20);
    expect(px).toBeCloseTo(150, 0);
    // the trail of fire is wide enough to read, and lies behind the head (toward the gun)
    const widths = r.sets.filter((s) => s.name === 'lineWidth').map((s) => s.value as number);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(2.5);
    const moves = r.calls.filter((c) => c.name === 'moveTo').map((c) => c.args as number[]);
    expect(moves.length).toBeGreaterThanOrEqual(2);
    for (const [mx] of moves) expect(mx).toBeLessThan(px);
    // a glow round the head: a light added to what is under it
    expect(r.ctx.globalCompositeOperation).toBe('source-over');
  });

  it('stays hidden while it is still over the firing ship, on long and short shots alike', () => {
    const qc = shellClear(1, 300);
    expect(qc).toBeGreaterThan(0);
    expect(qc).toBeLessThan(0.2);
    const early = recorder();
    realistic.cannonFire.drawShell(early.ctx, shell(qc * 0.8), lively);
    expect(heads(early)).toEqual([]);
    expect(early.calls.filter((c) => c.name === 'stroke')).toEqual([]);
    // a short shot (20 px at mid zoom) shows only over the last part of its flight
    const near = { x1: 20, y1: 200 };
    expect(shellClear(1, 20)).toBeGreaterThan(0.2);
    const a = recorder();
    realistic.cannonFire.drawShell(a.ctx, shell(0.2, near), lively);
    expect(heads(a)).toEqual([]);
    const b = recorder();
    realistic.cannonFire.drawShell(b.ctx, shell(0.8, near), lively);
    expect(heads(b).length).toBe(1);
  });

  it('flies higher with shellArc, and every kind is deterministic and restores the context', () => {
    const y = (m: typeof lively): number => {
      const r = recorder();
      realistic.cannonFire.drawShell(r.ctx, shell(0.5), m);
      return heads(r)[0][1];
    };
    expect(y(cinematic)).toBeLessThan(y(lively));
    expect(y(lively)).toBeLessThan(y(subtle));
    for (const kind of ['cannon', 'tracer', 'torpedo'] as const)
      for (const m of [subtle, lively, cinematic]) {
        const a = recorder();
        const b = recorder();
        for (const t of [0, 0.3, 0.7, 1]) {
          realistic.cannonFire.drawShell(a.ctx, shell(t, { kind }), m);
          realistic.cannonFire.drawShell(b.ctx, shell(t, { kind }), m);
        }
        expect(a.log, kind).toEqual(b.log);
        expect(a.ctx.globalAlpha).toBeCloseTo(1, 6);
        expect(a.ctx.lineCap).toBe('butt');
        expect(a.ctx.imageSmoothingEnabled).toBe(false);
        expect(a.ctx.globalCompositeOperation).toBe('source-over');
      }
  });
});
