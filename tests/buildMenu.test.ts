// Client helpers of the build menu, quick bar, spend panel and tech-tree forks (no DOM).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { buildingAt } from '../src/sim/buildings';
import { buildManyPreview } from '../src/sim/bulkbuild';
import { BULK_MAX_COUNT, MERC_MIN_AMOUNT, TECH_ORDER, TECHS } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { mercenaryPrice, warBondsInfo } from '../src/sim/spending';
import type { GameState, TechId } from '../src/sim/types';
import {
  buildClickAction,
  bulkPreviewText,
  effectiveCount,
  QuickPicks,
  QUICK_SLOTS,
  stableSlots,
  type PickStore,
} from '../src/client/hud/buildMenu';
import { bondsText, fundableAllies, fundText, mercSteps, mercText, waysToPlayAdvice } from '../src/client/hud/spendPanel';
import { roundedPath, routeEdge } from '../src/client/hud/techFork';
import { claimRect, makeFlatGame } from './helpers';

function game(gold = 1e6): GameState {
  const s = makeFlatGame(80, 60, 2, { human: true });
  claimRect(s, 1, 0, 0, 59, 59);
  claimRect(s, 2, 60, 0, 79, 59);
  s.players[1].gold = gold;
  s.players[1].iron = 1e5;
  return s;
}
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

function memStore(init: Record<string, string> = {}): PickStore & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe('build count', () => {
  it('uses the selector, Shift means x5, never above the sim limit', () => {
    expect(effectiveCount({ buildCount: 1 }, false)).toBe(1);
    expect(effectiveCount({ buildCount: 3 }, false)).toBe(3);
    expect(effectiveCount({ buildCount: 1 }, true)).toBe(5);
    expect(effectiveCount({ buildCount: 5 }, false)).toBeLessThanOrEqual(BULK_MAX_COUNT);
  });

  it('a x1 click is the classic build, more is buildMany, and buildMany queues the levels', () => {
    const s = game();
    const tile = at(s, 20, 20);
    expect(buildClickAction(s, 1, 'city', tile, 1)).toMatchObject({ type: 'build', building: 'city' });
    const a = buildClickAction(s, 1, 'city', tile, 5);
    expect(a).toEqual({ type: 'buildMany', building: 'city', tile, count: 5 });
    expect(applyAction(s, 1, a).ok).toBe(true);
    const b = buildingAt(s, tile)!;
    expect(b.type).toBe('city');
    expect(b.queuedLevels).toBe(4);
  });
});

describe('bulk preview text', () => {
  it('says what a x5 City queues and its cost', () => {
    const s = game();
    const t = bulkPreviewText(buildManyPreview(s, 1, 'city', at(s, 20, 20), 5), 'city');
    expect(t.tone).toBe('ok');
    expect(t.text).toMatch(/^City -> level 5: 4 upgrades queued, [\d.,k]+ gold$/);
  });

  it('says what it can afford when the money runs out', () => {
    const s = game(0);
    const pv0 = buildManyPreview(s, 1, 'city', at(s, 20, 20), 3);
    expect(bulkPreviewText(pv0, 'city').tone).toBe('no');
    // enough for exactly the first level
    s.players[1].gold = pv0.shortBy.gold > 0 ? buildManyPreview(game(), 1, 'city', at(s, 20, 20), 1).cost.gold : 0;
    const t = bulkPreviewText(buildManyPreview(s, 1, 'city', at(s, 20, 20), 3), 'city');
    expect(t.tone).toBe('short');
    expect(t.sub).toMatch(/^Can afford 1 of 3/);
  });
});

