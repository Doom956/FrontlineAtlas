// Pictogram library: every icon is a plain picture of the thing itself, drawn from vector path data with the
// Canvas 2D API (no image files, no fonts). Icons are rendered on demand and cached in one sprite atlas per
// (device pixel size, tint, halo) combination.
//
// Icon space is 64 x 64 units. Each icon is a list of layers (SVG path strings). Drawing order:
//   1. optional halo (white by default) around every layer, for map visibility
//   2. dark outline: every layer stroked thick, so only the silhouette's edge shows
//   3. layers filled / stroked in order; `clip` layers are clipped to the last non-clip layer (flat light / shadow
//      tones and markings), and `edge` layers get a thin dark line once their clipped shading is drawn
// Layers marked `detail` are skipped below DETAIL_MIN_PX device pixels so 16 px icons stay clean.
// Style: restrained materials with two or three flat tones (light from the upper left), a thin dark outline,
// buildings in front elevation with the right side in shadow, troops in side view.
// Units are drawn pointing right (top view) so the renderer can rotate them.

export type BuildingIconId =
  | 'city'
  | 'farm'
  | 'market'
  | 'mine'
  | 'oilWell'
  | 'barracks'
  | 'factory'
  | 'arsenal'
  | 'fort'
  | 'supplyDepot'
  | 'watchtower'
  | 'port'
  | 'lab'
  | 'hospital'
  | 'airfield'
  | 'sam'
  | 'silo';
export type ResourceIconId = 'iron' | 'oil' | 'fertile';
export type TerrainIconId = 'plains' | 'forest' | 'hills' | 'mountains' | 'desert' | 'swamp' | 'tundra';
export type UnitIconId = 'transport' | 'warship' | 'tradeShip' | 'bomber' | 'fighter' | 'rocket' | 'atomBomb' | 'transportPlane';
export type StatusIconId = 'crown' | 'handshake' | 'envelope' | 'brokenShield' | 'target' | 'skull';
export type TroopIconId = 'infantry' | 'armor' | 'artillery';
export type IconId = BuildingIconId | ResourceIconId | TerrainIconId | UnitIconId | StatusIconId | TroopIconId;

export type IconGroup = 'building' | 'resource' | 'terrain' | 'unit' | 'status' | 'troop';
export type BuildingCategory = 'economy' | 'production' | 'defence' | 'logistics' | 'advanced';

export interface IconInfo {
  label: string;
  group: IconGroup;
  category?: BuildingCategory;
  /** Buildings: the category colour (CATEGORY_COLORS). */
  color?: string;
}

export const ICON_INFO: Record<IconId, IconInfo> = {
  city: { label: 'City', group: 'building', category: 'economy' },
  farm: { label: 'Farm', group: 'building', category: 'economy' },
  market: { label: 'Market', group: 'building', category: 'economy' },
  mine: { label: 'Mine', group: 'building', category: 'economy' },
  oilWell: { label: 'Oil Well', group: 'building', category: 'economy' },
  lab: { label: 'Lab', group: 'building', category: 'economy' },
  barracks: { label: 'Barracks', group: 'building', category: 'production' },
  factory: { label: 'Factory', group: 'building', category: 'production' },
  arsenal: { label: 'Arsenal', group: 'building', category: 'production' },
  fort: { label: 'Fort', group: 'building', category: 'defence' },
  watchtower: { label: 'Watchtower', group: 'building', category: 'defence' },
  sam: { label: 'SAM Site', group: 'building', category: 'defence' },
  supplyDepot: { label: 'Supply Depot', group: 'building', category: 'logistics' },
  port: { label: 'Port', group: 'building', category: 'logistics' },
  hospital: { label: 'Hospital', group: 'building', category: 'logistics' },
  airfield: { label: 'Airfield', group: 'building', category: 'advanced' },
  silo: { label: 'Missile Silo', group: 'building', category: 'advanced' },
  iron: { label: 'Iron', group: 'resource' },
  oil: { label: 'Oil', group: 'resource' },
  fertile: { label: 'Fertile Land', group: 'resource' },
  plains: { label: 'Plains', group: 'terrain' },
  forest: { label: 'Forest', group: 'terrain' },
  hills: { label: 'Hills', group: 'terrain' },
  mountains: { label: 'Mountains', group: 'terrain' },
  desert: { label: 'Desert', group: 'terrain' },
  swamp: { label: 'Swamp', group: 'terrain' },
  tundra: { label: 'Tundra', group: 'terrain' },
  transport: { label: 'Transport', group: 'unit' },
  warship: { label: 'Warship', group: 'unit' },
  tradeShip: { label: 'Trade Ship', group: 'unit' },
  bomber: { label: 'Bomber', group: 'unit' },
  fighter: { label: 'Fighter', group: 'unit' },
  rocket: { label: 'Rocket', group: 'unit' },
  atomBomb: { label: 'Atom Bomb', group: 'unit' },
  transportPlane: { label: 'Cargo Plane', group: 'unit' },
  crown: { label: 'Leader', group: 'status' },
  handshake: { label: 'Alliance', group: 'status' },
  envelope: { label: 'Alliance Request', group: 'status' },
  brokenShield: { label: 'Traitor', group: 'status' },
  target: { label: 'Target', group: 'status' },
  skull: { label: 'Eliminated', group: 'status' },
  infantry: { label: 'Infantry', group: 'troop' },
  armor: { label: 'Armor', group: 'troop' },
  artillery: { label: 'Artillery', group: 'troop' },
};

export const ICON_IDS: readonly IconId[] = Object.keys(ICON_INFO) as IconId[];

/** Accent colour per building category (build bar tabs, tooltip headers, legend). */
export const CATEGORY_COLORS: Record<BuildingCategory, string> = {
  economy: '#e0b030',
  production: '#d8672b',
  defence: '#4f86d6',
  logistics: '#3fa66a',
  advanced: '#9c5fd6',
};
for (const id of ICON_IDS) {
  const cat = ICON_INFO[id].category;
  if (cat) ICON_INFO[id].color = CATEGORY_COLORS[cat];
}

// ---------------------------------------------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------------------------------------------

export interface IconLayer {
  /** SVG path data in 64 x 64 icon units. */
  d: string;
  fill?: string;
  stroke?: string;
  /** Stroke width in icon units (stroke layers). */
  width?: number;
  /** Replace the colour with the owner tint ('base'), a darker ('dark') or lighter ('light') shade of it. */
  tint?: 'base' | 'dark' | 'light';
  /** Thin dark line drawn after the fill (separates a shape from what lies under it). */
  edge?: boolean;
  /** Fine detail: skipped at small sizes. */
  detail?: boolean;
  /** No outline / halo for this layer (inner markings). */
  noOutline?: boolean;
  /** Clip this layer to the nearest earlier layer without `clip` (shading, highlights, panels). Never outlined. */
  clip?: boolean;
  /** Layer opacity. */
  alpha?: number;
  cap?: 'round' | 'butt' | 'square';
}

const n = (v: number): string => String(Math.round(v * 100) / 100);

