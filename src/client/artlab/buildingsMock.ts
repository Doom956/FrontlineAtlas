// The art lab's "Buildings mockup" (art lab builds only): map buildings drawn in the troops' shaded pixel style (a 4-tone
// ramp per material, lit from the top left, a darker right side, a dark 1 px outline, a soft drop shadow), one
// silhouette per type, the owner's colour on roofs, flags and bands, level pips under each. It is a MOCKUP: the game's
// map still draws buildings with render/buildings.ts. Flak, tank traps, the radar dish and coastal guns are not game
// features yet; they are visual add-ons here. Everything is drawn in code (no image files) into small pixel buffers
// and shown at two zooms, next to today's marker icon. No module-level side effects.
import { drawMarker, ICON_INFO, type BuildingIconId } from '../icons';
import { CATEGORY_PLATES } from '../render/buildings';
import type { RGB } from '../art/shared/colour';
import { ownerTones, rampOf, type MaterialId } from '../art/detailed/palette';
import { backdrop } from './backdrop';
import { label } from './scenes';

const W = 46;
const H = 48;
const SCALE_CLOSE = 3;
const SCALE_NORMAL = 2;

type Ramp = readonly RGB[];

// ------------------------------------------------------------------------------------------------- pixel buffer

class Pix {
  readonly d = new Uint8ClampedArray(W * H * 4);
  px(x: number, y: number, c: readonly number[], a = 255): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    this.d[o] = c[0];
    this.d[o + 1] = c[1];
    this.d[o + 2] = c[2];
    this.d[o + 3] = a;
  }
  rect(x: number, y: number, w: number, h: number, c: readonly number[], a = 255): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c, a);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: readonly number[]): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
  }
  /** A solid ball of radius r lit from the top left (ramp tones 3, 2, 1). */
  disc(cx: number, cy: number, r: number, ramp: Ramp, ry = r): void {
    for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) {
      for (let x = -Math.ceil(r); x <= Math.ceil(r); x++) {
        const q = (x * x) / (r * r) + (y * y) / (ry * ry);
        if (q > 1.05) continue;
        const k = (x / r + y / ry) / 2;
        this.px(cx + x, cy + y, ramp[k < -0.3 ? 3 : k < 0.25 ? 2 : 1]);
      }
    }
  }
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    return this.d[(y * W + x) * 4 + 3];
  }
}

interface BoxOpt {
  top?: Ramp;
  side?: Ramp;
  /** side depth in px (up and to the right) */
  d?: number;
}

/** A block seen from the front and a little above, lit from the top left: front face (tone 2, lit left edge), top face
 * (tone 3) going up and right, right side (tone 1). (x, yb) is the front face's bottom left. */
function box(p: Pix, x: number, yb: number, w: number, h: number, f: Ramp, o: BoxOpt = {}): void {
  const d = o.d ?? 4;
  const t = o.top ?? f;
  const s = o.side ?? f;
  const yt = yb - h + 1;
  for (let k = 1; k <= d; k++) p.rect(x + w + k - 1, yt - k, 1, h, s[k === d ? 0 : 1]);
  for (let i = 1; i <= d; i++) p.rect(x + i, yt - i, w, 1, i === d ? t[2] : t[3]);
  p.rect(x, yt, w, h, f[2]);
  p.rect(x, yt, 1, h, f[3]);
  p.rect(x, yt, w, 1, f[3]);
  p.rect(x, yb, w, 1, f[1]);
  p.rect(x + w - 1, yt, 1, h, f[1]);
}

function flag(p: Pix, x: number, yTop: number, h: number, own: Ramp, pole: Ramp): void {
  p.rect(x, yTop, 1, h, pole[2]);
  p.rect(x + 1, yTop, 6, 1, own[3]);
  p.rect(x + 1, yTop + 1, 6, 2, own[2]);
  p.rect(x + 1, yTop + 3, 5, 1, own[1]);
  p.px(x + 6, yTop + 3, own[1], 0);
}

