// Connector pairing for same-owner buildings (art/detailed/buildingLinks.ts, pure): which pairs join, how far, and never
// across water or enemy land.
import { describe, expect, it } from 'vitest';
import { LINK_MAX_DEGREE, LINK_MAX_DIST, pairLinks, quayPath, type LinkBuilding, type LinkTerrain, type LinkType } from '../src/client/art/detailed/buildingLinks';

/** Land everywhere (owner 1) except where the test cuts water or hands land to nation 2. */
const land = (over: Partial<LinkTerrain> = {}): LinkTerrain => ({ water: () => false, owner: () => 1, ...over });
let n = 0;
const b = (type: LinkType, x: number, y: number, owner = 1): LinkBuilding => ({ id: ++n, type, x, y, owner, level: 3 });

describe('building links', () => {
  it('joins same-owner buildings of one kind within the distance', () => {
    const f1 = b('fort', 10, 10);
    const f2 = b('fort', 10 + LINK_MAX_DIST.trench - 1, 10);
    const f3 = b('fort', 10 + LINK_MAX_DIST.trench * 2 + 6, 10);
    const links = pairLinks([f1, f2, f3], land());
    expect(links.filter((l) => l.kind === 'trench').map((l) => [l.a, l.b])).toEqual([[f1.id, f2.id]]);
    const c1 = b('city', 0, 40);
    const c2 = b('city', LINK_MAX_DIST.road, 40);
    expect(pairLinks([c1, c2], land()).map((l) => l.kind)).toEqual(['road']);
    expect(pairLinks([c1, b('city', LINK_MAX_DIST.road + 1, 40)], land())).toEqual([]);
  });

  it('never joins different owners or different kinds', () => {
    expect(pairLinks([b('city', 0, 0, 1), b('city', 5, 0, 2)], land({ owner: (x) => (x < 3 ? 1 : 2) }))).toEqual([]);
    expect(pairLinks([b('city', 0, 0), b('fort', 5, 0)], land())).toEqual([]);
    expect(pairLinks([b('port', 0, 0), b('city', 5, 0)], land())).toEqual([]);
  });

  it('refuses a link across water or across enemy land', () => {
    const lake = land({ water: (x) => x === 8 });
    expect(pairLinks([b('city', 2, 0), b('city', 14, 0)], lake)).toEqual([]);
    const strip = land({ owner: (x) => (x >= 7 && x <= 9 ? 2 : 1) });
    expect(pairLinks([b('fort', 2, 0), b('fort', 14, 0)], strip)).toEqual([]);
    expect(pairLinks([b('fort', 2, 0), b('fort', 14, 0)], land())).toHaveLength(1);
  });

  it('chains buildings: at most two links each, nearest pairs first', () => {
    const cs = [b('city', 0, 0), b('city', 6, 0), b('city', 12, 0), b('city', 6, 6)];
    const links = pairLinks(cs, land());
    const deg = new Map<number, number>();
    for (const l of links) for (const id of [l.a, l.b]) deg.set(id, (deg.get(id) ?? 0) + 1);
    for (const d of deg.values()) expect(d).toBeLessThanOrEqual(LINK_MAX_DEGREE);
    expect(links.length).toBeGreaterThanOrEqual(3);
  });

  it('never fences a SAM site: it stays unlinked next to a fort', () => {
    const f1 = b('fort', 10, 12);
    const s = b('sam', 15, 12);
    expect(pairLinks([f1, s], land())).toEqual([]);
  });

  it('follows the shore for ports and refuses ports on different coasts', () => {
    // sea east of x = 20 ; ports on the shore, land between them
    const coast = land({ water: (x) => x > 20 });
    const p1 = b('port', 20, 10);
    const p2 = b('port', 20, 20);
    const l = pairLinks([p1, p2], coast);
    expect(l).toHaveLength(1);
    expect(l[0].kind).toBe('quay');
    const path = l[0].path ?? [];
    expect(path[0]).toEqual([20.5, 10.5]);
    expect(path[path.length - 1]).toEqual([20.5, 20.5]);
    const full = l[0].full ?? [];
    const core = l[0].core ?? [0, 0];
    expect(full.length).toBeGreaterThan(path.length);
    expect(full[core[0]]).toEqual(path[0]);
    expect(full[core[1]]).toEqual(path[path.length - 1]);
    expect(quayPath(p1, p2, coast).shore).toBeGreaterThan(0.9);
    // inland ports (no shore between) do not form a quay
    expect(pairLinks([b('port', 2, 10), b('port', 2, 20)], coast)).toEqual([]);
    // a bay in the way: water between the ports
    const bay = land({ water: (x, y) => x > 20 || (y > 13 && y < 17 && x > 12) });
    expect(pairLinks([p1, p2], bay)).toEqual([]);
  });

  it('gives the same links for any input order', () => {
    const set = [b('fort', 0, 0), b('fort', 9, 2), b('fort', 18, 1), b('sam', 4, 3), b('city', 30, 30), b('city', 40, 31)];
    const a = pairLinks(set, land());
    const r = pairLinks(set.slice().reverse(), land());
    expect(r).toEqual(a);
    expect(a.length).toBeGreaterThanOrEqual(3);
  });
});
