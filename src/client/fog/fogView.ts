// Fog of war, the client's view (game rule Modifiers.fogOfWar; the sim's vision is src/sim/fog.ts).
//
// The sim keeps, per player, which 16 x 16 tile blocks are in view now and which were ever seen; it is lockstep
// state because AI and auto units obey it. This view only reads it for the seat this client shows (state.humanId)
// and keeps what a player remembers, which is not game state:
//   - known owners: the renderer's tile feed (render/tiles.ts) stops taking owner changes in blocks out of view, so
//     its mirror holds the last owner seen there (0 = never seen); `feed` points at it once the renderer is wired in
//   - buildings and capitals last seen in blocks now out of view (greyed on the map, "last seen" in the tooltip)
//   - nations met (ever had land, a building, a unit or a capital in view, or diplomatic contact) and nations in
//     sight now (army totals are shown only for those, allies, or with watchtower / recon intel)
// Nothing here writes the GameState or fills a sim cache: refresh() reads the fog bits (pure reads, fog.ts).
//
// One view per game (fogFor). No fog for this client: the rule is off, the phase is not 'playing', a spectator, the
// owner console's revealIntel, or a player eliminated in a free-for-all (watching). A teams player who was eliminated
// while the team lives sees what the team sees.
import { airSeen, fogOn, seesAll } from '../../sim/fog';
import { armyTotalOf, hasIntel } from '../../sim/buildings';
import { areAllied } from '../../sim/diplomacy';
import { sameTeam } from '../../sim/rules';
import { blockCountsOf } from '../../sim/territory';
import { unitVisibleTo } from '../../sim/techtree';
import type { BuildingType, GameState, Unit } from '../../sim/types';

/** Vision grid block size in tiles (territory.BLOCK; repeated so the map shader math can use it). */
export const FOG_BLOCK = 16;
const SHIFT = 4;
/** Fog texture values: in view, explored, never seen. */
export const FOG_LIVE = 255;
export const FOG_SEEN = 110;
/** nations in sight are re-checked at least this often (ticks; FOG.humanTicks) */
const SIGHT_TICKS = 5;

export interface Remembered {
  type: BuildingType;
  owner: number;
  level: number;
}

/** What the view needs of the tile feed (render/tiles.ts). */
export interface KnownFeed {
  vis: ((i: number) => number) | null;
  owner(i: number): number;
  revealBlock(bx: number, by: number, bs: number): void;
  full(): void;
}

const AIR = new Set(['bomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb']);

export class FogView {
  /** fog applies to this client right now */
  active = false;
  /** changes whenever the bits, the memory or `active` change (cache keys for layers) */
  gen = 0;
  /** changes only when the view's bits or `active` change (texture, minimap) */
  bitsGen = 0;
  bw = 0;
  bh = 0;
  /** viewer's blocks in view / explored (copies; empty when not active) */
  now = new Uint32Array(0);
  seen = new Uint32Array(0);
  /** bw x bh: FOG_LIVE in view, FOG_SEEN explored, 0 unexplored (the map shader's fog texture) */
  tex = new Uint8Array(0);
  /** set when tex changed (the GL layer uploads and clears it) */
  texDirty = true;
  /** buildings last seen in blocks out of view, by tile */
  buildings = new Map<number, Remembered>();
  /** capitals last seen, by player id */
  capitals = new Map<number, number>();
  /** nations met (never shrinks within a game) */
  met = new Set<number>();
  /** nations with land or units in view now */
  inSight = new Set<number>();
  feed: KnownFeed | null = null;

  private state: GameState | null = null;
  private viewer = 0;
  private lastTick = -1;
  private lastPhase = '';
  private lastBuildings = -1;
  private lastSight = -1;
  private readEvents = new WeakSet<object>();

  private visFn = (i: number): number => this.tileVis(i);

  /** Connects the renderer's tile feed: it then keeps the known map (last owners seen) for this view. */
  attach(feed: KnownFeed): void {
    if (this.feed === feed) return;
    this.feed = feed;
    feed.vis = this.active ? this.visFn : null;
    if (this.active) feed.full();
  }

