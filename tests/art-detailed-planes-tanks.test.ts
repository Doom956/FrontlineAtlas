// The detailed planes and tanks after the owner asked for every type to be told apart and every upgrade to carry the
// unit from the propeller age into the modern look: a heavy armoured single-engine ground attack plane that becomes a
// straight-winged attack jet with rear engine pods and twin fins, a stealth jet fighter, a swept jet bomber, a four-jet
// cargo plane, a heavy bomber that becomes a giant eight-jet strategic bomber; tanks with their own silhouettes and
// the modern main battle tank look, raider drums, the siege gun and the amphibious screen. Each upgrade a change of
// many pixels at the game's normal zoom (1 art px per screen px), and the recon plane falling like a twin-engine
// plane that lost an engine.
import { describe, expect, it } from 'vitest';
import { project, rasterize, solidCount, type Part } from '../src/client/art/detailed/bake';
import { SPIN } from '../src/client/art/detailed/deaths';
import { modelLength, modelSpan, MOD_MASK, unitModel } from '../src/client/art/detailed/models';
import { ALL_MODS, LAND_KEYS, M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, PLANE_KEYS, type SpriteKey } from '../src/client/art/shared/keys';

const OWNER = [64, 160, 255] as const;
const W = 96;
const BITS = [M_MASTERY, M_PATH3, M_JET, M_SPECIAL, M_NIGHT] as const;

/** A unit baked at the normal zoom (res 1) onto a fixed canvas: a tank's turret laid on its hull at the pivot. */
function picture(key: SpriteKey, mods: number, facing = 4): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * W * 4);
  const lay = (b: ReturnType<typeof rasterize>, x: number, y: number): void => {
    for (let j = 0; j < b.h; j++)
      for (let i = 0; i < b.w; i++) {
        const s = (j * b.w + i) * 4;
        if (b.data[s + 3] < 128) continue;
        const X = x + i;
        const Y = y + j;
        if (X < 0 || Y < 0 || X >= W || Y >= W) continue;
        out.set(b.data.subarray(s, s + 4), (Y * W + X) * 4);
      }
  };
  const um = unitModel(key, mods);
  const b = rasterize(um.model, 1, facing, { facings: 32, owner: OWNER, roll: 0 });
  lay(b, W / 2 - b.ox, W / 2 - b.oy);
  if (um.turret) {
    const t = rasterize(um.turret.model, 1, facing * 2, { facings: 64, owner: OWNER });
    const [px, py] = project(um.turret.u, um.turret.v, 0, (facing * Math.PI * 2) / 32, 0, 1, false);
    lay(t, Math.round(W / 2 + px - t.ox), Math.round(W / 2 + py - t.oy));
  }
  return out;
}
const solid = (a: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i]) n++;
  return n;
};
const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 40) n++;
  return n;
};
const parts = (key: SpriteKey, mods = 0): Part[] => unitModel(key, mods).model.parts as Part[];
const turretParts = (key: SpriteKey, mods = 0): Part[] => (unitModel(key, mods).turret?.model.parts ?? []) as Part[];

describe('detailed planes and tanks: upgrades that show', () => {
  it('changes many pixels at the normal zoom for every upgrade a plane or tank can show', () => {
    for (const key of [...PLANE_KEYS, ...LAND_KEYS]) {
      const plain = picture(key, 0);
      const need = Math.max(25, solid(plain) * 0.08);
      for (const bit of BITS) {
        if (!(MOD_MASK[key] & bit)) continue;
        expect(changed(plain, picture(key, bit)), `${key} upgrade ${bit}`).toBeGreaterThan(need);
      }
    }
  });

  it('bakes every plane and tank with all its upgrades at once, deterministically', () => {
    for (const key of [...PLANE_KEYS, ...LAND_KEYS]) {
      const all = rasterize(unitModel(key, ALL_MODS).model, 2, 5, { facings: 32, owner: OWNER });
      expect(solidCount(all), key).toBeGreaterThan(100);
      expect(picture(key, ALL_MODS, 7)).toEqual(picture(key, ALL_MODS, 7));
    }
  });
});

