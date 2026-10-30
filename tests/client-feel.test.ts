// Client helpers of the feel pass (no DOM): name label placement, forgiving build placement, attack odds, tribes.
import { describe, expect, it } from 'vitest';
import { build, resolveBuildTarget } from '../src/sim/buildings';
import type { BuildingType } from '../src/sim/types';
import { CITY_MAX_LEVEL } from '../src/sim/config';
import { defaultTribeCount, outnumberRatio, rulesTextEntries } from '../src/client/compat';
import { computeLabels, fitSize } from '../src/client/labels';
import { tribesForLevel } from '../src/client/menu';
import { snapBuild } from '../src/client/placement';
import { claimRect, makeFlatGame } from './helpers';

describe('computeLabels', () => {
  it('centres the label in the largest well-shaped rectangle of the territory', () => {
    const w = 60;
    const h = 30;
    const owner = new Uint16Array(w * h);
    // Player 1: a wide block 20..49 x 5..14 plus a thin spur going up at x = 2..3.
    for (let y = 5; y <= 14; y++) for (let x = 20; x <= 49; x++) owner[y * w + x] = 1;
    for (let y = 0; y <= 29; y++) for (let x = 2; x <= 3; x++) owner[y * w + x] = 1;
    // Player 2: an L shape.
    for (let y = 18; y <= 28; y++) for (let x = 5; x <= 8; x++) owner[y * w + x] = 2;
    for (let y = 25; y <= 28; y++) for (let x = 5; x <= 30; x++) owner[y * w + x] = 2;
    const labels = computeLabels(owner, w, h, 3, () => true, () => 6);
    const l1 = labels.find((l) => l.id === 1)!;
    expect(l1.cx).toBeCloseTo(35, 0);
    expect(l1.cy).toBeCloseTo(10, 0);
    expect(l1.size).toBeCloseTo(fitSize(30, 10, 6), 5);
    expect(l1.tiles).toBe(300 + 60);
    // The label sits on own land, in the long arm of the L.
    const l2 = labels.find((l) => l.id === 2)!;
    expect(owner[Math.floor(l2.cy) * w + Math.floor(l2.cx)]).toBe(2);
    expect(l2.cy).toBeGreaterThan(24);
  });

  it('skips players without land or excluded by the filter', () => {
    const owner = new Uint16Array(100);
    owner[5] = 2;
    const labels = computeLabels(owner, 10, 10, 4, (id) => id !== 3, () => 4);
    expect(labels.map((l) => l.id)).toEqual([2]);
  });
});

describe('snapBuild', () => {
  // Contract with the sim (DESIGN section 5): the build ghost shows exactly what a build order will do, i.e. the
  // tile and upgrade flag of buildings.resolveBuildTarget, and nothing (-1) when the order is impossible.
  it('agrees with resolveBuildTarget: snapping, upgrades, top level, out of reach', () => {
    const s = makeFlatGame(60, 40, 2, { human: true });
    claimRect(s, 1, 2, 2, 30, 30);
    const p = s.players[1];
    p.gold = 1e7;
    p.iron = 1e5;
    const w = s.map.width;
    expect(build(s, 1, 'market', 8 * w + 8).ok).toBe(true);
    expect(build(s, 1, 'city', 20 * w + 20).ok).toBe(true);
    for (const b of s.buildings.values()) b.buildLeft = 0;
    const cases: [BuildingType, number][] = [
      ['farm', 25 * w + 8], // free
      ['farm', 9 * w + 9], // too close to the market: snaps away
      ['market', 9 * w + 9], // next to the market: upgrade
      ['city', 21 * w + 22], // next to the city: upgrade
      ['city', 5 * w + 28], // far from it: a new city
      ['farm', 8 * w + 35], // neutral land next to the border: snaps onto own land
      ['farm', 8 * w + 50], // deep in neutral land: nothing
    ];
    const check = (): void => {
      for (const [type, tile] of cases) {
        const r = resolveBuildTarget(s, 1, type, tile);
        const snap = snapBuild(s, 1, type, tile);
        if ('error' in r) {
          expect(snap.tile, `${type}@${tile}`).toBe(-1);
          expect(snap.ok).toBe(false);
        } else {
          expect(snap.tile, `${type}@${tile}`).toBe(r.tile);
          expect(snap.upgrade, `${type}@${tile}`).toBe(r.upgrade);
          expect(snap.ok).toBe(true);
        }
      }
    };
    check();
    // Top level city: the order makes a new city elsewhere.
    const city = [...s.buildings.values()].find((b) => b.type === 'city')!;
    city.level = CITY_MAX_LEVEL;
    check();
  });
});

describe('compat helpers', () => {
  it('reads the odds from an estimate, else falls back to sent / defender army', () => {
    expect(outnumberRatio({ odds: 2.5 }, 100, 10)).toBe(2.5);
    expect(outnumberRatio({ odds: 0 }, 300, 100)).toBe(3);
    expect(outnumberRatio({ odds: 0 }, 300, null)).toBeNull();
    expect(outnumberRatio(null, 0, 100)).toBeNull();
  });

  it('scales the tribe count of the map size by the menu level', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const d = defaultTribeCount(size);
      expect(d).toBeGreaterThan(0);
      expect(tribesForLevel(size, 'none')).toBe(0);
      expect(tribesForLevel(size, 'few')).toBe(Math.round(d * 0.5));
      expect(tribesForLevel(size, 'normal')).toBe(d);
      expect(tribesForLevel(size, 'many')).toBe(Math.round(d * 1.5));
    }
  });

  it('turns config RULES_TEXT into titled entries', () => {
    for (const [k, t] of rulesTextEntries()) {
      expect(typeof k).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
  });
});
