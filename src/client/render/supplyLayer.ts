// The supply lines on the real map (client only). What runs where is the sim's (supplylines.ts supplyNetworkOf: hubs
// and links with their route tiles); the look is art/detailed/supplyArt.ts (pixels on the art grid, sprites for trains
// and convoys). This layer only decides what is shown and draws it; it never touches the game state.
//
// Looks by zoom (render/glmap.ts artPixelsPerTile, the same grid the ground uses):
//   close   (zoom 10 and up)  full pixel rails with sleepers, junction yards with parked wagons, trains as sprites from
//                             zoom 11, convoy ships with wakes on a dotted sea lane
//   normal  (zoom 5 to 10)    one thin rail line and a dotted sea lane (no markers: trains and ships show close up)
//   far     (under zoom 5)    nothing but the red cross on a damaged hub's marker
// A damaged hub: smoke, a broken rail piece and its "Repair 45 s" timer (zoom 5 and up), a red cross on its marker
// (under zoom 8, where buildings are flat markers). A cut front: grey shimmer along the border near the forts that no
// route reaches, with a "Supply cut" label.
//
// Which networks: your own and the ones of other nations you can see (fog of war: a hub or a stretch of the route in
// view; with no fog every network). Trains and convoys are drawn from the game clock alone (no state is written, and
// nothing here is read by the sim), so they pause with the game.
//
// The rails: each nation's rail links are laid as one track network (art/detailed/supplyTracks.ts: routes that share a
// corridor are one track with a switch, gentle curves, every track from hub centre to hub centre under the buildings),
// and each link's trains run on its piece of that network.
//
// Cost: the networks are read again only when their key changes (a coarse tick step, the buildings, the fog view, the
// cut version and the damaged hubs and sunk convoys); each nation's track network is laid once per set of routes and
// cached; the rails and yards are baked per square piece of the map (CHUNK_PX art px a side, a couple per frame) and
// the lanes per lane, each drawn as one scaled image when in view; only trains inside the view are drawn.
import { SUPPLY_LINES, TICKS_PER_SECOND } from '../../sim/config';
import { isWater, type GameState } from '../../sim/types';
import { convoyPhase, cutVersion, supplyNetworkOf } from '../../sim/supplylines';
import type { TrackGround, TrackPixels } from '../art/detailed/buildingLinkArt';
import { gridOf } from '../art/detailed/grid';
import { drawBlob } from '../art/detailed/blobs';
import { detailedUnits } from '../art/detailed/units';
import { detailedWakes } from '../art/detailed/trails';
import { motionOf } from '../art/registry';
import { junctions, pathLength, pointAt, seaLane, type Hub, type P, type Rail } from '../art/detailed/supplyLines';
import { layTracks, type TrackLink, type TrackNet } from '../art/detailed/supplyTracks';
import { damageCross, drawTrain, frontArt, laneArt, railArt, railLook, supplyLabel, trainCars, trainLength, yardLines, type CarKind, type RailBreak } from '../art/detailed/supplyArt';
import type { TrailLayer, TrailUnit, UnitDraw } from '../art/types';
import { repairLeft } from '../supplyText';
import { ART_ZOOM } from './buildingArt';
import { markerSize, FAR_ZOOM } from './buildings';
import { buildingsKey, makeCanvas, type RGB, type View } from './common';
import { artPixelsPerTile } from './glmap';
import { groundBuilt } from './ground';
import { railPairKey, groundFor } from './linkLayer';
import { mapStyle } from './mapStyle';
import { spriteScale } from './units';
import type { TerrainData } from './terrain';

/** What a zoom shows of the supply lines. */
export type SupplyLook = 'close' | 'line' | 'none';
export function supplyLook(zoom: number): SupplyLook {
  return railLook(artPixelsPerTile(zoom));
}
/** Trains and convoy ships are sprites from this zoom on; below it (and above the line look) they are dots. */
export const SUPPLY_SPRITE_ZOOM = 11;
/** The repair timer and the smoke show from this zoom on. */
export const SUPPLY_MARK_ZOOM = 5;
/** The cut front's shimmer shows from this zoom on (the grid has 2 px per tile). */
export function shimmerShown(zoom: number): boolean {
  return artPixelsPerTile(zoom) >= 2;
}

/** Ticks per step of the network read (the territory under the routes is looked at this often). */
export const SUPPLY_STEP_TICKS = 20;
/** Tiles per second a train runs at (game time). */
const TRAIN_SPEED = 1.1;
/** Idle tiles between one train leaving a rail and the next entering (one train per rail). */
const TRAIN_GAP = 14;
/** Tiles at each end of a rail where no train shows (the hub's buildings stand there). */
const HUB_CLEAR = 2.6;
/** Radius (tiles) round a cut fort the shimmer runs along the border. */
const SHIMMER_R = 14;
/** Ships in a convoy and the gap between them (tiles). */
const CONVOY_SHIPS = 3;
const CONVOY_GAP = 1.6;
const BAKES_PER_FRAME = 2;
const CACHE_MAX = 72;
/** Art px along a side of one baked piece of the rail network. */
const CHUNK_PX = 512;

