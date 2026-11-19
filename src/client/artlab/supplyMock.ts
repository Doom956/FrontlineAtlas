// The art lab's "Supply" row (art lab builds only): the first look of the supply lines. Rails between a nation's hubs
// (capital, cities, factories, ports, forts), rail yards, trains, convoys on sea lanes, a damaged hub and a cut front,
// each at the close look, at normal game zoom and far out, next to today's map (the same scene without supply art).
// The terrain is a small made-up map painted with grass, forest, hills, mountains, desert, swamp, tundra, rivers and
// sea, drawn by the game's own map shader (render/glmap.ts MapGL, the real ground pass), so the lines are judged on the
// ground they will lie on. Where the lines run is art/detailed/supplyLines.ts (pure, tested); the pixels and sprites are
// art/detailed/supplyArt.ts.
import { MapGL, artPixelsPerTile } from '../render/glmap';
import { buildTerrain, type TerrainData } from '../render/terrain';
import { DEFAULT_THEME } from '../render/mapThemes';
import { groundBuilt } from '../render/ground';
import { mapStyle } from '../render/mapStyle';
import { ownedGround } from '../render/linkLayer';
import { markerSize, CATEGORY_PLATES } from '../render/buildings';
import { spriteScale } from '../render/units';
import { drawMarker, ICON_INFO, type BuildingIconId } from '../icons';
import { isWater, type MapData } from '../../sim/types';
import type { RGB } from '../art/shared/colour';
import { bakeBuilding, bakeBuildingFar, COAST, levelPill, OU, OV, type BuildingSpec, type Under } from '../art/detailed/buildings';
import { trackArt, type TrackGround, type TrackPixels } from '../art/detailed/buildingLinkArt';
import { trackPath } from '../art/detailed/buildingLinks';
import { gridOf } from '../art/detailed/grid';
import { drawBlob } from '../art/detailed/blobs';
import { detailedUnits } from '../art/detailed/units';
import { detailedWakes } from '../art/detailed/trails';
import { motionOf } from '../art/registry';
import { junctions, pathLength, pointAt, railNetwork, seaLane, type Hub, type P, type Rail, type SupplyTerrain } from '../art/detailed/supplyLines';
import { blitGround, damageCross, drawTrain, drawTrainDot, frontArt, laneArt, railArt, railLook, supplyLabel, trainCars, trainLength, yardLines, type CarKind, type GroundView, type RailBreak } from '../art/detailed/supplyArt';
import type { TrailUnit, UnitDraw } from '../art/types';

const BLUE: RGB = [64, 160, 255];
const RED: RGB = [226, 74, 60];
const OWNERS: Record<number, RGB> = { 1: BLUE, 2: RED };
const MW = 330;
const MH = 250;
/** zooms (CSS px per tile): the close look, normal game zoom, far out */
const CLOSE = 20;
const NORMAL = 7;
const FAR = 3;
/** units are drawn as sprites from this zoom on (the close look); below it a train is a dot */
const SPRITE_ZOOM = 11;
const unitScale = (z: number): number => (z < 11 ? 1.5 : z < 22 ? 2 : z < 32 ? 3 : 4);

type SiteType = 'city' | 'factory' | 'port' | 'fort';
interface Site extends Hub {
  type: SiteType;
  level: number;
}

interface TrainSpec {
  /** rail by its two hub ids, the train running from `from` toward the other end */
  a: number;
  b: number;
  from: number;
  /** where the engine's nose is, as a share of the rail */
  at: number;
  load: number;
}

interface SceneDef {
  id: string;
  title: string;
  note: string;
  cx: number;
  cy: number;
  sites: Site[];
  /** canvas size (CSS px) */
  cw: number;
  ch: number;
  zooms: number[];
  trains?: TrainSpec[];
  /** a rail broken next to a damaged hub: the hub, the rail's far end, the stretch (tiles from the hub) */
  damage?: { hub: number; to: number; s0: number; s1: number };
  /** convoy: a port and the beachhead tile across the water, ships on the lane at this share */
  convoy?: { port: number; to: [number, number]; at: number; ships: number };
  /** cut front: the cut owner and where the label stands (tiles) */
  front?: { owner: number; label: [number, number] };
  /** rails broken by a strike somewhere along them (tiles from the rail's first hub) */
  breaks?: { a: number; b: number; s0: number; s1: number }[];
  /** the upgrade scene: today's dirt track from a building to its city becomes a rail on the same route */
  upgrade?: { a: number; b: number };
  /** the close frames of a moving train (lab clock ms) */
  frames?: number[];
}

interface Scene extends SceneDef {
  rails: Rail[];
  yards: P[][];
  lane: P[] | null;
  track: P[] | null;
  /** close views centred on these points (the trains scene: one per train) */
  focus: P[];
  /** where the moving frames look */
  frameAt: P | null;
}

// ------------------------------------------------------------------------------------------------- the made-up map

