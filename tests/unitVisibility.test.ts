// Unit visibility on the map (client only): the far zoom silhouette icons (client/render/unitIcons.ts), the detailed
// style's map outline (client/art/detailed/outline.ts), the crossfade between them and the fleet marker size
// (client/render/units.ts). No unit is ever a plain block, every kind has its own icon, the owner's colour shows,
// icons bake once and are reused.
import { afterEach, describe, expect, it } from 'vitest';
import { rasterize, solidCount } from '../src/client/art/detailed/bake';
import { unitModel } from '../src/client/art/detailed/models';
import { EDGE_ALPHA, outlineOf, ringWidth } from '../src/client/art/detailed/outline';
import { SPRITE_KEYS, unitCategoryOf, type SpriteKey } from '../src/client/art/shared/keys';
import { Camera } from '../src/client/camera';
import { css } from '../src/client/render/common';
import { FLEET_ZOOM } from '../src/client/render/fleets';
import { clearIcons, drawUnitIcon, ICON_SHAPES, iconKey, iconScale, iconStats, paintIcon, type IconShape } from '../src/client/render/unitIcons';
import { NEAR_ZOOM, SPRITE_ZOOM, UnitLayer, unitBands } from '../src/client/render/units';
import { Terrain, type GameState, type Unit, type UnitType, type UnitVariant } from '../src/sim/types';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { claimRect, makeFlatGame } from './helpers';

const BLUE = [64, 160, 255];
const NAVY = [20, 30, 70];

/** A recording 2D context: every call by name with its arguments, every property write. */
function recCtx() {
  const calls: { k: string; a: unknown[]; fill?: unknown }[] = [];
  const props: Record<string, unknown[]> = {};
  const target: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(target, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10 });
      return (...a: unknown[]) => {
        calls.push({ k: String(k), a, fill: t.fillStyle });
      };
    },
    set: (t, k, v) => {
      t[k] = v;
      (props[String(k)] ??= []).push(v);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, props };
}

