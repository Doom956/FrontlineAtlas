// Dug-in borders and Air cover on the client: the trench texture mirror (render/trenchFeed.ts) follows the sim's
// trench change feed, the guide's `trench` and `airCover` tips fire when they first matter and point at the right
// tile, the tooltip line and the airfield's "Auto cover" label read right. No DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUIDE_KEY, GuideEngine, type GuideCtx } from '../src/client/guide/engine';
import { airCoverSpot, guideTips, trenchSpot } from '../src/client/guide/steps';
import { idleAirLabel, wingStatus } from '../src/client/pillars';
import { TrenchFeed } from '../src/client/render/trenchFeed';
import { dugInPct, trenchInfoAt, trenchTileText } from '../src/client/trench';
import type { TutorialUi } from '../src/client/tutorial/engine';
import { applyAction } from '../src/sim/actions';
import { TRENCH } from '../src/sim/config';
import { flattenDisc } from '../src/sim/trenches';
import type { GameState } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const UI: TutorialUi = {
  attackShare: 0.3,
  openPanel: null,
  researchTab: 'research',
  selectedUnits: 0,
  buildMode: null,
  mode: 'none',
  aiming: null,
  selectedBuildings: 0,
  selectedTile: -1,
  nationCard: 0,
  buildCount: 1,
  paused: false,
  speed: 1,
};

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

/** 40 x 20: player 1 (human) on the left half, player 2 on the right. */
function twoNations(): GameState {
  const s = makeFlatGame(40, 20, 2, { human: true });
  claimRect(s, 1, 0, 0, 19, 19);
  claimRect(s, 2, 20, 0, 39, 19);
  return s;
}
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
/** Sets a tile's dig points straight in the state (the sim digs over time; tests need it now). */
function dig(s: GameState, tile: number, points: number): void {
  s.trench!.dig[tile] = points;
}
function ctx(s: GameState, sec = 10): GuideCtx {
  return { s, me: s.players[s.humanId], ui: UI, sec, now: 1000 + sec * 1000, strike: () => null };
}

let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  vi.stubGlobal('localStorage', store);
  store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('trench feed (the R8 trench texture)', () => {
  it('rebuilds from the dig points and follows the sim change feed by dirty blocks', () => {
    const s = twoNations();
    const a = at(s, 19, 5);
    const b = at(s, 20, 5);
    dig(s, a, 2 * TRENCH.pointsPerLevel);
    dig(s, b, TRENCH.pointsPerLevel + 10);
    const f = new TrenchFeed();
    f.reset(s, 0);
    expect(f.any).toBe(true);
    expect(f.level[a]).toBe(2);
    expect(f.level[b]).toBe(1);
    expect(f.dirtyList.length).toBeGreaterThan(0);
    f.clearDirty();
    // a barrage-sized flattening through the sim: the change feed brings it, only that block turns dirty
    flattenDisc(s, a, 0, 2 * TRENCH.pointsPerLevel, 0);
    f.update(0, 0);
    expect(f.level[a]).toBe(0);
    expect(f.level[b]).toBe(1);
    expect(f.dirtyList).toEqual([0]);
    f.clearDirty();
    // nothing changed: nothing to upload
    f.update(16, 0);
    expect(f.dirtyList.length).toBe(0);
  });

  it('a rebuild of the tile feed (rejoin catch-up) rebuilds the trench mirror too', () => {
    const s = twoNations();
    const f = new TrenchFeed();
    f.reset(s, 0);
    expect(f.any).toBe(false);
    // dig points written without the change feed (as a snapshot load would)
    dig(s, at(s, 19, 9), 3 * TRENCH.pointsPerLevel);
    f.update(0, 0);
    expect(f.level[at(s, 19, 9)]).toBe(0);
    f.update(0, 1);
    expect(f.level[at(s, 19, 9)]).toBe(3);
    expect(f.any).toBe(true);
  });

  it('a state without trenches costs nothing', () => {
    const s = twoNations();
    delete (s as { trench?: unknown }).trench;
    const f = new TrenchFeed();
    f.reset(s, 0);
    f.update(0, 0);
    expect(f.any).toBe(false);
    expect(f.dirtyList.length).toBe(0);
  });
});

describe('trench texts', () => {
  it('tooltip line: level of max, what it costs, what breaks it', () => {
    const s = twoNations();
    const t = at(s, 20, 4);
    dig(s, t, 2 * TRENCH.pointsPerLevel);
    const info = trenchInfoAt(s, t);
    expect(info).not.toBeNull();
    const txt = trenchTileText(info!);
    expect(txt.main).toBe(`Trench 2 of ${Math.max(2, info!.max)}`);
    expect(txt.sub).toContain(`${Math.round(TRENCH.step * 200)}% more`);
    expect(txt.sub).toMatch(/Artillery, barrages, planes and warships flatten it/);
    expect(trenchInfoAt(s, at(s, 30, 4))).toBeNull();
  });

  it('Dug in: the defender front level, 0 without a shared land border', () => {
    const s = twoNations();
    for (let y = 0; y < 20; y++) dig(s, at(s, 20, y), 2 * TRENCH.pointsPerLevel);
    expect(dugInPct(s, 1, 2)).toBe(Math.round(TRENCH.step * 200));
    // player 1's side is not dug: attacks the other way pay nothing extra
    expect(dugInPct(s, 2, 1)).toBe(0);
  });
});