function hash(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
function noise(x: number, y: number, cell: number, s: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s);
  const b = hash(x0 + 1, y0, s);
  const c = hash(x0, y0 + 1, s);
  const d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const fbm = (x: number, y: number, s: number): number => noise(x, y, 9, s) * 0.6 + noise(x, y, 4, s + 3) * 0.3 + noise(x, y, 2, s + 7) * 0.1;

/** A blob: inside when the ragged ellipse round (cx, cy) with radii (rx, ry) covers the tile. */
const blob = (x: number, y: number, cx: number, cy: number, rx: number, ry: number, s: number): boolean => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 0.75 + 0.5 * fbm(x, y, s);

/** Distance from (x, y) to a polyline. */
function distTo(x: number, y: number, pts: readonly P[]): number {
  let m = 1e9;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    m = Math.min(m, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return m;
}

const RIVER_A: P[] = [[44, 4], [41.5, 22], [45.5, 36], [43, 50], [46, 64], [42, 92]];
const RIVER_C: P[] = [[262, 96], [258, 74], [263, 60], [259.5, 50], [263, 36], [260, 4]];
const BORDER_I = (y: number): number => 270 + 3.2 * Math.sin(y * 0.16) + 1.6 * Math.sin(y * 0.41);
const BORDER_E = (x: number): number => 136 + 1.8 * Math.sin(x * 0.2);

function paint(x: number, y: number): number {
  const n = fbm(x, y, 1);
  const hilly = fbm(x + 40, y + 9, 5);
  // the convoy's sea between two coasts
  if (x < 110 && y >= 168) {
    const west = 40 + 2.2 * Math.sin(y * 0.21) + 1.5 * fbm(x, y, 41);
    const east = 78 + 2.5 * Math.sin(y * 0.17 + 1) + 1.5 * fbm(x, y, 43);
    if (x > west && x < east) return x > west + 3 && x < east - 3 ? 0 : 1;
    if (blob(x, y, 60, 186, 3.5, 2.5, 47)) return 2;
  }
  // rivers: two tiles wide, a little ragged
  if (x < 110 && y < 95 && distTo(x + 0.5, y + 0.5, RIVER_A) < 1.05 + 0.25 * noise(x, y, 3, 9)) return 1;
  if (x >= 215 && y < 95 && distTo(x + 0.5, y + 0.5, RIVER_C) < 1.0 + 0.25 * noise(x, y, 3, 9)) return 1;
  // region A (grass): a mountain cluster with a hilly foot, a swamp below it
  if (blob(x, y, 57, 39, 6.5, 5.5, 11)) return 5;
  if (blob(x, y, 57, 39, 9, 8, 12) && hilly > 0.45) return 4;
  if (blob(x, y, 68, 54, 5.5, 3.5, 13)) return 7;
  // region B (desert): a rock range across the middle
  if (x >= 112 && x < 215 && y < 95) {
    if (blob(x, y, 166, 40, 5.5, 9.5, 21) || blob(x, y, 175, 54, 4, 4, 22)) return 5;
    if (blob(x, y, 166, 44, 9, 14, 23) && hilly > 0.5) return 4;
    return 6;
  }
  // region C (snow): tundra, a mountain cluster, taiga
  if (x >= 215 && y < 95) {
    if (blob(x, y, 280, 38, 6, 6, 31) || blob(x, y, 290, 48, 4, 3.5, 32)) return 5;
    if (blob(x, y, 283, 41, 9.5, 9, 33) && hilly > 0.5) return 4;
    if (n > 0.6) return 3;
    return 8;
  }
  // region E (train): a hill range the blue rail curves round, a mountain at its heart
  if (blob(x, y, 166, 127, 4.5, 4, 51)) return 5;
  if (blob(x, y, 166, 121, 11, 5, 52)) return 4;
  if (blob(x, y, 165, 146, 4.5, 3.5, 53)) return 5;
  if (blob(x, y, 165, 152, 11, 4.5, 54)) return 4;
  // region F (junction): forest round the yard, kept off it
  if (n > 0.64) return 3;
  if (hilly > 0.72) return 4;
  return 2;
}

/** Who owns a tile of the made-up map: blue everywhere, red east of the cut front, south of the train border, across the sea. */
function ownerOf(x: number, y: number, t: number): number {
  if (isWater(t)) return 0;
  if (x >= 215 && y >= 170 && x >= BORDER_I(y)) return 2;
  if (x >= 112 && x < 215 && y >= 100 && y < 165 && y >= BORDER_E(x)) return 2;
  if (x < 110 && y >= 168 && x > 70) return Math.hypot(x - 80, y - 212) < 9 ? 1 : 2;
  return 1;
}

interface World {
  map: MapData;
  terr: TerrainData;
  mirror: Uint32Array;
  t: SupplyTerrain;
  ter: (x: number, y: number) => number;
  own: (x: number, y: number) => number;
  heightAt?: (qx: number, qy: number) => number;
}

function buildWorld(): World {
  const n = MW * MH;
  const terrain = new Uint8Array(n);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) terrain[y * MW + x] = paint(x, y);
  const owner = new Uint16Array(n);
  const mirror = new Uint32Array(n);
  let landCount = 0;
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      const i = y * MW + x;
      owner[i] = ownerOf(x, y, terrain[i]);
      mirror[i] = owner[i];
      if (!isWater(terrain[i])) landCount++;
    }
  }
  const coastal = new Uint8Array(n);
  const map = { width: MW, height: MH, terrain, resource: new Uint8Array(n), owner, building: new Int32Array(n), coastal, fallout: new Float32Array(n), landTileCount: landCount } as MapData;
  const terr = buildTerrain(map, DEFAULT_THEME);
  const ter = (x: number, y: number): number => (x < 0 || y < 0 || x >= MW || y >= MH ? 0 : terrain[y * MW + x]);
  const own = (x: number, y: number): number => (x < 0 || y < 0 || x >= MW || y >= MH ? 0 : owner[y * MW + x]);
  return { map, terr, mirror, t: { terrain: ter, owner: own }, ter, own };
}