  /** Brings the view up to date with the state (cheap when nothing changed: compares a tick stamp). */
  refresh(state: GameState): void {
    const viewer = state.humanId;
    if (state !== this.state) this.newGame(state);
    const phaseKey = `${state.phase}:${state.continued ? 1 : 0}:${state.admin?.revealIntel.length ?? 0}`;
    if (state.tick === this.lastTick && viewer === this.viewer && phaseKey === this.lastPhase && state.buildingsVersion === this.lastBuildings) return;
    const bitsTick = state.tick !== this.lastTick || viewer !== this.viewer || phaseKey !== this.lastPhase;
    this.lastTick = state.tick;
    this.lastPhase = phaseKey;
    if (viewer !== this.viewer) {
      this.viewer = viewer;
      this.met.clear();
      this.buildings.clear();
      this.capitals.clear();
    }
    const want = this.wanted(state);
    if (want !== this.active) {
      this.active = want;
      this.gen++;
      this.bitsGen++;
      this.texDirty = true;
      if (want) this.copyBits(state, true);
      else {
        this.now.fill(0);
        this.seen.fill(0);
      }
      if (this.feed) {
        this.feed.vis = want ? this.visFn : null;
        this.feed.full();
      }
      this.lastBuildings = state.buildingsVersion;
      if (want) this.remember(state);
      return;
    }
    if (!want) return;
    let changed = false;
    if (bitsTick) changed = this.copyBits(state, false);
    if (changed || state.buildingsVersion !== this.lastBuildings) {
      this.lastBuildings = state.buildingsVersion;
      this.remember(state);
      this.gen++;
    } else if (bitsTick) {
      if (state.tick - this.lastSight >= SIGHT_TICKS || state.tick < this.lastSight) this.sight(state);
      else this.contacts(state);
    }
  }

  // ------------------------------------------------------------------ reads

  /** 2 = in view, 1 = explored (last seen), 0 = never seen. Everything is 2 without fog. */
  tileVis(tile: number): number {
    if (!this.active) return 2;
    const w = this.state!.map.width;
    const x = tile % w;
    const y = (tile - x) / w;
    const b = (y >> SHIFT) * this.bw + (x >> SHIFT);
    const bit = 1 << (b & 31);
    return this.now[b >>> 5] & bit ? 2 : this.seen[b >>> 5] & bit ? 1 : 0;
  }
  visible(tile: number): boolean {
    return this.tileVis(tile) === 2;
  }
  explored(tile: number): boolean {
    return this.tileVis(tile) > 0;
  }
  /** Owner this player knows: live in view, last seen when explored, 0 when never seen. */
  knownOwner(state: GameState, tile: number): number {
    if (tile < 0 || tile >= state.map.owner.length) return 0;
    const v = this.tileVis(tile);
    if (v === 2) return state.map.owner[tile];
    if (v === 0) return 0;
    return this.feed ? this.feed.owner(tile) : state.map.owner[tile];
  }
  /** May this client see unit u now (own, allied, in view, or aircraft on own / allied radar; hidden submarines never)? */
  unitShown(state: GameState, u: Unit): boolean {
    if (!this.active) return true;
    const me = this.viewer;
    if (u.owner === me) return true;
    if (!unitVisibleTo(state, me, u)) return false;
    if (this.teamOf(state, u.owner)) return true;
    if (AIR.has(u.type)) return airSeen(state, me, u) || this.unitInView(state, u);
    return this.unitInView(state, u);
  }
  /** Has this player met nation id (name, colour and card are known)? Always true without fog. */
  isMet(id: number): boolean {
    return !this.active || id <= 0 || id === this.viewer || this.met.has(id);
  }
  /** The army total of nation id as this player may see it, or null ("?": out of sight and no intel). */
  armyShown(state: GameState, id: number): number | null {
    if (!this.active || id === this.viewer || this.inSight.has(id) || this.teamOf(state, id) || hasIntel(state, this.viewer, id)) return armyTotalOf(state, id);
    return null;
  }
  /** A capital this player knows (in view or remembered), else -1. */
  knownCapital(state: GameState, id: number): number {
    const cap = state.players[id]?.capital ?? -1;
    if (!this.active || id === this.viewer || this.teamOf(state, id)) return cap;
    if (cap >= 0 && this.visible(cap)) return cap;
    return this.capitals.get(id) ?? -1;
  }
  /** The building this player sees or remembers at a tile: live in view, remembered when explored, else null. */
  buildingAt(state: GameState, tile: number): { type: BuildingType; owner: number; level: number; live: boolean } | null {
    const v = this.tileVis(tile);
    if (v === 2) {
      const id = state.map.building[tile] - 1;
      const b = id >= 0 ? state.buildings.get(id) : undefined;
      return b ? { type: b.type, owner: b.owner, level: b.level, live: true } : null;
    }
    if (v === 0) return null;
    const r = this.buildings.get(tile);
    return r ? { ...r, live: false } : null;
  }

