// The connected buildings in the real game (client only): the quay between same-coast ports, the trench between forts, the
// road with houses between cities and the fence round a SAM site and its fort, drawn UNDER every building's art, at art
// zoom (ART_ZOOM and up) only. Which pairs join is art/detailed/buildingLinks.ts (pure), the pixels are
// art/detailed/buildingLinkArt.ts. Nothing here changes a rule, a hit area, the pop icon or a level chip.
//
// Cost: LinkSet holds the links of the shown buildings and recomputes them only when its key changes (the building set
// version, the fog view, a coarse territory step); a recompute that finds the same links keeps them. LinkSprites bakes each
// link once per look, scale and (quarter-step) zoom, a few per frame, and draws a stale sprite of the link until the right
// one is ready.
import { buildingSpacing } from '../../sim/buildings';
import { isWater, type Building, type GameState } from '../../sim/types';
import { CU } from '../art/detailed/buildings';
import { paintLinks, type LinkSite } from '../art/detailed/buildingLinkArt';
import { pairLinks, type BuildingLink, type LinkBuilding, type LinkTerrain, type LinkType } from '../art/detailed/buildingLinks';
import { ART_ZOOM, artScale, balanceShift, drawnExtent, fitScale, specOf, type ArtLook } from './buildingArt';
import { makeCanvas } from './common';
import type { RGB } from './common';
import type { TerrainData } from './terrain';

/** Links are drawn from this zoom on (the buildings' art zoom). */
export const LINK_ZOOM = ART_ZOOM;
/** Ticks per territory step: the borders under the links are looked at again this often. */
export const LINK_TERRITORY_TICKS = 20;
/** New link sprites baked per frame at most. */
export const LINK_BAKES_PER_FRAME = 2;
const CACHE_MAX = 96;
/** Zoom steps links are baked at (a sprite is drawn scaled by zoom / its step, at most a few percent). */
const ZOOM_STEP = 0.25;
/** Biggest sprite edge (CSS px) a link is baked at. */
const MAX_EDGE = 2600;

const LINK_TYPES: ReadonlySet<string> = new Set(['port', 'fort', 'city', 'sam']);

export function linksShown(zoom: number): boolean {
  return zoom >= LINK_ZOOM;
}

export interface LinkEnd {
  tile: number;
  type: LinkType;
  level: number;
  /** a port: which way its pier points (0 east, 1 south, 2 west, 3 north) */
  facing: number;
  /** key of the art model (type, level, add-on) */
  sig: string;
}

export interface SetLink {
  link: BuildingLink;
  a: LinkEnd;
  b: LinkEnd;
  /** what the picture depends on besides look, scale and zoom */
  sig: string;
}

/** What LinkSet needs to compute: the shown buildings as link input and the terrain. */
export interface LinkInput {
  buildings: LinkBuilding[];
  terrain: LinkTerrain;
  end: (tile: number) => LinkEnd;
}

/** The cache key of the link set: changes with the building set (added, removed, captured, upgraded), the fog view and a coarse territory step, never on an unrelated frame. */
export function linkKey(buildingsKey: number, fogGen: number, tick: number, mapWidth: number): string {
  return `${buildingsKey}:${fogGen}:${Math.floor(tick / LINK_TERRITORY_TICKS)}:${mapWidth}`;
}

/** The links of the shown buildings, rebuilt only when `key` changes. */
export class LinkSet {
  links: SetLink[] = [];
  /** recomputes done (stats and tests) */
  computed = 0;
  /** recomputes that found different links */
  changed = 0;
  private key = '';
  private sig = '';

  /** Recomputes for a new key; true when the links differ from before. */
  update(key: string, input: () => LinkInput): boolean {
    if (key === this.key) return false;
    this.key = key;
    this.computed++;
    const inp = input();
    const ends = new Map<number, LinkEnd>();
    const endOf = (tile: number): LinkEnd => {
      let e = ends.get(tile);
      if (!e) {
        e = inp.end(tile);
        ends.set(tile, e);
      }
      return e;
    };
    const next: SetLink[] = pairLinks(inp.buildings, inp.terrain).map((link) => {
      const a = endOf(link.a);
      const b = endOf(link.b);
      const path = link.full ?? link.path;
      const shape = path ? path.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(';') : '';
      return { link, a, b, sig: `${link.kind}|${link.a}|${link.b}|${a.sig}:${a.facing}|${b.sig}:${b.facing}|${link.core ? link.core.join(',') : ''}|${shape}` };
    });
    const sig = next.map((l) => l.sig).join('\n');
    const diff = sig !== this.sig;
    if (diff) {
      this.links = next;
      this.sig = sig;
      this.changed++;
    }
    return diff;
  }