function windows(p: Pix, x: number, y: number, cols: number, rows: number, gx: number, gy: number, glass: Ramp): void {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const lit = (i * 5 + j * 3) % 4 !== 0;
      const wx = x + i * gx;
      const wy = y + j * gy;
      p.rect(wx, wy, 2, 2, lit ? [233, 212, 138] : glass[1]);
      if (lit) p.px(wx, wy, [250, 238, 190]);
    }
  }
}

const ramp = (m: MaterialId): Ramp => rampOf(m);

// ------------------------------------------------------------------------------------------------- add-ons

/** An anti-aircraft gun: a squat mount, a turret and two barrels raised up and to the right. */
function flakGun(p: Pix, cx: number, cy: number): void {
  const g = ramp('gun');
  p.rect(cx - 3, cy - 1, 7, 2, g[1]);
  p.rect(cx - 3, cy - 1, 7, 1, g[2]);
  const a = ramp('alu');
  p.line(cx - 1, cy - 3, cx + 4, cy - 11, a[1]);
  p.line(cx + 1, cy - 3, cx + 6, cy - 10, a[0]);
  p.line(cx - 2, cy - 3, cx + 3, cy - 11, a[2]);
  p.px(cx + 4, cy - 12, [255, 201, 92]);
  p.disc(cx, cy - 2, 2.6, a, 2.2);
}

/** A sandbag ring with a flak gun in it (an anti-aircraft pit). */
function flakPit(p: Pix, cx: number, cy: number): void {
  const t = ramp('tan');
  const g = ramp('gun');
  for (let y = -3; y <= 3; y++) {
    for (let x = -7; x <= 7; x++) {
      const q = (x * x) / 49 + (y * y) / 9;
      if (q > 1.1) continue;
      if (q < 0.55) p.px(cx + x, cy + y, g[0]);
      else p.px(cx + x, cy + y, (x + y) % 3 === 0 ? t[1] : y < 0 || x < -3 ? t[3] : t[2]);
    }
  }
  flakGun(p, cx, cy);
}

/** A czech hedgehog: three crossed steel bars. */
function hedgehog(p: Pix, cx: number, cy: number): void {
  const g = ramp('hull');
  p.rect(cx - 3, cy + 3, 8, 1, [0, 0, 0], 70);
  p.line(cx + 3, cy - 3, cx - 3, cy + 3, g[0]);
  p.line(cx - 3, cy - 3, cx + 3, cy + 3, g[1]);
  p.rect(cx - 3, cy, 7, 1, g[3]);
  p.px(cx - 3, cy - 3, g[3]);
  p.px(cx + 3, cy - 3, g[2]);
}

/** A radar dish on a mast: a tilted bowl with a feed horn, the owner's colour on the mast cab. */
function radar(p: Pix, cx: number, cy: number, own: Ramp): void {
  const g = ramp('gun');
  const a = ramp('alu');
  box(p, cx - 3, cy + 11, 6, 3, g, { d: 2 });
  p.rect(cx - 1, cy + 1, 3, 10, g[1]);
  p.rect(cx - 1, cy + 1, 1, 10, g[2]);
  box(p, cx - 4, cy + 3, 9, 3, own, { d: 2 });
  p.disc(cx, cy - 3, 6, a, 4.5);
  p.disc(cx + 1, cy - 2, 4, [a[0], a[0], a[1], a[1]], 3);
  p.line(cx + 1, cy - 2, cx - 5, cy - 8, g[2]);
  p.px(cx - 5, cy - 9, g[3]);
  // the sweep: two broken arcs of signal in front of the dish
  for (const [r, c] of [[9, own[3]], [13, own[2]]] as [number, RGB][]) {
    for (let k = -2; k <= 2; k++) {
      if (k === 0 && r === 13) continue;
      const a2 = -2.35 + k * 0.3;
      p.px(cx + Math.cos(a2) * r - 1, cy - 3 + Math.sin(a2) * r, c);
    }
  }
}

