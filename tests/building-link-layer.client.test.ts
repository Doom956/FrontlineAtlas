// The connected buildings in the game (render/linkLayer.ts): the link set is cached (rebuilt when the building set, the fog
// view or a coarse territory step changes, never on an unrelated frame), never joins across owners, and shows at art zoom only.
import { describe, expect, it } from 'vitest';
import { ART_ZOOM } from '../src/client/render/buildingArt';
import { LINK_BAKES_PER_FRAME, LINK_TERRITORY_TICKS, LinkSet, LinkSprites, linkInput, linkKey, linksShown, type LinkEnd } from '../src/client/render/linkLayer';
import type { Building, GameState } from '../src/sim/types';

const W = 120;
const H = 60;

function fakeState(blds: Partial<Building>[], tick = 0, ownerAt: (x: number, y: number) => number = () => 1): GameState {
  const owner = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) owner[y * W + x] = ownerAt(x, y);
  const buildings = new Map<number, Building>();
  blds.forEach((b, i) => buildings.set(i + 1, { id: i + 1, type: 'fort', owner: 1, tile: 0, level: 1, buildLeft: 0, ...b } as Building));
  return { tick, buildings, map: { width: W, height: H, terrain: new Uint8Array(W * H).fill(3), owner } } as unknown as GameState;
}

const at = (x: number, y: number): number => y * W + x;
const endOf = (b: Building): LinkEnd => ({ tile: b.tile, type: b.type as LinkEnd['type'], level: b.level, facing: 0, sig: `${b.type}${b.level}` });

/** One frame of the cache: the key the layer would use and the recompute it triggers. */
function frame(set: LinkSet, state: GameState, version: number, fog = -1): boolean {
  return set.update(linkKey(version, fog, state.tick, W), () => linkInput(state, [...state.buildings.values()], endOf));
}

describe('connected buildings in the game', () => {
  it('shows links at art zoom and up only', () => {
    expect(linksShown(ART_ZOOM - 0.01)).toBe(false);
    expect(linksShown(1)).toBe(false);
    expect(linksShown(ART_ZOOM)).toBe(true);
    expect(linksShown(30)).toBe(true);
  });

  it('joins same-owner forts and never links across owners', () => {
    const set = new LinkSet();
    const mine = fakeState([{ type: 'fort', tile: at(10, 10) }, { type: 'fort', tile: at(16, 10) }]);
    frame(set, mine, 1);
    expect(set.links.map((l) => l.link.kind)).toEqual(['trench']);
    const mixed = fakeState([{ type: 'fort', tile: at(10, 10), owner: 1 }, { type: 'fort', tile: at(16, 10), owner: 2 }]);
    const other = new LinkSet();
    frame(other, mixed, 1);
    expect(other.links).toEqual([]);
  });

  it('leaves out unfinished buildings and other types', () => {
    const set = new LinkSet();
    frame(set, fakeState([{ type: 'fort', tile: at(10, 10) }, { type: 'fort', tile: at(16, 10), buildLeft: 5 }, { type: 'farm', tile: at(13, 10) }]), 1);
    expect(set.links).toEqual([]);
  });

  it('rebuilds when a building is added, removed or captured, not on unrelated frames', () => {
    const set = new LinkSet();
    const state = fakeState([{ type: 'city', tile: at(10, 10) }, { type: 'city', tile: at(18, 10) }]);
    expect(frame(set, state, 5)).toBe(true);
    expect(set.computed).toBe(1);
    expect(set.links).toHaveLength(1);
    // frames with nothing changed (ticks within the same territory step)
    for (let t = 1; t < LINK_TERRITORY_TICKS; t++) {
      state.tick = t;
      expect(frame(set, state, 5)).toBe(false);
    }
    expect(set.computed).toBe(1);
    // a building added: new version
    state.buildings.set(9, { id: 9, type: 'city', owner: 1, tile: at(26, 10), level: 1, buildLeft: 0 } as Building);
    expect(frame(set, state, 6)).toBe(true);
    expect(set.links).toHaveLength(3);
    // removed
    state.buildings.delete(9);
    expect(frame(set, state, 7)).toBe(true);
    expect(set.links).toHaveLength(1);
    // captured: the owner changes, the link goes
    state.buildings.get(2)!.owner = 2;
    expect(frame(set, state, 8)).toBe(true);
    expect(set.links).toEqual([]);
    expect(set.computed).toBe(4);
  });

  it('looks at the territory under a link again every few ticks and keeps the links when nothing changed', () => {
    const set = new LinkSet();
    const state = fakeState([{ type: 'fort', tile: at(10, 10) }, { type: 'fort', tile: at(18, 10) }]);
    frame(set, state, 1);
    const before = set.links;
    state.tick = LINK_TERRITORY_TICKS * 2;
    expect(frame(set, state, 1)).toBe(false);
    expect(set.computed).toBe(2);
    expect(set.links).toBe(before);
    // an enemy takes a strip between them: the link is gone
    const cut = fakeState([{ type: 'fort', tile: at(10, 10) }, { type: 'fort', tile: at(18, 10) }], LINK_TERRITORY_TICKS * 3, (x) => (x >= 13 && x <= 15 ? 2 : 1));
    expect(frame(set, cut, 1)).toBe(true);
    expect(set.links).toEqual([]);
  });

  it('rebuilds when the fog view changes', () => {
    const set = new LinkSet();
    const state = fakeState([{ type: 'fort', tile: at(10, 10) }, { type: 'fort', tile: at(18, 10) }]);
    frame(set, state, 1, 0);
    frame(set, state, 1, 0);
    expect(set.computed).toBe(1);
    frame(set, state, 1, 1);
    expect(set.computed).toBe(2);
  });

  it('bakes a few link sprites per frame and keeps the last one meanwhile', () => {
    const sprites = new LinkSprites();
    const cv = {} as HTMLCanvasElement;
    const make = (zq: number) => () => ({ canvas: cv, tx: 0, ty: 0, zq, w: 10, h: 10 });
    sprites.newFrame();
    expect(sprites.get('a', 'a1', make(8))).not.toBeNull();
    expect(sprites.get('a', 'a1', () => { throw new Error('baked twice'); })).not.toBeNull();
    sprites.newFrame();
    let n = 0;
    for (let i = 0; i < LINK_BAKES_PER_FRAME + 3; i++) {
      if (sprites.get(`l${i}`, `l${i}k`, () => (n++, make(8)())) !== null) continue;
    }
    expect(n).toBe(LINK_BAKES_PER_FRAME);
    // a new zoom step for a known link: the budget is spent, the old sprite is drawn
    expect(sprites.get('a', 'a2', make(9))?.zq).toBe(8);
    sprites.newFrame();
    expect(sprites.get('a', 'a2', make(9))?.zq).toBe(9);
  });

  it('handles 200 buildings cheaply', () => {
    const blds: Partial<Building>[] = [];
    const types = ['fort', 'city', 'port', 'sam'];
    for (let i = 0; i < 200; i++) blds.push({ type: types[i % 4] as Building['type'], tile: at(2 + (i % 20) * 5, 2 + Math.floor(i / 20) * 5) });
    const state = fakeState(blds);
    const set = new LinkSet();
    const t0 = performance.now();
    frame(set, state, 1);
    const ms = performance.now() - t0;
    expect(set.links.length).toBeGreaterThan(20);
    expect(ms).toBeLessThan(250);
    // every later frame costs nothing
    const t1 = performance.now();
    for (let i = 0; i < 1000; i++) frame(set, state, 1);
    expect(performance.now() - t1).toBeLessThan(50);
    expect(set.computed).toBe(1);
  });
});