describe('quick bar picks', () => {
  it('starts with sensible defaults, then most used, pinned first', () => {
    const q = new QuickPicks(memStore());
    expect(q.list(QUICK_SLOTS)).toEqual(['city', 'farm', 'market', 'barracks', 'fort', 'port']);
    q.use('lab');
    q.use('lab');
    q.use('mine');
    expect(q.list(3)).toEqual(['lab', 'mine', 'city']);
    q.togglePin('silo');
    expect(q.list(3)).toEqual(['silo', 'lab', 'mine']);
    // a filter drops what can't be used here
    expect(q.list(3, (b) => b !== 'silo')).toEqual(['lab', 'mine', 'city']);
    expect(q.togglePin('silo')).toBe(false);
  });

  it('remembers pins and uses in its store and ignores bad data', () => {
    const st = memStore();
    const a = new QuickPicks(st);
    a.togglePin('fort');
    a.use('market');
    const b = new QuickPicks(st);
    expect(b.isPinned('fort')).toBe(true);
    expect(b.list(2)).toEqual(['fort', 'market']);
    const bad = new QuickPicks(memStore({ 'fa.quickbar.v1': '{"pinned":["nope",3],"score":{"city":"x"}}' }));
    expect(bad.pinned).toEqual([]);
    expect(new QuickPicks(memStore({ 'fa.quickbar.v1': 'not json' })).list(1)).toEqual(['city']);
    // a store that throws is fine too
    const broken: PickStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const c = new QuickPicks(broken);
    c.use('farm');
    expect(c.list(1)).toEqual(['farm']);
  });

  it('keeps buttons in place when the order changes', () => {
    expect(stableSlots(['city', 'farm', 'port'], ['port', 'city', 'lab'], 3)).toEqual(['city', 'lab', 'port']);
    expect(stableSlots([null, null], ['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('spend panel helpers', () => {
  it('mercenaries: slider range, price text and the refusal', () => {
    const st = mercSteps(12345);
    expect(st.min).toBe(MERC_MIN_AMOUNT);
    expect(st.max % st.step).toBe(0);
    expect(st.max).toBeLessThanOrEqual(12345);
    const s = game(1e6);
    const q = mercenaryPrice(s, 1, MERC_MIN_AMOUNT * 10);
    const ok = mercText(q, MERC_MIN_AMOUNT * 10);
    if (q.reason) expect(ok.ok).toBe(false);
    else expect(ok.main).toMatch(/^\+[\d.,k]+ troops now for [\d.,k]+ gold$/);
    s.players[1].gold = 0;
    const no = mercText(mercenaryPrice(s, 1, MERC_MIN_AMOUNT * 10), MERC_MIN_AMOUNT * 10);
    expect(no.ok).toBe(false);
    expect(no.main.length).toBeGreaterThan(0);
  });

  it('fund an ally: only allies are listed, the effect is described', () => {
    const s = game();
    expect(fundableAllies(s, 1)).toEqual([]);
    formAlliance(s, 1, 2);
    expect(fundableAllies(s, 1).map((p) => p.id)).toEqual([2]);
    const t = fundText({ bonus: 0.12, seconds: 60, opinion: 4, trustDiscount: 0.1, reason: null }, 'Azuria');
    expect(t).toMatchObject({ ok: true, main: 'Azuria: +12% attack against your enemies for 60 s' });
    expect(fundText({ bonus: 0, seconds: 60, opinion: 0, trustDiscount: 0, reason: 'Not enough gold' }, 'Azuria').ok).toBe(false);
  });

  it('war bonds: price, running and cooldown', () => {
    const s = game();
    const i = warBondsInfo(s, 1);
    expect(bondsText(i).ok).toBe(i.reason === null);
    expect(bondsText({ ...i, activeLeft: 12, readyIn: 50, reason: 'War bonds can be sold again in 50 s' }).main).toMatch(/^Running: .*12 s left$/);
  });

  it('advises an open tech choice', () => {
    const s = game();
    const me = s.players[1];
    me.techs.push('agriculture', 'banking');
    const a = waysToPlayAdvice(s, me);
    expect(a?.key).toBe('choice-finance');
    expect(a?.drawer).toBe('research');
    expect(a?.text).toContain(' or ');
  });
});

describe('tech tree forks', () => {
  it('routes lines through the gaps, not behind cards', () => {
    const a = { box: { x: 0, y: 100, w: 100, h: 50 } };
    const b = { box: { x: 250, y: 20, w: 100, h: 50 } };
    // neighbours: the caller draws its plain curve
    expect(routeEdge(a, { box: { x: 124, y: 20, w: 100, h: 50 } }, 24, 8, true)).toBeNull();
    // across a track: right of the source, along the row gap above the target, into its left edge
    const pts = routeEdge(a, b, 24, 8, false)!;
    expect(pts[0]).toEqual({ x: 100, y: 125 });
    expect(pts).toContainEqual({ x: 112, y: 16 });
    expect(pts).toContainEqual({ x: 238, y: 16 });
    expect(pts[pts.length - 1]).toEqual({ x: 245, y: 45 });
    // into the second card of a fork from above
    const fork = { x: 124, y: 200, w: 216, h: 50 };
    const top = routeEdge(a, { box: { x: 240, y: 200, w: 100, h: 50 }, enter: 'top', fork }, 24, 8, true)!;
    expect(top[top.length - 1]).toEqual({ x: 290, y: 196 });
    expect(top).toContainEqual({ x: 290, y: 196 });
    expect(top.some((p) => p.y === 196 && p.x === 112)).toBe(true);
    const d = roundedPath(pts, 6);
    expect(d.startsWith('M100 125')).toBe(true);
    expect(d).toContain('Q');
  });
});