  // ------------------------------------------------------------------ internals

  private newGame(state: GameState): void {
    this.state = state;
    const f = state.fog;
    this.bw = f ? f.bw : 0;
    this.bh = f ? f.bh : 0;
    const words = f ? f.words : 0;
    this.now = new Uint32Array(words);
    this.seen = new Uint32Array(words);
    this.tex = new Uint8Array(this.bw * this.bh);
    this.texDirty = true;
    this.active = false;
    this.viewer = state.humanId;
    this.lastTick = -1;
    this.lastPhase = '';
    this.lastBuildings = -1;
    this.lastSight = -1;
    this.readEvents = new WeakSet<object>();
    this.buildings.clear();
    this.capitals.clear();
    this.met.clear();
    this.inSight.clear();
    this.gen++;
  }

  private wanted(state: GameState): boolean {
    const me = state.humanId;
    if (!state.fog || !fogOn(state) || me <= 0 || seesAll(state, me)) return false;
    const p = state.players[me];
    if (!p) return false;
    if (p.alive) return true;
    // Eliminated: team vision while a teammate lives; a free-for-all watcher sees everything.
    return state.players.some((q) => q.alive && sameTeam(state, me, q.id));
  }

  /** Copies the viewer's bits (OR of alive teammates' when eliminated); true when they changed. */
  private copyBits(state: GameState, force: boolean): boolean {
    const f = state.fog!;
    const me = state.humanId;
    const p = state.players[me];
    const srcs: number[] = p?.alive ? [me] : state.players.filter((q) => q.alive && sameTeam(state, me, q.id)).map((q) => q.id);
    const n = this.now.length;
    let changed = force;
    const fresh: number[] = [];
    for (let k = 0; k < n; k++) {
      let nw = 0;
      let sn = f.seen[me]?.[k] ?? 0;
      for (const s of srcs) {
        nw |= f.now[s]?.[k] ?? 0;
        sn |= f.seen[s]?.[k] ?? 0;
      }
      sn |= nw;
      if (nw !== this.now[k] || sn !== this.seen[k] || force) {
        const gained = (nw & ~this.now[k]) >>> 0;
        if (gained && !force) fresh.push(k, gained);
        if (nw !== this.now[k] || sn !== this.seen[k]) changed = true;
        this.now[k] = nw;
        this.seen[k] = sn;
      }
    }
    if (!changed) return false;
    this.gen++;
    this.bitsGen++;
    this.texDirty = true;
    const nb = this.bw * this.bh;
    for (let b = 0; b < nb; b++) {
      const bit = 1 << (b & 31);
      this.tex[b] = this.now[b >>> 5] & bit ? FOG_LIVE : this.seen[b >>> 5] & bit ? FOG_SEEN : 0;
    }
    // Blocks that came into view: the feed catches up on what changed there while they were hidden (no flashes).
    if (this.feed) {
      for (let j = 0; j < fresh.length; j += 2) {
        const k = fresh[j];
        let bits = fresh[j + 1];
        while (bits) {
          const low = bits & -bits;
          const b = k * 32 + (31 - Math.clz32(low));
          bits = (bits & ~low) >>> 0;
          if (b < nb) this.feed.revealBlock(b % this.bw, (b / this.bw) | 0, FOG_BLOCK);
        }
      }
    }
    return true;
  }

