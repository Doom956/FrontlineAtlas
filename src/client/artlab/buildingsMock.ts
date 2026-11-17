// The art lab's "Buildings mockup" (art lab builds only): map buildings in the troops' own shaded pixel style, seen from
// above. Each building is a model of parts (the game's detailed-style part format, art/detailed/bake.ts) rasterized by
// the game's own unit rasterizer, so it has the units' pixel density, 4 tone material ramps, top-left light, ordered
// dither on the tone borders, rim shading and the owner-coloured outline ring with a dark outer edge (outline.ts).
// Nothing grey sits under a building. The ground round it is painted from the terrain colour under it (a contact
// shadow cast by the real parts, dirt yards, paths, a moat, a shore) as soft, dithered shades of that colour.
// The level is a small dark pill like the army count pill. The drawing code lives in art/detailed/buildings.ts (the game map
// draws the same buildings); this file is the lab sheet and map preview. Everything is drawn in code (no image files).
import { drawMarker, ICON_INFO, type BuildingIconId } from '../icons';
import { CATEGORY_PLATES } from '../render/buildings';
import { buildTerrain, TERRAIN_RGB, waterRGB } from '../render/terrain';
import { themeForMap } from '../render/mapThemes';
import { makeCanvas } from '../render/common';
import { troopPill, type TroopIconKind } from '../render/troopIcons';
import { isWater, type MapData } from '../../sim/types';
import { decodeWorldMapBlob } from '../../sim/worldmaps';
import balticBlob from '../../maps/data/baltic';
import type { RGB } from '../art/shared/colour';
import { motionParams } from '../art/motion';
import { FORE } from '../art/detailed/bake';
import { gridOf } from '../art/detailed/grid';
import { detailedUnits } from '../art/detailed/units';
import { bakeBuilding, bakeBuildingFar, COAST, CU, CV, OU, OV, SCALE_CLOSE, SCALE_NORMAL, cl, dark, mix, hash, vnoise, levelPill, type Addon, type BuildingSpec, type C, type Under } from '../art/detailed/buildings';
import type { SpriteKey } from '../art/shared/keys';
import type { UnitDraw } from '../art/types';
import { backdrop } from './backdrop';
import { label } from './scenes';

// ------------------------------------------------------------------------------------------------- the sheet

const BLUE: RGB = [64, 160, 255];
const RED: RGB = [226, 74, 60];

interface Row {
  title: string;
  spec: BuildingSpec;
}
const GROUPS: { name: string; rows: Row[] }[] = [
  {
    name: 'Fort',
    rows: [
      { title: 'Fort, level 1', spec: { type: 'fort', level: 1, addon: null } },
      { title: 'Fort, level 3', spec: { type: 'fort', level: 3, addon: null } },
      { title: 'Fort, level 5', spec: { type: 'fort', level: 5, addon: null } },
      { title: 'Fort level 3 with flak guns (add-on)', spec: { type: 'fort', level: 3, addon: 'flak' } },
      { title: 'Fort level 3 with tank traps (add-on)', spec: { type: 'fort', level: 3, addon: 'traps' } },
    ],
  },
  {
    name: 'City',
    rows: [
      { title: 'City, level 1', spec: { type: 'city', level: 1, addon: null } },
      { title: 'City, level 3', spec: { type: 'city', level: 3, addon: null } },
      { title: 'City, level 5', spec: { type: 'city', level: 5, addon: null } },
      { title: 'City level 3 with flak (add-on)', spec: { type: 'city', level: 3, addon: 'flak' } },
    ],
  },
  {
    name: 'SAM site',
    rows: [
      { title: 'SAM site, level 1', spec: { type: 'sam', level: 1, addon: null } },
      { title: 'SAM site, level 3', spec: { type: 'sam', level: 3, addon: null } },
      { title: 'SAM site level 1 with radar dish (add-on)', spec: { type: 'sam', level: 1, addon: 'radar' } },
    ],
  },
  {
    name: 'Port',
    rows: [
      { title: 'Port, level 1', spec: { type: 'port', level: 1, addon: null } },
      { title: 'Port, level 3', spec: { type: 'port', level: 3, addon: null } },
      { title: 'Port level 3 with coastal guns (add-on)', spec: { type: 'port', level: 3, addon: 'guns' } },
    ],
  },
];