/** A coastal gun emplacement: a round concrete base, a turret and one long barrel out over the sea. */
function coastalGun(p: Pix, cx: number, cy: number, own: Ramp): void {
  const c = ramp('sup');
  const g = ramp('gun');
  p.disc(cx, cy, 6, c, 3.6);
  p.disc(cx - 1, cy - 2, 4, ramp('alu'), 3);
  p.rect(cx - 2, cy - 2, 3, 1, own[2]);
  p.line(cx + 2, cy - 2, cx + 12, cy + 1, g[2]);
  p.line(cx + 2, cy - 3, cx + 12, cy, g[3]);
  p.rect(cx + 11, cy, 3, 2, g[0]);
}

// ------------------------------------------------------------------------------------------------- buildings

type Addon = 'flak' | 'traps' | 'radar' | 'guns' | null;

function fort(p: Pix, own: Ramp, lv: number, addon: Addon): void {
  const S = ramp('hull');
  const g = ramp('gun');
  const merlons = (x0: number, x1: number, yt: number): void => {
    for (let x = x0; x < x1; x += 4) {
      p.rect(x, yt - 2, 2, 2, S[2]);
      p.px(x, yt - 2, S[3]);
    }
  };
  const cap = (x: number, yb: number, w: number): void => box(p, x, yb, w, 2, own, { d: 4 });
  if (lv === 1) {
    box(p, 8, 36, 24, 10, S);
    merlons(8, 32, 27);
    p.rect(18, 31, 4, 6, g[0]);
    p.rect(8, 29, 24, 2, own[2]);
    p.rect(8, 29, 24, 1, own[3]);
    flag(p, 10, 15, 12, own, g);
  } else if (lv === 3) {
    box(p, 13, 29, 14, 15, S);
    cap(12, 15, 16);
    box(p, 4, 36, 32, 9, S);
    merlons(4, 36, 28);
    box(p, 1, 37, 8, 15, S);
    cap(0, 23, 10);
    box(p, 31, 37, 8, 15, S);
    cap(30, 23, 10);
    p.rect(18, 31, 4, 6, g[0]);
    p.rect(9, 30, 22, 2, own[2]);
    p.rect(9, 30, 22, 1, own[3]);
    for (const x of [4, 34]) p.rect(x, 28, 1, 3, g[0]);
    p.rect(19, 19, 2, 3, g[0]);
    flag(p, 20, 2, 11, own, g);
  } else {
    box(p, 13, 28, 14, 19, S);
    cap(12, 10, 16);
    box(p, 6, 31, 8, 14, S);
    cap(5, 18, 10);
    box(p, 26, 31, 8, 14, S);
    cap(25, 18, 10);
    box(p, 2, 36, 36, 8, S);
    merlons(2, 38, 29);
    box(p, 0, 37, 9, 18, S);
    cap(-1, 20, 11);
    box(p, 31, 37, 9, 18, S);
    cap(30, 20, 11);
    p.rect(17, 31, 6, 6, g[0]);
    for (let x = 18; x < 23; x += 2) p.rect(x, 31, 1, 6, g[2]);
    p.rect(8, 30, 24, 3, own[2]);
    p.rect(8, 30, 24, 1, own[3]);
    p.rect(8, 32, 24, 1, own[1]);
    for (const x of [3, 35]) p.rect(x, 25, 1, 3, g[0]);
    p.rect(19, 17, 2, 4, g[0]);
    flag(p, 20, 0, 9, own, g);
    flag(p, 3, 8, 8, own, g);
    flag(p, 34, 8, 8, own, g);
  }
  if (addon === 'flak') {
    flakPit(p, 8, 40);
    flakPit(p, 38, 40);
  } else if (addon === 'traps') {
    for (const x of [8, 18, 28, 38]) hedgehog(p, x, 40);
  }
}

function tower(p: Pix, x: number, yb: number, w: number, h: number, wall: Ramp, own: Ramp, cols: number, rows: number, antenna = false): void {
  box(p, x, yb, w, h, wall, { d: 3 });
  const yt = yb - h + 1;
  box(p, x - 1, yt, w + 2, 2, own, { d: 4 });
  windows(p, x + 2, yt + 4, cols, rows, 3, 3, ramp('glass'));
  if (antenna) {
    p.rect(x + w / 2 + 2, yt - 10, 1, 9, ramp('gun')[2]);
    p.px(x + w / 2 + 2, yt - 11, [255, 80, 60]);
  }
}