  clear(): void {
    this.links = [];
    this.key = '';
    this.sig = '';
  }
}

interface Sprite {
  canvas: HTMLCanvasElement;
  /** tile the sprite's top left is at, the zoom step it was baked at and its CSS size */
  tx: number;
  ty: number;
  zq: number;
  w: number;
  h: number;
}

/** Baked link sprites with a per-frame bake budget; the latest sprite of each link serves while a new one waits. */
export class LinkSprites {
  private cache = new Map<string, Sprite>();
  private latest = new Map<string, Sprite>();
  private budget = LINK_BAKES_PER_FRAME;
  baked = 0;

  newFrame(): void {
    this.budget = LINK_BAKES_PER_FRAME;
  }

  clear(): void {
    this.cache.clear();
    this.latest.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /** The sprite for a key (baked within the frame's budget), else the link's last sprite, else null. */
  get(id: string, key: string, bake: () => Sprite | null): Sprite | null {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.latest.set(id, hit);
      return hit;
    }
    if (this.budget <= 0) return this.latest.get(id) ?? null;
    this.budget--;
    const s = bake();
    this.baked++;
    if (!s) return this.latest.get(id) ?? null;
    this.cache.set(key, s);
    this.latest.set(id, s);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    if (this.latest.size > CACHE_MAX * 2) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
    return s;
  }
}

/** The link input of the buildings a frame shows: finished ones of a nation, of the four linked types. */
export function linkInput(state: GameState, shown: readonly Building[], end: (b: Building) => LinkEnd): LinkInput {
  const m = state.map;
  const w = m.width;
  const h = m.height;
  const byTile = new Map<number, Building>();
  const buildings: LinkBuilding[] = [];
  for (const b of shown) {
    if (!LINK_TYPES.has(b.type) || b.owner === 0 || b.buildLeft > 0) continue;
    byTile.set(b.tile, b);
    buildings.push({ id: b.tile, type: b.type as LinkType, x: b.tile % w, y: (b.tile / w) | 0, owner: b.owner, level: b.level });
  }
  const terrain: LinkTerrain = {
    water: (x, y) => x < 0 || y < 0 || x >= w || y >= h || isWater(m.terrain[y * w + x]),
    owner: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m.owner[y * w + x]),
  };
  return { buildings, terrain, end: (tile) => end(byTile.get(tile) as Building) };
}

/** What a frame hands the layer to draw. */
export interface LinkFrame {
  state: GameState;
  terr: TerrainData | null;
  ox: number;
  oy: number;
  zoom: number;
  look: ArtLook;
  dpr: number;
  viewW: number;
  viewH: number;
  /** the picture spec of an end (add-on and all), for its reach */
  specOf: (e: LinkEnd) => ReturnType<typeof specOf>;
}

export class LinkLayer {
  readonly set = new LinkSet();
  readonly sprites = new LinkSprites();
  /** links drawn last frame (stats and tests) */
  drawn = 0;

  reset(): void {
    this.set.clear();
    this.sprites.clear();
  }

  newFrame(): void {
    this.sprites.newFrame();
    this.drawn = 0;
  }