// ------------------------------------------------------------------------------------------------- the scenes

let nextId = 1;
/** The last land tile before the sea on row y, scanning east from x (the convoy's west coast), and the first land past it. */
function coastX(y: number, x = 20): number {
  while (x < MW && !isWater(paint(x + 1, y))) x++;
  return x;
}
function farShoreX(y: number): number {
  let x = coastX(y) + 1;
  while (x < MW && isWater(paint(x, y))) x++;
  return x;
}
const site = (type: SiteType, x: number, y: number, owner = 1, level = 2): Site => ({ id: nextId++, type, x, y, owner, level });

function sceneDefs(): SceneDef[] {
  const W = 480;
  const H = 270;
  const zz = [CLOSE, NORMAL, FAR];
  const a1 = site('city', 28, 47, 1, 3);
  const a2 = site('factory', 84, 44);
  const b1 = site('city', 140, 50, 1, 3);
  const b2 = site('fort', 192, 40, 1, 2);
  const c1 = site('city', 242, 50, 1, 3);
  const c2 = site('factory', 296, 56);
  const d1 = site('factory', 44, 133);
  const d2 = site('city', 65, 127, 1, 3);
  const e1 = site('city', 141, 129, 1, 4);
  const e2 = site('factory', 191, 127);
  const e3 = site('city', 143, 145, 2, 3);
  const e4 = site('factory', 189, 146, 2, 2);
  const f0 = site('factory', 270, 130);
  const f1 = site('city', 249, 131, 1, 3);
  const f2 = site('fort', 291, 128);
  const f3 = site('city', 271, 111, 1, 2);
  const f4 = site('fort', 268, 149);
  const g1 = site('port', coastX(201), 201, 1, 3);
  const g2 = site('city', 22, 204, 1, 3);
  const h0 = site('factory', 165, 205);
  const h1 = site('city', 143, 207, 1, 3);
  const h2 = site('fort', 181, 190);
  const i1 = site('fort', 262, 204);
  const i2 = site('city', 238, 206, 1, 3);
  const i3 = site('city', 292, 205, 2, 3);
  return [
    {
      id: 'rail-grass',
      title: 'Rail on grass: round the mountains and the swamp, over the river',
      note: 'A rail from the city to the factory, laid by itself over the nation\'s own dry land. It runs straight where it can, bends in long curves, keeps a tile off the foot of the mountains and the swamp, and crosses the river on a short straight steel bridge. Close up: a gravel bed in the colour of the land, dark sleepers, two thin steel rails, the one toward the light lit, each with a one-pixel shadow. A train shows the size against the rail.',
      cx: 46,
      cy: 46,
      sites: [a1, a2],
      cw: W,
      ch: H,
      zooms: [CLOSE, 12, NORMAL, FAR],
      trains: [{ a: a1.id, b: a2.id, from: a1.id, at: 0.42, load: 2 }],
    },
    {
      id: 'rail-desert',
      title: 'Rail on desert: round a rock range',
      note: 'The same rail on sand: the bed takes the sand\'s own tones, and the rail swings round the rock range in one long curve.',
      cx: 158,
      cy: 50,
      sites: [b1, b2],
      cw: W,
      ch: H,
      zooms: zz,
    },
    {
      id: 'rail-snow',
      title: 'Rail on snow: tundra, taiga and a frozen river',
      note: 'On tundra the bed is pale and bluish, through the taiga the tree crowns overhang the outer gravel, and a bridge carries the rail over the river.',
      cx: 262,
      cy: 51,
      sites: [c1, c2],
      cw: W,
      ch: H,
      zooms: zz,
    },
    {
      id: 'upgrade',
      title: 'A dirt track to a city upgrades into a rail',
      note: 'Today the factory has a thin dirt track to its city. With supply lines the track becomes a rail on the same route: the same bends, now with a gravel bed, sleepers and steel.',
      cx: 54.5,
      cy: 130,
      sites: [d1, d2],
      cw: W,
      ch: H,
      zooms: [CLOSE, NORMAL, FAR],
      upgrade: { a: d1.id, b: d2.id },
    },
    {
      id: 'train',
      title: 'Trains of two nations',
      note: 'A blue train (engine, tender and 5 wagons) runs round the hills toward the front; a red one with 3 wagons runs on its own side of the border. Each car turns with the curve, the whole train has the owner\'s ring like a unit, and the smoke trails back off the stack. At normal zoom a train is a dot in the owner\'s colour moving along the thin line; far out the rails and trains are hidden.',
      cx: 166,
      cy: 136,
      sites: [e1, e2, e3, e4],
      cw: 600,
      ch: 338,
      zooms: [32, CLOSE, NORMAL, FAR],
      trains: [
        { a: e1.id, b: e2.id, from: e1.id, at: 0.56, load: 3 },
        { a: e3.id, b: e4.id, from: e3.id, at: 0.56, load: 1 },
      ],
      frames: [0, 3000, 6000, 9000],
    },
    {
      id: 'junction',
      title: 'A junction: a small rail yard where 3 or more rails meet',
      note: 'The factory joins four rails, so it gets a rail yard: sidings fan out of the main line on a shared gravel apron, with a few wagons standing in them.',
      cx: 270,
      cy: 130,
      sites: [f0, f1, f2, f3, f4],
      cw: W,
      ch: H,
      zooms: zz,
    },
    {
      id: 'convoy',
      title: 'A convoy leaves the port on a sea lane',
      note: 'The port is linked by convoy to the beachhead across the water. A dotted lane of paler water runs from the port; three cargo ships follow it in a line, each with its white wake. At normal zoom the lane stays and a dot in the owner\'s colour moves along it.',
      cx: 48,
      cy: 202,
      sites: [g1, g2],
      cw: W,
      ch: H,
      zooms: zz,
      convoy: { port: g1.id, to: [farShoreX(212), 212], at: 0.42, ships: 3 },
    },
    {
      id: 'damaged',
      title: 'A damaged hub repairs itself',
      note: 'A strike hit the factory: smoke rises from it, the rail beside it is torn up (a scorched crater, two bent rail pieces thrown aside) and a timer counts down the repair. Far out the factory\'s marker carries a red cross.',
      cx: 168,
      cy: 204,
      sites: [h0, h1, h2],
      cw: W,
      ch: H,
      zooms: zz,
      damage: { hub: h0.id, to: h2.id, s0: 2.0, s1: 3.4 },
    },
    {
      id: 'cut',
      title: 'A cut front',
      note: 'A strike tore up the only rail from the blue city to the front, so the front has no link back to a working hub and fights slower: close up its border shimmers grey, and a "Supply cut" label stands on it at every zoom.',
      cx: 266,
      cy: 205,
      sites: [i1, i2, i3],
      cw: W,
      ch: H,
      zooms: zz,
      front: { owner: 1, label: [BORDER_I(211) - 4.5, 211] },
      breaks: [{ a: i2.id, b: i1.id, s0: 5.2, s1: 6.6 }],
    },
  ];
}