function city(p: Pix, own: Ramp, lv: number, addon: Addon): void {
  const cream = ramp('cream');
  const brick = ramp('brick');
  const conc = ramp('sup');
  const g = ramp('gun');
  if (lv === 1) {
    tower(p, 5, 33, 12, 11, cream, own, 3, 2);
    tower(p, 20, 33, 11, 15, brick, own, 3, 3);
    tower(p, 13, 39, 11, 7, conc, own, 3, 1);
    p.rect(17, 36, 3, 3, g[0]);
  } else if (lv === 3) {
    tower(p, 3, 33, 9, 20, conc, own, 2, 5);
    tower(p, 15, 33, 11, 26, cream, own, 3, 6);
    tower(p, 29, 33, 8, 17, brick, own, 2, 4);
    tower(p, 5, 40, 12, 12, brick, own, 3, 2);
    tower(p, 21, 40, 13, 9, cream, own, 4, 1);
    p.rect(10, 37, 3, 3, g[0]);
  } else {
    tower(p, 2, 32, 8, 20, brick, own, 2, 5);
    tower(p, 12, 32, 12, 33, cream, own, 3, 9, true);
    tower(p, 27, 32, 9, 24, conc, own, 2, 6);
    tower(p, 4, 38, 10, 14, cream, own, 2, 3);
    tower(p, 17, 41, 13, 10, brick, own, 4, 2);
    tower(p, 33, 38, 8, 11, conc, own, 2, 2);
  }
  if (addon === 'flak') {
    // flak on the tallest roof (the roof slab of the middle block) and a sandbag pit on the ground
    flakGun(p, lv === 3 ? 22 : 28, lv === 3 ? 6 : 12);
    flakPit(p, 38, 42);
  }
}

function sam(p: Pix, own: Ramp, lv: number, addon: Addon): void {
  const conc = ramp('sup');
  const ol = ramp('olive');
  const w = ramp('white');
  const g = ramp('gun');
  box(p, 3, 40, lv === 1 ? 30 : 38, 5, ramp('hullDark'), { d: 5, top: ramp('hull') });
  const launcher = (x: number, tilt: number): void => {
    p.rect(x - 2, 35, 9, 3, g[1]);
    p.rect(x - 2, 35, 9, 1, g[2]);
    p.line(x + 1, 35, x + 1 + tilt, 22, g[1]);
    for (const dx of [0, 5]) {
      const x0 = x + dx;
      const x1 = x0 + tilt;
      for (let i = 0; i <= 13; i++) {
        const t = i / 13;
        const mx = x0 + (x1 - x0) * t;
        const my = 34 - 14 * t;
        const nose = i >= 10;
        const stripe = i === 6 || i === 7;
        p.px(mx - 1, my, nose || stripe ? own[3] : w[3]);
        p.px(mx, my, nose || stripe ? own[2] : w[2]);
        p.px(mx + 1, my, nose || stripe ? own[1] : w[1]);
      }
      p.px(x1, 18, g[2]);
      p.px(x0 - 1, 33, g[2]);
      p.px(x0 + 1, 33, g[2]);
    }
  };
  if (lv === 1) {
    launcher(7, 5);
    box(p, 24, 38, 10, 7, ol, { d: 3 });
    p.rect(24, 34, 10, 2, own[2]);
    p.rect(24, 34, 10, 1, own[3]);
  } else {
    launcher(4, 4);
    launcher(16, 4);
    launcher(28, 4);
    box(p, 34, 38, 8, 6, ol, { d: 3 });
    p.rect(34, 34, 8, 2, own[2]);
    p.rect(34, 34, 8, 1, own[3]);
  }
  if (addon === 'radar') radar(p, 34, 18, own);
}