  draw(ctx: CanvasRenderingContext2D, f: LinkFrame): void {
    if (!linksShown(f.zoom) || !this.set.links.length) return;
    const { state, zoom, look, dpr } = f;
    const zq = Math.max(ZOOM_STEP, Math.round(zoom / ZOOM_STEP) * ZOOM_STEP);
    const w = state.map.width;
    const spacing = buildingSpacing(state);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const sl of this.set.links) {
      const link = sl.link;
      const path = link.full ?? link.path;
      // the link's tile box
      let x0 = Math.min(link.a % w, link.b % w);
      let x1 = Math.max(link.a % w, link.b % w);
      let y0 = Math.min((link.a / w) | 0, (link.b / w) | 0);
      let y1 = Math.max((link.a / w) | 0, (link.b / w) | 0);
      if (path) {
        for (const p of path) {
          x0 = Math.min(x0, p[0]);
          x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]);
          y1 = Math.max(y1, p[1]);
        }
      }
      const as = artScale(zoom);
      const margin = Math.ceil((CU * as) / zoom) + 1;
      if (f.ox + (x1 + 1 + margin) * zoom < 0 || f.ox + (x0 - margin) * zoom > f.viewW || f.oy + (y1 + 1 + margin) * zoom < 0 || f.oy + (y0 - margin) * zoom > f.viewH) continue;
      // one scale for the whole link: the smaller of its two buildings' fitted art scale (so it matches the art beside it)
      const sa = fitScale(f.specOf(sl.a) ?? { type: sl.a.type as never, level: 1, addon: null }, look, sl.a.facing, zoom, spacing);
      const sb = fitScale(f.specOf(sl.b) ?? { type: sl.b.type as never, level: 1, addon: null }, look, sl.b.facing, zoom, spacing);
      if (!sa || !sb) continue;
      const scale = Math.min(sa.scale, sb.scale);
      const key = `${sl.sig}|${look}|${scale}|${zq}|${dpr}`;
      const sp = this.sprites.get(`${link.a}:${link.b}:${link.kind}`, key, () => this.bake(f, sl, look, scale, zq, margin, [x0, y0, x1, y1]));
      if (!sp) continue;
      const rr = zoom / sp.zq;
      const dx = Math.round((f.ox + sp.tx * zoom) * dpr) / dpr;
      const dy = Math.round((f.oy + sp.ty * zoom) * dpr) / dpr;
      ctx.drawImage(sp.canvas, dx, dy, sp.w * rr, sp.h * rr);
      this.drawn++;
    }
    ctx.restore();
  }

  private bake(f: LinkFrame, sl: SetLink, look: ArtLook, scale: number, zq: number, margin: number, box: [number, number, number, number]): Sprite | null {
    const { state, dpr } = f;
    const w = state.map.width;
    const h = state.map.height;
    const tx = Math.floor(box[0]) - margin;
    const ty = Math.floor(box[1]) - margin;
    const cw = Math.ceil((Math.ceil(box[2]) + 1 + margin - tx) * zq);
    const ch = Math.ceil((Math.ceil(box[3]) + 1 + margin - ty) * zq);
    if (cw > MAX_EDGE || ch > MAX_EDGE || cw < 1 || ch < 1) return null;
    const cv = makeCanvas(Math.ceil(cw * dpr), Math.ceil(ch * dpr));
    const cx = cv.getContext('2d');
    if (!cx) return null;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toScreen = (px: number, py: number): [number, number] => [(px - tx) * zq, (py - ty) * zq];
    const sites = new Map<number, LinkSite>();
    for (const e of [sl.a, sl.b]) {
      const spec = f.specOf(e);
      if (!spec) continue;
      const x = e.tile % w;
      const y = (e.tile / w) | 0;
      let [sx, sy] = toScreen(x + 0.5, y + 0.5);
      if (e.type === 'port') {
        // the picture's anchor on a port is its coast edge
        sx += [1, 0, -1, 0][e.facing] * zq * 0.5;
        sy += [0, 1, 0, -1][e.facing] * zq * 0.5;
      } else sx += balanceShift(spec, look) * scale;
      sites.set(e.tile, { type: e.type, sx, sy, ext: drawnExtent(spec, look, e.facing) });
    }
    const rgba = f.terr?.rgba;
    paintLinks(cx, {
      links: [sl.link],
      sites,
      scale,
      dpr,
      w: cw,
      h: ch,
      tileOf: (sx, sy) => [tx + sx / zq, ty + sy / zq],
      toScreen,
      rgbAt: (px, py): RGB => {
        if (!rgba) return [120, 124, 110];
        const ix = Math.max(0, Math.min(w - 1, Math.floor(px)));
        const iy = Math.max(0, Math.min(h - 1, Math.floor(py)));
        const o = (iy * w + ix) * 4;
        return [rgba[o], rgba[o + 1], rgba[o + 2]];
      },
      waterAt: (px, py) => px < 0 || py < 0 || px >= w || py >= h || isWater(state.map.terrain[py * w + px]),
    });
    return { canvas: cv, tx, ty, zq, w: cw, h: ch };
  }
}