interface RailView {
  id: string;
  owner: number;
  a: number;
  b: number;
  /** the smooth route from hub a to hub b (tile coordinates) */
  path: P[];
  /** the same, oriented the way trains run (toward the front) */
  flow: P[];
  length: number;
  /** tile box x0, y0, x1, y1 */
  box: [number, number, number, number];
  brk?: RailBreak;
  /** trains run on it (both ends reached, nothing damaged) */
  live: boolean;
  seed: number;
}
/** A laid track (one drawn line of the network; several links may run on it). */
interface TrackView {
  owner: number;
  id: string;
  path: P[];
  box: [number, number, number, number];
  brk?: RailBreak;
}
interface LaneView {
  id: string;
  owner: number;
  a: number;
  b: number;
  /** null until found (or none: a lane the search cannot make) */
  lane: P[] | null;
  tried: boolean;
  box: [number, number, number, number];
  sunk: boolean;
}
interface YardView {
  id: string;
  owner: number;
  tile: number;
  lines: P[][];
  box: [number, number, number, number];
}
interface DamageView {
  owner: number;
  tile: number;
  until: number;
}
interface CutView {
  owner: number;
  tiles: number[];
}

/** What a frame hands the layer. */
export interface SupplyFrame {
  state: GameState;
  terr: TerrainData | null;
  /** camera: tile at the screen centre, zoom (CSS px per tile) and the view size (CSS px) */
  camX: number;
  camY: number;
  zoom: number;
  viewW: number;
  viewH: number;
  /** visible tile box */
  view: Pick<View, 'x0' | 'y0' | 'x1' | 'y1'>;
  colors: readonly RGB[];
  dpr: number;
  /** the viewer's nation (0 = a spectator) */
  me: number;
  /** fog of war: whether a tile is in view now (null = no fog) */
  visible: ((tile: number) => boolean) | null;
  /** a counter that changes when the fog view does */
  fogGen: number;
  /** state.tick plus the part of the tick that has passed */
  tickF: number;
  /** real clock (ms), for smoke and the wakes */
  nowMs: number;
}