function port(p: Pix, own: Ramp, lv: number, addon: Addon): void {
  const sea = ramp('sea');
  const teak = ramp('teak');
  const g = ramp('gun');
  const conc = ramp('sup');
  // the sea off the quay: a flat patch with wave marks, a light foam line at the quay edge
  p.rect(0, 32, 46, 12, sea[2]);
  for (let y = 33; y < 44; y++) for (let x = 0; x < 46; x++) if ((x * 3 + y * 5) % 11 === 0) p.px(x, y, sea[3]);
  p.rect(0, 32, 46, 1, [190, 205, 212]);
  p.rect(0, 33, 46, 1, sea[3]);
  // the quay: concrete apron along the top
  box(p, 0, 31, 46, 10, conc, { d: 0 });
  // the pier: planks running out over the water
  const pw = lv === 1 ? 7 : 10;
  box(p, 21, 43, pw, 12, teak, { d: 3, top: teak, side: ramp('hullDark') });
  for (let y = 33; y < 44; y += 3) p.rect(21, y, pw, 1, teak[1]);
  // a crane on the quay: legs, a boom out over the water, the owner's colour on its cab
  const crane = (x: number): void => {
    p.rect(x, 12, 1, 14, g[2]);
    p.rect(x + 7, 12, 1, 14, g[1]);
    p.line(x, 12, x + 7, 24, g[1]);
    p.rect(x - 1, 8, 20, 2, g[2]);
    p.rect(x - 1, 8, 20, 1, g[3]);
    box(p, x - 1, 13, 7, 4, own, { d: 2 });
    p.rect(x + 16, 10, 1, 8, g[1]);
    p.rect(x + 15, 18, 3, 2, ramp('rust')[2]);
  };
  // the warehouse on the quay with an owner roof
  box(p, 2, 25, 13, 8, ramp('cream'), { d: 3 });
  box(p, 1, 17, 15, 2, own, { d: 4 });
  p.rect(6, 21, 4, 4, g[0]);
  // containers
  const cont = (x: number, y: number, m: MaterialId): void => box(p, x, y, 6, 3, ramp(m), { d: 2 });
  if (lv === 1) {
    crane(26);
    cont(33, 25, 'rust');
    cont(39, 25, 'fadedBlue');
  } else {
    crane(14);
    crane(29);
    cont(2, 24, 'rust');
    cont(9, 24, 'ochre');
    cont(36, 23, 'fadedBlue');
    cont(36, 27, 'rust');
    cont(3, 27, 'fadedBlue');
  }
  if (addon === 'guns') {
    coastalGun(p, 7, 30, own);
    coastalGun(p, 36, 30, own);
  }
}

const BUILDERS: Record<string, (p: Pix, own: Ramp, lv: number, addon: Addon) => void> = { fort, city, sam, port };

// ------------------------------------------------------------------------------------------------- bake

/** A tiny anchor badge for the port, where the shape alone (quay, crane, water) might not say "port". */
function anchorBadge(p: Pix, x: number, y: number, own: Ramp): void {
  p.disc(x + 3, y + 3, 4, [own[0], own[0], own[1], own[1]]);
  const wh = [236, 240, 244];
  p.rect(x + 3, y + 1, 1, 5, wh);
  p.rect(x + 2, y + 2, 3, 1, wh);
  p.px(x + 1, y + 5, wh);
  p.px(x + 5, y + 5, wh);
  p.rect(x + 2, y + 6, 3, 1, wh);
}

export interface BuildingSpec {
  type: 'fort' | 'city' | 'sam' | 'port';
  level: number;
  addon: Addon;
}

const cache = new Map<string, HTMLCanvasElement>();