function buildScenes(w: World): Scene[] {
  return sceneDefs().map((d) => {
    const rails = railNetwork(d.sites, w.t);
    let focus: P[] = [];
    let frameAt: P | null = null;
    if (d.trains && d.frames) {
      // the trains scene looks at the middle of its trains
      const ps = d.trains.flatMap((t) => {
        const r = rails.find((q) => (q.a === t.a && q.b === t.b) || (q.a === t.b && q.b === t.a));
        if (!r) return [];
        const pts = r.a === t.from ? r.path : r.path.slice().reverse();
        return [pointAt(pts, pathLength(pts) * t.at - 5.5)];
      });
      focus = ps.map((p): P => [p.x, p.y]);
      // the moving frames look a little ahead of the blue train, where its rail bends
      const t0 = d.trains[0];
      const r0 = rails.find((q) => (q.a === t0.a && q.b === t0.b) || (q.a === t0.b && q.b === t0.a));
      if (r0) {
        const pts = r0.a === t0.from ? r0.path : r0.path.slice().reverse();
        const p = pointAt(pts, pathLength(pts) * t0.at + 5);
        frameAt = [p.x, p.y];
      }
    }
    if (d.damage) {
      // the broken stretch is measured from the hub
      const r = rails.find((q) => (q.a === d.damage?.hub && q.b === d.damage.to) || (q.b === d.damage?.hub && q.a === d.damage?.to));
      if (r && r.b === d.damage.hub) {
        const L = pathLength(r.path);
        d.damage = { ...d.damage, s0: L - d.damage.s1, s1: L - d.damage.s0 };
      }
    }
    const yards = junctions(d.sites, rails).flatMap((j) => yardLines(j, 4, 7, 0.44, 2.2));
    let lane: P[] | null = null;
    if (d.convoy) {
      const port = d.sites.find((s) => s.id === d.convoy?.port);
      if (port) {
        lane = seaLane({ x: port.x, y: port.y }, { x: d.convoy.to[0], y: d.convoy.to[1] }, w.t);
      }
    }
    let track: P[] | null = null;
    if (d.upgrade) {
      const a = d.sites.find((s) => s.id === d.upgrade?.a);
      const b = d.sites.find((s) => s.id === d.upgrade?.b);
      if (a && b) track = trackPath({ ...a, level: a.level }, { ...b, level: b.level }, { water: (x, y) => isWater(w.ter(x, y)), owner: w.own });
    }
    return { ...d, rails: d.upgrade ? [] : rails, yards, lane, track, focus, frameAt };
  });
}

// ------------------------------------------------------------------------------------------------- the map shader

class Backdrop {
  readonly cv = document.createElement('canvas');
  readonly gl: MapGL | null;
  constructor(readonly w: World) {
    this.gl = MapGL.create(this.cv);
    if (!this.gl) return;
    this.gl.setLite(false);
    this.gl.setGame(w.map, w.terr, w.mirror);
    this.gl.setPalette(0, [0, 0, 0], 0, false, 0);
    this.gl.setPalette(1, BLUE, 0, false, 0);
    this.gl.setPalette(2, RED, 0, false, 0);
    this.gl.uploadPalette();
  }
  get ready(): boolean {
    return !!groundBuilt(this.w.map, DEFAULT_THEME);
  }
  /** Draws the map round (cx, cy) at `zoom` into ctx (CSS px), as the game draws it. */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number, zoom: number, cw: number, ch: number, dpr: number, timeMs: number): void {
    const gl = this.gl;
    if (!gl) {
      flatDraw(ctx, this.w, cx, cy, zoom, cw, ch);
      return;
    }
    this.cv.width = Math.round(cw * dpr);
    this.cv.height = Math.round(ch * dpr);
    gl.draw(this.cv.width, this.cv.height, { centerX: cx, centerY: cy, zoom: zoom * dpr, timeS: timeMs / 1000, nowDs: Math.floor(timeMs / 100), auxMode: 0, showRes: false, fortOn: false, trenchOn: false, fogOn: false, dpr });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.cv, 0, 0);
    ctx.restore();
  }
}