const hashTiles = (t: ArrayLike<number>): number => {
  let h = t.length | 0;
  for (let i = 0; i < t.length; i += 1) h = (Math.imul(h, 31) + t[i]) | 0;
  return h >>> 0;
};
const boxOf = (pts: readonly P[]): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of pts) (x0 = Math.min(x0, q[0]), y0 = Math.min(y0, q[1]), x1 = Math.max(x1, q[0]), y1 = Math.max(y1, q[1]));
  return [x0, y0, x1, y1];
};
const mixSeed = (a: number, b: number): number => (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;

interface Sprite {
  cv: HTMLCanvasElement;
  x0: number;
  y0: number;
  w: number;
  h: number;
  P: number;
}

function pixelsCanvas(t: TrackPixels): HTMLCanvasElement | null {
  if (t.w < 1 || t.h < 1) return null;
  const cv = makeCanvas(t.w, t.h);
  const cx = cv.getContext('2d');
  if (!cx) return null;
  const img = cx.createImageData(t.w, t.h);
  img.data.set(t.rgba);
  cx.putImageData(img, 0, 0);
  return cv;
}

export class SupplyLayer {
  rails: RailView[] = [];
  tracks: TrackView[] = [];
  lanes: LaneView[] = [];
  yards: YardView[] = [];
  damaged: DamageView[] = [];
  cuts: CutView[] = [];
  /** building pairs a rail links now, once its picture is ready (the dirt track between them gives way) */
  pairs = new Set<string>();
  /** reads of the networks done (stats and tests) */
  computed = 0;
  /** rails, lanes and yards drawn last frame; trains drawn last frame */
  drawn = 0;
  trains = 0;
  private key = '';
  private nets = new Map<string, TrackNet>();
  /** per owner: a hash of its tracks, yards and breaks (the baked pieces change with it) */
  private netKey = new Map<number, string>();
  /** per owner: the hub tiles (trains fade out over a building) */
  private hubTiles = new Map<number, P[]>();
  private sprites = new Map<string, Sprite>();
  private latest = new Map<string, Sprite>();
  private budget = BAKES_PER_FRAME;
  private wakes: TrailLayer = detailedWakes.createLayer();
  private shimmer = new Map<string, { bucket: number; box: [number, number, number, number]; cv: HTMLCanvasElement | null; P: number }>();

  reset(): void {
    this.rails = [];
    this.tracks = [];
    this.netKey.clear();
    this.hubTiles.clear();
    this.lanes = [];
    this.yards = [];
    this.damaged = [];
    this.cuts = [];
    this.pairs.clear();
    this.key = '';
    this.nets.clear();
    this.sprites.clear();
    this.latest.clear();
    this.shimmer.clear();
    this.wakes.clear();
    this.laneCache.clear();
  }

  private laneCache = new Map<string, P[] | null>();

  // ----------------------------------------------------------------------------------------------- the networks

  /** Reads the networks again when their key changed. */
  update(f: SupplyFrame): void {
    const { state } = f;
    const sn = state.supplyNet;
    const key = `${Math.floor(state.tick / SUPPLY_STEP_TICKS)}:${buildingsKey(state)}:${f.fogGen}:${cutVersion(state)}:${sn?.hubs.length ?? 0}:${sn?.sunk.length ?? 0}:${f.me}:${state.map.width}`;
    if (key === this.key) return;
    this.key = key;
    this.computed++;
    const w = state.map.width;
    const h = state.map.height;
    const terrainAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : state.map.terrain[y * w + x]);
    const rails: RailView[] = [];
    const tracks: TrackView[] = [];
    const yards: YardView[] = [];
    const lanes: LaneView[] = [];
    const damaged: DamageView[] = [];
    const cuts: CutView[] = [];
    const vis = f.visible;
    const seenTile = (t: number): boolean => !vis || vis(t);
    const nets = new Map<string, TrackNet>();
    this.netKey.clear();
    this.hubTiles.clear();
    for (const p of state.players) {
      if (p.id <= 0 || !p.alive) continue;
      const net = supplyNetworkOf(state, p.id);
      if (!net.hubs.length) continue;
      const mine = p.id === f.me;
      const open = (t: number): boolean => mine || f.me === 0 ? true : seenTile(t);
      const kindOf = new Map<number, (typeof net.hubs)[number]>();
      for (const hb of net.hubs) kindOf.set(hb.tile, hb);
      // which way trains run: away from the capital (the walk's distance over live links)
      const dist = new Map<number, number>();
      const queue: number[] = [];
      for (const hb of net.hubs) if (hb.kind === 'capital') (dist.set(hb.tile, 0), queue.push(hb.tile));
      for (let q = 0; q < queue.length; q++) {
        for (const l of net.links) {
          if (l.cut) continue;
          const other = l.a === queue[q] ? l.b : l.b === queue[q] ? l.a : -1;
          if (other >= 0 && !dist.has(other)) (dist.set(other, (dist.get(queue[q]) as number) + 1), queue.push(other));
        }
      }
      const hubs: Hub[] = [];
      const damagedHere = new Set<number>();
      for (const hb of net.hubs) {
        if (hb.damagedUntil > state.tick) damagedHere.add(hb.tile);
        if (hb.damagedUntil > state.tick && open(hb.tile)) damaged.push({ owner: p.id, tile: hb.tile, until: hb.damagedUntil });
        if (hb.kind !== 'beachhead') hubs.push({ id: hb.tile, type: hb.kind, x: hb.tile % w, y: (hb.tile / w) | 0, owner: p.id });
      }
      this.hubTiles.set(p.id, net.hubs.map((hb) => [(hb.tile % w) + 0.5, ((hb.tile / w) | 0) + 0.5] as P));
      // the rail links laid as one track network (cached while the routes stay)
      const railLinks = net.links.filter((l) => l.kind === 'rail' && !!l.path && l.path.length >= 2);
      let nk = `${p.id}|${w}`;
      for (const l of railLinks) nk += `|${l.a}:${l.b}:${hashTiles(l.path as Int32Array)}`;
      let laid = this.nets.get(nk);
      if (!laid) laid = layTracks(railLinks.map((l): TrackLink => ({ a: l.a, b: l.b, tiles: l.path as Int32Array })), w, terrainAt, (x, y) => x >= 0 && y >= 0 && x < w && y < h && state.map.owner[y * w + x] === p.id);
      nets.set(nk, laid);
      const visibleRoute = (tiles: ArrayLike<number> | null, a: number, b: number): boolean => {
        if (mine || f.me === 0 || !vis) return true;
        if (vis(a) || vis(b)) return true;
        if (tiles) for (let i = 0; i < tiles.length; i += 4) if (vis(tiles[i])) return true;
        return false;
      };
      for (const l of net.links) {
        if (l.kind !== 'sea' || !visibleRoute(l.path, l.a, l.b)) continue;
        const ax = l.a % w;
        const ay = (l.a / w) | 0;
        const bx = l.b % w;
        const by = (l.b / w) | 0;
        lanes.push({ id: `${p.id}|${l.a}|${l.b}`, owner: p.id, a: l.a, b: l.b, lane: null, tried: false, box: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx) + 1, Math.max(ay, by) + 1], sunk: l.cut });
      }
      let anyRail = false;
      railLinks.forEach((l, i) => {
        const path = laid.paths[i];
        if (!path || !visibleRoute(l.path, l.a, l.b)) return;
        anyRail = true;
        const len = pathLength(path);
        const da = dist.get(l.a);
        const db = dist.get(l.b);
        const reversed = da !== undefined && db !== undefined ? db < da : db !== undefined && da === undefined;
        const ha = kindOf.get(l.a);
        const hb2 = kindOf.get(l.b);
        // a broken piece a little way out of the damaged end
        let brk: RailBreak | undefined;
        if (ha && ha.damagedUntil > state.tick) brk = { line: 0, s0: Math.min(1.2, len * 0.3), s1: Math.min(3.2, len * 0.6) };
        else if (hb2 && hb2.damagedUntil > state.tick) brk = { line: 0, s0: Math.max(len * 0.4, len - 3.2), s1: Math.max(len * 0.7, len - 1.2) };
        rails.push({
          id: `${p.id}|${l.a}|${l.b}`,
          owner: p.id,
          a: l.a,
          b: l.b,
          path,
          flow: reversed ? path.slice().reverse() : path,
          length: len,
          box: boxOf(path),
          brk,
          live: !l.cut && !!ha?.connected && !!hb2?.connected,
          seed: mixSeed(l.a, l.b),
        });
      });
      if (!anyRail) continue;
      // the tracks drawn (an enemy's only where some of its network is in view: the whole laid net, it is one picture)
      let key = nk;
      const own: Rail[] = [];
      for (const tr of laid.tracks) {
        const len = pathLength(tr.path);
        let brk: RailBreak | undefined;
        if (tr.hubA && damagedHere.has(tr.a)) brk = { line: 0, s0: Math.min(3.4, len * 0.3), s1: Math.min(5.2, len * 0.5) };
        else if (tr.hubB && damagedHere.has(tr.b)) brk = { line: 0, s0: Math.max(len * 0.5, len - 5.2), s1: Math.max(len * 0.7, len - 3.4) };
        if (brk) key += `|x${tr.id}`;
        tracks.push({ owner: p.id, id: tr.id, path: tr.path, box: boxOf(tr.path), brk });
        if (tr.hubA || tr.hubB) own.push({ a: tr.a, b: tr.b, path: tr.path, bridges: [] });
      }
      // rail yards where three or more tracks run into a hub
      for (const j of junctions(hubs, own)) {
        const lines = yardLines(j, 3, 6, 0.44, 2.4);
        yards.push({ id: `${p.id}|yard|${j.hub}`, owner: p.id, tile: j.hub, lines, box: boxOf(lines.flat()) });
        key += `|y${j.hub}`;
      }
      this.netKey.set(p.id, key);
      const sources = net.cut.filter((t) => open(t));
      if (sources.length) cuts.push({ owner: p.id, tiles: sources });
    }
    this.nets = nets;
    // keep a found lane while its two ends stay
    for (const l of lanes) {
      const c = this.laneCache.get(`${l.a}|${l.b}`);
      if (c !== undefined) {
        l.lane = c;
        l.tried = true;
      }
    }
    this.rails = rails;
    this.tracks = tracks;
    this.lanes = lanes;
    this.yards = yards;
    this.damaged = damaged;
    this.cuts = cuts;
    this.pairs.clear();
  }

  // ----------------------------------------------------------------------------------------------- sprites

  private bakeKey(f: SupplyFrame, owner: number, P: number, brk?: RailBreak): string {
    const oc = f.colors[owner];
    return `${P}|${mapStyle()}|${f.terr?.theme?.id ?? ''}|${oc ? oc.join(',') : ''}|${groundBuilt(f.state.map, f.terr?.theme) ? 1 : 0}${brk ? `|${brk.s0.toFixed(1)}-${brk.s1.toFixed(1)}` : ''}`;
  }

  /** The sprite of an id for a key: cached, baked within the frame's budget, else the id's last one (or null). */
  private sprite(id: string, key: string, bake: () => TrackPixels | null, P: number): Sprite | null {
    const full = `${id}|${key}`;
    const hit = this.sprites.get(full);
    if (hit) {
      this.latest.set(id, hit);
      return hit;
    }
    if (this.budget <= 0) return this.latest.get(id) ?? null;
    this.budget--;
    const px = bake();
    const cv = px ? pixelsCanvas(px) : null;
    if (!px || !cv) return this.latest.get(id) ?? null;
    const sp: Sprite = { cv, x0: px.x0, y0: px.y0, w: px.w, h: px.h, P };
    this.sprites.set(full, sp);
    this.latest.set(id, sp);
    if (this.sprites.size > CACHE_MAX) {
      const oldest = this.sprites.keys().next().value;
      if (oldest !== undefined) this.sprites.delete(oldest);
    }
    return sp;
  }

  private blit(ctx: CanvasRenderingContext2D, s: Sprite, f: SupplyFrame, ox: number, oy: number): void {
    const z = f.zoom;
    const rr = z / s.P;
    const x = Math.round((ox + s.x0 * rr) * f.dpr) / f.dpr;
    const y = Math.round((oy + s.y0 * rr) * f.dpr) / f.dpr;
    ctx.drawImage(s.cv, x, y, s.w * rr, s.h * rr);
  }

  // ----------------------------------------------------------------------------------------------- ground pass

  /**
   * Under the buildings: rails, yards, sea lanes, the cut fronts' shimmer, parked wagons, trains and convoys. Returns
   * the building pairs a rail has replaced the dirt track of (null when nothing is drawn at this zoom).
   */
  drawGround(ctx: CanvasRenderingContext2D, f: SupplyFrame): ReadonlySet<string> | null {
    this.drawn = 0;
    this.trains = 0;
    this.budget = BAKES_PER_FRAME;
    const look = supplyLook(f.zoom);
    if (look === 'none' && !shimmerShown(f.zoom)) return null;
    this.update(f);
    if (look === 'none') {
      this.drawShimmer(ctx, f);
      return null;
    }
    const z = f.zoom;
    const P = artPixelsPerTile(z);
    const ox = f.viewW / 2 - f.camX * z;
    const oy = f.viewH / 2 - f.camY * z;
    const { view } = f;
    const inView = (b: [number, number, number, number]): boolean => !(b[2] + 3 < view.x0 || b[0] - 3 > view.x1 || b[3] + 3 < view.y0 || b[1] - 3 > view.y1);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const groundOf = new Map<number, TrackGround>();
    const ground = (owner: number): TrackGround => {
      let g = groundOf.get(owner);
      if (!g) groundOf.set(owner, (g = groundFor(f.state, f.terr, z, f.colors, owner)));
      return g;
    };
    // sea lanes first (water), then the rails over the land
    const waterTile = (qx: number, qy: number): readonly number[] | null => {
      const m = f.state.map;
      const tx = Math.floor(qx);
      const ty = Math.floor(qy);
      if (tx < 0 || ty < 0 || tx >= m.width || ty >= m.height || !isWater(m.terrain[ty * m.width + tx])) return null;
      const o = (ty * m.width + tx) * 4;
      const rgba = f.terr?.rgba;
      return rgba ? [rgba[o], rgba[o + 1], rgba[o + 2]] : [40, 90, 140];
    };
    let laneWork = 1;
    for (const l of this.lanes) {
      if (!l.tried && laneWork > 0 && inView([l.box[0] - 25, l.box[1] - 25, l.box[2] + 25, l.box[3] + 25])) {
        laneWork--;
        const ck = `${l.a}|${l.b}`;
        const w = f.state.map.width;
        const lane = seaLane({ x: l.a % w, y: (l.a / w) | 0 }, { x: l.b % w, y: (l.b / w) | 0 }, { terrain: (x, y) => (x < 0 || y < 0 || x >= w || y >= f.state.map.height ? 0 : f.state.map.terrain[y * w + x]), owner: () => 0 });
        this.laneCache.set(ck, lane);
        l.lane = lane;
        l.tried = true;
      }
      if (!l.lane) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const q of l.lane) (x0 = Math.min(x0, q[0]), y0 = Math.min(y0, q[1]), x1 = Math.max(x1, q[0]), y1 = Math.max(y1, q[1]));
      if (!inView([x0, y0, x1, y1])) continue;
      const lane = l.lane;
      const sp = this.sprite(`${l.id}|lane`, `${P}`, () => laneArt(lane, P, waterTile), P);
      if (sp) {
        this.blit(ctx, sp, f, ox, oy);
        this.drawn++;
      }
    }
    // the rail network of each owner, baked in square pieces (every track, switch and yard in a piece at once, so
    // tracks that meet share one gravel bed and their rails join)
    const chunk = Math.max(8, Math.round(CHUNK_PX / P));
    const close = look === 'close';
    const byOwner = new Map<number, { lines: P[][]; boxes: [number, number, number, number][]; brks: (RailBreak | undefined)[] }>();
    for (const t of this.tracks) {
      let o = byOwner.get(t.owner);
      if (!o) byOwner.set(t.owner, (o = { lines: [], boxes: [], brks: [] }));
      o.lines.push(t.path);
      o.boxes.push(t.box);
      o.brks.push(t.brk);
    }
    if (close) {
      for (const y of this.yards) {
        const o = byOwner.get(y.owner);
        if (!o) continue;
        for (const l of y.lines) (o.lines.push(l), o.boxes.push(boxOf(l)), o.brks.push(undefined));
      }
    }
    const drawnOwners = new Set<number>();
    const pad = 1;
    for (const [owner, o] of byOwner) {
      const nk = `${this.netKey.get(owner) ?? ''}|${close ? 1 : 0}`;
      const cx0 = Math.floor((view.x0 - 1) / chunk);
      const cy0 = Math.floor((view.y0 - 1) / chunk);
      const cx1 = Math.floor((view.x1 + 1) / chunk);
      const cy1 = Math.floor((view.y1 + 1) / chunk);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const clip: [number, number, number, number] = [cx * chunk, cy * chunk, (cx + 1) * chunk, (cy + 1) * chunk];
          const idx: number[] = [];
          for (let i = 0; i < o.lines.length; i++) {
            const bx = o.boxes[i];
            if (bx[2] + pad < clip[0] || bx[0] - pad > clip[2] || bx[3] + pad < clip[1] || bx[1] - pad > clip[3]) continue;
            idx.push(i);
          }
          if (!idx.length) continue;
          const id = `${owner}|c${cx},${cy}`;
          const sp = this.sprite(id, `${this.bakeKey(f, owner, P)}|${nk}`, () => {
            const lines = idx.map((i) => o.lines[i]);
            const brks: RailBreak[] = [];
            idx.forEach((i, k) => {
              const b = o.brks[i];
              if (b) brks.push({ ...b, line: k });
            });
            return railArt(lines, ground(owner), mixSeed(owner, 7) % 7, brks, clip);
          }, P);
          if (!sp) continue;
          this.blit(ctx, sp, f, ox, oy);
          this.drawn++;
          drawnOwners.add(owner);
        }
      }
    }
    for (const r of this.rails) if (drawnOwners.has(r.owner)) this.pairs.add(railPairKey(r.a, r.b));
    ctx.restore();
    this.drawShimmer(ctx, f);
    if (z >= SUPPLY_SPRITE_ZOOM) this.drawYardWagons(ctx, f, ox, oy, inView);
    this.drawTrains(ctx, f, ox, oy, inView);
    this.drawConvoys(ctx, f, ox, oy, inView);
    return this.pairs;
  }

  // ----------------------------------------------------------------------------------------------- cut fronts

  /** A grey shimmer along the border within SHIMMER_R tiles of every cut fort (re-made about six times a second). */
  private drawShimmer(ctx: CanvasRenderingContext2D, f: SupplyFrame): void {
    if (!shimmerShown(f.zoom) || !this.cuts.length) return;
    const z = f.zoom;
    const P = artPixelsPerTile(z);
    const ox = f.viewW / 2 - f.camX * z;
    const oy = f.viewH / 2 - f.camY * z;
    const m = f.state.map;
    const w = m.width;
    const bucket = Math.floor(f.nowMs / 170);
    let made = 0;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const c of this.cuts) {
      for (const t of c.tiles) {
        const tx = t % w;
        const ty = (t / w) | 0;
        const x0 = Math.max(f.view.x0, tx - SHIMMER_R);
        const y0 = Math.max(f.view.y0, ty - SHIMMER_R);
        const x1 = Math.min(f.view.x1, tx + SHIMMER_R + 1);
        const y1 = Math.min(f.view.y1, ty + SHIMMER_R + 1);
        if (x1 <= x0 || y1 <= y0) continue;
        const id = `${c.owner}|${t}`;
        let e = this.shimmer.get(id);
        const box: [number, number, number, number] = [x0, y0, x1, y1];
        const stale = !e || e.P !== P || e.box.some((v, i) => v !== box[i]) || (e.bucket !== bucket && made < 2);
        if (stale) {
          made++;
          const px = frontArt(x0 * P, y0 * P, (x1 - x0) * P, (y1 - y0) * P, P, (qx, qy) => (qx < 0 || qy < 0 || qx >= w || qy >= m.height ? 0 : m.owner[qy * w + qx]), c.owner, f.nowMs);
          e = { bucket, box, cv: pixelsCanvas(px), P };
          this.shimmer.set(id, e);
          if (this.shimmer.size > 40) this.shimmer.delete(this.shimmer.keys().next().value as string);
        }
        if (e?.cv) ctx.drawImage(e.cv, Math.round((ox + x0 * z) * f.dpr) / f.dpr, Math.round((oy + y0 * z) * f.dpr) / f.dpr, (x1 - x0) * z, (y1 - y0) * z);
      }
    }
    ctx.restore();
  }

  // ----------------------------------------------------------------------------------------------- trains

  private screenPath(path: readonly P[], ox: number, oy: number, z: number): P[] {
    return path.map((p) => [ox + p[0] * z, oy + p[1] * z] as P);
  }

  private drawTrains(ctx: CanvasRenderingContext2D, f: SupplyFrame, ox: number, oy: number, inView: (b: [number, number, number, number]) => boolean): void {
    const z = f.zoom;
    const clock = (f.tickF / TICKS_PER_SECOND) * TRAIN_SPEED;
    const near = (x: number, y: number): boolean => x >= f.view.x0 - 8 && x <= f.view.x1 + 8 && y >= f.view.y0 - 8 && y <= f.view.y1 + 8;
    const sprite = z >= SUPPLY_SPRITE_ZOOM;
    let drawn = 0;
    for (const r of this.rails) {
      if (!sprite || !r.live || !inView(r.box) || drawn >= 14) continue;
      const first = r.flow[0];
      const last = r.flow[r.flow.length - 1];
      if (!near(first[0], first[1]) || !near(last[0], last[1])) continue;
      const cars = trainCars(1 + (r.seed % 3), r.seed);
      // the train's length in tiles; it runs only between the hubs' footprints, fading in and out at their edges
      const len = (trainLength(cars) * spriteScale(z)) / z;
      const span = r.length - 2 * HUB_CLEAR;
      if (span < len + 1) continue;
      const run = span - len;
      const cycle = run + TRAIN_GAP;
      const u = (clock + (r.seed % 97) * 0.37) % cycle;
      if (u > run) continue;
      const head = HUB_CLEAR + len + u;
      // it fades out over any other hub's building on the way too
      const mid = pointAt(r.flow, head - len / 2);
      let nearHub = Infinity;
      for (const q of this.hubTiles.get(r.owner) ?? []) nearHub = Math.min(nearHub, Math.hypot(q[0] - mid.x, q[1] - mid.y));
      const fade = Math.min(1, u / 1.2, (run - u) / 1.2, Math.max(0, (nearHub - len / 2 - 1.4) / 1.2));
      if (fade <= 0.02) continue;
      const color = f.colors[r.owner] ?? [128, 128, 128];
      const sp = this.screenPath(r.flow, ox, oy, z);
      ctx.save();
      ctx.globalAlpha *= fade;
      drawTrain(ctx, { path: sp, head: head * z, cars, owner: color, scale: spriteScale(z), dpr: f.dpr, timeMs: f.nowMs });
      ctx.restore();
      drawn++;
    }
    this.trains = drawn;
  }

  /** Wagons standing in a yard's sidings (close look). */
  private drawYardWagons(ctx: CanvasRenderingContext2D, f: SupplyFrame, ox: number, oy: number, inView: (b: [number, number, number, number]) => boolean): void {
    const sets: [CarKind[], number][] = [[['crates', 'drums'], 0.86], [[], 0], [['tank', 'flatTank'], 0.34], [['flatHeavy'], 0.84]];
    const z = f.zoom;
    for (const y of this.yards) {
      if (!inView(y.box)) continue;
      const color = f.colors[y.owner] ?? [128, 128, 128];
      y.lines.forEach((line, i) => {
        const [cars, at] = sets[(i + y.tile) % sets.length];
        if (!cars.length) return;
        const path = this.screenPath(line, ox, oy, z);
        drawTrain(ctx, { path, head: pathLength(path) * at, cars, owner: color, scale: spriteScale(z), dpr: f.dpr, timeMs: 0, smoke: false });
      });
    }
  }

  // ----------------------------------------------------------------------------------------------- convoys

  private drawConvoys(ctx: CanvasRenderingContext2D, f: SupplyFrame, ox: number, oy: number, inView: (b: [number, number, number, number]) => boolean): void {
    const z = f.zoom;
    const sail = SUPPLY_LINES.convoySailSeconds * TICKS_PER_SECOND;
    const units: TrailUnit[] = [];
    const draws: UnitDraw[] = [];
    const scale = spriteScale(z);
    const len = detailedUnits.lengthPx('tradeShip', 0, scale);
    const motion = motionOf('lively');
    for (const l of this.lanes) {
      if (!l.lane || l.sunk) continue;
      const ph = convoyPhase(f.tickF, l.a, l.b);
      if (ph >= sail) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const q of l.lane) (x0 = Math.min(x0, q[0]), y0 = Math.min(y0, q[1]), x1 = Math.max(x1, q[0]), y1 = Math.max(y1, q[1]));
      if (!inView([x0, y0, x1, y1])) continue;
      const color = f.colors[l.owner] ?? [128, 128, 128];
      const L = pathLength(l.lane);
      const span = L + CONVOY_GAP * CONVOY_SHIPS;
      const lead = (ph / sail) * span;
      // no marker at normal zoom: the dotted lane says where convoys sail; the ships show close up
      if (z < SUPPLY_SPRITE_ZOOM) continue;
      for (let i = CONVOY_SHIPS - 1; i >= 0; i--) {
        const s = lead - i * CONVOY_GAP;
        if (s < 0 || s > L) continue;
        const p = pointAt(l.lane, s);
        const x = ox + p.x * z;
        const y = oy + p.y * z;
        const id = 900000 + (l.a % 1000) * 10 + i;
        units.push({ id, key: 'tradeShip', x, y, tx: p.x, ty: p.y, angle: p.angle, half: len / 2, moving: true, speed: span / (sail / TICKS_PER_SECOND), turnRate: 0, motion });
        draws.push({ key: 'tradeShip', mods: 0, owner: color, x, y, angle: p.angle, zoom: z, scale, lod: scale >= 2 ? 'near' : 'mid', dpr: f.dpr, timeMs: f.nowMs, turnRate: 0, speed: 2, moving: true, seed: id, alpha: 1, shadow: true, damage: 0, outline: true });
      }
    }
    if (z >= SUPPLY_SPRITE_ZOOM) {
      this.wakes.frame(ctx, units, { ox, oy, zoom: z, scale, now: f.nowMs, viewW: f.viewW, viewH: f.viewH, dpr: f.dpr, full: true });
      for (const u of draws) detailedUnits.drawUnit(ctx, u, motion);
    }
  }

  // ----------------------------------------------------------------------------------------------- marks (over the buildings)

  /** Smoke, repair timers and crosses on damaged hubs, and the "Supply cut" labels. */
  drawMarks(ctx: CanvasRenderingContext2D, f: SupplyFrame): void {
    const z = f.zoom;
    if (!this.damaged.length && !this.cuts.length) return;
    const { state } = f;
    const w = state.map.width;
    const ox = f.viewW / 2 - f.camX * z;
    const oy = f.viewH / 2 - f.camY * z;
    const { view } = f;
    const art = z >= ART_ZOOM;
    for (const d of this.damaged) {
      if (state.tick >= d.until) continue;
      const tx = d.tile % w;
      const ty = (d.tile / w) | 0;
      if (tx < view.x0 - 3 || tx > view.x1 + 3 || ty < view.y0 - 4 || ty > view.y1 + 3) continue;
      const sx = ox + (tx + 0.5) * z;
      const sy = oy + (ty + 0.5) * z;
      if (!art) damageCross(ctx, sx, sy, z >= FAR_ZOOM ? markerSize(z) : 10);
      if (z < SUPPLY_MARK_ZOOM) continue;
      const g = gridOf(spriteScale(z), f.dpr);
      const k = spriteScale(z);
      // a thick column of smoke leaning with the wind, black at its root and greying as it rises
      for (let i = 8; i >= 0; i--) {
        const age = (f.nowMs / 2600 + i / 9) % 1;
        const x = sx + (3 + age * 16 + Math.sin(age * 5 + i) * 2) * k;
        const y = sy - (6 + age * 38) * k;
        drawBlob(ctx, age < 0.35 ? 'soot' : 'smoke', (2.6 + age * 6.5) * g.res, i & 3, x, y, g, 0.95 * (1 - age * 0.85));
      }
      if (z >= SUPPLY_SPRITE_ZOOM) drawBlob(ctx, 'fire', 2.4 * g.res, Math.floor(f.nowMs / 120) & 3, sx + 3 * k, sy - 4 * k, g, 0.95);
      const left = repairLeft(state, d.until);
      const total = Math.max(left, SUPPLY_LINES.repairSeconds);
      supplyLabel(ctx, sx, sy + (art ? 34 : 22), `Repair ${left} s`, 'repair', 1 - left / total);
    }
    if (z < SUPPLY_MARK_ZOOM) return;
    // one label per cluster of cut forts (within 20 tiles of one another)
    const placed: number[] = [];
    for (const c of this.cuts) {
      for (const t of c.tiles) {
        const tx = t % w;
        const ty = (t / w) | 0;
        if (tx < view.x0 - 3 || tx > view.x1 + 3 || ty < view.y0 - 4 || ty > view.y1 + 3) continue;
        if (placed.some((p) => Math.hypot((p % w) - tx, ((p / w) | 0) - ty) < 20)) continue;
        placed.push(t);
        supplyLabel(ctx, ox + (tx + 0.5) * z, oy + (ty + 0.5) * z - (art ? 34 : 20), 'Supply cut', 'cut');
      }
    }
  }
}