/** The silhouette of an icon as a mask (4 samples per CSS px, nose east, size 1). */
function mask(sh: IconShape): Set<number> {
  const out = new Set<number>();
  const inPoly = (p: number[], x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i];
      const yi = p[i + 1];
      const xj = p[j];
      const yj = p[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (let gy = -40; gy <= 40; gy++) {
    for (let gx = -40; gx <= 40; gx++) {
      const x = gx / 4;
      const y = gy / 4;
      let hit = sh.polys.some((p) => inPoly(p, x, y));
      if (!hit) hit = sh.ellipses.some((e) => ((x - e[0]) / e[2]) ** 2 + ((y - e[1]) / e[3]) ** 2 <= 1);
      if (hit) out.add((gy + 40) * 81 + gx + 40);
    }
  }
  return out;
}
function iou(a: Set<number>, b: Set<number>): number {
  let both = 0;
  for (const v of a) if (b.has(v)) both++;
  return both / (a.size + b.size - both);
}

describe('far zoom unit icons', () => {
  afterEach(() => clearIcons());

  it('has an icon for every sprite key, never smaller than 10 px along its length', () => {
    for (const k of SPRITE_KEYS) {
      const sh = ICON_SHAPES[k];
      expect(sh, k).toBeTruthy();
      expect(sh.polys.length + sh.ellipses.length, k).toBeGreaterThan(0);
      // the outline adds 1 px on each side
      for (const z of [0.5, 1.3, 2, 3.5]) expect(2 * sh.half * iconScale(z) + 2, `${k} at zoom ${z}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('every kind has its own silhouette; ships, tanks, planes and missiles are far apart', () => {
    const masks = new Map<SpriteKey, Set<number>>(SPRITE_KEYS.map((k) => [k, mask(ICON_SHAPES[k])]));
    for (let i = 0; i < SPRITE_KEYS.length; i++) {
      for (let j = i + 1; j < SPRITE_KEYS.length; j++) {
        const a = SPRITE_KEYS[i];
        const b = SPRITE_KEYS[j];
        const v = iou(masks.get(a)!, masks.get(b)!);
        expect(v, `${a} vs ${b}`).toBeLessThan(0.93);
        // across classes the outlines differ more (the details, a ship's wake and a missile's trail tell the rest)
        if (unitCategoryOf(a) !== unitCategoryOf(b)) expect(v, `${a} vs ${b} (other class)`).toBeLessThan(0.8);
      }
    }
  });

  it('no icon is a plain box: tanks have a barrel past the hull, every silhouette has more than 4 corners or is round', () => {
    for (const k of SPRITE_KEYS) {
      const sh = ICON_SHAPES[k];
      const corners = sh.polys.reduce((n, p) => n + p.length / 2, 0);
      expect(corners > 4 || sh.ellipses.length > 0, k).toBe(true);
    }
    for (const k of ['tankDivision', 'lightTank', 'heavyTank'] as const) expect(ICON_SHAPES[k].polys.length, k).toBe(2);
  });

  it('paints in the owner full colour with a dark outline (light for dark nations) and never with rect calls', () => {
    for (const k of SPRITE_KEYS) {
      const { ctx, calls, props } = recCtx();
      paintIcon(ctx, ICON_SHAPES[k], BLUE, 0.7, 1);
      expect(props.fillStyle, k).toContain(css(BLUE));
      expect(props.strokeStyle, k).toContain('rgba(8,11,17,0.92)');
      expect(calls.some((c) => c.k === 'rect' || c.k === 'fillRect' || c.k === 'strokeRect'), k).toBe(false);
    }
    const { ctx, props } = recCtx();
    paintIcon(ctx, ICON_SHAPES.warship, NAVY, 0, 1, true);
    expect(props.fillStyle).toContain(css(NAVY));
    expect(props.strokeStyle).toContain('rgba(232,238,246,0.9)');
  });

  it('bakes each icon once per kind, owner, heading, density and size, then reuses it', () => {
    const g = globalThis as unknown as { document?: unknown };
    const had = 'document' in g;
    const prev = g.document;
    const page = { width: 0, height: 0, getContext: () => recCtx().ctx };
    g.document = { createElement: () => page };
    try {
      const { ctx, calls } = recCtx();
      const b0 = iconStats.baked;
      const h0 = iconStats.hits;
      drawUnitIcon(ctx, 'warship', 'carrier', 100, 100, 0.3, BLUE, 2, 1);
      drawUnitIcon(ctx, 'warship', 'carrier', 140, 120, 0.31, BLUE, 2, 1);
      expect(iconStats.baked - b0).toBe(1);
      expect(iconStats.hits - h0).toBe(1);
      const blits = calls.filter((c) => c.k === 'drawImage');
      expect(blits.length).toBe(2);
      // whole device px, no rotation or path per unit
      for (const c of blits) for (const v of c.a.slice(5, 7) as number[]) expect(Number.isInteger(v)).toBe(true);
      expect(calls.some((c) => c.k === 'rotate')).toBe(false);
      // another owner, kind, heading or size is a new bake
      drawUnitIcon(ctx, 'warship', 'carrier', 100, 100, 0.3, NAVY, 2, 1);
      drawUnitIcon(ctx, 'warship', 'submarine', 100, 100, 0.3, BLUE, 2, 1);
      drawUnitIcon(ctx, 'warship', 'carrier', 100, 100, 1.3, BLUE, 2, 1);
      drawUnitIcon(ctx, 'warship', 'carrier', 100, 100, 0.3, BLUE, 3.5, 1);
      expect(iconStats.baked - b0).toBe(5);
    } finally {
      if (had) g.document = prev;
      else delete g.document;
    }
    expect(iconKey('warship', BLUE, 3, 1, 1, false)).not.toBe(iconKey('warship', BLUE, 3, 1, 1, true));
    expect(iconKey('warship', BLUE, 3, 1, 1, false)).not.toBe(iconKey('destroyer', BLUE, 3, 1, 1, false));
    expect(iconKey('warship', BLUE, 3, 1, 1, false)).not.toBe(iconKey('warship', BLUE, 3, 2, 1, false));
  });
});

describe('detailed map outline', () => {
  const bake = (key: SpriteKey) => rasterize(unitModel(key, 0).model, 1, 3, { facings: 16, owner: BLUE });

  it('keeps every solid pixel, grows the box by ring + 1 on each side and moves the origin with it', () => {
    for (const key of ['destroyer', 'fighter', 'tankDivision', 'rocket'] as SpriteKey[]) {
      const b = bake(key);
      for (const ring of [1, 2]) {
        const o = outlineOf(b, BLUE, ring);
        expect(o.w, key).toBe(b.w + 2 * (ring + 1));
        expect(o.h, key).toBe(b.h + 2 * (ring + 1));
        expect(o.ox - b.ox).toBe(ring + 1);
        expect(o.oy - b.oy).toBe(ring + 1);
        expect(solidCount(o)).toBeGreaterThan(solidCount(b));
        const G = ring + 1;
        for (let y = 0; y < b.h; y++)
          for (let x = 0; x < b.w; x++) {
            const s = (y * b.w + x) * 4;
            if (b.data[s + 3] < 200) continue;
            const d = ((y + G) * o.w + x + G) * 4;
            expect([o.data[d], o.data[d + 1], o.data[d + 2], o.data[d + 3]]).toEqual([b.data[s], b.data[s + 1], b.data[s + 2], b.data[s + 3]]);
          }
      }
    }
  });

  it('rings the unit in the owner colour with a dark edge outside it, and drops the old translucent rim', () => {
    const b = bake('battleship');
    const o = outlineOf(b, BLUE, 1);
    let ring = 0;
    let edge = 0;
    for (let i = 0; i < o.data.length; i += 4) {
      const c = [o.data[i], o.data[i + 1], o.data[i + 2], o.data[i + 3]];
      if (c[0] === 64 && c[1] === 160 && c[2] === 255 && c[3] === 255) ring++;
      if (c[0] === 8 && c[1] === 11 && c[2] === 17 && c[3] === EDGE_ALPHA) edge++;
      expect(c[0] === 10 && c[1] === 13 && c[2] === 17 && c[3] < 200).toBe(false);
    }
    expect(ring).toBeGreaterThan(40);
    expect(edge).toBeGreaterThan(40);
    // a very dark nation gets a light edge
    const n = outlineOf(rasterize(unitModel('battleship', 0).model, 1, 3, { facings: 16, owner: NAVY }), NAVY, 1);
    let light = 0;
    for (let i = 0; i < n.data.length; i += 4) if (n.data[i] === 232 && n.data[i + 3] === EDGE_ALPHA) light++;
    expect(light).toBeGreaterThan(40);
  });

  it('keeps the ring about one CSS px wide', () => {
    expect(ringWidth(1)).toBe(1);
    expect(ringWidth(0.5)).toBe(2);
    expect(ringWidth(1 / 3)).toBe(3);
    expect(ringWidth(2)).toBe(1);
  });
});

describe('zoom bands', () => {
  it('fades the icons into the sprites between zoom 4 and 5', () => {
    expect(NEAR_ZOOM).toBe(FLEET_ZOOM);
    expect(unitBands(3.9)).toEqual({ icon: 1, sprite: 0 });
    const m = unitBands(4.5);
    expect(m.icon).toBeCloseTo(0.5);
    expect(m.sprite).toBeCloseTo(0.5);
    expect(unitBands(SPRITE_ZOOM + 0.1)).toEqual({ icon: 0, sprite: 1 });
  });
});

/** 120 x 40: player 1's land on the west, sea to the east. */
function game(): GameState {
  const s = makeFlatGame(120, 40, 2, { human: true, seed: 5 });
  for (let y = 0; y < 40; y++) for (let x = 40; x < 120; x++) s.map.terrain[y * 120 + x] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 39, 39);
  return s;
}
let nid = 9000;
function unit(s: GameState, type: UnitType, variant: UnitVariant | undefined, owner: number, x: number, y: number): Unit {
  const u = { id: nid++, type, owner, x, y, target: y * s.map.width + x + 5, home: y * s.map.width + x, path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 9999, cargo: 0, state: 0, targetOwner: 0 } as unknown as Unit;
  if (variant) u.variant = variant;
  s.units.push(u);
  return u;
}

describe('the unit layer', () => {
  afterEach(() => clearIcons());

  it('draws every unit as its icon or sprite at every zoom: never a filled box', () => {
    const s = game();
    const kinds: [UnitType, UnitVariant | undefined][] = [
      ['warship', undefined], ['warship', 'destroyer'], ['warship', 'battleship'], ['warship', 'submarine'], ['warship', 'carrier'], ['transport', undefined], ['tradeShip', undefined],
      ['tankDivision', undefined], ['tankDivision', 'lightTank'], ['tankDivision', 'heavyTank'],
      ['fighter', undefined], ['bomber', undefined], ['bomber', 'heavyBomber'], ['bomber', 'groundAttack'], ['transportPlane', undefined], ['reconPlane', undefined], ['rocket', undefined], ['atomBomb', undefined],
    ];
    kinds.forEach(([t, v], i) => unit(s, t, v, 1 + (i % 2), t === 'tankDivision' ? 10 + i * 3 : 50 + i * 3, t === 'tankDivision' ? 20 : 10 + (i % 3) * 10));
    const colors = s.players.map((p) => p.color);
    for (const z of [0.8, 1.3, 2, 3, 3.9, 4.5, 6, 12]) {
      const cam = new Camera(s.map.width, s.map.height);
      cam.resize(2000, 1000);
      cam.zoom = z;
      cam.x = 60;
      cam.y = 20;
      const layer = new UnitLayer();
      layer.reset(s.map.width);
      layer.track(s, 0);
      const { ctx, calls } = recCtx();
      const p0 = iconStats.painted;
      layer.draw(ctx, s, cam, 1, colors, 0, 1, 1000);
      // no canvas here: sprites cannot bake, so every unit shows its icon (painted on the spot), never a block
      expect(iconStats.painted - p0, `zoom ${z}`).toBe(layer.drawn);
      // (zoomed out, the warships may join fleet markers)
      if (z >= FLEET_ZOOM) expect(layer.drawn, `zoom ${z}`).toBe(kinds.length);
      expect(calls.some((c) => c.k === 'rect' || c.k === 'strokeRect'), `zoom ${z}`).toBe(false);
      // (the troop pills of transports are plates of fillRect in dark colours: no box in a nation's colour)
      const owners = new Set(colors.map((c) => css(c)));
      expect(calls.some((c) => c.k === 'fillRect' && (c.a[2] as number) >= 3 && (c.a[3] as number) >= 3 && owners.has(String(c.fill))), `zoom ${z}`).toBe(false);
    }
  });

  it('sizes a fleet marker by its icon, never by the sprite (a carrier fleet is not a block)', () => {
    const s = game();
    const a = unit(s, 'warship', 'carrier', 1, 70, 20);
    unit(s, 'warship', 'carrier', 1, 71, 20);
    const colors = s.players.map((p) => p.color);
    const cam = new Camera(s.map.width, s.map.height);
    cam.resize(800, 400);
    cam.zoom = 3.5;
    cam.x = 70;
    cam.y = 20;
    const layer = new UnitLayer();
    layer.reset(s.map.width);
    layer.track(s, 0);
    layer.draw(ctxNoop(), s, cam, 1, colors, 1, 1, 0);
    expect(layer.fleets).toBe(1);
    const at = layer.screenOf(a.id)!;
    expect(layer.ownFleetAt(at.x + 10, at.y)).not.toBeNull();
    // the old marker took the carrier sprite's length (about 60 px): its hit area reached 40 px out
    expect(layer.ownFleetAt(at.x + 40, at.y)).toBeNull();
  });
});

function ctxNoop(): CanvasRenderingContext2D {
  return recCtx().ctx;
}
