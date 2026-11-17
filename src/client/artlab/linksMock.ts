// The art lab's "Connected buildings" mockup (art lab builds only): same-owner buildings that stand near each other are
// drawn as one place. Ports share a harbour wall along the coast, forts a trench line, cities a road with suburbs and a
// SAM site next to a fort sits inside a fence round both. Which pairs join is art/detailed/buildingLinks.ts (pure, tested);
// the pixels are art/detailed/buildingLinkArt.ts. Every pair is shown BEFORE (loose stamps) and AFTER (connected) at zoom
// 8 (far look) and zoom 11 (close look) over the game's own Baltic terrain. The game itself is unchanged.
import { buildTerrain } from '../render/terrain';
import { themeForMap } from '../render/mapThemes';
import { makeCanvas } from '../render/common';
import { isWater } from '../../sim/types';
import type { RGB } from '../art/shared/colour';
import { gridOf } from '../art/detailed/grid';
import { bakeBuilding, bakeBuildingFar, COAST, levelPill, modelExtent, OU, OV, type Addon, type BuildingSpec, type Under } from '../art/detailed/buildings';
import { pairLinks, type BuildingLink, type LinkBuilding, type LinkTerrain } from '../art/detailed/buildingLinks';
import { paintLinks, type LinkSite } from '../art/detailed/buildingLinkArt';
import { loadBalticTerrain } from './buildingsMock';

const BLUE: RGB = [64, 160, 255];
const RED: RGB = [226, 74, 60];
const MAP_ID = 'baltic';
const CW = 480;
const CH = 270;
/** tile window cut for each scene */
const WT = 72;
const HT = 44;
/** screen px per model unit at a zoom (the units' own scale) */
const unitScale = (z: number): number => (z < 11 ? 1.5 : z < 22 ? 2 : z < 32 ? 3 : 4);

interface Site extends LinkBuilding {
  addon: Addon;
}

interface Scene {
  id: string;
  title: string;
  note: string;
  sites: Site[];
  links: BuildingLink[];
  /** view centre in tiles */
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  tiles: HTMLCanvasElement;
  rgb: Uint8ClampedArray;
  land: (x: number, y: number) => boolean;
  owner: (x: number, y: number) => number;
  borderX?: (y: number) => number;
}

interface World {
  w: number;
  h: number;
  land: (x: number, y: number) => boolean;
  rgba: Uint8ClampedArray;
}

type Layout = { type: Site['type']; level: number; dx: number; dy: number; owner: number }[];

/** Finds, scanning the map, an anchor where the layout's buildings all stand on dry land (a port on an east-facing coast). */
function search(world: World, layout: Layout, ownerOf: (ax: number, ay: number) => (x: number, y: number) => number, ok: (links: BuildingLink[]) => boolean, start: number): { ax: number; ay: number } | null {
  const { land } = world;
  const dry = (x: number, y: number): boolean => {
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (!land(x + i, y + j)) return false;
    return true;
  };
  const coast = (x: number, y: number): boolean => {
    if (!land(x, y) || !land(x - 6, y) || land(x + 1, y)) return false;
    for (let k = 1; k <= 6; k++) for (let j = -3; j <= 3; j++) if (land(x + k, y + j)) return false;
    return true;
  };
  let seen = 0;
  for (let ay = 30; ay < world.h - 30; ay += 2) {
    for (let ax = 30; ax < world.w - 30; ax += 2) {
      if (!layout.every((b) => (b.type === 'port' ? coast(ax + b.dx, ay + b.dy) : dry(ax + b.dx, ay + b.dy)))) continue;
      const owner = ownerOf(ax, ay);
      const terrain: LinkTerrain = { water: (x, y) => !land(x, y), owner };
      const links = pairLinks(layout.map((b, i) => ({ id: i + 1, type: b.type, x: ax + b.dx, y: ay + b.dy, owner: b.owner, level: b.level })), terrain);
      if (!ok(links)) continue;
      if (seen++ < start) continue;
      return { ax, ay };
    }
  }
  return null;
}

/** The east-facing coast pairs for the ports scene: the second port's offset is searched, not fixed. */
function findPorts(world: World): { ax: number; ay: number; dx: number; dy: number } | null {
  for (let dy = 8; dy <= 13; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const layout: Layout = [{ type: 'port', level: 3, dx: 0, dy: 0, owner: 1 }, { type: 'port', level: 2, dx, dy, owner: 1 }];
      const r = search(world, layout, () => (x, y) => (world.land(x, y) ? 1 : 0), (l) => l.length === 1 && l[0].kind === 'quay', 0);
      if (r) return { ...r, dx, dy };
    }
  }
  return null;
}