/** Without WebGL: today's flat terrain colours. */
function flatDraw(ctx: CanvasRenderingContext2D, w: World, cx: number, cy: number, zoom: number, cw: number, ch: number): void {
  const x0 = cx - cw / 2 / zoom;
  const y0 = cy - ch / 2 / zoom;
  for (let ty = Math.floor(y0); ty < y0 + ch / zoom + 1; ty++) {
    for (let tx = Math.floor(x0); tx < x0 + cw / zoom + 1; tx++) {
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) continue;
      const o = (ty * MW + tx) * 4;
      ctx.fillStyle = `rgb(${w.terr.rgba[o]},${w.terr.rgba[o + 1]},${w.terr.rgba[o + 2]})`;
      ctx.fillRect((tx - x0) * zoom, (ty - y0) * zoom, zoom + 0.5, zoom + 0.5);
    }
  }
}

// ------------------------------------------------------------------------------------------------- drawing a panel

interface View extends GroundView {
  cx: number;
  cy: number;
}

const toS = (v: View, p: P): P => [v.ox + p[0] * v.zoom, v.oy + p[1] * v.zoom];

/** The rail pixels of each rail at a grid size (cached: the same for every panel at that size). */
const pixelCache = new Map<string, TrackPixels>();

function groundOf(w: World, P: number, owner: number): TrackGround {
  return { P, terrainAt: w.ter, ramps: DEFAULT_THEME.ground, heightAt: w.heightAt, tint: ownedGround(mapStyle(), OWNERS[owner] ?? null) };
}

function siteUnder(w: World, s: Site): Under {
  const tint = ownedGround(mapStyle(), OWNERS[s.owner] ?? null);
  return {
    rgb: () => {
      const o = (s.y * MW + s.x) * 4;
      const c: RGB = [w.terr.rgba[o], w.terr.rgba[o + 1], w.terr.rgba[o + 2]];
      return tint(c, 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
    },
    water: () => false,
  };
}

function drawSites(ctx: CanvasRenderingContext2D, w: World, sc: Scene, v: View, damaged: number | null): void {
  const z = v.zoom;
  const levels: [number, number, number, RGB][] = [];
  for (const s of sc.sites.slice().sort((a, b) => a.y - b.y)) {
    const owner = OWNERS[s.owner];
    const [sx, sy] = toS(v, [s.x + 0.5, s.y + 0.5]);
    if (z < 8) {
      // the flat marker: the category plate with its white glyph, the owner as a band under it
      const id = s.type as BuildingIconId;
      const size = markerSize(z);
      const cat = ICON_INFO[id].category;
      const r = size * 0.5;
      const fw = Math.max(2, Math.min(4, size * 0.1));
      ctx.fillStyle = 'rgba(12,15,20,0.38)';
      ctx.beginPath();
      ctx.roundRect(sx - r - 1, sy - r - 1, size + 2, size + fw + 3, size * 0.26);
      ctx.fill();
      ctx.fillStyle = `rgb(${owner.join(',')})`;
      ctx.beginPath();
      ctx.roundRect(sx - r + size * 0.12, sy + r - 1, size * 0.76, fw + 1, Math.min(2, fw / 2));
      ctx.fill();
      drawMarker(ctx, id, sx, sy, size, { plate: cat ? CATEGORY_PLATES[cat] : `rgb(${owner.join(',')})`, dpr: v.dpr });
      if (damaged === s.id) damageCross(ctx, sx, sy, size);
      continue;
    }
    const scale = unitScale(z);
    const spec: BuildingSpec = { type: s.type, level: s.level, addon: null };
    const spr = z < 11 ? bakeBuildingFar(spec, owner, scale, v.dpr, siteUnder(w, s)) : bakeBuilding(spec, owner, scale, v.dpr, siteUnder(w, s));
    const ax = s.type === 'port' ? v.ox + (s.x + 1) * z - COAST * scale : sx;
    const cellX = ax - OU * scale;
    const cellY = sy - OV * scale;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spr.canvas, Math.round(cellX * v.dpr) / v.dpr, Math.round(cellY * v.dpr) / v.dpr, spr.w, spr.h);
    if (scale >= 2) levels.push([cellX + spr.cx, cellY + spr.top - 15, s.level, owner]);
  }
  for (const [x, y, lv, o] of levels) levelPill(ctx, x, y, lv, o);
}

/** The rails of a scene as ground pixels (close or line look; nothing far out). */
function drawRails(ctx: CanvasRenderingContext2D, w: World, sc: Scene, v: View, P: number, rails: { key: string; lines: P[][]; owner: number; brk?: RailBreak }[]): void {
  if (railLook(P) === 'none') return;
  for (const r of rails) {
    const key = `${sc.id}|${r.key}|${P}`;
    let px = pixelCache.get(key);
    if (!px) {
      px = railArt(r.lines, groundOf(w, P, r.owner), 3, r.brk);
      pixelCache.set(key, px);
    }
    blitGround(ctx, px, P, v);
  }
}