  /** Rebuilds the memory of buildings, capitals, met nations and nations in sight from what is in view now. */
  private remember(state: GameState): void {
    const me = this.viewer;
    // Buildings: forget what is in view now, then note every building in view.
    for (const tile of [...this.buildings.keys()]) if (this.visible(tile)) this.buildings.delete(tile);
    for (const b of state.buildings.values()) {
      if (b.owner === me || !this.visible(b.tile)) continue;
      this.buildings.set(b.tile, { type: b.type, owner: b.owner, level: b.level });
      this.met.add(b.owner);
    }
    this.sight(state);
  }

  /**
   * Capitals in view, nations in sight now (land in a block in view, or a unit you see) and nations met. Runs with
   * every change of the bits or buildings and at least every SIGHT_TICKS ticks (land and units move into view between).
   */
  private sight(state: GameState): void {
    const me = this.viewer;
    this.lastSight = state.tick;
    const metBefore = this.met.size;
    for (const [id, tile] of [...this.capitals]) {
      const p = state.players[id];
      if (this.visible(tile) && (!p || !p.alive || p.capital !== tile)) this.capitals.delete(id);
    }
    const sight = new Set<number>();
    for (const p of state.players) {
      if (p.id <= 0) continue;
      if (p.id === me || this.teamOf(state, p.id)) {
        this.met.add(p.id);
        sight.add(p.id);
        continue;
      }
      if (p.alive && p.capital >= 0 && this.visible(p.capital)) {
        this.capitals.set(p.id, p.capital);
        this.met.add(p.id);
      }
    }
    // Land in view: every player holding a tile of a block in view (the territory index's per-block counts, exact).
    const nb = this.bw * this.bh;
    const vis: number[] = [];
    for (let b = 0; b < nb; b++) if (this.now[b >>> 5] & (1 << (b & 31))) vis.push(b);
    for (const p of state.players) {
      if (p.id <= 0 || p.id === me || !p.alive || sight.has(p.id)) continue;
      const { counts } = blockCountsOf(state, p.id);
      if (!counts.length || !p.tiles) continue;
      for (let k = 0; k < vis.length; k++) {
        if (counts[vis[k]] > 0) {
          sight.add(p.id);
          break;
        }
      }
    }
    for (const u of state.units) if (u.hp > 0 && u.owner !== me && this.unitShown(state, u)) sight.add(u.owner);
    for (const q of sight) this.met.add(q);
    const same = sight.size === this.inSight.size && [...sight].every((q) => this.inSight.has(q));
    this.inSight = sight;
    this.contacts(state);
    if (!same || this.met.size !== metBefore) this.gen++;
  }

  /** Diplomatic contact makes a nation met: alliance requests either way, and events addressed to you naming it. */
  private contacts(state: GameState): void {
    const me = this.viewer;
    for (const r of state.allianceRequests) {
      if (r.from === me) this.met.add(r.to);
      if (r.to === me) this.met.add(r.from);
    }
    // Events addressed to this player name the others in them (an attack on you, an alliance offer).
    const ev = state.events;
    for (let j = ev.length - 1; j >= 0 && !this.readEvents.has(ev[j]); j--) {
      const e = ev[j];
      this.readEvents.add(e);
      if (e.players.includes(me)) for (const q of e.players) if (q > 0) this.met.add(q);
    }
  }

  private unitInView(state: GameState, u: Unit): boolean {
    const w = state.map.width;
    const x = Math.max(0, Math.min(w - 1, Math.round(u.x)));
    const y = Math.max(0, Math.min(state.map.height - 1, Math.round(u.y)));
    return this.visible(y * w + x);
  }
  private teamOf(state: GameState, id: number): boolean {
    return id > 0 && id !== this.viewer && areAllied(state, this.viewer, id);
  }
}

const views = new WeakMap<GameState, FogView>();