function cut(world: World, ax: number, ay: number, cx: number, cy: number, owner: (x: number, y: number) => number): { x0: number; y0: number; tiles: HTMLCanvasElement; rgb: Uint8ClampedArray } {
  const x0 = Math.max(0, Math.min(world.w - WT, Math.round(cx - WT / 2)));
  const y0 = Math.max(0, Math.min(world.h - HT, Math.round(cy - HT / 2)));
  const tiles = makeCanvas(WT, HT);
  const rgb = new Uint8ClampedArray(WT * HT * 4);
  const tc = tiles.getContext('2d');
  if (tc) {
    const img = tc.createImageData(WT, HT);
    for (let y = 0; y < HT; y++) {
      for (let x = 0; x < WT; x++) {
        const mi = (y0 + y) * world.w + x0 + x;
        const o = (y * WT + x) * 4;
        let r = world.rgba[mi * 4];
        let g = world.rgba[mi * 4 + 1];
        let b = world.rgba[mi * 4 + 2];
        const ow = owner(x0 + x, y0 + y);
        if (ow) {
          const t = ow === 1 ? BLUE : RED;
          r += (t[0] - r) * 0.15;
          g += (t[1] - g) * 0.15;
          b += (t[2] - b) * 0.15;
        }
        for (const a of [img.data, rgb]) {
          a[o] = r;
          a[o + 1] = g;
          a[o + 2] = b;
          a[o + 3] = 255;
        }
      }
    }
    tc.putImageData(img, 0, 0);
  }
  return { x0, y0, tiles, rgb };
}

function scenes(world: World): Scene[] {
  const out: Scene[] = [];
  const allBlue = (): ((x: number, y: number) => number) => (x, y) => (world.land(x, y) ? 1 : 0);
  const make = (id: string, title: string, note: string, ax: number, ay: number, layout: Layout, owner: (x: number, y: number) => number, cx: number, cy: number, borderX?: (y: number) => number): void => {
    const sites: Site[] = layout.map((b, i) => ({ id: i + 1, type: b.type, level: b.level, owner: b.owner, x: ax + b.dx, y: ay + b.dy, addon: null }));
    const links = pairLinks(sites, { water: (x, y) => !world.land(x, y), owner });
    out.push({ id, title, note, sites, links, cx, cy, ...cut(world, ax, ay, cx, cy, owner), land: world.land, owner, borderX });
  };
  const ports = findPorts(world);
  if (ports) {
    const layout: Layout = [{ type: 'port', level: 3, dx: 0, dy: 0, owner: 1 }, { type: 'port', level: 2, dx: ports.dx, dy: ports.dy, owner: 1 }];
    make('ports', 'Ports on one coast', 'Two ports of the same nation on the same shore get one continuous harbour wall: a stone quay with a dark kerb on the sea side, a paved apron behind it and bollards. Each port keeps its own piers, crane and level chip.', ports.ax, ports.ay, layout, allBlue(), ports.ax + 2 + ports.dx / 2, ports.ay + ports.dy / 2);
  }
  const fl: Layout = [{ type: 'fort', level: 3, dx: -14, dy: 1, owner: 1 }, { type: 'fort', level: 5, dx: 0, dy: -1, owner: 1 }, { type: 'fort', level: 2, dx: 13, dy: 2, owner: 1 }];
  const f = search(world, fl, allBlue, (l) => l.length === 2 && l.every((k) => k.kind === 'trench'), 2);
  if (f) make('forts', 'Forts in a line', 'Forts of the same nation within 18 tiles are tied together by a trench line with an earth berm each side and a small concrete bunker now and then. The forts stay the strong shapes on top.', f.ax, f.ay, fl, allBlue(), f.ax, f.ay);
  const cl: Layout = [{ type: 'city', level: 3, dx: -18, dy: 0, owner: 1 }, { type: 'city', level: 5, dx: 1, dy: 2, owner: 1 }, { type: 'city', level: 2, dx: 13, dy: -2, owner: 2 }];
  const bf = (ax: number) => (y: number): number => ax + 7 + 2.6 * Math.sin(y * 0.2);
  const ownerAt = (ax: number) => (x: number, y: number): number => (world.land(x, y) ? (x < bf(ax)(y) ? 1 : 2) : 0);
  const c = search(world, cl, ownerAt, (l) => l.length === 1 && l[0].kind === 'road', 1);
  if (c) make('cities', 'Cities growing together', 'Cities of the same nation grow a road with houses along it toward each other: dense next to each city, thinning out in the middle. The red city across the border is not joined to the blue ones, and nothing crosses the border.', c.ax, c.ay, cl, ownerAt(c.ax), c.ax - 3, c.ay, bf(c.ax));
  const sl: Layout = [{ type: 'fort', level: 3, dx: 0, dy: 0, owner: 1 }, { type: 'sam', level: 1, dx: 6, dy: -2, owner: 1 }, { type: 'sam', level: 3, dx: 21, dy: 3, owner: 1 }];
  const s = search(world, sl, allBlue, (l) => l.length === 1 && l[0].kind === 'perimeter', 3);
  if (s) make('samfort', 'SAM site inside a fort', 'A SAM site beside a fort of the same nation sits inside the fort\'s perimeter: a fence on an earth berm round both, a trampled yard and a gate. A SAM site far from any fort (right) keeps standing alone.', s.ax, s.ay, sl, allBlue(), s.ax + 9, s.ay);
  return out;
}