function railFor(sc: Scene, a: number, b: number): Rail | undefined {
  return sc.rails.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
}

function drawTrains(ctx: CanvasRenderingContext2D, sc: Scene, v: View, timeMs: number): void {
  for (const t of sc.trains ?? []) {
    const r = railFor(sc, t.a, t.b);
    if (!r) continue;
    const owner = OWNERS[sc.sites.find((s) => s.id === t.from)?.owner ?? 1];
    const tiles = r.a === t.from ? r.path : r.path.slice().reverse();
    const path = tiles.map((p) => toS(v, p));
    const L = pathLength(path);
    const speed = 0.9 * v.zoom; // CSS px per second at the lab clock
    const head = Math.min(L, t.at * L + (timeMs / 1000) * speed);
    if (v.zoom >= SPRITE_ZOOM) {
      const cars = trainCars(t.load, t.a * 7 + t.b);
      drawTrain(ctx, { path, head: Math.max(head, trainLength(cars) * unitScale(v.zoom)), cars, owner, scale: unitScale(v.zoom), dpr: v.dpr, timeMs });
    } else {
      const p = pointAt(path, head - 1.5 * v.zoom);
      drawTrainDot(ctx, p.x, p.y, owner, v.dpr);
    }
  }
}

/** Wagons standing in a yard's sidings (close look), at the yard's two ends (the hub stands in its middle). */
function drawYardWagons(ctx: CanvasRenderingContext2D, sc: Scene, v: View): void {
  if (v.zoom < SPRITE_ZOOM) return;
  const sets: [CarKind[], number][] = [[['crates', 'drums'], 0.86], [[], 0], [['tank', 'flatTank'], 0.34], [['flatHeavy'], 0.84]];
  sc.yards.forEach((line, i) => {
    const [cars, at] = sets[i % sets.length];
    if (!cars.length) return;
    const path = line.map((p) => toS(v, p));
    drawTrain(ctx, { path, head: pathLength(path) * at, cars, owner: BLUE, scale: unitScale(v.zoom), dpr: v.dpr, timeMs: 0, smoke: false });
  });
}

/** The convoy: the dotted lane in the water, the ships with their wakes (close) or a moving dot (normal). */
function drawConvoy(ctx: CanvasRenderingContext2D, sc: Scene, v: View, P: number, timeMs: number, waterAt: (qx: number, qy: number) => readonly number[] | null): void {
  const lane = sc.lane;
  if (!lane || !sc.convoy || v.zoom < 5) return;
  const key = `${sc.id}|lane|${P}`;
  let px = pixelCache.get(key);
  if (!px) {
    px = laneArt(lane, P, waterAt);
    pixelCache.set(key, px);
  }
  blitGround(ctx, px, P, v);
  const path = lane.map((p) => toS(v, p));
  const L = pathLength(path);
  const speed = 2.2; // tiles per second
  const z = v.zoom;
  if (z < SPRITE_ZOOM) {
    const p = pointAt(path, (sc.convoy.at * L + (timeMs / 1000) * speed * z) % L);
    drawTrainDot(ctx, p.x, p.y, BLUE, v.dpr);
    return;
  }
  const scale = spriteScale(z);
  const len = detailedUnits.lengthPx('tradeShip', 0, scale);
  const gap = len * 1.9;
  const motion = motionOf('lively');
  const layer = detailedWakes.createLayer();
  const scratch = document.createElement('canvas');
  scratch.width = 4;
  scratch.height = 4;
  const sctx = scratch.getContext('2d');
  const at = (t: number, i: number): { x: number; y: number; angle: number } => pointAt(path, sc.convoy!.at * L + (t / 1000) * speed * z - i * gap);
  // the wakes laid over the last few seconds, so they trail behind the ships as on the map
  const STEP = 50;
  for (let t = timeMs - 6000; t <= timeMs; t += STEP) {
    const units: TrailUnit[] = [];
    for (let i = 0; i < sc.convoy.ships; i++) {
      const p = at(t, i);
      units.push({ id: 500 + i, key: 'tradeShip', x: p.x, y: p.y, tx: (p.x - v.ox) / z, ty: (p.y - v.oy) / z, angle: p.angle, half: len / 2, moving: true, speed, turnRate: 0, motion });
    }
    const target = t + STEP > timeMs ? ctx : sctx;
    if (target) layer.frame(target, units, { ox: v.ox, oy: v.oy, zoom: z, scale, now: t, viewW: v.w, viewH: v.h, dpr: v.dpr, full: true });
  }
  for (let i = sc.convoy.ships - 1; i >= 0; i--) {
    const p = at(timeMs, i);
    const u: UnitDraw = { key: 'tradeShip', mods: 0, owner: BLUE, x: p.x, y: p.y, angle: p.angle, zoom: z, scale, lod: scale >= 2 ? 'near' : 'mid', dpr: v.dpr, timeMs, turnRate: 0, speed, moving: true, seed: 11 + i * 7, alpha: 1, shadow: true, damage: 0, outline: true };
    detailedUnits.drawUnit(ctx, u, motion);
  }
}