/** The sprite of a building for an owner colour: shadow, the building, a dark outline, level pips, a badge if needed. */
export function bakeBuilding(spec: BuildingSpec, owner: RGB): HTMLCanvasElement {
  const key = `${spec.type}|${spec.level}|${spec.addon}|${owner.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const own = ownerTones(owner);
  const p = new Pix();
  // the drop shadow: a soft dark ground patch falling down and to the right of the building
  const sh = (cx: number, cy: number, rx: number, ry: number): void => {
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) p.px(cx + x, cy + y, [4, 8, 12], 92);
  };
  if (spec.type === 'fort') sh(24, 39, 20, 2);
  else if (spec.type === 'city') sh(24, 42, 21, 2);
  else if (spec.type === 'sam') sh(26, 44, 20, 2);
  BUILDERS[spec.type](p, own, spec.level, spec.addon);
  // outline: a dark pixel round the silhouette (and over the shadow)
  const solid = (x: number, y: number): boolean => p.at(x, y) >= 200;
  const edge: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) edge.push(x, y);
  for (let i = 0; i < edge.length; i += 2) p.px(edge[i], edge[i + 1], [8, 11, 17], 220);
  if (spec.type === 'port') anchorBadge(p, 1, 38, own);
  // level pips: one per level, pale gold on a dark plate, centred under the building
  const n = spec.level;
  const pw = n * 3 + 1;
  const x0 = Math.round(W / 2 - pw / 2);
  p.rect(x0 - 1, H - 4, pw + 2, 4, [8, 11, 17], 200);
  for (let i = 0; i < n; i++) {
    p.rect(x0 + 1 + i * 3 - 1, H - 3, 2, 2, [246, 226, 150]);
    p.px(x0 + i * 3, H - 3, [255, 247, 214]);
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const cx = c.getContext('2d');
  if (cx) {
    const img = cx.createImageData(W, H);
    img.data.set(p.d);
    cx.putImageData(img, 0, 0);
  }
  cache.set(key, c);
  return c;
}

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
  { head: 'Close zoom', sub: 'Blue nation', w: W * SCALE_CLOSE + PAD * 2 },
  { head: 'Close zoom', sub: 'Red nation', w: W * SCALE_CLOSE + PAD * 2 },
  { head: 'Normal zoom', sub: 'Blue nation', w: W * SCALE_NORMAL + PAD * 2 },
  { head: 'Normal zoom', sub: 'Red nation', w: W * SCALE_NORMAL + PAD * 2 },
  { head: "Today's icon", sub: 'Blue nation', w: 84 },
  { head: "Today's icon", sub: 'Red nation', w: 84 },
];
const ROW_H = H * SCALE_CLOSE + 10;
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
    const bx = x + r * 0.78;
    const by = y - r * 0.78;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f5f1';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(14,18,24,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#1a1f27';
    ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(level), bx, by + 0.5);
  }
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
  // column heads
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
        const spr = bakeBuilding(row.spec, owners[i]);
        const s = scales[i];
        ctx.drawImage(spr, Math.round(xs[i] + (COLS[i].w - W * s) / 2), Math.round(cy - (H * s) / 2), W * s, H * s);
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
  const drawFlat = (k: number, cx: number, cy: number): void => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    const s = 4;
    ctx.beginPath();
    ctx.rect(-s / 2, -s / 2, s, s);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(245,245,240,0.9)';
    ctx.stroke();
    ctx.fillStyle = '#2a2e36';
    ctx.fill();
    ctx.restore();
  };
  drawFlat(1, xs[2] + COLS[2].w / 2, y + 56);
  label(ctx, 'Real size', xs[2] + COLS[2].w / 2, y + 90, 'center', true);
  drawFlat(14, xs[0] + COLS[0].w / 2, y + 56);
  label(ctx, 'Enlarged 14 times', xs[0] + COLS[0].w / 2, y + 100, 'center', true);
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
  note.textContent = 'Map buildings in the troops\' shaded pixel style: slightly 3D, lit from the top left, with a drop shadow, the nation\'s colour on roofs, flags and bands, and one gold pip per level. Each building is shown for a blue and a red nation, at close and normal zoom, next to today\'s icon.';
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
  root.append(sec);
  const ctx = cv.getContext('2d');
  const go = (): void => {
    if (ctx) drawSheet(ctx, dpr);
  };
  go();
  // the fonts may arrive after the first draw: draw again once they have
  void document.fonts?.ready.then(go);
  return sec;
}
