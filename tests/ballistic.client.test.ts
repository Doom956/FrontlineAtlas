// The silo rocket's and the atom bomb's drawn arc (client only, art/shared/ballistic.ts) and the detailed style's
// staging (art/detailed/ballistic.ts): the arc's maths, the staging timeline, Reduce motion, and the stage models.
import { describe, expect, it } from 'vitest';
import { ARC, arcAt, arcGround, arcPeak, arcPose, arcShape, ballisticPhase, BallisticBoard, flashAlpha, ICBM, ROCKET, separations, STAGE_GAP_MS, stagePlan, stageFall } from '../src/client/art/shared/ballistic';
import { bodyParts, bodyShift, CUT, FORE_STEPS, foreStep, stageParts } from '../src/client/art/detailed/ballistic';
import { partBox } from '../src/client/art/detailed/bake';
import { rasterize, solidCount } from '../src/client/art/detailed/bake';

const OWNER = [64, 160, 255] as const;

describe('the ballistic arc', () => {
  it('is on the ground at launch and at impact, highest in the middle', () => {
    for (const d of [8, 40, 110, 400]) {
      expect(arcAt(0, d).h).toBe(0);
      expect(arcAt(1, d).h).toBeCloseTo(0, 9);
      expect(arcAt(0.5, d).h).toBeCloseTo(arcPeak(d), 9);
      for (let f = 0.05; f < 1; f += 0.05) expect(arcAt(f, d).h).toBeLessThanOrEqual(arcPeak(d) + 1e-9);
      expect(arcAt(0.25, d).h).toBeGreaterThan(0);
      expect(arcAt(0.85, d).h).toBeGreaterThan(0);
    }
    expect(arcShape(0)).toBe(0);
    expect(arcShape(0.5)).toBe(1);
    expect(arcShape(1)).toBe(0);
  });

  it('peaks higher on a longer flight, within its bounds', () => {
    let prev = 0;
    for (const d of [2, 10, 30, 80, 150, 300]) {
      const p = arcPeak(d);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    expect(arcPeak(100000)).toBe(arcPeak(200000));
    expect(arcPeak(0)).toBe(0);
  });

  it('the atom bomb flies a higher arc than the silo rocket, both within bounds', () => {
    expect(arcPeak(100, 'atomBomb')).toBeCloseTo(45, 9);
    expect(arcPeak(100, 'rocket')).toBeCloseTo(28, 9);
    for (const d of [20, 60, 200]) expect(arcPeak(d, 'atomBomb')).toBeGreaterThan(arcPeak(d, 'rocket'));
    expect(arcPeak(100000, 'atomBomb')).toBe(ARC.peakMax);
    expect(arcAt(0.5, 100, undefined, 'rocket').h).toBeCloseTo(28, 9);
  });

  it('caps the drawn lift so a long flight seen up close stays on screen', () => {
    // normal zoom: not cut
    expect(arcPeak(120, 'atomBomb', 8)).toBeCloseTo(54, 9);
    expect(arcPose(0, 0, 960, 0, 120, 8, 0.5, undefined, 'atomBomb').lift).toBeCloseTo(54 * ARC.lift * 8, 6);
    // close zoom: the lift stops at the cap, and the arc is the same shape, only lower
    for (const z of [16, 24, 32]) {
      const mid = arcPose(0, 0, 120 * z, 0, 120, z, 0.5, undefined, 'atomBomb');
      expect(mid.lift).toBeLessThanOrEqual(ARC.liftCapPx + 1e-6);
      expect(mid.lift).toBeCloseTo(ARC.liftCapPx, 6);
      expect(mid.high).toBeCloseTo(1, 9);
      expect(arcPose(0, 0, 120 * z, 0, 120, z, 0.25, undefined, 'atomBomb').lift).toBeLessThan(mid.lift);
    }
  });

  it('keeps the drawn ground point on the path: from the silo to the target, never back, never far from the sim', () => {
    expect(arcGround(0)).toBe(0);
    expect(arcGround(1)).toBe(1);
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.01) {
      const s = arcGround(f);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(Math.abs(s - f)).toBeLessThan(0.07);
      prev = s;
    }
  });

  it('climbs steeply off the pad and comes down steeply on the target', () => {
    expect(arcAt(0, 110).pitch).toBeCloseTo(Math.PI / 2, 6);
    expect(arcAt(0.02, 110).pitch).toBeGreaterThan(1.2);
    expect(Math.abs(arcAt(0.5, 110).pitch)).toBeLessThan(0.05);
    expect(arcAt(0.999, 110).pitch).toBeLessThan(-1.2);
  });

  it('on screen: lifted off the ground point, nose up at launch and down at impact, on the target at the end', () => {
    const start = arcPose(100, 300, 900, 300, 110, 8, 0);
    expect(start.lift).toBe(0);
    expect(start.x).toBe(100);
    expect(start.angle).toBeCloseTo(-Math.PI / 2, 6);
    const mid = arcPose(100, 300, 900, 300, 110, 8, 0.5);
    expect(mid.lift).toBeGreaterThan(100);
    expect(mid.y).toBeLessThan(mid.gy);
    expect(mid.high).toBeCloseTo(1, 9);
    const end = arcPose(100, 300, 900, 300, 110, 8, 1);
    expect(end.lift).toBeCloseTo(0, 9);
    expect(end.x).toBeCloseTo(900, 9);
    expect(end.y).toBeCloseTo(300, 9);
    expect(Math.sin(end.angle)).toBeGreaterThan(0.8);
    // the same flight twice is the same picture (nothing random, nothing stored)
    expect(arcPose(100, 300, 900, 300, 110, 8, 0.37)).toEqual(arcPose(100, 300, 900, 300, 110, 8, 0.37));
    // the lift scales with the zoom like the map, so a trail laid in tiles stays on the arc
    expect(arcPose(0, 0, 800, 0, 20, 16, 0.5).lift).toBeCloseTo(arcPose(0, 0, 400, 0, 20, 8, 0.5).lift * 2, 6);
  });
});