/** A damaged hub: smoke rising off it and the repair timer over it. */
function drawDamage(ctx: CanvasRenderingContext2D, sc: Scene, v: View, timeMs: number): void {
  const d = sc.damage;
  if (!d) return;
  const hub = sc.sites.find((s) => s.id === d.hub);
  if (!hub) return;
  const [sx, sy] = toS(v, [hub.x + 0.5, hub.y + 0.5]);
  if (v.zoom < 5) return;
  const g = gridOf(unitScale(v.zoom), v.dpr);
  const k = unitScale(v.zoom);
  // a thick column of smoke leaning with the wind, black at its root and greying as it rises
  for (let i = 8; i >= 0; i--) {
    const age = (timeMs / 2600 + i / 9) % 1;
    const x = sx + (3 + age * 16 + Math.sin(age * 5 + i) * 2) * k;
    const y = sy - (6 + age * 38) * k;
    drawBlob(ctx, age < 0.35 ? 'soot' : 'smoke', (2.6 + age * 6.5) * g.res, i & 3, x, y, g, 0.95 * (1 - age * 0.85));
  }
  if (v.zoom >= SPRITE_ZOOM) drawBlob(ctx, 'fire', 2.4 * g.res, Math.floor(timeMs / 120) & 3, sx + 3 * k, sy - 4 * k, g, 0.95);
  // the repair timer under the hub, clear of its level chip and the smoke
  supplyLabel(ctx, sx, sy + (v.zoom >= SPRITE_ZOOM ? 34 : 22), 'Repair 45 s', 'repair', 0.25);
}