const LABEL_W = 232;
const PAD = 8;
const COLS = [
  { head: 'Close zoom', sub: 'Blue nation', w: CU * SCALE_CLOSE + PAD * 2 },
  { head: 'Close zoom', sub: 'Red nation', w: CU * SCALE_CLOSE + PAD * 2 },
  { head: 'Normal zoom', sub: 'Blue nation', w: CU * SCALE_NORMAL + PAD * 2 },
  { head: 'Normal zoom', sub: 'Red nation', w: CU * SCALE_NORMAL + PAD * 2 },
  { head: "Today's icon", sub: 'Blue nation', w: 84 },
  { head: "Today's icon", sub: 'Red nation', w: 84 },
];
export const ROW_H = CV * SCALE_CLOSE + 10;
const GROUP_H = 26;
const HEAD_H = 46;
const FLAT_H = 120;
export const SHEET_W = LABEL_W + COLS.reduce((a, c) => a + c.w, 0);

/** Row tops (CSS px) of each group on the sheet, for screenshots. */
export function sheetLayout(): { name: string; y: number; h: number }[] {
  const out: { name: string; y: number; h: number }[] = [];
  let y = HEAD_H;
  for (const g of GROUPS) {
    const h = GROUP_H + g.rows.length * ROW_H;
    out.push({ name: g.name, y, h });
    y += h;
  }
  out.push({ name: 'Flat', y, h: FLAT_H });
  return out;
}
const SHEET_H = HEAD_H + GROUPS.reduce((a, g) => a + GROUP_H + g.rows.length * ROW_H, 0) + FLAT_H;

/** Today's map marker for a building (render/buildings.ts drawOne): a category plate, a white glyph, the owner band. */
function todayIcon(ctx: CanvasRenderingContext2D, type: BuildingSpec['type'], level: number, x: number, y: number, owner: RGB, dpr: number): void {
  const size = 40;
  const r = size / 2;
  const fw = 4;
  const cat = ICON_INFO[type as BuildingIconId].category;
  ctx.fillStyle = 'rgba(12,15,20,0.55)';
  ctx.beginPath();
  ctx.roundRect(x - r - 1, y - r - 1, size + 2, size + fw + 3, size * 0.26);
  ctx.fill();
  ctx.fillStyle = `rgb(${owner[0]},${owner[1]},${owner[2]})`;
  ctx.beginPath();
  ctx.roundRect(x - r + size * 0.12, y + r - 1, size * 0.76, fw + 1, 2);
  ctx.fill();
  drawMarker(ctx, type as BuildingIconId, x, y, size, { plate: cat ? CATEGORY_PLATES[cat] : owner, dpr });
  if (level > 1) {
    const br = 8;
    const bx2 = x + r * 0.78;
    const by = y - r * 0.78;
    ctx.beginPath();
    ctx.arc(bx2, by, br, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f5f1';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(14,18,24,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#1a1f27';
    ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(level), bx2, by + 0.5);
  }
}

/** The shore line of the sheet's port: a wavy coast about u = COAST. */
const coastU = (v: number): number => COAST + 2.2 * Math.sin(v * 0.19 + 0.7) + 1.1 * Math.sin(v * 0.47) + (vnoise(v * 0.3, 3, 31) - 0.5) * 1.6;
/**
 * The sheet's terrain under a cell: plains, and for a port a bay of sea inside the cell (a curved, irregular shore on the
 * west, rounded far shores on the other sides, so no hard square of water), in the game's shelf and shore colours.
 */