describe('guide: trench and Air cover tips', () => {
  it('trench: fires when a stretch of own border facing a nation reaches level 2, pointing at it; level 1 is not enough', () => {
    const s = twoNations();
    const g = new GuideEngine([], guideTips());
    dig(s, at(s, 19, 7), TRENCH.pointsPerLevel);
    expect(trenchSpot(ctx(s))).toBe(-1);
    expect(g.update(ctx(s))?.id).not.toBe('trench');
    // one deep tile is not a line yet: it waits for a stretch of 8
    const s2 = twoNations();
    dig(s2, at(s2, 19, 7), 2 * TRENCH.pointsPerLevel);
    expect(trenchSpot(ctx(s2))).toBe(-1);
    const s3 = twoNations();
    for (let y = 4; y < 12; y++) dig(s3, at(s3, 19, y), 2 * TRENCH.pointsPerLevel);
    const g2 = new GuideEngine([], guideTips());
    const v = g2.update(ctx(s3));
    expect(v?.id).toBe('trench');
    expect(v?.tile).toBeGreaterThanOrEqual(at(s3, 19, 4));
    expect(s3.map.width === 40 && v!.tile % 40).toBe(19);
    expect(v!.text).toMatch(/^That dark line is a trench/);
  });

  it('trench: an own attack into a front averaging level 2 points at its deepest tile', () => {
    const s = twoNations();
    for (let y = 0; y < 20; y++) dig(s, at(s, 20, y), 2 * TRENCH.pointsPerLevel);
    dig(s, at(s, 20, 11), 3 * TRENCH.pointsPerLevel);
    const r = applyAction(s, 1, { type: 'attack', tile: at(s, 20, 3), troops: { infantry: 1000, armor: 0, artillery: 0 } });
    expect(r.reason ?? '').toBe('');
    expect(s.attacks.some((a) => a.attacker === 1 && a.target === 2)).toBe(true);
    expect(trenchSpot(ctx(s))).toBe(at(s, 20, 11));
  });

  it('trench: a tribe next door never brings it', () => {
    const s = twoNations();
    s.players[2].personality = 'tribe';
    for (let y = 0; y < 20; y++) dig(s, at(s, 19, y), 2 * TRENCH.pointsPerLevel);
    expect(trenchSpot(ctx(s))).toBe(-1);
  });

  it('airCover: the first automatic sortie of the player, pointing at its zone', () => {
    const s = twoNations();
    const g = new GuideEngine([], guideTips());
    expect(airCoverSpot(ctx(s))).toBe(-1);
    s.air = {
      wings: [],
      raids: [],
      zones: [{ wing: 77, owner: 1, tile: at(s, 24, 10), radius: 3, strength: 1, untilTick: s.tick + 100, victim: 2, tiles: 20 }],
      cover: [{ airfield: 77, owner: 1, nextTick: s.tick + 100, sorties: 1 }],
    };
    expect(airCoverSpot(ctx(s))).toBe(at(s, 24, 10));
    const v = g.update(ctx(s));
    expect(v?.id).toBe('airCover');
    expect(v?.tile).toBe(at(s, 24, 10));
    // someone else's cover does not count
    s.air.cover![0].owner = 2;
    expect(airCoverSpot(ctx(s))).toBe(-1);
  });
});

describe('airfield label', () => {
  it('reads "Auto cover" instead of "Idle" for an Air doctrine holder', () => {
    const s = twoNations();
    expect(idleAirLabel(s, 1).name).toBe('Idle');
    s.players[1].doctrine = { id: 'air', level: 1, chosenTick: 0, adaptUntilTick: 0, lastSwitchTick: 0 };
    expect(idleAirLabel(s, 1).name).toBe('Auto cover');
    // while adapting after a switch the bonus (and the label) wait
    s.players[1].doctrine.adaptUntilTick = s.tick + 100;
    expect(idleAirLabel(s, 1).name).toBe('Idle');
  });

  it('the idle wing line of an Air holder explains Air cover', () => {
    const s = twoNations();
    s.players[1].doctrine = { id: 'air', level: 1, chosenTick: 0, adaptUntilTick: 0, lastSwitchTick: 0 };
    const b = { id: 9, type: 'airfield', owner: 1, tile: at(s, 5, 5), level: 1, buildLeft: 0, bombers: 2, fighters: 0 } as never;
    expect(wingStatus(s, b).line).toMatch(/^Auto cover: bombs dug-in or stalled fronts/);
  });
});