function renderPanel(cv: HTMLCanvasElement, w: World, back: Backdrop, sc: Scene, zoom: number, supply: boolean, timeMs: number, dpr: number, at: P = [sc.cx, sc.cy]): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const cw = cv.width / dpr;
  const ch = cv.height / dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  // the view stays inside the map (far out it would show the void past the edge)
  const cx = Math.max(cw / 2 / zoom, Math.min(MW - cw / 2 / zoom, at[0]));
  const cy = Math.max(ch / 2 / zoom, Math.min(MH - ch / 2 / zoom, at[1]));
  const v: View = { cx, cy, zoom, dpr, w: cw, h: ch, ox: cw / 2 - cx * zoom, oy: ch / 2 - cy * zoom };
  back.draw(ctx, cx, cy, zoom, cw, ch, dpr, timeMs);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = artPixelsPerTile(zoom);
  // the upgrade scene: today's dirt track (close look only, as the game draws it) or the rail on its route
  if (sc.track) {
    if (!supply && zoom >= 11) blitGround(ctx, trackArt(sc.track, groundOf(w, P, 1), 7), P, v);
    if (supply) drawRails(ctx, w, sc, v, P, [{ key: 'upgrade', lines: [sc.track], owner: 1 }]);
  }
  if (supply) {
    const rails = sc.rails.map((r) => {
      const owner = sc.sites.find((s) => s.id === r.a)?.owner ?? 1;
      const d = sc.damage;
      const cut = sc.breaks?.find((q) => (q.a === r.a && q.b === r.b) || (q.a === r.b && q.b === r.a));
      const brk = d && ((r.a === d.hub && r.b === d.to) || (r.b === d.hub && r.a === d.to)) ? { line: 0, s0: d.s0, s1: d.s1 } : cut ? { line: 0, s0: cut.s0, s1: cut.s1 } : undefined;
      return { key: `${r.a}-${r.b}`, lines: [r.path], owner, brk };
    });
    if (P >= 8 && sc.yards.length) rails.push({ key: 'yard', lines: sc.yards, owner: 1, brk: undefined });
    drawRails(ctx, w, sc, v, P, rails);
    if (sc.front && P >= 8) {
      const x0 = Math.floor((cx - cw / 2 / zoom) * P);
      const y0 = Math.floor((cy - ch / 2 / zoom) * P);
      blitGround(ctx, frontArt(x0, y0, Math.ceil((cw / zoom) * P) + 2, Math.ceil((ch / zoom) * P) + 2, P, w.own, sc.front.owner, timeMs), P, v);
    }
    if (sc.convoy) {
      const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const waterAt = (qx: number, qy: number): readonly number[] | null => {
        if (!isWater(w.ter(Math.floor(qx), Math.floor(qy)))) return null;
        const X = Math.max(0, Math.min(cv.width - 1, Math.floor((v.ox + qx * zoom) * dpr)));
        const Y = Math.max(0, Math.min(cv.height - 1, Math.floor((v.oy + qy * zoom) * dpr)));
        const o = (Y * cv.width + X) * 4;
        return [img[o], img[o + 1], img[o + 2]];
      };
      // the lane's colours come from the water drawn under it: baked per panel, not cached
      pixelCache.delete(`${sc.id}|lane|${P}`);
      drawConvoy(ctx, sc, v, P, timeMs, waterAt);
    }
  }
  drawSites(ctx, w, sc, v, supply && sc.damage ? sc.damage.hub : null);
  if (supply) {
    if (zoom >= 5) drawYardWagons(ctx, sc, v);
    if (zoom >= 5) drawTrains(ctx, sc, v, timeMs);
    drawDamage(ctx, sc, v, timeMs);
    if (sc.front) {
      const [lx, ly] = toS(v, sc.front.label);
      supplyLabel(ctx, lx, ly, 'Supply cut', 'cut');
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const ZOOM_NAME = (z: number): string => (z >= 30 ? 'closest look' : z >= 20 ? 'close look' : z >= 11 ? 'close look, middle' : z >= 5 ? 'normal zoom' : 'far out');

/** Mounts the Supply row in the lab page and draws it once the map's ground is built. */
export function mountSupplyMock(root: HTMLElement): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'al-row al-bm';
  sec.id = 'al-supply';
  sec.setAttribute('aria-labelledby', 'al-row-supply');
  sec.style.display = 'block';
  const head = document.createElement('div');
  head.className = 'al-row-head';
  const t = document.createElement('h2');
  t.id = 'al-row-supply';
  t.textContent = 'Supply';
  const note = document.createElement('p');
  note.textContent = 'The first look of the supply lines, on a small made-up map drawn by the game\'s own map shader. Rails link each hub (capital, cities, factories, ports, forts) to its nearest hubs over the nation\'s own dry land; they are drawn in the ground on the map\'s own pixel grid, coloured by the land they cross. Trains and convoy ships are pictures on top, like units, drawn from the network. Each scene is shown at the close look (zoom 20), at normal game zoom (zoom 7) and far out (zoom 3), each next to today\'s map: the same scene without supply art.';
  head.append(t, note);
  sec.append(head);
  root.append(sec);
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const w = buildWorld();
  const back = new Backdrop(w);
  const scenes = buildScenes(w);
  const jobs: (() => void)[] = [];
  for (const sc of scenes) {
    const blk = document.createElement('div');
    blk.dataset.supply = sc.id;
    blk.style.cssText = 'margin-top:18px';
    const h3 = document.createElement('h3');
    h3.textContent = sc.title;
    const p = document.createElement('p');
    p.textContent = sc.note;
    const grid = document.createElement('div');
    grid.style.cssText = `display:grid;grid-template-columns:repeat(2,${sc.cw}px);gap:8px 12px;margin-top:8px`;
    const fig = (cap: string, zoom: number, supply: boolean, time: number, tag: string, at?: P): void => {
      const f = document.createElement('div');
      const c = document.createElement('p');
      c.textContent = cap;
      c.style.cssText = 'margin:0 0 3px;font-weight:600';
      const cv = document.createElement('canvas');
      cv.dataset.state = tag;
      cv.dataset.zoom = String(zoom);
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', `${sc.title}, ${cap}`);
      cv.style.cssText = `display:block;border-radius:8px;max-width:100%;width:${sc.cw}px;height:${sc.ch}px`;
      cv.width = sc.cw * dpr;
      cv.height = sc.ch * dpr;
      f.append(c, cv);
      grid.append(f);
      jobs.push(() => renderPanel(cv, w, back, sc, zoom, supply, time, dpr, at));
    };
    for (const zoom of sc.zooms) {
      if (zoom >= SPRITE_ZOOM && sc.focus.length > 1) {
        // one close pair per train, each centred on it
        sc.focus.forEach((f, i) => {
          fig(`TODAY: no supply art, zoom ${zoom} (${ZOOM_NAME(zoom)}), ${i ? 'red' : 'blue'} side`, zoom, false, 1200, i ? 'today-red' : 'today', f);
          fig(`SUPPLY LINES: zoom ${zoom} (${ZOOM_NAME(zoom)}), ${i ? 'red' : 'blue'} train`, zoom, true, 1200, i ? 'supply-red' : 'supply', f);
        });
        continue;
      }
      fig(`TODAY: no supply art, zoom ${zoom} (${ZOOM_NAME(zoom)})`, zoom, false, 1200, 'today');
      fig(`SUPPLY LINES: zoom ${zoom} (${ZOOM_NAME(zoom)})`, zoom, true, 1200, 'supply');
    }
    for (const [i, ft] of (sc.frames ?? []).entries()) fig(`Moving: frame ${i + 1}, ${(ft / 1000).toFixed(1)} s later, zoom ${CLOSE}`, CLOSE, true, 1200 + ft, `frame${i + 1}`, sc.frameAt ?? sc.focus[0]);
    blk.append(h3, p, grid);
    sec.append(blk);
  }
  // the ground textures build in slices between frames: draw once now (flat), again when they are ready
  const drawAll = (): void => {
    for (const j of jobs) j();
  };
  let tries = 0;
  const wait = (): void => {
    if (back.ready || !back.gl || tries++ > 600) {
      const gd = groundBuilt(w.map, DEFAULT_THEME);
      if (gd) {
        w.heightAt = (qx, qy) => {
          const fx = Math.max(0, Math.min(MW - 1.001, qx - 0.5));
          const fy = Math.max(0, Math.min(MH - 1.001, qy - 0.5));
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const ux = fx - ix;
          const uy = fy - iy;
          const at = (x: number, y: number): number => gd.data[(y * MW + x) * 4 + 1] / 255;
          return (at(ix, iy) * (1 - ux) + at(ix + 1, iy) * ux) * (1 - uy) + (at(ix, iy + 1) * (1 - ux) + at(ix + 1, iy + 1) * ux) * uy;
        };
        pixelCache.clear();
      }
      // one frame for the ground pass to take the new textures, then the pictures
      requestAnimationFrame(() => {
        drawAll();
        void document.fonts?.ready.then(() => {
          drawAll();
          sec.dataset.ready = '1';
        });
      });
      return;
    }
    requestAnimationFrame(wait);
  };
  // a first draw starts the ground build (the map layer asks for it when it draws)
  requestAnimationFrame(() => {
    drawAll();
    wait();
  });
  return sec;
}