/** The fog view of a game, refreshed (cheap when nothing changed). One per GameState, client side only. */
export function fogFor(state: GameState): FogView {
  let v = views.get(state);
  if (!v) views.set(state, (v = new FogView()));
  v.refresh(state);
  return v;
}

/** The known owner of a tile for this client (the real owner without fog). */
export function knownOwnerOf(state: GameState, tile: number): number {
  if (!state.fog) return tile >= 0 && tile < state.map.owner.length ? state.map.owner[tile] : 0;
  return fogFor(state).knownOwner(state, tile);
}

/** The fog view when fog applies to this client right now, else null (HUD panels: null = show everything). */
export function activeFog(state: GameState | null | undefined): FogView | null {
  if (!state || !state.fog) return null;
  const v = fogFor(state);
  return v.active ? v : null;
}

/** Display name of a nation for this client: "Unknown nation" when fog hides one it has not met. */
export function nationName(state: GameState, id: number): string {
  const p = state.players[id];
  if (!p) return 'Unknown nation';
  const fog = activeFog(state);
  return fog && !fog.isMet(id) ? UNKNOWN_NATION : p.name;
}
export const UNKNOWN_NATION = 'Unknown nation';
/** Toast for a click on a nation this player has not met. */
export const UNMET_TOAST = 'You have not met this nation yet. Expand toward them, or build a Watchtower to see further.';
/** Tip for an army number fog hides. */
export const ARMY_HIDDEN_TIP = 'Out of sight: a Watchtower near them shows it';

/**
 * An event as this client may read it (fog of war). Events addressed to you name nations you then know (contacts()
 * marks them met). Broadcasts (no players listed: an atom bomb, the fall of a nation) say nothing about nations you
 * have not met: the fall of one says so without the name, any other names one only as "an unknown nation"; and a
 * broadcast on land you never explored carries no map spot (no camera jump, no panned sound). Returns the event
 * itself when nothing is hidden (a copy otherwise; the sim's event is untouched).
 */
export function fogEvent<E extends { kind: string; message: string; players: number[]; tile: number }>(state: GameState, e: E): E {
  const fog = activeFog(state);
  if (!fog || e.players.length > 0) return e;
  let message = e.message;
  if (e.kind === 'eliminated') {
    for (const p of state.players) {
      const head = `${p.name} has been eliminated`;
      if (p.id <= 0 || !e.message.startsWith(head)) continue;
      if (!fog.isMet(p.id)) message = 'A nation you have not met has fallen';
      else {
        // "... by Y": Y is named only once met
        for (const q of state.players) {
          if (q.id > 0 && !fog.isMet(q.id) && e.message.startsWith(`${head} by ${q.name}`)) message = `${head} by a nation you have not met`;
        }
      }
      break;
    }
  } else message = hideUnmet(state, fog, message);
  const tile = e.tile >= 0 && !fog.explored(e.tile) ? -1 : e.tile;
  return message === e.message && tile === e.tile ? e : { ...e, message, tile };
}

/** A text with the names of nations this player has not met replaced by "an unknown nation" (longest names first). */
function hideUnmet(state: GameState, fog: FogView, text: string): string {
  const unmet = state.players.filter((p) => p.id > 0 && p.name && !fog.isMet(p.id) && text.includes(p.name)).sort((a, b) => b.name.length - a.name.length);
  if (!unmet.length) return text;
  // met names that hold an unmet one ("Varkosia" and "Varkos") are set aside first
  const kept = state.players.filter((p) => p.id > 0 && p.name && fog.isMet(p.id) && text.includes(p.name) && unmet.some((q) => p.name.includes(q.name)));
  let out = text;
  kept.forEach((p, k) => (out = out.split(p.name).join(`\u0001${k}\u0001`)));
  for (const p of unmet) out = out.split(p.name).join('\u0000');
  out = out.split('\u0000').join('an unknown nation');
  kept.forEach((p, k) => (out = out.split(`\u0001${k}\u0001`).join(p.name)));
  return out.charAt(0).toUpperCase() + out.slice(1);
}