function render(cv: HTMLCanvasElement, sc: Scene, zoom: number, connected: boolean, dpr: number): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vx0 = sc.cx - CW / 2 / zoom;
  const vy0 = sc.cy - CH / 2 / zoom;
  const toX = (tx: number): number => (tx - vx0) * zoom;
  const toY = (ty: number): number => (ty - vy0) * zoom;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sc.tiles, vx0 - sc.x0, vy0 - sc.y0, CW / zoom, CH / zoom, 0, 0, CW, CH);
  if (sc.borderX) {
    ctx.lineCap = 'round';
    for (const [lw, col] of [[Math.max(2, zoom * 0.32), 'rgba(12,16,22,0.65)'], [Math.max(1, zoom * 0.14), 'rgba(236,238,232,0.85)']] as [number, string][]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.beginPath();
      let pen = false;
      for (let ty = Math.floor(vy0); ty <= Math.ceil(vy0 + CH / zoom); ty++) {
        const bx = sc.borderX(ty);
        if (!sc.land(Math.floor(bx) - 1, ty) || !sc.land(Math.floor(bx) + 2, ty)) {
          pen = false;
          continue;
        }
        if (!pen) ctx.moveTo(toX(bx), toY(ty + 0.5));
        else ctx.lineTo(toX(bx), toY(ty + 0.5));
        pen = true;
      }
      ctx.stroke();
    }
  }
  const scale = unitScale(zoom);
  const far = zoom < 11;
  const grid = gridOf(scale, dpr);
  const tileAt = (tx: number, ty: number): number => {
    const ix = Math.max(0, Math.min(WT - 1, Math.floor(tx - sc.x0)));
    const iy = Math.max(0, Math.min(HT - 1, Math.floor(ty - sc.y0)));
    return (iy * WT + ix) * 4;
  };
  const anchorOf = (s: Site): [number, number] => [s.type === 'port' ? toX(s.x + 1) - COAST * scale : toX(s.x + 0.5), toY(s.y + 0.5)];
  if (connected) {
    const sites = new Map<number, LinkSite>();
    for (const s of sc.sites) {
      const [ax, ay] = anchorOf(s);
      sites.set(s.id, { type: s.type, sx: ax + (s.type === 'port' ? COAST * scale : 0), sy: ay, ext: modelExtent({ type: s.type, level: s.level, addon: null }, far ? 'far' : 'close') });
    }
    paintLinks(ctx, {
      links: sc.links,
      sites,
      scale,
      dpr,
      w: CW,
      h: CH,
      tileOf: (sx, sy) => [vx0 + sx / zoom, vy0 + sy / zoom],
      toScreen: (tx, ty) => [toX(tx), toY(ty)],
      rgbAt: (tx, ty) => {
        const o = tileAt(tx, ty);
        return [sc.rgb[o], sc.rgb[o + 1], sc.rgb[o + 2]];
      },
      waterAt: (tx, ty) => !sc.land(tx, ty),
    });
  }
  const levels: [number, number, number, RGB][] = [];
  for (const s of sc.sites.slice().sort((a, b) => a.y - b.y)) {
    const owner = s.owner === 1 ? BLUE : RED;
    const [ax, ay] = anchorOf(s);
    const cellX = ax - OU * scale;
    const cellY = ay - OV * scale;
    const tileOf = (px: number, py: number): [number, number] => [
      (s.type === 'port' ? s.x + 1 : s.x + 0.5) + ((px - OU * grid.res) / grid.res - (s.type === 'port' ? COAST : 0)) * (scale / zoom),
      s.y + 0.5 + ((py - OV * grid.res) / grid.res) * (scale / zoom),
    ];
    const under: Under = {
      rgb: (px, py): RGB => {
        const [tx, ty] = tileOf(px, py);
        const o = tileAt(tx, ty);
        return [sc.rgb[o], sc.rgb[o + 1], sc.rgb[o + 2]];
      },
      water: (px, py): boolean => {
        const [tx, ty] = tileOf(px, py);
        return !sc.land(Math.floor(tx), Math.floor(ty));
      },
    };
    const bs: BuildingSpec = { type: s.type, level: s.level, addon: s.addon };
    const spr = far ? bakeBuildingFar(bs, owner, scale, dpr, under) : bakeBuilding(bs, owner, scale, dpr, under);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spr.canvas, Math.round(cellX * dpr) / dpr, Math.round(cellY * dpr) / dpr, spr.w, spr.h);
    if (scale >= 2) levels.push([cellX + spr.cx, cellY + spr.top - 15, s.level, owner]);
  }
  for (const [x, y, lv, o] of levels) levelPill(ctx, x, y, lv, o);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Mounts the Connected buildings section in the lab page and draws it. */