function sheetUnder(spec: BuildingSpec, res: number, scale: number): Under {
  const plains = TERRAIN_RGB[2];
  if (spec.type !== 'port') return { water: () => false, rgb: () => plains };
  const ox = OU * res;
  const oy = OV * res;
  const U = (ax: number): number => (ax + 0.5 - ox) / res;
  const V = (ay: number): number => (ay + 0.5 - oy) / (res * FORE);
  /** 1 at the middle of the bay, 0 on its far shore */
  const bay = (u: number, v: number): number => {
    const du = (u - 14.5) / 12.2;
    const dv = (v + 6) / 23;
    return 1 - (Math.pow(Math.abs(du), 2.6) + Math.pow(Math.abs(dv), 2.6)) ** (1 / 2.6) + (vnoise(u * 0.22, v * 0.22, 41) - 0.5) * 0.3;
  };
  const inSea = (u: number, v: number): boolean => u > coastU(v) && bay(u, v) > 0;
  const tilePx = (4 / scale) * res;
  return {
    water: (ax, ay) => inSea(U(ax), V(ay)),
    rgb: (ax, ay) => {
      const u = U(ax);
      const v = V(ay);
      if (!inSea(u, v)) return plains;
      const dist = Math.min(u - coastU(v), bay(u, v) * 13);
      return waterRGB(1 + ((dist * res) / tilePx) * 1.5);
    },
  };
}