function poly(...p: number[]): string {
  let s = `M${n(p[0])} ${n(p[1])}`;
  for (let i = 2; i < p.length; i += 2) s += `L${n(p[i])} ${n(p[i + 1])}`;
  return s + 'Z';
}
function line(...p: number[]): string {
  let s = `M${n(p[0])} ${n(p[1])}`;
  for (let i = 2; i < p.length; i += 2) s += `L${n(p[i])} ${n(p[i + 1])}`;
  return s;
}
function rect(x: number, y: number, w: number, h: number): string {
  return poly(x, y, x + w, y, x + w, y + h, x, y + h);
}
function rrect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  return (
    `M${n(x + r)} ${n(y)}L${n(x + w - r)} ${n(y)}Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)}` +
    `L${n(x + w)} ${n(y + h - r)}Q${n(x + w)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)}` +
    `L${n(x + r)} ${n(y + h)}Q${n(x)} ${n(y + h)} ${n(x)} ${n(y + h - r)}` +
    `L${n(x)} ${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}Z`
  );
}
function ell(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${n(cx - rx)} ${n(cy)}A${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)}` +
    `A${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)}Z`
  );
}
const circ = (cx: number, cy: number, r: number): string => ell(cx, cy, r, r);
/** Lens / leaf shape from (x1,y1) to (x2,y2), bulging b units to each side. */
function leaf(x1: number, y1: number, x2: number, y2: number, b: number): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const px = (-dy / len) * b * 2;
  const py = (dx / len) * b * 2;
  return `M${n(x1)} ${n(y1)}Q${n(mx + px)} ${n(my + py)} ${n(x2)} ${n(y2)}Q${n(mx - px)} ${n(my - py)} ${n(x1)} ${n(y1)}Z`;
}
/** Rotates local points (x right, y down) by deg (counter-clockwise on screen) and moves them to (cx, cy). */
function rot(cx: number, cy: number, deg: number, pts: number[]): number[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    out.push(cx + x * c + y * s, cy - x * s + y * c);
  }
  return out;
}
const rpoly = (cx: number, cy: number, deg: number, ...pts: number[]): string => poly(...rot(cx, cy, deg, pts));
/** Ring sector between radii r1 < r2 from angle a0 to a1 (degrees, counter-clockwise on screen, 0 = right). */
function sector(cx: number, cy: number, r1: number, r2: number, a0: number, a1: number): string {
  const p = (r: number, a: number): string => {
    const t = (a * Math.PI) / 180;
    return `${n(cx + r * Math.cos(t))} ${n(cy - r * Math.sin(t))}`;
  };
  return `M${p(r1, a0)}L${p(r2, a0)}A${n(r2)} ${n(r2)} 0 0 0 ${p(r2, a1)}L${p(r1, a1)}A${n(r1)} ${n(r1)} 0 0 1 ${p(r1, a0)}Z`;
}
const join = (...d: string[]): string => d.join('');

function windowGrid(xs: number[], ys: number[], w: number, h: number): string {
  let d = '';
  for (const x of xs) for (const y of ys) d += rect(x, y, w, h);
  return d;
}

// Palette: restrained, slightly desaturated materials. Light comes from the upper left; shading is done with
// clipped overlay layers (shadeC / lightC) so every material gets the same light, base and shadow tones.
const OUT = '#25272c';
const DARK = '#24262b';
const STONE_L = '#cbc6ba';
const STONE = '#a7a196';
const STONE_D = '#7c776d';
const CONC_L = '#cfd0cb';
const CONC = '#aaada8';
const CONC_D = '#80847f';
const ROCK = '#8a7c69';
const ROCK_D = '#5f5549';
const BRICK = '#97533c';
const BARN = '#97463a';
const BARN_D = '#6e3229';
const ROOF_L = '#7d8289';
const ROOF = '#5f656d';
const STEEL_L = '#a7b0b8';
const STEEL = '#818c96';
const STEEL_D = '#5c656f';
const STEEL_DD = '#3e444b';
const WOOD_L = '#b8915f';
const WOOD = '#916c44';
const WOOD_D = '#654b31';
const OLIVE_L = '#8b9160';
const OLIVE = '#6d7348';
const OLIVE_D = '#4e5335';
const OLIVE_DD = '#3a3d28';
const KHAKI = '#b3a67c';
const GRASS_L = '#a3b46e';
const GRASS = '#7f9853';
const GRASS_D = '#5b723b';
const PINE = '#55704a';
const WATER_L = '#8eafc6';
const WATER = '#5f839f';
const SAND_L = '#e6d4a5';
const SAND = '#d0b47c';
const SNOW = '#eef1f3';
const SNOW_D = '#c6cfd8';
const GOLD = '#d0aa50';
const GOLD_D = '#9e7c33';
const RED = '#a83e33';
const RED_D = '#7a2b24';
const CREAM_L = '#f2eee4';
const CREAM = '#e2dccd';
const CREAM_D = '#c2baa6';
const GLASS = '#a7c1d1';
const GLASS_D = '#6f8ea3';
const WIN = '#38404a';
const SOIL = '#7b5d40';
const SOIL_D = '#5b432e';
const RUBBER = '#303338';
const SMOKE = '#bfc2c5';
const SKIN = '#b58c69';
const SKIN_D = '#8f6a4f';
const BONE = '#e4dfcf';
const SHADE = '#1d2027';
const LIGHT = '#ffffff';

type LayerOpts = Omit<IconLayer, 'd' | 'fill' | 'stroke' | 'width'>;
const F = (d: string, fill: string, o: LayerOpts = {}): IconLayer => ({ d, fill, ...o });
const S = (d: string, stroke: string, width: number, o: LayerOpts = {}): IconLayer => ({ d, stroke, width, ...o });
/** Fill clipped to the last non-clip layer (markings, panels). */
const C = (d: string, fill: string, o: LayerOpts = {}): IconLayer => ({ d, fill, clip: true, ...o });
/** Shadow side of the last shape. */
const shadeC = (d: string, a = 0.28, o: LayerOpts = {}): IconLayer => ({ d, fill: SHADE, clip: true, alpha: a, ...o });
/** Lit side / highlight of the last shape. */
const lightC = (d: string, a = 0.22, o: LayerOpts = {}): IconLayer => ({ d, fill: LIGHT, clip: true, alpha: a, ...o });

/** Flat-roofed block in oblique view: front face (x, y, w, h), side face d deep to the right, rising d / 2. */
function block(x: number, y: number, w: number, h: number, d: number, face: string, top: string, o: LayerOpts = {}): IconLayer[] {
  const r = d / 2;
  return [
    F(poly(x + w, y, x + w + d, y - r, x + w + d, y + h - r, x + w, y + h), face, { edge: true, ...o }),
    shadeC(rect(0, 0, 64, 64), 0.3),
    F(poly(x, y, x + d, y - r, x + w + d, y - r, x + w, y), top, { edge: true, ...o }),
    F(rect(x, y, w, h), face, { edge: true, ...o }),
  ];
}

/** City tower: front face with window bands, right third in shadow. */
function tower(x: number, top: number, w: number, face: string, edge = true): IconLayer[] {
  let win = '';
  for (let y = top + 3.5; y <= 56; y += 4.5) win += rect(x + 1.8, y, w - 3.6, 1.7);
  return [
    F(rect(x, top, w, 60 - top), face, { edge }),
    C(win, WIN, { alpha: 0.6, detail: true }),
    lightC(rect(x, top, w, 1.4), 0.25),
    shadeC(rect(x + w * 0.64, 0, w * 0.36 + 0.5, 64), 0.3),
  ];
}

/** Ploughed furrows converging towards a far vanishing point. */
function furrows(top: number, bottom: number): string {
  let d = '';
  for (let k = -3; k <= 3; k++) {
    const xt = 32 + k * 8;
    const xb = 32 + k * 11;
    d += poly(xt - 1, top, xt + 1, top, xb + 2, bottom, xb - 2, bottom);
  }
  return d;
}

function awning(): IconLayer[] {
  const parts = 6;
  let a = '';
  let b = '';
  let va = '';
  let vb = '';
  for (let i = 0; i < parts; i++) {
    const t0 = 13 + (i * 38) / parts;
    const t1 = 13 + ((i + 1) * 38) / parts;
    const b0 = 4 + (i * 56) / parts;
    const b1 = 4 + ((i + 1) * 56) / parts;
    const r = (b1 - b0) / 2;
    const face = poly(t0, 8, t1, 8, b1, 21, b0, 21);
    const val = `M${n(b0)} 21L${n(b1)} 21L${n(b1)} 23A${n(r)} ${n(r * 0.75)} 0 0 1 ${n(b0)} 23Z`;
    if (i % 2 === 0) {
      a += face;
      va += val;
    } else {
      b += face;
      vb += val;
    }
  }
  return [F(rect(12, 6, 40, 2.6), WOOD_D), F(a, RED), F(b, CREAM), F(va, RED_D), F(vb, CREAM_D)];
}

/** Wooden crate (side view) with frame boards. */
function crate(x: number, y: number, w: number, h: number): IconLayer[] {
  return [
    F(rect(x, y, w, h), WOOD_L, { edge: true }),
    S(join(rect(x + 1.4, y + 1.4, w - 2.8, h - 2.8), line(x, y + h / 2, x + w, y + h / 2)), WOOD_D, 0.9, { clip: true, detail: true }),
    shadeC(rect(x + w * 0.68, y, w * 0.32 + 0.5, h), 0.22),
  ];
}

function wheatEar(x: number, top: number, bottom: number, lean = 0): IconLayer[] {
  let left = leaf(x + lean, top + 6, x + lean, top - 2.5, 2.1);
  let right = '';
  for (let i = 0; i < 4; i++) {
    const y = top + 6 + i * 4.2;
    const xl = x + lean * (1 - i * 0.2);
    left += leaf(xl, y + 3, xl - 4.4, y - 2.2, 1.6);
    right += leaf(xl, y + 3, xl + 4.4, y - 2.2, 1.6);
  }
  return [
    S(line(x, bottom, x + lean * 0.3, top + 20, x + lean, top + 4), GOLD_D, 1.6),
    F(left, '#dcbc68'),
    F(right, GOLD),
    S(join(line(x + lean - 0.6, top - 2, x + lean - 2.4, top - 9), line(x + lean + 0.6, top - 2, x + lean + 2.6, top - 9)), GOLD_D, 0.7, {
      noOutline: true,
      detail: true,
    }),
  ];
}

function pine(cx: number, base: number, h: number, w: number, snow = false): IconLayer[] {
  const t = h / 3;
  let d = '';
  let caps = '';
  for (let i = 0; i < 3; i++) {
    const y0 = base - h * 0.14 - i * t * 0.72;
    const ww = w * (1 - i * 0.24);
    const apex = y0 - t * 1.3;
    d += poly(cx - ww / 2, y0, cx, apex, cx + ww / 2, y0);
    caps += poly(cx - ww * 0.36, apex + t * 0.9, cx, apex - 1, cx + ww * 0.36, apex + t * 0.9, cx + ww * 0.12, apex + t * 0.7, cx, apex + t * 0.95, cx - ww * 0.14, apex + t * 0.68);
  }
  const out: IconLayer[] = [F(rect(cx - w * 0.08, base - h * 0.2, w * 0.16, h * 0.2), WOOD_D), F(d, PINE)];
  if (snow) out.push(C(caps, SNOW));
  out.push(shadeC(rect(cx, 0, w / 2 + 1, 64), 0.3));
  return out;
}

/** Rotated ellipse as a polygon (deg counter-clockwise on screen). */
function rell(cx: number, cy: number, rx: number, ry: number, deg: number, steps = 28): string {
  const pts: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    pts.push(Math.cos(t) * rx, Math.sin(t) * ry);
  }
  return poly(...rot(cx, cy, deg, pts));
}

/**
 * Field howitzer, side view, muzzle up and to the right. Drawn in a 64-unit frame with the near wheel hub at
 * (25, 48); placed with that hub at (cx, cy) and scaled by k. Below DETAIL_MIN_PX only the barrel, muzzle brake,
 * shield, wheel ring and one trail leg remain.
 */
function howitzer(cx: number, cy: number, k: number): IconLayer[] {
  const T = (p: number[]): number[] => p.map((v, i) => (i % 2 === 0 ? cx + (v - 25) * k : cy + (v - 48) * k));
  const pp = (...p: number[]): string => poly(...T(p));
  const ln = (...p: number[]): string => line(...T(p));
  const ci = (x: number, y: number, r: number): string => circ(cx + (x - 25) * k, cy + (y - 48) * k, r * k);
  // barrel axis: trunnion at (25, 36.5), elevated 22 degrees; local x along the barrel, y across (down)
  const [tx, ty] = T([25, 36.5]);
  const bar = (...p: number[]): string => poly(...rot(tx, ty, 22, p.map((v) => v * k)));
  let spokes = '';
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + 0.3;
    spokes += ln(25 + Math.cos(a) * 2, 48 + Math.sin(a) * 2, 25 + Math.cos(a) * 6.4, 48 + Math.sin(a) * 6.4);
  }
  return [
    S(ln(26, 45, 9, 51.5), OLIVE_DD, 2.4 * k, { detail: true }), // far trail leg
    F(pp(6, 49.5, 10, 50.3, 9.3, 54.3, 5.3, 53.5), OLIVE_DD, { detail: true }), // far spade
    F(ci(30, 46.5, 9.4), RUBBER, { detail: true }), // far wheel
    C(ci(30, 46.5, 6), OLIVE_DD, { detail: true }),
    S(ln(24, 47, 5, 57), OLIVE_D, 2.8 * k), // near trail leg
    F(pp(1.5, 54.5, 5.5, 55.3, 5, 60.5, 1, 59.7), OLIVE_D, { detail: true }), // spade
    F(pp(19, 39, 31, 37, 31, 47, 20, 47), OLIVE_D, { detail: true }), // saddle
    F(pp(27, 28.5, 37.5, 25.5, 37.5, 45, 27, 46), OLIVE_L, { edge: true }), // gun shield face
    lightC(pp(27, 28.5, 37.5, 25.5, 37.5, 28, 27, 31), 0.25),
    F(pp(37.5, 25.5, 40, 26.6, 40, 45.4, 37.5, 45), OLIVE_DD, { edge: true }), // shield edge
    F(bar(-2, 1.8, 23, 1.8, 23, 4.8, -2, 4.8), OLIVE_D, { edge: true, detail: true }), // recoil cylinder
    F(bar(-11, -1.9, 32, -1.4, 32, 1.4, -11, 1.9), OLIVE, { edge: true }), // barrel
    lightC(bar(-12, -2.5, 33, -2.5, 33, -0.5, -12, -0.5), 0.22),
    F(bar(-12, -3.1, -6, -3.1, -6, 3.3, -12, 3.3), OLIVE_D, { edge: true, detail: true }), // breech
    F(bar(30.5, -3, 39, -3, 39, 3, 30.5, 3), OLIVE_D, { edge: true }), // muzzle brake
    C(bar(34.2, -4, 35.4, -4, 35.4, 4, 34.2, 4), DARK, { detail: true }),
    lightC(bar(29, -4, 40, -4, 40, -1.6, 29, -1.6), 0.2),
    F(ci(25, 48, 10), RUBBER), // near wheel: tyre
    F(ci(25, 48, 7.3), OLIVE_L, { noOutline: true }), // rim
    F(ci(25, 48, 6), OLIVE_DD, { noOutline: true }),
    S(spokes, OLIVE_L, 1.3 * k, { noOutline: true, detail: true }),
    F(ci(25, 48, 2.3), OLIVE_L, { noOutline: true, detail: true }), // hub
    C(ci(25, 48, 0.9), DARK, { detail: true }),
    shadeC(ci(29, 52, 7), 0.25),
  ];
}

/** SAM missile with its tail at (tx, ty), pointing deg (0 = right, 90 = up): light body, pale pointed nose, small fins. */
function missile(tx: number, ty: number, len: number, w: number, deg: number, o: LayerOpts = {}): IconLayer[] {
  const h = w / 2;
  const noseLen = w * 2.2;
  const bodyLen = len - noseLen;
  return [
    F(join(rpoly(tx, ty, deg, 0, -h, w * 1.6, -h, w * 0.2, -h - w * 0.6, -w * 0.3, -h - w * 0.6), rpoly(tx, ty, deg, 0, h, w * 1.6, h, w * 0.2, h + w * 0.6, -w * 0.3, h + w * 0.6)), STEEL_D, { ...o, detail: true, noOutline: true }),
    F(rpoly(tx, ty, deg, 0, -h, bodyLen, -h, bodyLen + noseLen * 0.55, -h * 0.65, len, 0, bodyLen + noseLen * 0.55, h * 0.65, bodyLen, h, 0, h), '#c9ccc4', {
      edge: true,
      ...o,
    }),
    C(rpoly(tx, ty, deg, bodyLen, -w, len + 2, -w, len + 2, w, bodyLen, w), '#eceee9', o),
    C(rpoly(tx, ty, deg, bodyLen - 1.4, -w, bodyLen - 0.4, -w, bodyLen - 0.4, w, bodyLen - 1.4, w), STEEL_D, { detail: true, ...o }),
    shadeC(rpoly(tx, ty, deg, -2, 0.3, len + 2, 0.3, len + 2, w, -2, w), 0.25, o),
  ];
}

const RED_CROSS = poly(19.5, 29, 26.5, 29, 26.5, 34.5, 32, 34.5, 32, 41.5, 26.5, 41.5, 26.5, 47, 19.5, 47, 19.5, 41.5, 14, 41.5, 14, 34.5, 19.5, 34.5);

export const ICON_DATA: Record<IconId, IconLayer[]> = {
  // ---- buildings (front elevation, right side in shadow) ---------------------------------------------------
  city: [
    ...tower(40, 13, 12, '#9aa2a6', false),
    ...tower(6, 19, 12, '#8e9aa5', false),
    F(rect(26.5, 3.5, 7, 6), '#b1b6b8'),
    shadeC(rect(31, 0, 10, 20), 0.3),
    S(line(30, 0.8, 30, 3.5), STEEL_DD, 1.2),
    ...tower(23, 9, 14, '#b4b9ba'),
    ...tower(2, 31, 13, '#c3b190'),
    ...tower(13, 40, 12, '#a3a6a1'),
    ...tower(35, 43, 12, '#b9a98a'),
    ...tower(46, 25, 16, '#a76f57'),
  ],
  farm: [
    F('M5 51L5 17A5.5 6 0 0 1 16 17L16 51Z', CONC),
    lightC(rect(5, 0, 2.6, 64), 0.3),
    shadeC(rect(12, 0, 8, 64), 0.3),
    S(join(line(5, 26, 16, 26), line(5, 35, 16, 35), line(5, 44, 16, 44)), CONC_D, 0.8, { clip: true, detail: true }),
    F(poly(40, 50, 40, 30, 59, 27, 59, 48), BARN, { edge: true }),
    shadeC(rect(38, 20, 30, 40), 0.32),
    F(poly(40, 30, 38, 21, 57, 18.5, 59, 27), ROOF, { edge: true }),
    F(poly(38, 21, 29, 13, 48, 10.5, 57, 18.5), ROOF_L, { edge: true }),
    F(poly(18, 50, 18, 30, 20, 21, 29, 13, 38, 21, 40, 30, 40, 50), BARN, { edge: true }),
    S(line(18, 30, 20, 21, 29, 13, 38, 21, 40, 30), CREAM, 1.4, { noOutline: true }),
    F(rect(23, 35, 12, 15), BARN_D, { noOutline: true }),
    S(join(rect(23, 35, 12, 15), line(23, 35, 35, 50), line(35, 35, 23, 50)), CREAM, 1.1, { noOutline: true, detail: true }),
    F(rect(26.5, 21.5, 5, 6), DARK, { noOutline: true }),
    F(poly(47, 34, 53, 33, 53, 40, 47, 41), DARK, { noOutline: true, detail: true, alpha: 0.7 }),
    F(rect(0, 51, 64, 11), SOIL),
    C(furrows(51, 62), SOIL_D),
    lightC(rect(0, 51, 64, 1.6), 0.18),
  ],
  market: [
    F(join(rect(8, 20, 3.4, 38), rect(52.6, 20, 3.4, 38)), WOOD_D),
    F(rect(11.4, 21, 41.2, 20), '#4b4037', { noOutline: true }),
    ...awning(),
    F('M9.5 34Q16 25.5 22.5 34Z', '#c48a3f', { edge: true }),
    lightC(circ(13.5, 28.5, 3.5), 0.25),
    F('M25.5 34Q32 25.5 38.5 34Z', '#7d9a4c', { edge: true }),
    lightC(circ(29.5, 28.5, 3.5), 0.25),
    F('M41.5 34Q48 25.5 54.5 34Z', '#a8483c', { edge: true }),
    lightC(circ(45.5, 28.5, 3.5), 0.25),
    ...crate(8, 33, 16, 8),
    ...crate(24, 33, 16, 8),
    ...crate(40, 33, 16, 8),
    F(rect(4, 41, 56, 17), WOOD, { edge: true }),
    lightC(rect(4, 41, 56, 2.4), 0.25),
    S(join(line(4, 46.5, 60, 46.5), line(4, 52, 60, 52)), WOOD_D, 0.9, { clip: true, detail: true }),
    shadeC(rect(4, 55, 56, 4), 0.25),
  ],
  mine: [
    // rocky slope rising to the right with a timber-framed adit; rails run out to an ore cart
    F(poly(0, 60, 0, 43, 7, 35, 13, 27, 22, 21, 31, 19, 40, 13, 50, 9, 58, 11, 64, 9, 64, 60), ROCK),
    lightC(poly(0, 43, 7, 35, 13, 27, 22, 21, 31, 19, 26, 27, 16, 33, 8, 42, 4, 60, 0, 60), 0.18),
    lightC(poly(40, 13, 50, 9, 52, 18, 44, 24), 0.15),
    shadeC(poly(46, 0, 66, 0, 66, 64, 50, 64), 0.25),
    S(join(line(4, 50, 12, 46), line(44, 22, 58, 19), line(48, 30, 62, 27), line(42, 40, 54, 37)), ROCK_D, 1.1, { clip: true, detail: true }),
    F(rect(17, 33, 18, 27), '#1f1d1b', { noOutline: true }), // adit
    S(join(line(23.5, 56, 21.5, 62), line(28.5, 56, 30.5, 62), line(24.5, 49, 23.5, 56), line(27.5, 49, 28.5, 56)), STEEL_L, 1.1, { noOutline: true }),
    S(join(line(21, 60, 31, 60), line(22.5, 56.5, 29.5, 56.5), line(23.5, 53, 28.5, 53)), WOOD, 1, { noOutline: true, detail: true }),
    F(join(rect(13, 32, 5, 28), rect(34, 32, 5, 28)), WOOD, { edge: true }), // posts
    shadeC(join(rect(16, 32, 2, 28), rect(37, 32, 2, 28)), 0.3),
    F(rect(10, 27, 32, 6), WOOD_L, { edge: true }), // lintel
    shadeC(rect(10, 31, 32, 2), 0.3),
    S(join(line(14, 27, 14, 33), line(38, 27, 38, 33)), WOOD_D, 0.9, { noOutline: true, detail: true }),
    F(join(circ(45, 45, 3.8), circ(51.5, 43, 4.4), circ(57.5, 45, 3.6)), '#574c43'),
    C(join(circ(50, 41.5, 1.3), circ(45, 43.5, 1)), '#b06a45', { detail: true }),
    F(poly(40, 45, 62, 45, 59, 55, 43, 55), STEEL, { edge: true }), // ore cart
    lightC(rect(40, 45, 24, 2), 0.3),
    shadeC(rect(40, 51, 24, 5), 0.25),
    F(join(circ(46, 57, 3), circ(56, 57, 3)), RUBBER),
  ],
  oilWell: [
    F(rect(2, 55, 60, 5), STEEL_D, { edge: true }),
    lightC(rect(2, 55, 60, 1.5), 0.25),
    S(line(11, 34, 11, 50), STEEL_L, 1.3),
    F(rect(7, 48, 8, 7), STEEL, { edge: true }),
    shadeC(rect(12, 48, 4, 7), 0.3),
    S(join(line(24, 55, 32, 25), line(40, 55, 32, 25)), STEEL_D, 3.6),
    S(line(27.4, 43, 36.6, 43), STEEL_D, 2, { detail: true }),
    S(line(51, 23.5, 49.5, 46), STEEL_DD, 2.2),
    F(rect(43, 47, 13, 8), STEEL, { edge: true }),
    shadeC(rect(51, 47, 6, 8), 0.3),
    F(rpoly(49.5, 46.5, 0, -2, -1.5, 2, -1.5, 2, 8, -2, 8), STEEL_DD, { edge: true }),
    F(rpoly(49.5, 46.5, 0, -6, 5, 6, 5, 5, 10, -5, 10), STEEL_DD, { edge: true }),
    F(rpoly(32, 25, 6, -18, -2.4, 20, -2.4, 20, 2.4, -18, 2.4), '#b38a45', { edge: true }),
    shadeC(rpoly(32, 25, 6, -20, 0.6, 22, 0.6, 22, 4, -20, 4), 0.25),
    F('M17.5 19.5L12.5 18.5Q7 27 12.5 36L17.5 34Z', '#b38a45', { edge: true }),
    shadeC(rect(15, 0, 6, 64), 0.25),
    F(circ(32, 25, 2.5), STEEL_DD),
  ],
  lab: [
    // low, wide research building in cool blue-grey under a large observatory dome, antenna on the roof
    ...block(2, 40, 40, 20, 14, '#a3afba', '#c3ccd3'),
    F(rect(5, 44, 34, 6), GLASS, { noOutline: true }),
    lightC(rect(5, 44, 34, 1.5), 0.4),
    S(join(...[11.5, 18, 25.5, 32].map((x) => line(x, 44, x, 50))), STEEL_D, 0.8, { noOutline: true, detail: true }),
    F(join(poly(44, 42, 54, 37, 54, 41.5, 44, 46.5)), GLASS_D, { noOutline: true }),
    F(rect(18.5, 52.5, 7, 7.5), GLASS_D, { noOutline: true }),
    S(line(51, 35, 51, 15), STEEL_DD, 1.4), // antenna mast
    F(rell(48.6, 16.6, 5, 1.8, 50), STEEL_L, { edge: true }), // dish
    F(rect(13, 35, 30, 3.5), CONC, { edge: true }), // dome drum
    shadeC(rect(35, 30, 10, 10), 0.25),
    F('M14.5 35.5A13.5 13.5 0 0 1 41.5 35.5Z', '#c9d0d6', { edge: true }), // dome
    lightC(ell(21.5, 26, 5, 4), 0.35),
    shadeC(ell(40, 38, 11, 17), 0.3),
    C(rect(26.6, 20, 2.8, 16), STEEL_DD, { detail: true }),
  ],
  barracks: [
    S(line(58, 60, 58, 6.5), STEEL_D, 1.8),
    F('M59 7.5L64 8.3L64 16L59 15.2Z', RED, { tint: 'base' }),
    shadeC(rect(59, 12.5, 6, 6), 0.3),
    F(poly(43, 58, 43, 33, 49, 23, 55, 30, 55, 54.5), KHAKI, { edge: true }),
    shadeC(rect(0, 0, 64, 64), 0.32),
    F(poly(1, 34.5, 7, 23, 49, 23, 43.5, 34.5), '#5d6a3e', { edge: true }),
    lightC(poly(0, 0, 64, 0, 64, 27, 0, 27), 0.14),
    F(rect(3, 33, 40, 25), KHAKI, { edge: true }),
    shadeC(rect(3, 33, 40, 2.5), 0.25),
    F(windowGrid([7, 14, 30, 37], [40], 4, 6), WIN, { noOutline: true }),
    F(rect(20.5, 42, 7, 16), WOOD_D, { noOutline: true }),
    F(rect(47.5, 39, 3.6, 5), WIN, { noOutline: true, detail: true }),
    F(join(rrect(4, 54, 7, 4, 2), rrect(11.5, 54, 7, 4, 2), rrect(7.5, 50.5, 7, 4, 2)), '#a89a6c', { edge: true, detail: true }),
  ],
  factory: [
    F(rect(46, 10, 8, 50), BRICK),
    lightC(rect(46, 0, 2, 64), 0.18),
    shadeC(rect(51, 0, 6, 64), 0.3),
    C(rect(46, 15, 8, 2.4), CREAM_D),
    F(rect(45, 8, 10, 3), '#6d3b2b'),
    F(join(circ(51, 4.5, 3.4), circ(57.5, 3.4, 2.8), circ(45.5, 3.8, 2.4)), SMOKE),
    shadeC(rect(44, 5, 20, 6), 0.15),
    F(poly(2, 60, 2, 22, 16, 31, 16, 22, 30, 31, 30, 22, 44, 31, 44, 60), BRICK, { edge: true }),
    C(join(poly(2, 22, 16, 31, 16, 34.5, 2, 25.5), poly(16, 22, 30, 31, 30, 34.5, 16, 25.5), poly(30, 22, 44, 31, 44, 34.5, 30, 25.5)), ROOF),
    C(join(rect(14.5, 22, 1.5, 9), rect(28.5, 22, 1.5, 9)), GLASS_D),
    shadeC(rect(38, 0, 10, 64), 0.25),
    F(windowGrid([6, 18, 30], [39], 8, 8), GLASS_D, { noOutline: true }),
    S(join(line(10, 39, 10, 47), line(22, 39, 22, 47), line(34, 39, 34, 47), line(2, 43, 44, 43)), DARK, 0.7, { noOutline: true, detail: true }),
    F(rect(18.5, 50, 9, 10), STEEL_D, { noOutline: true }),
  ],
  arsenal: [
    // depot hall: long wall, pitched roof, gable end receding to the right, big sliding hangar door
    F(poly(44, 46, 44, 26, 56, 19.5, 56, 40), OLIVE_L, { edge: true }),
    shadeC(rect(0, 0, 64, 64), 0.32),
    F(poly(44, 26, 50, 13, 56, 19.5), '#7f8456', { edge: true }),
    shadeC(rect(0, 0, 64, 64), 0.3),
    F(poly(1, 27, 9, 13, 50, 13, 44, 27), OLIVE_D, { edge: true }),
    lightC(poly(0, 0, 64, 0, 64, 18, 0, 18), 0.14),
    S(join(...[12, 20, 28, 36, 44].map((x) => line(x - 2.5, 14, x - 8, 26.5))), OLIVE_DD, 0.7, { clip: true, detail: true, alpha: 0.7 }),
    F(rect(3, 26, 41, 22), OLIVE_L, { edge: true }),
    shadeC(rect(3, 26, 41, 2.2), 0.3),
    C(rect(3, 29.5, 41, 3.4), '#c8bf8e', { detail: true }),
    S(join(line(6, 31.2, 9, 31.2), line(11, 31.2, 13.5, 31.2), line(31, 31.2, 34, 31.2), line(36, 31.2, 40.5, 31.2)), DARK, 1.2, {
      noOutline: true,
      detail: true,
      cap: 'butt',
    }),
    F(rect(15, 34, 16, 14), STEEL_D, { noOutline: true }),
    S(join(line(23, 34, 23, 48), ...[17, 19, 21, 25, 27, 29].map((x) => line(x, 34, x, 48))), STEEL_DD, 0.7, { noOutline: true, detail: true }),
    shadeC(rect(15, 34, 16, 3), 0.35),
    F(windowGrid([6.5, 36], [36], 4.5, 3.5), WIN, { noOutline: true, detail: true }),
    F(rect(0, 48, 64, 3), CONC_D, { noOutline: true, alpha: 0.6 }),
    ...howitzer(37, 52.5, 0.62),
  ],
  fort: [
    F(poly(17, 58, 18, 30, 46, 30, 47, 58), STONE),
    F(windowGrid([18, 24, 30, 36, 42], [25], 4, 5.5), STONE),
    shadeC(rect(17, 30, 30, 3), 0.25),
    F('M26 58L26 46A6 6 0 0 1 38 46L38 58Z', WOOD_D, { edge: true }),
    S(join(line(29, 42, 29, 58), line(32, 40, 32, 58), line(35, 42, 35, 58)), DARK, 0.8, { clip: true, detail: true }),
    F(windowGrid([4, 10, 16], [16], 4, 6.5), STONE),
    F(poly(1, 58, 4, 22, 20, 22, 23, 58), STONE, { edge: true }),
    lightC(poly(0, 0, 11, 0, 11, 64, 0, 64), 0.18),
    shadeC(poly(12, 0, 30, 0, 30, 64, 13, 64), 0.28),
    F(windowGrid([42, 48, 54], [16], 4, 6.5), STONE),
    F(poly(41, 58, 44, 22, 60, 22, 63, 58), STONE, { edge: true }),
    lightC(poly(30, 0, 51, 0, 51, 64, 30, 64), 0.18),
    shadeC(poly(52, 0, 66, 0, 66, 64, 53, 64), 0.28),
    F(join(rect(9.6, 32, 2.2, 7), rect(51.6, 32, 2.2, 7)), DARK, { noOutline: true }),
    S(join(line(2.5, 44, 21.5, 44), line(18, 40, 46, 40), line(42.5, 44, 61.5, 44), line(18, 50, 26, 50), line(38, 50, 46, 50)), STONE_D, 0.8, {
      noOutline: true,
      detail: true,
    }),
  ],
  watchtower: [
    S(join(line(15, 62, 22, 30), line(49, 62, 42, 30)), WOOD_D, 3.6),
    S(join(line(19, 53, 44, 40), line(45, 53, 20, 40), line(17, 53, 47, 53), line(20, 40, 44, 40)), WOOD, 2),
    F(rect(10, 26, 44, 5), WOOD, { edge: true }),
    lightC(rect(10, 26, 44, 1.5), 0.25),
    shadeC(rect(40, 26, 20, 6), 0.25),
    F(rect(14, 14, 36, 12), WOOD_L, { edge: true }),
    F(rect(17, 16, 30, 6), DARK, { clip: true }),
    shadeC(rect(38, 0, 20, 64), 0.25),
    S(join(line(25, 15, 25, 26), line(32, 15, 32, 26), line(39, 15, 39, 26)), WOOD_D, 1.4, { noOutline: true }),
    F(poly(8, 15, 32, 3, 56, 15), '#6b5643', { edge: true }),
    shadeC(rect(32, 0, 32, 20), 0.25),
  ],
  supplyDepot: [
    F(poly(38, 58, 38, 30, 58, 24, 58, 52), '#94a0aa', { edge: true }),
    shadeC(rect(0, 0, 64, 64), 0.32),
    F(poly(38, 30, 21, 21, 41, 15, 58, 24), ROOF, { edge: true }),
    F(poly(4, 58, 4, 30, 21, 21, 38, 30, 38, 58), '#94a0aa', { edge: true }),
    S(join(...[8, 12, 16, 26, 30, 34].map((x) => line(x, 18, x, 58))), '#7a8792', 0.8, { clip: true, detail: true }),
    F(rect(11, 38, 20, 20), STEEL_D, { noOutline: true }),
    S(join(line(11, 42, 31, 42), line(11, 46, 31, 46), line(11, 50, 31, 50), line(11, 54, 31, 54)), STEEL_DD, 0.8, { noOutline: true, detail: true }),
    F(rect(35, 58, 28, 3.5), WOOD_D),
    ...crate(36, 45, 13, 13),
    ...crate(49, 45, 13, 13),
    ...crate(42.5, 32.5, 13, 12.5),
  ],
  port: [
    F(rect(0, 52, 64, 10), WATER),
    S(join(line(44, 56, 50, 55, 56, 56), line(4, 59, 10, 58, 16, 59), line(30, 60, 36, 59, 42, 60)), WATER_L, 1, { clip: true, detail: true }),
    F(rect(0, 44, 42, 8), CONC, { edge: true }),
    lightC(rect(0, 44, 42, 2), 0.3),
    F(rect(12.5, 36, 14, 8), '#4f6e8a', { edge: true }),
    S(join(line(16, 36, 16, 44), line(19.5, 36, 19.5, 44), line(23, 36, 23, 44)), DARK, 0.7, { clip: true, detail: true, alpha: 0.5 }),
    S(join(line(9, 44, 9, 13), line(30, 44, 30, 13), line(9, 28, 30, 28)), '#8f6a2c', 3),
    S(join(line(19.5, 2, 4, 10.5), line(19.5, 2, 61, 10.5)), '#8f6a2c', 1.2),
    F(poly(16, 11, 19.5, 2, 23, 11), '#8f6a2c'),
    F(rect(2, 10, 61, 4.5), '#c39444', { edge: true }),
    shadeC(rect(0, 12.6, 64, 3), 0.25),
    F(rect(46.5, 14.5, 8, 3), STEEL_DD),
    S(join(line(48.5, 17.5, 47.5, 25), line(52.5, 17.5, 53.5, 25)), STEEL_DD, 0.9),
    F(rect(43, 25, 15, 8), '#9e563f', { edge: true }),
    S(join(line(46.5, 25, 46.5, 33), line(50.5, 25, 50.5, 33), line(54.5, 25, 54.5, 33)), DARK, 0.7, { clip: true, detail: true, alpha: 0.5 }),
    shadeC(rect(43, 30.5, 15, 3), 0.25),
  ],
  hospital: [
    ...block(4, 26, 38, 34, 16, '#ebe9e3', '#f6f5f1'),
    F(rect(3, 23.5, 40, 3), CONC, { edge: true }), // roof parapet
    F(poly(43, 23.5, 59, 15.5, 59, 18.5, 43, 26.5), CONC_D, { edge: true }),
    F(join(rect(10, 15, 9, 8.5)), CONC_L, { edge: true }), // rooftop plant room
    shadeC(rect(16, 15, 3, 9), 0.25),
    F(poly(17.5, 33, 22.5, 33, 22.5, 37, 26.5, 37, 26.5, 42, 22.5, 42, 22.5, 46, 17.5, 46, 17.5, 42, 13.5, 42, 13.5, 37, 17.5, 37), RED, { noOutline: true }),
    F(windowGrid([31, 36], [31, 39], 3.5, 5), GLASS_D, { noOutline: true, detail: true }),
    F(windowGrid([6.5], [31, 39], 3.5, 5), GLASS_D, { noOutline: true, detail: true }),
    F(join(poly(45, 31, 55, 26, 55, 31, 45, 36), poly(45, 41, 55, 36, 55, 41, 45, 46)), GLASS_D, { noOutline: true }),
    F(rect(13, 52, 14, 8), GLASS_D, { noOutline: true }), // entrance
    S(line(20, 52, 20, 60), STEEL_D, 0.8, { noOutline: true, detail: true }),
    F(poly(9, 49, 31, 49, 33.5, 52.5, 6.5, 52.5), '#a83e33', { edge: true }), // entrance canopy
    shadeC(rect(0, 51, 64, 2), 0.3),
    S(join(line(8, 52.5, 8, 60), line(32, 52.5, 32, 60)), STEEL_D, 1, { noOutline: true }),
  ],
  airfield: [
    F(rect(0, 50, 64, 11), '#5c6066'),
    lightC(rect(0, 50, 64, 1.4), 0.2),
    S(join(line(4, 55.5, 12, 55.5), line(20, 55.5, 28, 55.5), line(36, 55.5, 44, 55.5), line(52, 55.5, 60, 55.5)), CREAM, 1.6, { noOutline: true }),
    F('M2 50L2 32A17 15 0 0 1 36 32L36 50Z', STEEL_L),
    S(join(line(10, 20, 10, 50), line(19, 17, 19, 50), line(28, 20, 28, 50)), STEEL, 0.8, { clip: true, detail: true }),
    lightC(rect(0, 0, 8, 64), 0.18),
    shadeC(rect(26, 0, 12, 64), 0.28),
    F('M9 50L9 37A10 8 0 0 1 29 37L29 50Z', DARK, { noOutline: true }),
    F(poly(38.5, 42, 36, 32, 40, 32, 45, 42), RED, { tint: 'base' }),
    F('M39 41L57 41Q63 41.8 63 44.2Q62.5 46.6 57 47L40 47Q37 46.5 37 44Q37 41.3 39 41Z', CREAM_L, { edge: true }),
    shadeC(rect(36, 44.6, 28, 3), 0.18),
    C(rect(59, 42.3, 2.5, 1.6), GLASS_D),
    F(poly(45, 45, 54, 45, 50, 50.5, 43, 50.5), STEEL_L, { edge: true }),
    S(line(42, 43, 55, 43), GLASS_D, 1, { noOutline: true, detail: true, cap: 'butt' }),
  ],
  sam: [
    // launcher truck, side view: four separate missiles on an inclined rail at the rear
    S(line(31, 43, 26, 35), OLIVE_DD, 2.6),
    F(rpoly(16.5, 40.8, 32, -3, -1.4, 27, -1.4, 27, 2.2, -3, 2.2), OLIVE_D, { edge: true }), // rail
    S(join(...[7, 19].map((x) => line(...rot(16.5, 40.8, 32, [x, 0, x, -22.5])))), OLIVE_D, 2, { noOutline: true, detail: true }), // rack frames
    ...missile(3, 19, 27, 2.8, 32),
    ...missile(7, 25.4, 27, 2.8, 32, { detail: true }),
    ...missile(11, 31.7, 27, 2.8, 32),
    ...missile(14.9, 38.1, 27, 2.8, 32, { detail: true }),
    F(poly(2, 52, 2, 43, 44, 43, 46.5, 35, 57.5, 35, 62, 43, 62, 52), OLIVE, { edge: true }),
    lightC(rect(0, 0, 64, 44.6), 0.15),
    shadeC(rect(0, 48.5, 64, 5), 0.25),
    S(line(44, 43, 44, 52), OLIVE_DD, 0.8, { clip: true, detail: true }),
    C(poly(48, 37, 56.4, 37, 59.6, 42.5, 47, 42.5), GLASS_D),
    F(join(circ(10, 53.5, 4.6), circ(21, 53.5, 4.6), circ(34, 53.5, 4.6), circ(52, 53.5, 4.6)), RUBBER),
    F(join(circ(10, 53.5, 1.8), circ(21, 53.5, 1.8), circ(34, 53.5, 1.8), circ(52, 53.5, 1.8)), OLIVE_D, { noOutline: true, detail: true }),
  ],
  silo: [
    // flat concrete pad seen from above at an angle; the round hatch lid stands open, the missile rises from the shaft
    F(poly(4, 52, 16, 40, 60, 40, 48, 52), CONC, { edge: true }), // pad top
    lightC(poly(4, 52, 16, 40, 30, 40, 18, 52), 0.15),
    F(poly(4, 52, 48, 52, 48, 57, 4, 57), CONC_D, { edge: true }), // front face
    F(poly(48, 52, 60, 40, 60, 45, 48, 57), CONC_D, { edge: true }), // side face
    shadeC(rect(0, 0, 64, 64), 0.25),
    S(join(line(10, 46, 54, 46), line(22, 40, 14, 52), line(44, 40, 36, 52)), CONC_D, 0.7, { noOutline: true, detail: true, alpha: 0.6 }),
    F(ell(32, 46, 9.6, 3.6), '#1f2125', { noOutline: true }), // shaft
    S(ell(32, 46, 9.6, 3.6), STEEL_D, 1.1, { noOutline: true }),
    F(rell(17.8, 36.3, 10.4, 3.6, 104), CONC_D, { edge: true }), // lid edge
    F(rell(17, 36, 10.4, 3.4, 104), CONC_L, { edge: true }), // lid
    shadeC(rect(17, 0, 10, 64), 0.18),
    S(rell(17, 36, 6.4, 1.6, 104), CONC_D, 0.7, { noOutline: true, detail: true }),
    F(rect(20.5, 43.3, 3, 3), STEEL_DD, { noOutline: true, detail: true }), // hinge
    F('M27.5 50L27.5 17Q32 3 36.5 17L36.5 50Z', '#dcdad2', { edge: true }), // missile
    C(rect(24, 0, 16, 16.5), '#5b5f63'),
    C(rect(24, 25, 16, 2.4), '#5b5f63', { detail: true }),
    lightC(rect(27.5, 0, 2.6, 64), 0.35),
    shadeC(rect(33.5, 0, 6, 64), 0.25),
    F('M4 52L10 46L22.4 46A9.6 3.6 0 0 0 41.6 46L54 46L48 52Z', CONC, { noOutline: true }), // pad in front of the shaft
    S('M22.4 46A9.6 3.6 0 0 0 41.6 46', STEEL_D, 1.1, { noOutline: true }),
    S(line(4, 52, 48, 52), OUT, 0.9, { noOutline: true }),
  ],
  iron: [
    F(poly(3, 58, 4, 47, 12, 42, 20, 48, 20, 58), '#6e645c'),
    lightC(poly(0, 0, 12, 0, 12, 64, 0, 64), 0.15),
    F(poly(8, 58, 6, 38, 18, 22, 34, 18, 46, 28, 48, 58), '#7a6f66', { edge: true }),
    lightC(poly(6, 38, 18, 22, 34, 18, 29, 32, 15, 38), 0.22),
    shadeC(poly(34, 18, 46, 28, 50, 58, 36, 58, 29, 32), 0.3),
    C(join(poly(11, 46, 20, 40, 24, 47, 15, 52), poly(28, 37, 37, 33, 39, 41, 30, 44), poly(20, 27, 28, 25, 26, 32, 19, 32)), '#a35b38'),
    C(join(poly(13, 46, 18, 42.5, 20, 45), poly(30, 37.5, 35, 35.5, 35.5, 38)), '#c97b4f', { detail: true }),
    F(poly(26, 60, 62, 60, 58, 50, 30, 50), STEEL, { edge: true }), // ingot
    shadeC(poly(48, 40, 66, 40, 66, 64, 54, 64), 0.25),
    F(poly(30, 50, 58, 50, 54.5, 44, 33.5, 44), STEEL_L, { edge: true }),
  ],
  oil: [
    F('M32 3C35 13 51 25 51 41A19 19 0 0 1 13 41C13 25 29 13 32 3Z', '#2a2d33'),
    S('M32 3C35 13 51 25 51 41A19 19 0 0 1 13 41C13 25 29 13 32 3Z', '#6a7480', 2.6, { clip: true, alpha: 0.75 }),
    shadeC('M51 30L51 64L28 64Q44 56 45 40Q45 34 43 28Z', 0.45),
    C('M47 36Q50 46 44 53Q38 58 31 58Q41 54 44 47Q46 42 47 36Z', '#5c6571'),
    C('M17.5 40Q17.5 28 28 17Q23.5 30 24.5 42Q25 50 30 55.5Q19 52 17.5 40Z', '#4f5864'),
    C(ell(23.5, 34, 2.4, 6.5), '#c3cbd3'),
    C(circ(25, 45, 1.3), '#9aa4ae', { detail: true }),
  ],
  fertile: [
    F(rect(0, 50, 64, 12), SOIL),
    C(furrows(50, 62), SOIL_D),
    lightC(rect(0, 50, 64, 1.5), 0.2),
    ...wheatEar(10, 14, 56, -2),
    ...wheatEar(24, 8, 56, -1),
    ...wheatEar(39, 7, 56, 1),
    ...wheatEar(53, 13, 56, 2),
  ],

  // ---- terrains --------------------------------------------------------------------------------------------
  plains: [
    // gentle grass band, lighter towards the sky, with three tall tufts
    F('M1 60L1 47Q16 41 32 45Q48 49 63 43L63 60Z', '#869a5a'),
    lightC('M0 51Q16 45 32 49Q48 53 64 47L64 30L0 30Z', 0.28),
    shadeC(rect(0, 55, 64, 10), 0.15),
    S(join('M6 53Q14 50.5 22 53', 'M38 56Q46 53.5 56 55.5'), '#5f7340', 0.9, { clip: true, detail: true }),
    F(join(leaf(12, 47, 7, 33, 1.3), leaf(12, 47, 12.5, 29, 1.5), leaf(12, 47, 17.5, 34, 1.3)), '#5b7139', { noOutline: true }),
    F(join(leaf(31, 47, 27.5, 37, 1.1), leaf(31, 47, 31.5, 34, 1.3), leaf(31, 47, 35, 38, 1.1)), '#5b7139', { noOutline: true }),
    F(join(leaf(49, 49, 44, 34, 1.3), leaf(49, 49, 49.5, 29.5, 1.5), leaf(49, 49, 54.5, 35, 1.3)), '#5b7139', { noOutline: true }),
    lightC(rect(0, 0, 64, 40), 0.1),
    F(join(circ(22, 50, 1.4), circ(40, 52, 1.3), circ(58, 50, 1.3)), CREAM, { noOutline: true, detail: true }),
  ],
  forest: [
    ...pine(13, 58, 40, 20),
    ...pine(51, 58, 44, 20),
    F(rect(29.8, 43, 4.4, 18), WOOD_D),
    F('M22 44A9 9 0 0 1 19.5 27.5A13 13 0 0 1 44.5 27.5A9 9 0 0 1 42 44Z', GRASS, { edge: true }),
    shadeC(ell(41, 42, 17, 16), 0.3),
    lightC(ell(25, 20, 7, 6), 0.22),
  ],
  hills: [
    F('M20 52A22 27 0 0 1 64 52Z', '#62724a'),
    shadeC(ell(56, 58, 12, 28), 0.25),
    F('M0 60A23 30 0 0 1 46 60Z', '#76865a', { edge: true }),
    lightC(ell(13, 37, 9, 7), 0.18),
    shadeC(ell(38, 66, 16, 32), 0.25),
    F('M24 63A20 14 0 0 1 64 63Z', '#8a9668', { edge: true }),
    shadeC(ell(57, 66, 10, 14), 0.22),
  ],
  mountains: [
    F(poly(30, 60, 46, 22, 63, 60), STONE_D),
    C(poly(0, 0, 64, 0, 64, 36, 52, 36, 49, 39, 46, 35, 43, 38, 40, 35, 0, 35), SNOW),
    shadeC(poly(46, 22, 49, 60, 66, 60, 66, 0), 0.3),
    F(poly(1, 60, 24, 6, 47, 60), '#958c81', { edge: true }),
    C(poly(0, 0, 64, 0, 64, 27, 33, 27, 30, 31, 27, 27.5, 24, 32, 21, 27, 17, 30, 14, 27, 0, 27), SNOW),
    shadeC(poly(24, 6, 30, 60, 66, 60, 66, 0), 0.3),
    lightC(poly(24, 6, 1, 60, 10, 60), 0.12),
  ],
  desert: [
    F('M14 46Q30 26 50 30Q58 32 64 36L64 46Z', SAND),
    shadeC('M50 30Q58 32 64 36L64 46L40 46Q47 38 50 30Z', 0.2),
    F(join(rrect(46, 12, 6, 32, 3), 'M46 30L42 30Q39.5 30 39.5 27.5L39.5 21Q39.5 19 41.5 19Q43.5 19 43.5 21L43.5 26L46 26Z',
      'M52 26L56.5 26L56.5 17Q56.5 15 58.5 15Q60.5 15 60.5 17L60.5 27.5Q60.5 30 58 30L52 30Z'), '#6f8a4e'),
    lightC(rect(46, 0, 2, 64), 0.18),
    shadeC(join(rect(50, 0, 3, 64), rect(58.5, 0, 3, 64), rect(41.5, 0, 2, 64)), 0.28),
    F('M0 61L0 44Q14 34 30 42Q44 50 64 47L64 61Z', SAND_L, { edge: true }),
    shadeC('M30 42Q44 50 64 47L64 64L20 64Q30 54 30 42Z', 0.16),
    S(join('M6 54Q14 50 22 54', 'M38 58Q46 54 56 57'), SAND, 1.2, { clip: true, detail: true }),
  ],
  swamp: [
    F(ell(32, 50, 30, 11), '#4b6553'),
    lightC(ell(22, 46, 12, 3), 0.15),
    shadeC(ell(36, 60, 30, 6), 0.2),
    F('M43 47A7 3 0 1 0 57 47Z', GRASS_D, { edge: true }),
    S(join(line(16, 52, 15, 18), line(24, 50, 25, 12), line(32, 52, 34, 22)), '#6f7f45', 2),
    F(join(rrect(12.6, 18, 4.6, 12, 2.3), rrect(22.7, 12, 4.6, 13, 2.3), rrect(31.7, 22, 4.6, 11, 2.3)), '#6a4a31'),
    shadeC(join(rect(15.5, 0, 3, 64), rect(25.6, 0, 3, 64), rect(34.6, 0, 3, 64)), 0.28),
    F(join(leaf(16, 52, 6, 31, 2), leaf(32, 52, 43, 32, 2), leaf(24, 51, 19, 33, 1.5)), '#7d8e4c'),
    shadeC(rect(28, 0, 40, 64), 0.15),
  ],
  tundra: [
    F('M1 60L1 47Q18 39 34 45Q50 39 63 45L63 60Z', SNOW),
    C(join('M0 64L0 56Q16 50 30 55Q46 50 64 54L64 64Z'), SNOW_D),
    S(join('M8 52Q16 49 24 52', 'M40 52Q48 49 56 52'), SNOW_D, 1.2, { clip: true, detail: true }),
    F(join(poly(5, 49, 9, 44, 14, 48), poly(50, 47.5, 54, 42.5, 59, 47)), STONE_D, { edge: true }),
    shadeC(join(rect(9, 40, 6, 10), rect(54, 40, 6, 10)), 0.3),
    ...pine(32, 52, 44, 26, true),
  ],

  // ---- units (top view, pointing right) --------------------------------------------------------------------
  transport: [
    // landing craft, top view: blunt bow ramp, open well deck with vehicles, wheelhouse at the stern
    F(poly(2, 18.5, 56, 18, 62, 21, 62, 43, 56, 46, 2, 45.5), '#7d868f', { tint: 'base' }),
    C(poly(4, 21, 55, 20.5, 59.5, 23, 59.5, 41, 55, 43.5, 4, 43), '#98a0a7', { tint: 'light' }),
    F(rect(17, 22.5, 35, 19), '#3c4146', { edge: true }), // well deck
    S(join(...[22, 28, 34, 40, 46].map((x) => line(x, 22.5, x, 41.5))), '#4a5056', 0.7, { clip: true, detail: true }),
    F(rect(53.5, 22, 6.5, 20), '#b3b9be', { edge: true }), // bow ramp
    S(join(line(55.5, 24, 55.5, 40), line(57.8, 24, 57.8, 40)), STEEL_D, 0.7, { clip: true, detail: true }),
    F(join(rect(19.5, 24.5, 14, 6.5), rect(19.5, 33, 14, 6.5)), OLIVE, { edge: true }), // trucks
    C(join(rect(29.5, 24.5, 4, 6.5), rect(29.5, 33, 4, 6.5)), OLIVE_D, { detail: true }),
    F(rect(36.5, 27, 13, 10), OLIVE_L, { edge: true }), // tank
    F(circ(42, 32, 3.2), OLIVE_D, { edge: true, detail: true }),
    S(line(44, 32, 51.5, 32), OLIVE_DD, 1.2, { detail: true, cap: 'butt' }),
    F(rect(4.5, 23.5, 9.5, 17), CREAM, { edge: true }), // wheelhouse
    C(rect(11.8, 24.5, 1.6, 15), GLASS_D, { detail: true }),
    shadeC(rect(4, 36, 10, 6), 0.2),
  ],
  warship: [
    // destroyer, top view: long narrow hull, sharp bow, square stern, two turrets forward, one aft
    F('M2 25.5L43 24.3Q55 25.5 63 32Q55 38.5 43 39.7L2 38.5Q1.2 32 2 25.5Z', '#868e96', { tint: 'base' }),
    C('M4.5 27.6L43 26.6Q52.5 27.6 58.5 32Q52.5 36.4 43 37.4L4.5 36.4Z', '#a1a8af', { tint: 'light' }),
    S(line(6, 32, 58, 32), DARK, 0.6, { clip: true, detail: true, alpha: 0.25 }),
    F(rect(22, 28.2, 14, 7.6), '#c4c8cc', { edge: true }), // superstructure
    F(rect(25, 29.6, 8, 4.8), '#d6d9dc', { edge: true }),
    C(rect(31.5, 29.6, 1.5, 4.8), GLASS_D, { detail: true }),
    shadeC(rect(20, 32.6, 16, 4), 0.2),
    F(ell(27.5, 32, 1.8, 1.6), '#5e656c', { noOutline: true, detail: true }), // funnel
    S(join(line(49, 31, 56, 31), line(49, 33, 56, 33)), STEEL_DD, 1.2, { cap: 'butt' }),
    F('M45.5 29.3L48.5 29.3Q51.3 29.3 51.3 32Q51.3 34.7 48.5 34.7L45.5 34.7Z', '#6f777f', { edge: true }),
    S(join(line(42, 31, 48.5, 31), line(42, 33, 48.5, 33)), STEEL_DD, 1.2, { cap: 'butt' }),
    F('M38 29.3L41 29.3Q43.8 29.3 43.8 32Q43.8 34.7 41 34.7L38 34.7Z', '#6f777f', { edge: true }),
    S(join(line(14, 31, 7.5, 31), line(14, 33, 7.5, 33)), STEEL_DD, 1.2, { cap: 'butt' }),
    F('M18 29.3L15 29.3Q12.2 29.3 12.2 32Q12.2 34.7 15 34.7L18 34.7Z', '#6f777f', { edge: true }),
  ],
  tradeShip: [
    F('M3 15L44 15Q62 17 63 32Q62 47 44 49L3 49Q1 49 1 47L1 17Q1 15 3 15Z', '#7a4a3c', { tint: 'base' }),
    C('M4 18L44 18Q58 20 59.5 32Q58 44 44 46L4 46Z', '#8f9499', { tint: 'light' }),
    F(rect(3.5, 21, 10, 22), CREAM, { edge: true }), // bridge
    C(rect(11, 22, 1.8, 20), GLASS_D, { detail: true }),
    shadeC(rect(3, 37, 11, 7), 0.2),
    F(join(rect(8, 16.5, 4, 4.5), rect(8, 43, 4, 4.5)), CREAM_D, { edge: true }), // bridge wings
    F(join(rect(16, 18.5, 9, 13), rect(46, 18.5, 9, 13), rect(36, 32.5, 9, 13)), '#5a6e84', { noOutline: true }),
    F(join(rect(26, 18.5, 9, 13), rect(16, 32.5, 9, 13), rect(46, 32.5, 9, 13)), '#8a5c4a', { noOutline: true }),
    F(join(rect(36, 18.5, 9, 13), rect(26, 32.5, 9, 13)), '#6c7a5e', { noOutline: true }),
    S(join(...[18.5, 21, 23.5, 28.5, 31, 33.5, 38.5, 41, 43.5, 48.5, 51, 53.5].map((x) => line(x, 19, x, 45))), DARK, 0.5, {
      noOutline: true,
      detail: true,
      alpha: 0.35,
    }),
  ],
  bomber: [
    F(poly(10, 30, 6.5, 18, 2.5, 18, 3, 30, 3, 34, 2.5, 46, 6.5, 46, 10, 34), '#7b8459', { tint: 'dark' }),
    F(poly(41, 29.5, 36, 3, 31.5, 3, 28, 29.5, 28, 34.5, 31.5, 61, 36, 61, 41, 34.5), '#8a9465', { tint: 'base' }),
    shadeC(rect(0, 33, 64, 31), 0.15),
    F(join(ell(39.5, 11.5, 6, 2.2), ell(41, 21.5, 6, 2.2), ell(41, 42.5, 6, 2.2), ell(39.5, 52.5, 6, 2.2)), '#5e6644', {
      tint: 'dark',
      edge: true,
    }),
    S(join(line(46, 7.5, 46, 15.5), line(47.5, 17.5, 47.5, 25.5), line(47.5, 38.5, 47.5, 46.5), line(46, 48.5, 46, 56.5)), STEEL_DD, 1, {
      noOutline: true,
      detail: true,
    }),
    F('M3 32Q3 29 8 29L52 29Q60 29.5 63 32Q60 34.5 52 35L8 35Q3 35 3 32Z', '#99a273', { tint: 'light', edge: true }),
    lightC(rect(0, 29, 64, 1.6), 0.25),
    shadeC(rect(0, 33.4, 64, 2), 0.2),
    C(ell(59, 32, 3.5, 2.2), GLASS_D),
    C(ell(52, 32, 2.2, 1.6), GLASS, { detail: true }),
  ],
  // cargo plane in top view (nose right): straight high wing with four engines, fat fuselage, T-tail, and two
  // parachute canopies dropping behind it
  transportPlane: [
    F(join(circ(6.5, 9, 5), circ(6.5, 55, 5)), CREAM_L, { detail: true }),
    S(join(line(2, 9, 11, 9), line(6.5, 4.5, 6.5, 13.5), line(2, 55, 11, 55), line(6.5, 50.5, 6.5, 59.5)), CREAM_D, 1, { noOutline: true, detail: true }),
    F(poly(16, 29.5, 12, 17, 7.5, 17, 9, 29.5, 9, 34.5, 7.5, 47, 12, 47, 16, 34.5), '#7b8a70', { tint: 'dark' }),
    F(poly(39, 29, 35.5, 2.5, 30, 2.5, 29.5, 29, 29.5, 35, 30, 61.5, 35.5, 61.5, 39, 35), '#8e9c80', { tint: 'base' }),
    shadeC(rect(0, 33, 64, 31), 0.15),
    F(join(ell(41, 11, 5, 2.3), ell(41.5, 20.5, 5, 2.3), ell(41.5, 43.5, 5, 2.3), ell(41, 53, 5, 2.3)), '#5f6b55', { tint: 'dark', edge: true }),
    F('M8 32Q8 27.5 13 27.5L53 27.5Q61 28 63 32Q61 36 53 36.5L13 36.5Q8 36.5 8 32Z', '#a3b093', { tint: 'light', edge: true }),
    lightC(rect(0, 27.5, 64, 2), 0.25),
    shadeC(rect(0, 34.2, 64, 2.3), 0.2),
    C(ell(58.5, 32, 3, 2.4), GLASS_D),
    C(rect(18, 31.2, 26, 1.6), '#5f6b55', { tint: 'dark', detail: true }),
  ],
  fighter: [
    F(join(poly(4, 29.5, 12, 29.5, 7, 19, 3, 19), poly(4, 34.5, 12, 34.5, 7, 45, 3, 45)), '#7f8a95', { tint: 'dark' }),
    F(join(poly(40, 29, 23, 8, 17, 8, 20, 29), poly(40, 35, 23, 56, 17, 56, 20, 35)), '#909ba6', { tint: 'base' }),
    shadeC(rect(0, 34, 64, 30), 0.15),
    F('M2.5 30L9 28.5L44 28L56 30.3L63 32L56 33.7L44 36L9 35.5L2.5 34Z', '#a7b0b9', { tint: 'light', edge: true }),
    lightC(rect(0, 28, 64, 1.8), 0.22),
    shadeC(rect(0, 33.4, 64, 3), 0.2),
    C(ell(48, 32, 5.5, 1.9), GLASS_D),
    lightC(ell(47, 31.3, 2.5, 0.8), 0.4, { detail: true }),
    F(rect(1.5, 30.4, 2, 3.2), STEEL_DD, { noOutline: true }),
  ],
  rocket: [
    F('M10 29.5Q3 30 0.5 32Q3 34 10 34.5Z', '#d08a3c', { noOutline: true }),
    C(ell(8, 32, 4, 1.2), '#ecc77a'),
    F(join(poly(11, 28.5, 20, 28.5, 13, 19, 8, 19), poly(11, 35.5, 20, 35.5, 13, 45, 8, 45)), '#9a3d33', { tint: 'dark' }),
    F('M10 28.5L46 28.5Q58 29 63 32Q58 35 46 35.5L10 35.5Z', '#d9d6cd', { tint: 'light', edge: true }),
    C(rect(46, 20, 20, 24), '#9a3d33', { tint: 'dark' }),
    C(rect(22, 20, 2.4, 24), '#9a3d33', { tint: 'dark', detail: true }),
    lightC(rect(0, 28.5, 64, 1.5), 0.3),
    shadeC(rect(0, 32.6, 64, 4), 0.22),
  ],
  atomBomb: [
    // olive-khaki egg-shaped casing with a boxed tail-fin assembly; small trefoil
    F(poly(19, 27, 11, 29, 11, 35, 19, 37), '#5d6240', { tint: 'dark', edge: true }),
    F(rect(2.5, 17, 10, 30), '#5d6240', { tint: 'dark', edge: true }),
    C(join(rect(4.6, 19.2, 5.8, 11.3), rect(4.6, 33.5, 5.8, 11.3)), SHADE, { alpha: 0.6 }),
    S(join(line(4.6, 19.2, 10.4, 30.5), line(4.6, 44.8, 10.4, 33.5)), '#5d6240', 1, { tint: 'dark', clip: true, detail: true }),
    F('M17 32Q17 14.5 37 14.5Q61 14.5 62 32Q61 49.5 37 49.5Q17 49.5 17 32Z', '#9c9660', { tint: 'base', edge: true }),
    lightC(ell(35, 21, 16, 4.5), 0.2),
    shadeC(ell(40, 49, 26, 10), 0.25),
    S(join(line(28, 14, 28, 50), line(48, 15, 48, 49)), DARK, 0.8, { clip: true, detail: true, alpha: 0.45 }),
    F(circ(38, 32, 5.2), '#d8c672', { edge: true }),
    C(join(sector(38, 32, 1.5, 4.6, 60, 120), sector(38, 32, 1.5, 4.6, 180, 240), sector(38, 32, 1.5, 4.6, 300, 360)), DARK),
    C(circ(38, 32, 0.9), DARK),
  ],
  crown: [
    // three sharp points, ochre gold in three tones, small set stones
    F(poly(9, 45, 5, 18, 19, 31, 32, 8, 45, 31, 59, 18, 55, 45), '#c19a4a'),
    lightC(poly(0, 0, 32, 0, 32, 64, 0, 64), 0.16),
    shadeC(poly(32, 0, 64, 0, 64, 64, 32, 64), 0.22),
    S(join(line(19, 31, 21, 44), line(45, 31, 43, 44)), '#8a6a2c', 0.9, { clip: true, detail: true }),
    F(join(circ(5, 17.5, 1.9), circ(32, 7.5, 2.1), circ(59, 17.5, 1.9)), '#d6b46a', { edge: true }),
    F('M8 44Q32 48 56 44L56 54Q32 58 8 54Z', '#b38c40', { edge: true }),
    lightC('M8 44Q32 48 56 44L56 46.5Q32 50.5 8 46.5Z', 0.3),
    shadeC('M8 51.5Q32 55.5 56 51.5L56 58L8 58Z', 0.25),
    shadeC(rect(32, 0, 32, 64), 0.15),
    F(join(ell(20, 50.2, 1.6, 1.9), ell(44, 50.2, 1.6, 1.9)), '#4d6f9a', { noOutline: true, detail: true }),
    F(ell(32, 50.8, 2.2, 2.4), '#9c3a30', { noOutline: true }),
    lightC(circ(31.3, 50, 0.8), 0.5, { detail: true }),
    F(ell(32, 30, 1.7, 2.6), '#9c3a30', { noOutline: true, detail: true }),
  ],
  handshake: [
    // side view: forearms come in level from left and right; the left hand's thumb lies over the clasp and its
    // fingers wrap down over the back of the right hand
    F(poly(0, 24, 14, 24, 16, 44, 0, 44), '#56708e'), // left sleeve
    C(rect(11, 20, 6, 28), '#e6e1d4'),
    shadeC(rect(0, 38, 20, 8), 0.25),
    F(poly(64, 24, 50, 24, 48, 44, 64, 44), '#8a7d55'), // right sleeve
    C(rect(47, 20, 6, 28), '#e6e1d4'),
    shadeC(rect(44, 38, 20, 8), 0.25),
    F('M50 26L39 26Q31 26.5 27 30L18.5 37.5Q16 41.5 19.5 44L35 45L50 44Z', '#b4876a', { edge: true }), // right hand
    shadeC(rect(0, 40, 64, 6), 0.2),
    F('M14 25L28 24.5Q37 24.3 41 27L46.5 30.5Q48 37 45 42.5Q40 44.5 31 43.5L29 40L25 40.5Q19 40.5 15 43Z', '#dcb796', { edge: true }), // left hand
    lightC(rect(0, 20, 64, 6.5), 0.25),
    shadeC(rect(0, 41, 64, 6), 0.15),
    S(join('M33 33Q35 38 33.5 43.5', 'M37.5 32Q39.5 37.5 38.5 44', 'M42 31.5Q44 36.5 43 43'), '#9c7356', 1.1, {
      noOutline: true,
      detail: true,
    }), // fingers wrapping over the right hand
    S('M29 33Q37 30 46 31.5', '#9c7356', 1.1, { noOutline: true, detail: true }), // knuckle line
    F(join(ell(19.8, 41.6, 2.6, 2.2), ell(24, 42.4, 2.6, 2.2)), '#b4876a', { edge: true, detail: true }), // right fingertips
    F('M19 28Q25 21.5 34 22.5Q39 23.3 39.5 25.5Q39 27.3 35 27.3L23 29.5Z', '#e6c7a8', { edge: true }), // thumb
    S('M21 28.5Q28 25.5 37 25.3', '#9c7356', 0.9, { noOutline: true }),
  ],
  envelope: [
    F(rect(4, 15, 56, 36), CREAM),
    C(poly(4, 15, 4, 51, 29, 33), '#d8d1bf'),
    C(poly(60, 15, 60, 51, 35, 33), '#cfc8b5'),
    S(join(line(4, 51, 28, 33), line(60, 51, 36, 33)), CREAM_D, 1, { clip: true, detail: true }),
    F(poly(4, 15, 32, 37, 60, 15), CREAM_L, { edge: true }),
    F(circ(32, 36, 5), RED, { edge: true }),
    lightC(circ(30.4, 34.4, 2), 0.3),
  ],
  brokenShield: [
    F('M30.5 5L7.5 11.5L7.5 29Q7.5 49 29.5 59L31 49L26.5 41L32 30L27 20L31 12Z', STEEL_L),
    C('M32 10L12.5 15.5L12.5 29Q12.5 45 32 54Z', '#4f6e96'),
    lightC(rect(0, 0, 18, 64), 0.15),
    F('M35 5L58 11.5L58 29Q58 49 36 59L37.5 49L33 41L38.5 30L33.5 20L37.5 12Z', STEEL_L),
    C('M33.5 10L53 15.5L53 29Q53 45 33.5 54Z', '#4f6e96'),
    shadeC(rect(0, 0, 64, 64), 0.22),
  ],
  target: [
    // signal-red rings on a pale disc, thin crosshair ticks outside
    S(join(line(32, 2, 32, 10), line(32, 54, 32, 62), line(2, 32, 10, 32), line(54, 32, 62, 32)), STEEL_DD, 2),
    F(circ(32, 32, 23), '#e4ded0'),
    S(circ(32, 32, 20.5), '#a3483c', 4, { clip: true }),
    S(circ(32, 32, 12), '#a3483c', 3.6, { clip: true }),
    C(circ(32, 32, 4.4), '#a3483c'),
    S(join(line(32, 9, 32, 17), line(32, 47, 32, 55), line(9, 32, 17, 32), line(47, 32, 55, 32)), DARK, 0.9, { clip: true, detail: true, alpha: 0.5 }),
  ],
  skull: [
    // narrower cranium with cheekbones, separate jaw, angular sockets; lit left, shaded right
    F('M32 5Q50 5 50.5 24Q51 33 46 38L44.5 43L19.5 43L18 38Q13 33 13.5 24Q14 5 32 5Z', '#ddd7c5'),
    lightC(ell(23, 14, 9, 6), 0.3),
    shadeC(poly(33, 0, 64, 0, 64, 64, 36, 64), 0.22),
    F(join(poly(18.5, 24.5, 29, 26.5, 28, 33.5, 20.5, 33), poly(45.5, 24.5, 35, 26.5, 36, 33.5, 43.5, 33)), '#2a2a2c', { noOutline: true }),
    F('M32 34.5L29 40.5L32 39.4L35 40.5Z', '#2a2a2c', { noOutline: true }),
    S(join(line(25, 40.5, 25, 43), line(28.5, 41, 28.5, 43), line(32, 41.5, 32, 43), line(35.5, 41, 35.5, 43), line(39, 40.5, 39, 43)), '#8f897a', 0.9, {
      noOutline: true,
      detail: true,
    }),
    F('M20.5 46L43.5 46L42 53Q40 58.5 32 58.5Q24 58.5 22 53Z', '#d2cbb7'),
    shadeC(poly(33, 0, 64, 0, 64, 64, 34, 64), 0.22),
    shadeC(rect(0, 55, 64, 6), 0.18),
    S(join(line(22, 49.5, 42, 49.5), line(25.5, 46, 25.5, 49.5), line(29, 46, 29, 49.5), line(32, 46, 32, 49.5), line(35, 46, 35, 49.5), line(38.5, 46, 38.5, 49.5)), '#8f897a', 0.9, {
      clip: true,
      detail: true,
    }),
  ],
  infantry: [
    F('M8 63Q8 49 19 45L27 43L40 43L47 46Q56 50 57 63Z', OLIVE),
    lightC(rect(0, 0, 22, 64), 0.12),
    shadeC(rect(44, 0, 20, 64), 0.25),
    S(line(24, 44, 36, 63), OLIVE_D, 2.2, { clip: true, detail: true }),
    F(rect(29, 35, 9, 9), SKIN_D),
    F('M24 30Q24 20 33 20Q41.5 20 43 27L45.5 32.5L43 33.5L43.5 36.5Q42 40.5 37 40.5L31 40.5Q24.5 39.5 24 30Z', SKIN, { edge: true }),
    shadeC(rect(0, 28, 64, 6.5), 0.5), // shadow under the helmet brim
    shadeC(rect(0, 34.5, 64, 3), 0.2),
    shadeC(rect(37, 0, 20, 64), 0.15),
    F('M20 28Q20 12 34 12Q48 12 48 26L50.5 27.5Q51 30 48.5 30L21 30Q18.5 30 20 28Z', OLIVE_D, { edge: true }),
    lightC(ell(29, 17, 7, 3.5), 0.18),
    shadeC(rect(0, 27.5, 64, 4), 0.2),
    S(line(36, 26, 36.5, 31.5), OLIVE_DD, 0.9, { noOutline: true, detail: true }),
    F(rpoly(16, 60, 40, 0, -1.6, 50, -1, 50, 1, 0, 1.8), STEEL_DD, { edge: true }),
    F(rpoly(16, 60, 40, 12, 1.5, 17, 1.5, 15.5, 7, 12.5, 6.5), STEEL_DD, { edge: true }),
    F(rpoly(16, 60, 40, -3, -2.4, 12, -2.2, 14, 0.5, 12, 3.4, -3, 4), WOOD, { edge: true }),
    lightC(rpoly(16, 60, 40, -4, -3, 16, -3, 16, -0.6, -4, -0.6), 0.2),
  ],
  armor: [
    F(rrect(4, 43, 54, 15, 7.5), RUBBER),
    F(join(...[11.5, 20, 28.5, 37, 45.5].map((x) => circ(x, 51.5, 4)), circ(53, 50, 3.2)), STEEL_D, { noOutline: true }),
    F(join(...[11.5, 20, 28.5, 37, 45.5].map((x) => circ(x, 51.5, 1.4))), STEEL_L, { noOutline: true, detail: true }),
    F(poly(3, 39, 7, 33.5, 50, 33.5, 62, 39, 59, 45, 5, 45), OLIVE_L, { edge: true }),
    shadeC(rect(0, 40.5, 64, 6), 0.28),
    F(poly(46, 24.2, 63, 24.8, 63, 27.6, 46, 28.2), OLIVE_D, { edge: true }),
    F(rect(53, 23.6, 4, 4.8), OLIVE_D, { edge: true, detail: true }),
    F(rect(27, 16.5, 9, 4.5), OLIVE_D, { edge: true }),
    F(poly(17, 34, 19, 25, 25, 20.5, 42, 20.5, 51, 23.5, 52, 30, 49, 34), OLIVE, { edge: true }),
    lightC(rect(0, 0, 64, 24), 0.15),
    shadeC(rect(0, 30, 64, 10), 0.25),
  ],
  artillery: [...howitzer(25.5, 45, 1)],
};


// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

export type TintColor = string | readonly [number, number, number];

export interface IconDrawOptions {
  /** Owner colour: recolours tinted layers (unit hulls/bodies, building flags). */
  tint?: TintColor;
  alpha?: number;
  /** Device pixel ratio (1-3). Default: window.devicePixelRatio. */
  dpr?: number;
  /** Light halo around the outline for map visibility: true = white, or a CSS colour. */
  outline?: boolean | string;
  /** drawIcon only: (x, y) is the top-left corner (default) or the centre. */
  anchor?: 'topLeft' | 'center';
  /** drawIcon only: rotation in radians around the icon centre (units are drawn pointing right). */
  rotation?: number;
}

/** Layers with fine detail are skipped below this many device pixels. */
export const DETAIL_MIN_PX = 22;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function parseColor(c: TintColor): [number, number, number] {
  if (typeof c !== 'string') return [c[0], c[1], c[2]];
  const s = c.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)) as [number, number, number];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const m = s.match(/(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [128, 128, 128];
}
function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
/** Mixes towards black (amt < 0) or white (amt > 0). */
function shade(rgb: [number, number, number], amt: number): string {
  const t = amt < 0 ? 0 : 255;
  const a = Math.abs(amt);
  return toHex([rgb[0] + (t - rgb[0]) * a, rgb[1] + (t - rgb[1]) * a, rgb[2] + (t - rgb[2]) * a]);
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const pathCache = new Map<string, Path2D>();
function path(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

/** Outline thickness in device px for an icon of sizeDev device px. */
function outlinePx(sizeDev: number): number {
  return clamp(sizeDev / 28, 0.9, 2);
}
function haloPx(sizeDev: number): number {
  return clamp(sizeDev / 22, 1, 2.5);
}

/**
 * Draws an icon with its top-left corner at the current origin, sizeDev x sizeDev device pixels.
 * Uncached: use drawIcon / iconCanvas in render loops.
 */
export function renderIcon(ctx: Ctx2D, id: IconId, sizeDev: number, opts: Pick<IconDrawOptions, 'tint' | 'outline'> = {}): void {
  const layers = ICON_DATA[id];
  const o = outlinePx(sizeDev);
  const h = opts.outline ? haloPx(sizeDev) : 0;
  const pad = o + h;
  const s = (sizeDev - 2 * pad) / 64;
  const ou = o / s;
  const hu = h / s;
  const minLine = 0.9 / s;
  const small = sizeDev < DETAIL_MIN_PX;
  const tint = opts.tint !== undefined ? parseColor(opts.tint) : null;
  const tintColors = tint ? { base: toHex(tint), dark: shade(tint, -0.3), light: shade(tint, 0.3) } : null;
  const visible = layers.filter((l) => !(small && l.detail));

  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';

  const outlinePass = (color: string, extra: number): void => {
    ctx.strokeStyle = color;
    for (const l of visible) {
      if (l.noOutline || l.clip) continue;
      ctx.lineCap = l.cap ?? 'round';
      ctx.lineWidth = (l.stroke ? Math.max(l.width ?? 1, minLine) : 0) + 2 * extra;
      ctx.stroke(path(l.d));
    }
  };
  if (h > 0) outlinePass(typeof opts.outline === 'string' ? opts.outline : '#ffffff', ou + hu);
  outlinePass(OUT, ou);

  let parent: Path2D | null = null;
  const edges: Path2D[] = [];
  const flushEdges = (): void => {
    if (edges.length === 0) return;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = OUT;
    ctx.lineCap = 'round';
    ctx.lineWidth = ou * 0.85;
    for (const p of edges) ctx.stroke(p);
    edges.length = 0;
  };
  for (const l of visible) {
    if (!l.noOutline && !l.clip) flushEdges();
    const color = l.tint && tintColors ? tintColors[l.tint] : undefined;
    const p = path(l.d);
    const clipped = l.clip === true && parent !== null;
    if (clipped) {
      ctx.save();
      ctx.clip(parent!);
    }
    ctx.globalAlpha = l.alpha ?? 1;
    if (l.fill) {
      ctx.fillStyle = color ?? l.fill;
      ctx.fill(p);
    }
    if (l.stroke) {
      ctx.strokeStyle = l.fill ? l.stroke : (color ?? l.stroke);
      ctx.lineCap = l.cap ?? 'round';
      ctx.lineWidth = Math.max(l.width ?? 1, minLine);
      ctx.stroke(p);
    }
    if (clipped) ctx.restore();
    if (!l.clip) parent = p;
    if (l.edge) edges.push(p);
  }
  flushEdges();
  ctx.restore();
}

// ---- canvases and atlas -----------------------------------------------------------------------------------

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('icons: no canvas available');
}

function defaultDpr(): number {
  const d = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  return d || 1;
}
/** Device pixel size for a CSS size: dpr clamped to 1-3, whole pixels. */
function devSize(sizePx: number, dpr: number | undefined): number {
  return Math.max(4, Math.round(sizePx * clamp(dpr ?? defaultDpr(), 1, 3)));
}
function tintKey(t: TintColor | undefined): string {
  return t === undefined ? '' : toHex(parseColor(t));
}
function haloKey(o: boolean | string | undefined): string {
  return !o ? '' : o === true ? '#fff' : o;
}

const ATLAS_COLS = 8;
interface Atlas {
  canvas: AnyCanvas;
  ctx: Ctx2D;
  cell: number;
  drawn: Set<IconId>;
}
const atlases = new Map<string, Atlas>();
const atlasSlot = new Map<IconId, number>(ICON_IDS.map((id, i) => [id, i]));

function getAtlas(sizeDev: number, tint: TintColor | undefined, outline: boolean | string | undefined): Atlas {
  const key = `${sizeDev}|${tintKey(tint)}|${haloKey(outline)}`;
  let a = atlases.get(key);
  if (!a) {
    const cell = sizeDev + 2; // 1 px gap on each side: no bleeding when sampled
    const rows = Math.ceil(ICON_IDS.length / ATLAS_COLS);
    const canvas = makeCanvas(cell * ATLAS_COLS, cell * rows);
    const ctx = canvas.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error('icons: 2d context unavailable');
    a = { canvas, ctx, cell, drawn: new Set() };
    atlases.set(key, a);
  }
  return a;
}

/** Atlas canvas and source rectangle of an icon (drawn into the atlas on first use). */
export function iconSprite(
  id: IconId,
  sizePx: number,
  opts: Pick<IconDrawOptions, 'tint' | 'outline' | 'dpr'> = {},
): { canvas: AnyCanvas; sx: number; sy: number; size: number } {
  const sizeDev = devSize(sizePx, opts.dpr);
  const a = getAtlas(sizeDev, opts.tint, opts.outline);
  const slot = atlasSlot.get(id)!;
  const sx = (slot % ATLAS_COLS) * a.cell + 1;
  const sy = Math.floor(slot / ATLAS_COLS) * a.cell + 1;
  if (!a.drawn.has(id)) {
    a.ctx.save();
    a.ctx.translate(sx, sy);
    renderIcon(a.ctx, id, sizeDev, opts);
    a.ctx.restore();
    a.drawn.add(id);
  }
  return { canvas: a.canvas, sx, sy, size: sizeDev };
}

/**
 * Draws a cached icon. sizePx and (x, y) are in the context's units (CSS px); opts.dpr says how many device
 * pixels one unit covers (default window.devicePixelRatio), so the sprite is rendered at full resolution.
 */
export function drawIcon(ctx: Ctx2D, id: IconId, x: number, y: number, sizePx: number, opts: IconDrawOptions = {}): void {
  const sp = iconSprite(id, sizePx, opts);
  const half = sizePx / 2;
  const cx = opts.anchor === 'center' ? x : x + half;
  const cy = opts.anchor === 'center' ? y : y + half;
  const prevAlpha = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = prevAlpha * opts.alpha;
  if (opts.rotation) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(opts.rotation);
    ctx.drawImage(sp.canvas, sp.sx, sp.sy, sp.size, sp.size, -half, -half, sizePx, sizePx);
    ctx.restore();
  } else {
    ctx.drawImage(sp.canvas, sp.sx, sp.sy, sp.size, sp.size, cx - half, cy - half, sizePx, sizePx);
  }
  ctx.globalAlpha = prevAlpha;
}

const canvasCache = new Map<string, AnyCanvas>();

/** A canvas holding only this icon, sizePx * dpr device pixels square (cached; do not draw into it). */
export function iconCanvas(id: IconId, sizePx: number, opts: Pick<IconDrawOptions, 'tint' | 'outline' | 'dpr'> = {}): AnyCanvas {
  const sizeDev = devSize(sizePx, opts.dpr);
  const key = `${id}|${sizeDev}|${tintKey(opts.tint)}|${haloKey(opts.outline)}`;
  let c = canvasCache.get(key);
  if (!c) {
    c = makeCanvas(sizeDev, sizeDev);
    const ctx = c.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error('icons: 2d context unavailable');
    renderIcon(ctx, id, sizeDev, opts);
    canvasCache.set(key, c);
  }
  return c;
}

const urlCache = new Map<string, string>();

/** PNG data URL for <img> tags (browser only). Rendered at sizePx * dpr; set the <img> to sizePx CSS px. */
export function iconDataUrl(id: IconId, sizePx: number, opts: Pick<IconDrawOptions, 'tint' | 'outline' | 'dpr'> = {}): string {
  const sizeDev = devSize(sizePx, opts.dpr);
  const key = `${id}|${sizeDev}|${tintKey(opts.tint)}|${haloKey(opts.outline)}`;
  let u = urlCache.get(key);
  if (!u) {
    const c = document.createElement('canvas');
    c.width = sizeDev;
    c.height = sizeDev;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('icons: 2d context unavailable');
    renderIcon(ctx, id, sizeDev, opts);
    u = c.toDataURL('image/png');
    urlCache.set(key, u);
  }
  return u;
}

/** Drops every cached sprite (e.g. after a devicePixelRatio change). */
export function clearIconCache(): void {
  atlases.clear();
  canvasCache.clear();
  urlCache.clear();
  markerAtlases.clear();
  markerUrlCache.clear();
  silhouetteCache.clear();
}

// ---------------------------------------------------------------------------------------------------------------
// Map markers: the second tier of building art. A small plate in the owner's colour (darker rim) with a white,
// simplified silhouette of the same object as the detailed icon (same shape language, far fewer parts), so the map
// stays calm and a marker still reads as "the barn", "the crane", "the launcher". Deposits get small coloured
// markers without a plate (iron = grey rocks, oil = black drop, fertile = wheat ear).
// Glyph space is 64 x 64 units like the icons. Layer modes:
//   fill      glyph colour (white on a plate; `color` for deposits)
//   stroke    glyph colour line of `width` units
//   cut       filled in the plate colour (holes: doors, windows, the gap of an arch)
//   cutStroke stroked in the plate colour
// `ring` first strokes the shape in the plate colour (4 units) so overlapping parts stay apart.
// ---------------------------------------------------------------------------------------------------------------

export type MarkerId = BuildingIconId | ResourceIconId;
export interface MarkerLayer {
  d: string;
  mode?: 'fill' | 'stroke' | 'cut' | 'cutStroke';
  width?: number;
  ring?: boolean;
  /** Deposit markers: own colour (default white / plate colour). */
  color?: string;
  /** Skipped below MARKER_DETAIL_PX device pixels. */
  detail?: boolean;
}

export const MARKER_IDS: readonly MarkerId[] = [
  'city', 'farm', 'market', 'mine', 'oilWell', 'barracks', 'factory', 'arsenal', 'fort', 'supplyDepot',
  'watchtower', 'port', 'lab', 'hospital', 'airfield', 'sam', 'silo', 'iron', 'oil', 'fertile',
];
export const MARKER_DETAIL_PX = 26;

const MF = (d: string, o: Partial<MarkerLayer> = {}): MarkerLayer => ({ d, mode: 'fill', ...o });
const MS = (d: string, width: number, o: Partial<MarkerLayer> = {}): MarkerLayer => ({ d, mode: 'stroke', width, ...o });
const MC = (d: string, o: Partial<MarkerLayer> = {}): MarkerLayer => ({ d, mode: 'cut', ...o });

const IRON_C = '#a29c93';
const IRON_L = '#cdc7bd';
const RUST = '#b5693f';
const OIL_C = '#15161a';
const WHEAT = '#e9bd42';
const WHEAT_D = '#b38a2c';

export const MARKER_DATA: Record<MarkerId, MarkerLayer[]> = {
  // skyline of towers
  city: [
    MF('M8 56V30H17V22H25V9H38V25H45V17H56V56Z'),
    MC(join(rect(16.2, 30, 1.6, 26), rect(24.2, 22, 1.6, 34), rect(37.2, 25, 1.6, 31), rect(44.2, 17, 1.6, 39))),
    MC(windowGrid([28.5, 33.5], [14, 21, 28, 35], 2.6, 3.6), { detail: true }),
  ],
  // barn with a gambrel roof, big door and loft window
  farm: [
    MF('M10 56V32L15 21L32 11L49 21L54 32V56Z'),
    MC('M24 56V39H40V56Z'),
    MC(rect(28.5, 23, 7, 7)),
    MS(join(line(24, 39, 40, 56), line(40, 39, 24, 56)), 1.6, { detail: true }),
  ],
  // stall: scalloped striped awning on two posts over a counter
  market: [
    MF('M12 11H52L58 27Q51.5 34 45 27Q38.5 34 32 27Q25.5 34 19 27Q12.5 34 6 27Z'),
    MC(join(poly(22.5, 11, 27.5, 11, 26.2, 28, 21, 28), poly(36.5, 11, 41.5, 11, 43, 28, 37.8, 28))),
    MF(join(rect(9, 31, 4, 23), rect(51, 31, 4, 23))),
    MF(rect(6, 42, 52, 13)),
    MC(rect(6, 46, 52, 1.6), { detail: true }),
  ],
  // hillside with an arched adit and an ore cart in it
  mine: [
    MF('M4 57L12 38Q20 21 34 19Q48 17 60 36V57Z'),
    MC('M19 57V42A13 13 0 0 1 45 42V57Z'),
    MF(join(poly(24, 43, 40, 43, 38, 51, 26, 51), circ(28.5, 53.5, 2.6), circ(35.5, 53.5, 2.6))),
  ],
  // pumpjack: horse head, walking beam on an A-frame, counterweight, wellhead
  oilWell: [
    MF(rect(5, 52, 54, 5)),
    MS(join(line(24, 52, 32, 21), line(40, 52, 32, 21)), 4.4),
    MS(line(10.5, 33, 10.5, 52), 2),
    MF(rect(6.5, 46, 8, 6)),
    MF(rpoly(31, 21, -8, -19, -2.8, 21, -2.8, 21, 2.8, -19, 2.8), { ring: true }),
    MF('M8 16Q3 25 8.5 34L14 32V18Z', { ring: true }),
    MF(rect(46, 26, 10, 9), { ring: true }),
  ],
  // long barracks hall with a flag
  barracks: [
    MF(join(poly(4, 32, 10, 22, 44, 22, 50, 32), rect(6, 32, 42, 22))),
    MC(join(rect(23, 40, 8, 14), rect(11, 38, 6, 6), rect(37, 38, 6, 6))),
    MS(line(55.5, 54, 55.5, 8), 2.4),
    MF(poly(56.5, 7.5, 64, 11.5, 56.5, 15.5)),
  ],
  // saw-tooth roof hall, chimney and smoke
  factory: [
    MF('M6 56V30L18 21V30L30 21V30L42 21V56Z'),
    MF(rect(45, 15, 8, 41)),
    MF(join(circ(50, 9, 4.2), circ(57.5, 5.5, 3))),
    MC(join(rect(11, 39, 6, 6), rect(22, 39, 6, 6), rect(33, 39, 6, 6))),
  ],
  // depot hall behind a wheeled cannon
  arsenal: [
    MF(poly(6, 38, 6, 22, 14, 12, 50, 12, 58, 22, 58, 38)),
    MC(rect(34, 24, 14, 14)),
    MF(rpoly(31, 40, 28, -17, -3.4, 15, -3.4, 15, 3.4, -17, 3.4), { ring: true }),
    MS(line(22, 48, 8, 57), 3.4, { ring: true }),
    MF(circ(23, 48, 8), { ring: true }),
    MC(circ(23, 48, 2.6)),
  ],
  // stone fort: two crenellated towers, a crenellated wall and an arched gate
  fort: [
    MF(join(
      rect(6, 18, 14, 38), rect(6, 12.5, 3.8, 6), rect(11.1, 12.5, 3.8, 6), rect(16.2, 12.5, 3.8, 6),
      rect(20, 30, 24, 26), rect(22, 25, 4, 6), rect(30, 25, 4, 6), rect(38, 25, 4, 6),
      rect(44, 18, 14, 38), rect(44, 12.5, 3.8, 6), rect(49.1, 12.5, 3.8, 6), rect(54.2, 12.5, 3.8, 6),
    )),
    MC('M26 56V46A6 6 0 0 1 38 46V56Z'),
    MC(join(rect(11.5, 25, 3, 7), rect(49.5, 25, 3, 7)), { detail: true }),
  ],
  // stacked crates
  supplyDepot: [
    MF(join(rrect(7, 36, 23, 20, 1.5), rrect(34, 36, 23, 20, 1.5), rrect(20.5, 13, 23, 20, 1.5))),
    { d: join(line(7, 36, 30, 56), line(34, 36, 57, 56), line(20.5, 13, 43.5, 33)), mode: 'cutStroke', width: 2, detail: true },
  ],
  // tall wooden tower: splayed legs, cabin, pointed roof
  watchtower: [
    MS(join(line(18, 58, 25, 26), line(46, 58, 39, 26)), 4.2),
    MS(join(line(21, 46, 43, 36), line(43, 46, 21, 36)), 2.2, { detail: true }),
    MF(rect(14.5, 25, 35, 4)),
    MF(rect(18, 15, 28, 10)),
    MC(rect(21, 17, 22, 5), { detail: true }),
    MF(poly(13, 16, 32, 5, 51, 16)),
  ],
  // harbour: dock, crane with a hook, a container, waves
  port: [
    MF(rect(4, 43, 56, 6)),
    MF(rect(15, 11, 5.5, 32)),
    MF(rect(10, 9, 47, 4.6)),
    MS(line(49, 13.6, 49, 27), 1.8),
    MF(rect(45.5, 27, 7, 5.5)),
    MF(rect(26, 34, 13, 9)),
    MS('M4 56Q9 52.5 14 56T24 56T34 56T44 56T54 56T64 56', 2.6),
  ],
  // laboratory flask with bubbles
  lab: [
    MF('M25 9H39V14H36.5V25L50.5 49.5Q53 56 46 56H18Q11 56 13.5 49.5L27.5 25V14H25Z'),
    MC('M20.5 42H43.5L47.5 49.5Q48.5 52 45.5 52H18.5Q15.5 52 16.5 49.5Z'),
    MF(join(circ(28, 46, 2.4), circ(36, 48, 1.8)), { detail: true }),
  ],
  // hospital block with a cross
  hospital: [
    MF(rrect(9, 13, 46, 44, 2)),
    MC(poly(27.5, 21, 36.5, 21, 36.5, 30.5, 46, 30.5, 46, 39.5, 36.5, 39.5, 36.5, 49, 27.5, 49, 27.5, 39.5, 18, 39.5, 18, 30.5, 27.5, 30.5)),
  ],
  // aeroplane seen from above
  airfield: [
    MF('M32 5Q35.5 5 35.5 12V24L58 36V41.5L35.5 35V47.5L43.5 53.5V57.5L32 54.5L20.5 57.5V53.5L28.5 47.5V35L6 41.5V36L28.5 24V12Q28.5 5 32 5Z'),
  ],
  // launcher truck with three missiles angled up
  sam: [
    MF(join(rect(5, 42, 42, 9), rect(45, 35, 14, 16))),
    MC(rect(48, 38, 8, 5), { detail: true }),
    MF(join(circ(13, 52, 4.2), circ(25, 52, 4.2), circ(51, 52, 4.2)), { ring: true }),
    ...[0, 1, 2].map((k) => MF(rpoly(14 + k * 9, 38, 52, 0, -2.6, 25, -2.6, 30, 0, 25, 2.6, 0, 2.6), { ring: true })),
  ],
  // open hatch with a missile rising out of it
  silo: [
    MF(rect(4, 48, 56, 8)),
    MC(rect(21, 48, 22, 4)),
    MS(join(line(21, 48, 12, 39), line(43, 48, 52, 39)), 3),
    MF(join(rect(27, 17, 10, 33), poly(27, 17, 32, 6, 37, 17), poly(27, 38, 21, 47, 27, 45), poly(37, 38, 43, 47, 37, 45)), { ring: true }),
  ],
  // grey-brown ore rocks with rust flecks
  iron: [
    MF('M4 57L8 34L22 21L37 28L41 45L38 57Z', { color: IRON_C }),
    MF('M8 34L22 21L25 34L14 41Z', { color: IRON_L }),
    MF('M31 57L36 38L50 29L61 42L61 57Z', { color: IRON_C }),
    MF('M36 38L50 29L50 40L41 45Z', { color: IRON_L }),
    MF(join(circ(19, 47, 3.2), circ(49, 49, 3), circ(29, 37, 2.2)), { color: RUST }),
  ],
  // black drop with a glint
  oil: [
    MF('M32 5C32 5 51 28 51 40A19 19 0 0 1 13 40C13 28 32 5 32 5Z', { color: OIL_C }),
    MF(ell(24.5, 40, 3.2, 6.5), { color: '#5d636e' }),
  ],
  // golden wheat ear on a stem
  fertile: [
    MS(line(32, 61, 32, 16), 3, { color: WHEAT_D }),
    MF(join(
      ell(32, 10, 4.4, 7.5),
      ...[0, 1, 2, 3].flatMap((k) => [rell(25.5, 19 + k * 9, 4.6, 7.8, -34), rell(38.5, 19 + k * 9, 4.6, 7.8, 34)]),
    ), { color: WHEAT }),
  ],
};

export interface MarkerOptions {
  /** Plate colour (owner); null / undefined = no plate (deposits). */
  plate?: TintColor | null;
  /** 'square' (map markers) or 'disc' (category discs in menus). */
  shape?: 'square' | 'disc';
  /** Device pixel ratio (1-3). Default: window.devicePixelRatio. */
  dpr?: number;
}

const OUTLINE_DARK = '#1f2126';

function luminance(rgb: [number, number, number]): number {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/** Draws a marker with its top-left corner at the current origin, sizeDev x sizeDev device pixels (uncached). */
export function renderMarker(ctx: Ctx2D, id: MarkerId, sizeDev: number, opts: Pick<MarkerOptions, 'plate' | 'shape'> = {}): void {
  const layers = MARKER_DATA[id];
  const plated = opts.plate !== undefined && opts.plate !== null;
  const small = sizeDev < MARKER_DETAIL_PX;
  const visible = layers.filter((l) => !(small && l.detail));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let plateCol = '#000000';
  const glyphCol = '#ffffff';
  let glyphScale: number;
  if (plated) {
    const rgb = parseColor(opts.plate!);
    // a deep shade of the owner's colour with a white glyph: high contrast on any land (light or dark), and the
    // hue still says whose it is
    plateCol = shade(rgb, luminance(rgb) > 0.6 ? -0.68 : -0.58);
    const rim = shade(rgb, -0.85);
    const rimW = clamp(sizeDev * 0.075, 1, 3);
    const s = sizeDev - rimW;
    ctx.beginPath();
    if (opts.shape === 'disc') ctx.arc(sizeDev / 2, sizeDev / 2, s / 2, 0, Math.PI * 2);
    else ctx.roundRect(rimW / 2, rimW / 2, s, s, s * 0.24);
    ctx.fillStyle = plateCol;
    ctx.fill();
    ctx.lineWidth = rimW;
    ctx.strokeStyle = rim;
    ctx.stroke();
    glyphScale = (sizeDev * (opts.shape === 'disc' ? 0.66 : sizeDev < 24 ? 0.8 : 0.74)) / 64;
  } else {
    glyphScale = (sizeDev * 0.9) / 64;
  }
  const off = (sizeDev - 64 * glyphScale) / 2;
  ctx.translate(off, off);
  ctx.scale(glyphScale, glyphScale);
  const minW = 0.9 / glyphScale;
  if (!plated) {
    // deposits: a dark outline (white for the black oil drop) around every shape
    const halo = id === 'oil' ? '#f4f1ea' : OUTLINE_DARK;
    const hw = clamp(sizeDev / 20, 1, 2.2) / glyphScale;
    ctx.strokeStyle = halo;
    for (const l of visible) {
      if (l.mode === 'cut' || l.mode === 'cutStroke') continue;
      ctx.lineWidth = (l.mode === 'stroke' ? Math.max(l.width ?? 1, minW) : 0) + 2 * hw;
      ctx.stroke(path(l.d));
    }
  }
  for (const l of visible) {
    const p = path(l.d);
    const mode = l.mode ?? 'fill';
    if (l.ring && plated) {
      ctx.strokeStyle = plateCol;
      ctx.lineWidth = (mode === 'stroke' ? Math.max(l.width ?? 1, minW) : 0) + 4;
      ctx.stroke(p);
    }
    const own = l.color ?? glyphCol;
    if (mode === 'fill') {
      ctx.fillStyle = own;
      ctx.fill(p);
    } else if (mode === 'stroke') {
      ctx.strokeStyle = own;
      ctx.lineWidth = Math.max(l.width ?? 1, minW);
      ctx.stroke(p);
    } else if (mode === 'cut') {
      ctx.fillStyle = plated ? plateCol : (l.color ?? OUTLINE_DARK);
      ctx.fill(p);
    } else {
      ctx.strokeStyle = plated ? plateCol : (l.color ?? OUTLINE_DARK);
      ctx.lineWidth = Math.max(l.width ?? 1, minW);
      ctx.stroke(p);
    }
  }
  ctx.restore();
}

interface MarkerAtlas {
  canvas: AnyCanvas;
  ctx: Ctx2D;
  cell: number;
  drawn: Set<MarkerId>;
}
const markerAtlases = new Map<string, MarkerAtlas>();
const markerSlot = new Map<MarkerId, number>(MARKER_IDS.map((id, i) => [id, i]));
const markerUrlCache = new Map<string, string>();

/** Atlas canvas and source rectangle of a marker (drawn into a per-size, per-plate atlas on first use). */
export function markerSprite(id: MarkerId, sizePx: number, opts: MarkerOptions = {}): { canvas: AnyCanvas; sx: number; sy: number; size: number } {
  const sizeDev = devSize(sizePx, opts.dpr);
  const plate = opts.plate === undefined || opts.plate === null ? '' : tintKey(opts.plate);
  const key = `${sizeDev}|${plate}|${opts.shape ?? 'square'}`;
  let a = markerAtlases.get(key);
  if (!a) {
    const cell = sizeDev + 2;
    const rows = Math.ceil(MARKER_IDS.length / ATLAS_COLS);
    const canvas = makeCanvas(cell * ATLAS_COLS, cell * rows);
    const ctx = canvas.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error('icons: 2d context unavailable');
    a = { canvas, ctx, cell, drawn: new Set() };
    markerAtlases.set(key, a);
  }
  const slot = markerSlot.get(id)!;
  const sx = (slot % ATLAS_COLS) * a.cell + 1;
  const sy = Math.floor(slot / ATLAS_COLS) * a.cell + 1;
  if (!a.drawn.has(id)) {
    a.ctx.save();
    a.ctx.translate(sx, sy);
    renderMarker(a.ctx, id, sizeDev, opts);
    a.ctx.restore();
    a.drawn.add(id);
  }
  return { canvas: a.canvas, sx, sy, size: sizeDev };
}

/** True when the marker for this size / plate is already rendered (drawing it costs one drawImage). */
export function markerReady(id: MarkerId, sizePx: number, opts: MarkerOptions = {}): boolean {
  const sizeDev = devSize(sizePx, opts.dpr);
  const plate = opts.plate === undefined || opts.plate === null ? '' : tintKey(opts.plate);
  return markerAtlases.get(`${sizeDev}|${plate}|${opts.shape ?? 'square'}`)?.drawn.has(id) ?? false;
}

/** Draws a cached marker centred at (x, y); sizePx in the context's units (CSS px). */
export function drawMarker(ctx: Ctx2D, id: MarkerId, x: number, y: number, sizePx: number, opts: MarkerOptions & { alpha?: number } = {}): void {
  const sp = markerSprite(id, sizePx, opts);
  const half = sizePx / 2;
  const prev = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = prev * opts.alpha;
  ctx.drawImage(sp.canvas, sp.sx, sp.sy, sp.size, sp.size, x - half, y - half, sizePx, sizePx);
  ctx.globalAlpha = prev;
}

/** PNG data URL of a marker (browser only), e.g. a category disc: { plate: ICON_INFO[id].color, shape: 'disc' }. */
export function markerDataUrl(id: MarkerId, sizePx: number, opts: MarkerOptions = {}): string {
  const sizeDev = devSize(sizePx, opts.dpr);
  const key = `${id}|${sizeDev}|${opts.plate ? tintKey(opts.plate) : ''}|${opts.shape ?? 'square'}`;
  let u = markerUrlCache.get(key);
  if (!u) {
    const c = document.createElement('canvas');
    c.width = sizeDev;
    c.height = sizeDev;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('icons: 2d context unavailable');
    renderMarker(ctx, id, sizeDev, opts);
    u = c.toDataURL('image/png');
    markerUrlCache.set(key, u);
  }
  return u;
}

const silhouetteCache = new Map<string, AnyCanvas>();

/**
 * The icon's shape (with its halo) filled with one flat colour: drop shadows under units.
 * sizePx * dpr device pixels square, cached.
 */
export function iconSilhouette(id: IconId, sizePx: number, color: string, opts: Pick<IconDrawOptions, 'dpr'> = {}): AnyCanvas {
  const sizeDev = devSize(sizePx, opts.dpr);
  const key = `${id}|${sizeDev}|${color}`;
  let c = silhouetteCache.get(key);
  if (!c) {
    c = makeCanvas(sizeDev, sizeDev);
    const ctx = c.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error('icons: 2d context unavailable');
    renderIcon(ctx, id, sizeDev, { outline: true });
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, sizeDev, sizeDev);
    silhouetteCache.set(key, c);
  }
  return c;
}