describe('detailed planes told apart', () => {
  it('keeps the size order with the small planes drawn larger', () => {
    const span = (k: SpriteKey, m = 0): number => modelSpan(unitModel(k, m));
    expect(span('heavyBomber')).toBeGreaterThan(span('transportPlane') * 1.15);
    expect(span('transportPlane')).toBeGreaterThan(span('bomber'));
    expect(span('bomber')).toBeGreaterThan(span('groundAttack'));
    expect(span('groundAttack')).toBeGreaterThan(span('fighter'));
    // the smallest plane is still big enough to read at the normal zoom
    expect(span('fighter')).toBeGreaterThan(17);
    expect(modelLength(unitModel('fighter', 0))).toBeGreaterThan(16);
  });

  it('carries the planes into the jet age with the engines each type should have', () => {
    const um = (k: SpriteKey, m: number) => unitModel(k, m);
    // propellers: four on the heavy bomber, two on the bomber, the cargo and the recon plane, one on the attack plane
    expect(um('heavyBomber', 0).props.length).toBe(4);
    expect(um('groundAttack', 0).props.length).toBe(1);
    expect(um('reconPlane', 0).props.length).toBe(2);
    // jets: the attack jet's two pods, a jet bomber's four, the cargo jet's four, the stealth fighter's one
    for (const [k, n] of [
      ['groundAttack', 2],
      ['bomber', 4],
      ['transportPlane', 4],
      ['fighter', 1],
    ] as const) {
      expect(um(k, M_JET).props.length, k).toBe(0);
      expect(um(k, M_JET).nozzles.length, k).toBe(n);
    }
    // the attack jet's engines sit high on the rear body, behind the wing, close to the centreline
    for (const n of um('groundAttack', M_JET).nozzles) {
      expect(n.u).toBeLessThan(-4);
      expect(Math.abs(n.v)).toBeLessThan(4);
      expect(n.z).toBeGreaterThan(3);
    }
    // Strategic Bombing: a giant eight-jet bomber, bigger than the four-engine bomber it replaces
    const strat = um('heavyBomber', M_PATH3);
    expect(strat.props.length).toBe(0);
    expect(strat.nozzles.length).toBe(8);
    expect(modelSpan(strat)).toBeGreaterThan(modelSpan(um('heavyBomber', 0)));
    expect(modelLength(strat)).toBeGreaterThan(modelLength(um('heavyBomber', 0)));
  });

  it('gives the heavy bomber twin end-plate fins and the ground attack plane its bombs and rockets', () => {
    // two tall fins standing at the tailplane tips (no fin on the centreline)
    const fins = parts('heavyBomber').filter((p) => p.k === 'seg' && p.h > 2.5);
    expect(fins.length).toBe(2);
    for (const f of fins) expect(Math.abs(f.p[1])).toBeGreaterThan(6);
    // red rocket heads and yellow bomb noses under the wings
    expect(parts('groundAttack').filter((p) => p.m === 'brick').length).toBe(6);
    expect(parts('groundAttack').filter((p) => p.m === 'hazard').length).toBe(2);
  });

  it('paints night bombers dark with black edges, and keeps the owner colour on every plane', () => {
    for (const key of ['bomber', 'groundAttack', 'heavyBomber'] as const) {
      const m = parts(key, M_NIGHT);
      expect(m.some((p) => p.m === 'night'), key).toBe(true);
      expect(m.some((p) => p.m === 'black' && p.edge), key).toBe(true);
    }
    for (const key of PLANE_KEYS) for (const mods of [0, MOD_MASK[key]]) expect(parts(key, mods).some((p) => p.m === 'own'), `${key} ${mods}`).toBe(true);
  });
});

describe('detailed tanks told apart', () => {
  it('turns every tank into a modern main battle tank with Armor Mastery: a longer gun and side skirts', () => {
    for (const key of LAND_KEYS) {
      expect(modelLength(unitModel(key, M_MASTERY)), key).toBeGreaterThan(modelLength(unitModel(key, 0)));
      // dark steel skirt plates over both tracks, several a side
      expect(parts(key, M_MASTERY).filter((p) => p.m === 'gun' && p.pat === 'rivets').length, key).toBeGreaterThanOrEqual(6);
    }
  });

  it('fits the raider drums, the siege gun and the amphibious screen', () => {
    // Deep Raids: two fuel drums sticking out behind the light tank
    const raid = parts('lightTank', M_PATH3);
    expect(raid.some((p) => p.m === 'rust') && raid.some((p) => p.m === 'ochre')).toBe(true);
    expect(modelLength(unitModel('lightTank', M_PATH3))).toBeGreaterThan(modelLength(unitModel('lightTank', 0)));
    // Siege Tanks: a howitzer much thicker than the heavy tank's gun, in a bigger casemate
    const thickest = (ps: Part[]): number => Math.max(...ps.filter((p) => p.k === 'seg' && p.m === 'gun').map((p) => p.p[4]));
    expect(thickest(turretParts('heavyTank', M_PATH3))).toBeGreaterThan(thickest(turretParts('heavyTank', 0)) * 1.6);
    // Amphibious Tanks: the pale screen round the hull and a tall snorkel on every tank
    for (const key of LAND_KEYS) {
      const p = parts(key, M_SPECIAL);
      expect(p.filter((q) => q.m === 'canvas').length, key).toBeGreaterThanOrEqual(4);
      expect(p.some((q) => q.h >= 4), key).toBe(true);
    }
  });
});

describe('the recon plane shot down', () => {
  it('falls like a twin-engine plane that lost an engine, not a spinning fighter', () => {
    const [turns, cork] = SPIN.reconPlane!;
    expect(turns).toBeLessThan(0.6);
    expect(cork).toBeLessThan(0.2);
    expect(turns).toBeLessThan(SPIN.fighter![0]);
  });
});