function drawSheet(ctx: CanvasRenderingContext2D, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(backdrop('land', SHEET_W, SHEET_H, 14), 0, 0);
  const xs: number[] = [];
  let x = LABEL_W;
  for (const c of COLS) {
    xs.push(x);
    x += c.w;
  }
  ctx.fillStyle = 'rgba(10,14,20,0.82)';
  ctx.fillRect(0, 0, SHEET_W, HEAD_H);
  COLS.forEach((c, i) => {
    label(ctx, c.head, xs[i] + c.w / 2, 14, 'center');
    label(ctx, c.sub, xs[i] + c.w / 2, 33, 'center', true);
  });
  label(ctx, 'Building (rows)', 8, 23, 'left');
  let y = HEAD_H;
  for (const g of GROUPS) {
    ctx.fillStyle = 'rgba(10,14,20,0.78)';
    ctx.fillRect(0, y, SHEET_W, GROUP_H);
    ctx.font = '700 13px "DM Sans", system-ui, sans-serif';
    ctx.fillStyle = '#edeff3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.name, 10, y + GROUP_H / 2);
    y += GROUP_H;
    for (const row of g.rows) {
      const cy = y + ROW_H / 2;
      label(ctx, row.title, 8, cy, 'left');
      const owners = [BLUE, RED, BLUE, RED];
      const scales = [SCALE_CLOSE, SCALE_CLOSE, SCALE_NORMAL, SCALE_NORMAL];
      for (let i = 0; i < 4; i++) {
        const s = scales[i];
        const grid = gridOf(s, dpr);
        const spr = i < 2 ? bakeBuilding(row.spec, owners[i], s, dpr, sheetUnder(row.spec, grid.res, s), true) : bakeBuildingFar(row.spec, owners[i], s, dpr, sheetUnder(row.spec, grid.res, s), true);
        const px = xs[i] + (COLS[i].w - spr.w) / 2;
        const py = cy - spr.h / 2;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(spr.canvas, Math.round(px * dpr) / dpr, Math.round(py * dpr) / dpr, spr.w, spr.h);
        if (i < 2) levelPill(ctx, px + spr.cx, py + spr.top - 15, row.spec.level, owners[i]);
      }
      todayIcon(ctx, row.spec.type, row.spec.level, xs[4] + COLS[4].w / 2, cy - 4, BLUE, dpr);
      todayIcon(ctx, row.spec.type, row.spec.level, xs[5] + COLS[5].w / 2, cy - 4, RED, dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, y + ROW_H - 1, SHEET_W, 1);
      y += ROW_H;
    }
  }
  // the far-zoom flat Fort (one flat level-3 fort: the flat icon is the same at every level and for every nation)
  ctx.fillStyle = 'rgba(10,14,20,0.78)';
  ctx.fillRect(0, y, SHEET_W, FLAT_H);
  label(ctx, 'Flat Fort (far zoom), level 3', 8, y + 24, 'left');
  label(ctx, 'Far zoom keeps this flat square for every fort', 8, y + 48, 'left', true);
  // today's far-zoom fort exactly as the map draws it: a 4 px square, dark fill, a 1 px pale outline (drawFar in
  // render/buildings.ts), drawn at real size and then shown enlarged with hard pixels so it stays true to the original
  const real = document.createElement('canvas');
  real.width = 12 * dpr;
  real.height = 12 * dpr;
  const rc = real.getContext('2d');
  if (rc) {
    rc.scale(dpr, dpr);
    rc.beginPath();
    rc.rect(4, 4, 4, 4);
    rc.lineWidth = 1;
    rc.strokeStyle = 'rgba(245,245,240,0.9)';
    rc.stroke();
    rc.fillStyle = '#2a2e36';
    rc.fill();
  }
  const drawFlat = (k: number, cx: number, cy: number): void => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(real, cx - 6 * k, cy - 6 * k, 12 * k, 12 * k);
  };
  drawFlat(1, xs[2] + COLS[2].w / 2, y + 56);
  label(ctx, 'Real size', xs[2] + COLS[2].w / 2, y + 90, 'center', true);
  drawFlat(8, xs[0] + COLS[0].w / 2, y + 56);
  label(ctx, 'Enlarged 8 times', xs[0] + COLS[0].w / 2, y + 108, 'center', true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ------------------------------------------------------------------------------------------------- on the real map

const MAP_ID = 'baltic';
/** map zoom (CSS px per tile) the two previews stand for */
const ZOOM_NORMAL = 4;
const ZOOM_CLOSE = 11;
const MAP_W = 880;
/** screen px per model unit at a zoom: the units' own scale (render/units.ts spriteScale) */
const unitScale = (z: number): number => (z < 11 ? 1.5 : z < 22 ? 2 : z < 32 ? 3 : 4);

interface Site {
  type: BuildingSpec['type'];
  level: number;
  addon: Addon;
  /** tile position of the building's anchor on the ground */
  x: number;
  y: number;
  blue: boolean;
}

/** A real unit drawn next to a building (a tank or a ship), placed in model units from the building's origin. */
interface Troop {
  key: SpriteKey;
  site: number;
  u: number;
  v: number;
  angle: number;
  blue: boolean;
}

interface Pill {
  site: number;
  u: number;
  v: number;
  troops: number;
  kinds: TroopIconKind[];
  blue: boolean;
}

interface Crop {
  /** the tile window the preview shows (the normal zoom window; the close one is its middle) */
  cx: number;
  cy: number;
  /** tile colours for the whole map window, nations tinted in */
  tiles: HTMLCanvasElement;
  rgb: Uint8ClampedArray;
  x0: number;
  y0: number;
  w: number;
  h: number;
  borderX: (y: number) => number;
  sites: Site[];
  troops: Troop[];
  pills: Pill[];
  water: (x: number, y: number) => boolean;
  /** which nation owns a land tile: 1 blue, 2 red, 0 none */
  owner: (x: number, y: number) => number;
}

/**
 * The Baltic map's terrain, decoded with the game's own map decoder. The lab page waits forever at the top level
 * (gate.ts), so the game's lazy map chunks never initialise in this single-file build: the data is imported directly.
 */
export async function loadBalticTerrain(): Promise<MapData> {
  const bin = atob(balticBlob);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const d = decodeWorldMapBlob(new Uint8Array(await new Response(stream).arrayBuffer()));
  return { width: d.width, height: d.height, terrain: d.terrain, resource: d.resource } as MapData;
}

/** Loads the Baltic map with the game's own loader and terrain colours and cuts a window with sea, a coast and a border. */
async function buildCrop(): Promise<Crop> {
  const map = await loadBalticTerrain();
  const theme = themeForMap(MAP_ID);
  const terr = buildTerrain(map, theme);
  const mw = map.width;
  const mh = map.height;
  const landAt = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < mw && y < mh && !isWater(map.terrain[y * mw + x]);
  const WN = MAP_W / ZOOM_NORMAL;
  const HN = 84;
  // integral image of land, to find a window about half land, with an east-facing coast near its middle
  const sat = new Int32Array((mw + 1) * (mh + 1));
  for (let y = 0; y < mh; y++) {
    let row = 0;
    for (let x = 0; x < mw; x++) {
      row += landAt(x, y) ? 1 : 0;
      sat[(y + 1) * (mw + 1) + x + 1] = sat[y * (mw + 1) + x + 1] + row;
    }
  }
  const landIn = (x: number, y: number, w: number, h: number): number => sat[(y + h) * (mw + 1) + x + w] - sat[y * (mw + 1) + x + w] - sat[(y + h) * (mw + 1) + x] + sat[y * (mw + 1) + x];
  let best = { s: 1e9, x: 0, y: 0, px: 0, py: 0 };
  for (let y = 4; y + HN + 4 < mh; y += 6) {
    for (let x = 4; x + WN + 4 < mw; x += 6) {
      const f = landIn(x, y, WN, HN) / (WN * HN);
      if (f < 0.4 || f > 0.62) continue;
      const cx = x + (WN >> 1);
      const cy = y + (HN >> 1);
      // an east-facing coast near the middle: land, then 7 sea tiles to its right, deep enough for a pier
      let found = -1;
      for (let dy = -10; dy <= 10 && found < 0; dy += 2) {
        for (let dx = -14; dx <= 14; dx++) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (!landAt(tx, ty) || !landAt(tx - 8, ty) || landAt(tx + 1, ty)) continue;
          let sea = true;
          for (let k = 1; k <= 7 && sea; k++) for (let j = -4; j <= 4; j++) if (landAt(tx + k, ty + j)) sea = false;
          if (sea) {
            found = tx * 4096 + ty;
            break;
          }
        }
      }
      if (found < 0) continue;
      const s = Math.abs(f - 0.5);
      if (s < best.s) best = { s, x, y, px: Math.floor(found / 4096), py: found % 4096 };
    }
  }
  const x0 = best.x;
  const y0 = best.y;
  const px = best.px;
  const py = best.py;
  // nations: a wavy border running roughly north to south west of the coast; blue to its west, red to its east
  const bx0 = px - 32;
  const borderX = (y: number): number => bx0 + (y - py) * 0.18 + 5 * Math.sin(y * 0.11);
  const owner = (x: number, y: number): number => (landAt(x, y) ? (x < borderX(y) ? 1 : 2) : 0);
  // tile colours: the game's terrain colours (render/terrain.ts buildTerrain, theme applied), nations tinted over land
  const tiles = makeCanvas(WN, HN);
  const rgb = new Uint8ClampedArray(WN * HN * 4);
  const tc = tiles.getContext('2d');
  if (tc) {
    const img = tc.createImageData(WN, HN);
    for (let y = 0; y < HN; y++) {
      for (let x = 0; x < WN; x++) {
        const mi = (y0 + y) * mw + x0 + x;
        const o = (y * WN + x) * 4;
        let r = terr.rgba[mi * 4];
        let g = terr.rgba[mi * 4 + 1];
        let b = terr.rgba[mi * 4 + 2];
        const ow = owner(x0 + x, y0 + y);
        if (ow) {
          const t = ow === 1 ? BLUE : RED;
          r += (t[0] - r) * 0.15;
          g += (t[1] - g) * 0.15;
          b += (t[2] - b) * 0.15;
        }
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
        rgb[o] = r;
        rgb[o + 1] = g;
        rgb[o + 2] = b;
        rgb[o + 3] = 255;
      }
    }
    tc.putImageData(img, 0, 0);
  }
  // building sites: a tile in from the coast, away from water, on land of the right nation
  const dry = (x: number, y: number): boolean => {
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (!landAt(x + i, y + j)) return false;
    return true;
  };
  const near = (x: number, y: number, blue: boolean): [number, number] => {
    for (let r = 0; r < 30; r++) {
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const tx = x + i;
          const ty = y + j;
          if (dry(tx, ty) && owner(tx, ty) === (blue ? 1 : 2) && Math.abs(tx - borderX(ty)) > 3) return [tx, ty];
        }
      }
    }
    return [x, y];
  };
  const mk = (type: BuildingSpec['type'], level: number, addon: Addon, x: number, y: number, blue: boolean): Site => {
    const [sx, sy] = near(x, y, blue);
    return { type, level, addon, x: sx, y: sy, blue };
  };
  const sites: Site[] = [
    // the port sits on the coast itself (the pier reaches into the sea), on the red side
    { type: 'port', level: 3, addon: 'guns', x: px, y: py, blue: false },
    mk('fort', 3, 'flak', px - 16, py - 27, false),
    mk('city', 3, 'flak', px - 24, py + 26, false),
    mk('sam', 1, null, px - 27, py + 9, false),
    mk('fort', 5, 'flak', px - 52, py - 27, true),
    mk('city', 1, null, px - 50, py + 26, true),
    mk('sam', 3, 'radar', px - 46, py + 1, true),
    mk('city', 5, null, px - 84, py + 6, true),
  ];
  const troops: Troop[] = [];
  const pills: Pill[] = [];
  const addTank = (site: number, key: SpriteKey, u: number, v: number, angle: number): void => {
    troops.push({ key, site, u, v, angle, blue: sites[site].blue });
  };
  // beside the red level 3 fort and the blue level 5 fort: columns of tanks and an army count pill; a tank by each
  // other building; a destroyer and a trade ship at sea off the port
  addTank(1, 'tankDivision', -14, 27, 0);
  addTank(1, 'tankDivision', 1, 27, 0);
  addTank(1, 'heavyTank', 17, 27, 0);
  pills.push({ site: 1, u: 2, v: 38, troops: 12400, kinds: ['armor', 'artillery'], blue: false });
  addTank(4, 'tankDivision', -8, 29, 0.3);
  addTank(4, 'lightTank', 9, 30, 0.3);
  pills.push({ site: 4, u: 0, v: 40, troops: 50000, kinds: [], blue: true });
  addTank(2, 'lightTank', 38, 8, 0.4);
  addTank(3, 'heavyTank', 30, 14, 0);
  addTank(5, 'tankDivision', 28, 6, 0.2);
  addTank(6, 'lightTank', -36, 10, 3.2);
  troops.push({ key: 'destroyer', site: 0, u: 34, v: -34, angle: 0.05, blue: false }, { key: 'tradeShip', site: 0, u: 36, v: 34, angle: -0.1, blue: false });
  return {
    cx: px - 8,
    cy: py,
    tiles,
    rgb,
    x0,
    y0,
    w: WN,
    h: HN,
    borderX,
    sites,
    troops,
    pills,
    water: (x, y) => !landAt(x, y),
    owner,
  };
}