export function mountLinksMock(root: HTMLElement): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'al-row al-bm';
  sec.id = 'al-links';
  sec.setAttribute('aria-labelledby', 'al-row-links');
  sec.style.display = 'block';
  const head = document.createElement('div');
  head.className = 'al-row-head';
  const t = document.createElement('h2');
  t.id = 'al-row-links';
  t.textContent = 'Connected buildings';
  const note = document.createElement('p');
  note.textContent = 'Same-nation buildings that stand near each other are drawn as one place: ports share a harbour wall, forts a trench line, cities a road with suburbs, and a SAM site next to a fort sits inside the fort\'s fence. The connectors are only decoration under the buildings, in the same pixel style and tinted by the land they cross; every building keeps its own core and level chip. Nothing is joined across water or across a border. Each scene is shown before and after, at zoom 8 (simplified far look) and zoom 11 (full detail). This is a mockup: the game does not draw these yet.';
  head.append(t, note);
  sec.append(head);
  root.append(sec);
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  void loadBalticTerrain().then(
    (map) => {
      const theme = themeForMap(MAP_ID);
      const terr = buildTerrain(map, theme);
      const world: World = { w: map.width, h: map.height, rgba: terr.rgba, land: (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height && !isWater(map.terrain[y * map.width + x]) };
      for (const sc of scenes(world)) {
        const blk = document.createElement('div');
        blk.dataset.links = sc.id;
        blk.style.cssText = 'margin-top:18px';
        const h3 = document.createElement('h3');
        h3.textContent = sc.title;
        const p = document.createElement('p');
        p.textContent = sc.note;
        const grid = document.createElement('div');
        grid.style.cssText = `display:grid;grid-template-columns:repeat(2,${CW}px);gap:8px 12px;margin-top:8px`;
        for (const zoom of [8, 11]) {
          for (const connected of [false, true]) {
            const fig = document.createElement('div');
            const cap = document.createElement('p');
            cap.textContent = `${connected ? 'AFTER: connected' : 'BEFORE: loose buildings'}, zoom ${zoom}`;
            cap.style.cssText = 'margin:0 0 3px;font-weight:600';
            const cv = document.createElement('canvas');
            cv.dataset.state = connected ? 'after' : 'before';
            cv.dataset.zoom = String(zoom);
            cv.setAttribute('role', 'img');
            cv.setAttribute('aria-label', `${sc.title}, ${connected ? 'after' : 'before'}, zoom ${zoom}`);
            cv.style.cssText = `display:block;border-radius:8px;max-width:100%;width:${CW}px`;
            cv.width = CW * dpr;
            cv.height = CH * dpr;
            fig.append(cap, cv);
            grid.append(fig);
            const go = (): void => render(cv, sc, zoom, connected, dpr);
            go();
            void document.fonts?.ready.then(go);
          }
        }
        blk.append(h3, p, grid);
        sec.append(blk);
      }
      sec.dataset.ready = '1';
    },
    (e: unknown) => {
      const m = document.createElement('p');
      m.textContent = `The map could not be loaded: ${String(e)}`;
      sec.append(m);
    },
  );
  return sec;
}