describe('the staging timeline', () => {
  it('the atom bomb drops its stages in order on the climb and its reentry vehicle parts before impact', () => {
    const s = separations('atomBomb');
    expect(s).toEqual([ICBM.stage1, ICBM.stage2, ICBM.rv]);
    expect(ICBM.stage1).toBeGreaterThan(0);
    expect(ICBM.stage1).toBeLessThan(ICBM.stage2);
    expect(ICBM.stage2).toBeLessThan(ICBM.burnout);
    expect(ICBM.burnout).toBeLessThan(0.5);
    expect(ICBM.rv).toBeGreaterThan(0.5);
    expect(ICBM.rv).toBeLessThan(1);
    expect(separations('rocket')).toEqual([]);
  });

  it('holds a minimum real time between staging events, on a long flight and a short one', () => {
    for (const total of [5000, 6000, 9000, 14000, 30000, 90000]) {
      const p = stagePlan(total, { stage1: 0, stage2: 0, burnout: 0, rv: 0 });
      const t = [p.stage1, p.stage2, p.burnout, p.rv].map((f) => f * total);
      expect(t[0]).toBeGreaterThanOrEqual(STAGE_GAP_MS - 1e-6);
      for (let i = 1; i < 4; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(STAGE_GAP_MS - 1e-6);
      expect(p.rv).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(separations('atomBomb', total)).toEqual([p.stage1, p.stage2, p.rv]);
      // the order never changes: the body and the burning stage follow the plan
      const burns: number[] = [];
      for (let f = 0; f <= 1.0001; f += 0.002) {
        const q = ballisticPhase('atomBomb', f, undefined, total);
        if (burns[burns.length - 1] !== q.burn) burns.push(q.burn);
      }
      expect(burns).toEqual([1, 2, 3, 0]);
    }
    // a flight too short for the gaps still keeps the order (spread over the first 0.9)
    const s = stagePlan(3000, { stage1: 0, stage2: 0, burnout: 0, rv: 0 });
    expect(s.stage1).toBeLessThan(s.stage2);
    expect(s.stage2).toBeLessThan(s.burnout);
    expect(s.burnout).toBeLessThan(s.rv);
    // a long flight keeps the nominal timeline
    expect(stagePlan(90000, { stage1: 0, stage2: 0, burnout: 0, rv: 0 })).toEqual({ ...ICBM });
  });

  it('the body only ever loses stages, the motors burn one after another, the heat comes on the way down', () => {
    let body = 0;
    const burns: number[] = [];
    for (let f = 0; f <= 1.0001; f += 0.005) {
      const p = ballisticPhase('atomBomb', f);
      expect(p.body).toBeGreaterThanOrEqual(body);
      body = p.body;
      if (burns[burns.length - 1] !== p.burn) burns.push(p.burn);
      if (f < ICBM.rv) expect(p.heat).toBe(0);
    }
    expect(burns).toEqual([1, 2, 3, 0]);
    expect(body).toBe(3);
    expect(ballisticPhase('atomBomb', 0.99).heat).toBeGreaterThan(0.9);
    expect(ballisticPhase('atomBomb', 0.05).smoke).toBeGreaterThan(ballisticPhase('atomBomb', 0.35).smoke);
    expect(ballisticPhase('atomBomb', 0.55).smoke).toBe(0);
  });

  it('the rocket burns out near the apex, coasts with a faint trail and heats up before impact', () => {
    expect(ROCKET.burnout).toBeGreaterThan(0.3);
    expect(ROCKET.burnout).toBeLessThan(0.5);
    expect(ballisticPhase('rocket', 0.2).burn).toBe(1);
    const coast = ballisticPhase('rocket', 0.6);
    expect(coast.burn).toBe(0);
    expect(coast.smoke).toBeGreaterThan(0);
    expect(coast.smoke).toBeLessThan(ballisticPhase('rocket', 0.2).smoke * 0.5);
    expect(coast.heat).toBe(0);
    expect(ballisticPhase('rocket', 0.97).heat).toBeGreaterThan(0.5);
  });

  it('a spent stage falls to the ground and fades', () => {
    const a = stageFall(0, 6000, false, 3);
    expect(a.t).toBe(0);
    expect(a.alpha).toBe(1);
    const b = stageFall(a.fallMs, 6000, false, 3);
    expect(b.t).toBe(1);
    expect(b.alpha).toBeCloseTo(0, 9);
    expect(stageFall(a.fallMs * 0.5, 6000, false, 3).t).toBeCloseTo(0.5, 9);
  });
});

describe('Reduce motion', () => {
  it('no tumbling and no flashes; the stages still part and fall', () => {
    expect(stageFall(500, 6000, false, 3).spin).not.toBe(0);
    expect(stageFall(500, 6000, true, 3).spin).toBe(0);
    expect(stageFall(500, 6000, true, 3).t).toBeGreaterThan(0);
    expect(flashAlpha(40, 200, false)).toBeGreaterThan(0);
    expect(flashAlpha(40, 200, true)).toBe(0);
    expect(flashAlpha(250, 200, false)).toBe(0);
  });
});

describe('the detailed stage models', () => {
  it('each stage dropped leaves a shorter body, and the parts add up to the whole', () => {
    const counts = [0, 1, 2, 3].map((k) => bodyParts('atomBomb', k).length);
    for (let k = 1; k < 4; k++) expect(counts[k]).toBeLessThan(counts[k - 1]);
    expect(counts[3]).toBeGreaterThan(0);
    const spent = [1, 2, 3].map((k) => stageParts(k).parts.length);
    expect(spent.reduce((a, b) => a + b, 0) + counts[3]).toBe(counts[0]);
    expect(stageParts(1).mid).toBeLessThan(CUT[1]);
    expect(stageParts(3).mid).toBeGreaterThan(CUT[2]);
  });

  it('after a separation the rest of the stack settles with its middle on the arc (the warhead lands on the target)', () => {
    expect(bodyShift('atomBomb', 0, 0.1, 6000)).toBe(0);
    expect(bodyShift('rocket', 0, 0.9, 6000)).toBe(0);
    expect(bodyShift('atomBomb', 3, ICBM.rv, 6000)).toBeCloseTo(0, 9);
    let a = Infinity;
    let b = -Infinity;
    for (const p of bodyParts('atomBomb', 3)) {
      const [u0, , u1] = partBox(p);
      a = Math.min(a, u0);
      b = Math.max(b, u1);
    }
    expect(bodyShift('atomBomb', 3, 1, 6000)).toBeCloseTo(-(a + b) / 2, 9);
  });

  it('every look bakes non-empty, and a body seen end on is shorter', () => {
    for (let k = 0; k < 4; k++) {
      const b = rasterize({ parts: bodyParts('atomBomb', k), flat: true }, 1.5, 3, { facings: 32, owner: OWNER });
      expect(solidCount(b)).toBeGreaterThan(4);
    }
    for (let k = 1; k <= 3; k++) expect(solidCount(rasterize({ parts: stageParts(k).parts, flat: true }, 1.5, 7, { facings: 16, owner: OWNER }))).toBeGreaterThan(4);
    expect(foreStep(1)).toBe(FORE_STEPS.length - 1);
    expect(foreStep(0.1)).toBe(0);
  });
});

describe('the board of where missiles were drawn', () => {
  it('finds a missile by id or by its ground point, and forgets old ones', () => {
    const b = new BallisticBoard();
    b.frame(1000);
    b.put(7, 50.5, 20.5, 0.2, -12);
    expect(b.offsetOf(7)).toEqual([0.2, -12]);
    expect(b.offsetNear(51, 21, 1.5)).toEqual([0.2, -12]);
    expect(b.offsetNear(60, 21, 1.5)).toBeNull();
    expect(b.offsetOf(7, 2500)).toBeNull();
  });
});