/** Draws a preview of the crop at a zoom (CSS px per tile) with buildings and units at the units' own scale for that zoom. */
function drawMapPreview(cv: HTMLCanvasElement, crop: Crop, zoom: number, dpr: number, shiftX: number, far = false): void {
  const cw = MAP_W;
  const ch = cv.height / dpr;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the view is centred on (cx + shiftX, cy) in map tiles
  const vx0 = crop.cx + shiftX - cw / 2 / zoom;
  const vy0 = crop.cy - ch / 2 / zoom;
  const toX = (tx: number): number => (tx - vx0) * zoom;
  const toY = (ty: number): number => (ty - vy0) * zoom;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.tiles, vx0 - crop.x0, vy0 - crop.y0, cw / zoom, ch / zoom, 0, 0, cw, ch);
  // the border between the two nations: a dark line with a pale one on top, where the owner changes
  ctx.lineCap = 'round';
  const pts: [number, number][] = [];
  for (let ty = Math.floor(vy0); ty <= Math.ceil(vy0 + ch / zoom); ty++) {
    const bx2 = crop.borderX(ty);
    if (crop.owner(Math.floor(bx2) - 1, ty) && crop.owner(Math.floor(bx2) + 2, ty)) pts.push([toX(bx2), toY(ty + 0.5)]);
    else if (pts.length) pts.push([-9999, -9999]);
  }
  for (const [lw, col] of [[Math.max(2, zoom * 0.32), 'rgba(12,16,22,0.65)'], [Math.max(1, zoom * 0.14), 'rgba(236,238,232,0.85)']] as [number, string][]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    let pen = false;
    for (const [x, y] of pts) {
      if (x < -9000) {
        pen = false;
        continue;
      }
      if (!pen) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
  const scale = unitScale(zoom);
  const grid = gridOf(scale, dpr);
  const tileAt = (tx: number, ty: number): number => {
    const ix = Math.max(0, Math.min(crop.w - 1, Math.floor(tx - crop.x0)));
    const iy = Math.max(0, Math.min(crop.h - 1, Math.floor(ty - crop.y0)));
    return (iy * crop.w + ix) * 4;
  };
  const sorted = crop.sites.slice().sort((a, b) => a.y - b.y);
  const levels: [number, number, number, RGB][] = [];
  const anchors = new Map<Site, [number, number]>();
  for (const s of sorted) {
    const owner = s.blue ? BLUE : RED;
    // the model origin stands on the site's tile centre (a port's coast line on the coast between its two tiles)
    const ax = s.type === 'port' ? toX(s.x + 1) - COAST * scale : toX(s.x + 0.5);
    const ay = toY(s.y + 0.5);
    anchors.set(s, [ax, ay]);
    const cellX = ax - OU * scale;
    const cellY = ay - OV * scale;
    if (cellX < -CU * scale || cellY < -CV * scale || cellX > cw || cellY > ch) continue;
    // a cell pixel's tile: the cell pixel's distance from the model origin, in screen px, over the zoom
    const tileOf = (px: number, py: number): [number, number] => [
      (s.type === 'port' ? s.x + 1 : s.x + 0.5) + ((px - OU * grid.res) / grid.res - (s.type === 'port' ? COAST : 0)) * (scale / zoom),
      s.y + 0.5 + ((py - OV * grid.res) / grid.res) * (scale / zoom),
    ];
    const under: Under = {
      rgb: (px, py): RGB => {
        const [tx, ty] = tileOf(px, py);
        const o = tileAt(tx, ty);
        return [crop.rgb[o], crop.rgb[o + 1], crop.rgb[o + 2]];
      },
      water: (px, py): boolean => {
        const [tx, ty] = tileOf(px, py);
        return crop.water(Math.floor(tx), Math.floor(ty));
      },
    };
    const bs: BuildingSpec = { type: s.type, level: s.level, addon: s.addon };
    const spr = far ? bakeBuildingFar(bs, owner, scale, dpr, under) : bakeBuilding(bs, owner, scale, dpr, under);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spr.canvas, Math.round(cellX * dpr) / dpr, Math.round(cellY * dpr) / dpr, spr.w, spr.h);
    if (scale >= 2) levels.push([cellX + spr.cx, cellY + spr.top - 15, s.level, owner]);
  }
  // the game's own unit art beside the buildings, at the same zoom, with the map outline the units wear
  const motion = motionParams('subtle', true);
  const at = (site: number, u: number, v: number): [number, number] => {
    const a = anchors.get(crop.sites[site]) ?? [toX(crop.sites[site].x + 0.5), toY(crop.sites[site].y + 0.5)];
    return [a[0] + u * scale, a[1] + v * scale * FORE];
  };
  const placed = crop.troops.map((t) => ({ t, p: at(t.site, t.u, t.v) })).sort((a, b) => a.p[1] - b.p[1]);
  for (const { t, p } of placed) {
    const u: UnitDraw = { key: t.key, mods: 0, owner: t.blue ? BLUE : RED, x: p[0], y: p[1], angle: t.angle, zoom, scale, lod: 'near', dpr, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 1, alpha: 1, shadow: false, outline: true, damage: 0 };
    detailedUnits.drawUnit(ctx, u, motion);
  }
  ctx.imageSmoothingEnabled = false;
  for (const q of crop.pills) {
    const p = at(q.site, q.u, q.v);
    troopPill(ctx, p[0], p[1], q.troops, q.kinds, q.blue ? BLUE : RED, { edge: '#ffe98a', arrow: 'up', small: true });
  }
  for (const [x, y, lv, o] of levels) levelPill(ctx, x, y, lv, o);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Mounts the Buildings mockup section in the lab page and draws it. */
export function mountBuildingsMock(root: HTMLElement): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'al-row al-bm';
  sec.id = 'al-buildings';
  sec.setAttribute('aria-labelledby', 'al-row-buildings');
  sec.style.display = 'block';
  const head = document.createElement('div');
  head.className = 'al-row-head';
  const t = document.createElement('h2');
  t.id = 'al-row-buildings';
  t.textContent = 'Buildings mockup';
  const note = document.createElement('p');
  note.textContent = 'Map buildings drawn like the troops: the same shaded pixels, four tones per material, lit from the top left, a dark edge and an outline in the nation\'s colour. They stand on the land with a shadow, dirt and paths made from the land\'s own colour, and at close zoom the level is a small dark chip like the army count (at normal zoom the size and look of the building show it). Each building is shown for a blue and a red nation, at close and normal zoom, next to today\'s icon.';
  const note2 = document.createElement('p');
  note2.textContent = 'Flak, tank traps, the radar dish and coastal guns are not in the game yet: they are drawn as add-ons only. The build menu, the pin menu and the tabs keep today\'s icons, and far zoom keeps the flat icons. This is a mockup: the real map still draws today\'s icons.';
  head.append(t, note, note2);
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Buildings mockup: fort, city, SAM site and port at every level, two nations, two zooms, next to today\'s icons');
  cv.style.cssText = `display:block;margin-top:12px;border-radius:8px;max-width:100%;width:${SHEET_W}px`;
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  cv.width = SHEET_W * dpr;
  cv.height = SHEET_H * dpr;
  sec.append(head, cv);
  const mh = document.createElement('div');
  mh.className = 'al-row-head';
  const mt = document.createElement('h3');
  mt.textContent = 'On the real map';
  const mn = document.createElement('p');
  mn.textContent = `Normal zoom shows the far look: simplified shapes with no inner clutter, a thinner softer owner outline, colours pulled toward the land, a wide soft shadow and a ground patch that fades into the terrain. Close zoom keeps the full detail. The same buildings over a crop of the game's ${MAP_ID} map (its own loader and terrain colours), with the border of two nations, at the same size as the game's units for each zoom (zoom ${ZOOM_NORMAL} and zoom ${ZOOM_CLOSE}). Next to them are the game's real tanks, ships and army count pills, so the two can be compared side by side.`;
  mh.append(mt, mn);
  sec.append(mh);
  const previews: [string, number, number, number, boolean][] = [
    [`Normal zoom (zoom ${ZOOM_NORMAL})`, ZOOM_NORMAL, 300, 0, true],
    [`Close zoom (zoom ${ZOOM_CLOSE})`, ZOOM_CLOSE, 720, -16, false],
  ];
  const mcs: { cv: HTMLCanvasElement; zoom: number; shift: number; far: boolean }[] = [];
  for (const [name, zoom, hh, shift, far] of previews) {
    const sub = document.createElement('p');
    sub.textContent = name;
    sub.style.cssText = 'margin:12px 0 4px;font-weight:600';
    const mc = document.createElement('canvas');
    mc.setAttribute('role', 'img');
    mc.setAttribute('aria-label', `Buildings on a real map crop, ${name}`);
    mc.style.cssText = `display:block;border-radius:8px;max-width:100%;width:${MAP_W}px`;
    mc.width = MAP_W * dpr;
    mc.height = hh * dpr;
    mc.getContext('2d')?.fillRect(0, 0, 1, 1);
    sec.append(sub, mc);
    mcs.push({ cv: mc, zoom, shift, far });
  }
  root.append(sec);
  void buildCrop().then(
    (crop) => {
      const go = (): void => {
        for (const m of mcs) drawMapPreview(m.cv, crop, m.zoom, dpr, m.shift, m.far);
      };
      go();
      void document.fonts?.ready.then(go);
    },
    (e: unknown) => {
      for (const m of mcs) {
        const c2 = m.cv.getContext('2d');
        if (c2) {
          c2.fillStyle = '#222';
          c2.fillRect(0, 0, m.cv.width, m.cv.height);
          c2.fillStyle = '#ddd';
          c2.font = '16px sans-serif';
          c2.fillText(`The map could not be loaded: ${String(e)}`, 16, 32);
        }
      }
    },
  );
  const ctx = cv.getContext('2d');
  const go = (): void => {
    if (ctx) drawSheet(ctx, dpr);
  };
  go();
  // the fonts may arrive after the first draw: draw again once they have
  void document.fonts?.ready.then(go);
  return sec;
}
