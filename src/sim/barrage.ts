// Artillery barrage (Action 'barrage', DESIGN section 4, "Special land abilities").
//
// A player with at least BARRAGE_MIN_ARTILLERY artillery (at home and in attacks) shells enemy land within
// barrageRange of its own land. The order is telegraphed: a Barrage sits in state.barrages for BARRAGE_DELAY seconds
// (the client draws the warning circle), then the shells land on a disc of BARRAGE_RADIUS:
//   - every hostile owner with land on the disc loses troops from its home army: together barrageKill(artillery)
//     (diminishing in the artillery count), split by their share of the disc, each at most BARRAGE_KILL_ARMY_SHARE of
//     its home army;
//   - hostile forts and SAM sites lose BARRAGE_BUILDING_DAMAGE hp (0 = destroyed) and are knocked out for
//     BARRAGE_DISABLE_SECONDS (no fort bonus, no SAM shots): the counter to SAM cover near a front. Shells are not
//     aircraft: SAMs never intercept them;
//   - other hostile buildings are destroyed with BARRAGE_DESTROY_CHANCE (state.rng, in tile order).
// The front does not move. One barrage per player every barrageCooldown seconds (Player.barrageReadyTick).
import { buildingAt, destroyBuilding } from './buildings';
import {
  BARRAGE_BALLISTICS_RANGE,
  BARRAGE_BUILDING_DAMAGE,
  BARRAGE_COOLDOWN,
  BARRAGE_COOLDOWN_BALLISTICS,
  BARRAGE_DELAY,
  BARRAGE_DESTROY_CHANCE,
  BARRAGE_DISABLE_SECONDS,
  BARRAGE_GOLD,
  BARRAGE_KILL_ARMY_SHARE,
  BARRAGE_KILL_HALF,
  BARRAGE_KILL_MAX,
  BARRAGE_MIN_ARTILLERY,
  BARRAGE_RADIUS,
  BARRAGE_RANGE,
  BUILDINGS,
  TICKS_PER_SECOND,
} from './config';
import { areAllied } from './diplomacy';
import { atPeace, peaceReason } from './rules';
import { forEachInRadius } from './grid';
import { addEvent, newId } from './state';
import { hasTech } from './tech';
import { TROOP_TYPES, isWater } from './types';
import type { ActionResult, Barrage, GameState, Player } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** Artillery a player has: at home plus in its attacks. */
export function artilleryOf(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId <= 0) return 0;
  let n = p.troops.artillery;
  for (const a of state.attacks) if (a.attacker === playerId) n += a.troops.artillery;
  return n;
}

/** How far from your own land a barrage reaches (tiles; Ballistics x BARRAGE_BALLISTICS_RANGE). */
export function barrageRange(p: Player): number {
  return BARRAGE_RANGE * (hasTech(p, 'ballistics') ? BARRAGE_BALLISTICS_RANGE : 1);
}

/** Seconds between two barrages of a player (Ballistics: BARRAGE_COOLDOWN_BALLISTICS). */
export function barrageCooldown(p: Player): number {
  return hasTech(p, 'ballistics') ? BARRAGE_COOLDOWN_BALLISTICS : BARRAGE_COOLDOWN;
}

/** Seconds until playerId may fire the next barrage (0 = now). */
export function barrageReadyIn(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p) return 0;
  return Math.max(0, (p.barrageReadyTick - state.tick) / TICKS_PER_SECOND);
}

/** Troops a barrage fired with `artillery` kills in all (before the per-victim cap): diminishing, at most BARRAGE_KILL_MAX. */
export function barrageKill(artillery: number): number {
  if (!(artillery > 0)) return 0;
  return (BARRAGE_KILL_MAX * artillery) / (artillery + BARRAGE_KILL_HALF);
}

/** True if playerId owns a tile within r (straight line) of tile. Early exit; at most (2r+1)^2 reads. */
function ownLandWithin(state: GameState, playerId: number, tile: number, r: number): boolean {
  const map = state.map;
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const ri = Math.floor(r);
  const r2 = r * r;
  const owner = map.owner;
  for (let y = Math.max(0, cy - ri); y <= Math.min(map.height - 1, cy + ri); y++) {
    const dy = y - cy;
    const row = y * w;
    for (let x = Math.max(0, cx - ri); x <= Math.min(w - 1, cx + ri); x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2 && owner[row + x] === playerId) return true;
    }
  }
  return false;
}

/**
 * Checks a barrage order (the client previews with it): the guns are loaded (barrageReadyIn), at least
 * BARRAGE_MIN_ARTILLERY artillery, the tile is land of a living, non-allied nation or tribe within barrageRange of
 * your own land, and BARRAGE_GOLD gold.
 */
export function canBarrage(state: GameState, playerId: number, tile: number): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  const map = state.map;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.owner.length) return FAIL('Invalid tile');
  if (p.barrageReadyTick > state.tick) return FAIL(`Your guns are reloading (${Math.ceil(barrageReadyIn(state, playerId))} s)`);
  if (artilleryOf(state, playerId) < BARRAGE_MIN_ARTILLERY) return FAIL(`Needs at least ${BARRAGE_MIN_ARTILLERY} artillery (build an Arsenal)`);
  if (isWater(map.terrain[tile])) return FAIL('Shell enemy land, not water');
  const target = map.owner[tile];
  if (target === playerId) return FAIL('That is your own land');
  if (target === 0) return FAIL('Nobody to shell there');
  if (!state.players[target]?.alive) return FAIL('That nation is gone');
  if (areAllied(state, playerId, target)) return FAIL('You cannot shell an ally');
  const peace = peaceReason(state, playerId, target);
  if (peace) return FAIL(peace);
  const range = barrageRange(p);
  if (!ownLandWithin(state, playerId, tile, range)) return FAIL(`Too far: guns reach ${range} tiles from your border`);
  if (p.gold < BARRAGE_GOLD) return FAIL(`Not enough gold (${BARRAGE_GOLD})`);
  return { ok: true };
}

/** Fires a barrage: pays, starts the cooldown, queues the shells (they land BARRAGE_DELAY s later) and warns the target. */
export function launchBarrage(state: GameState, playerId: number, tile: number): ActionResult {
  const ok = canBarrage(state, playerId, tile);
  if (!ok.ok) return ok;
  const p = state.players[playerId];
  p.gold -= BARRAGE_GOLD;
  p.barrageReadyTick = state.tick + Math.round(barrageCooldown(p) * TICKS_PER_SECOND);
  const target = state.map.owner[tile];
  const b: Barrage = {
    id: newId(state),
    owner: playerId,
    tile,
    target,
    artillery: artilleryOf(state, playerId),
    hitTick: state.tick + Math.round(BARRAGE_DELAY * TICKS_PER_SECOND),
  };
  state.barrages.push(b);
  addEvent(state, 'barrage', `${p.name}'s artillery is shelling ${state.players[target].name}`, [target, playerId], tile);
  return { ok: true };
}

/** Kills up to `amount` of a player's home troops, split by composition. Returns the units killed. */
function killHome(state: GameState, victim: number, amount: number, killer: number): number {
  const p = state.players[victim];
  if (!p || !p.alive || amount <= 0) return 0;
  const t = p.troops;
  const tot = t.infantry + t.armor + t.artillery;
  const n = Math.min(amount, tot);
  if (n <= 0) return 0;
  for (const k of TROOP_TYPES) t[k] = Math.max(0, t[k] - (n * t[k]) / tot);
  p.stats.troopsLost += n;
  state.players[killer].stats.troopsKilled += n;
  return n;
}

/** The shells land (see the file comment). */
function impact(state: GameState, b: Barrage): void {
  const map = state.map;
  const w = map.width;
  const shooter = state.players[b.owner];
  state.effects.push({ kind: 'barrage', x: (b.tile % w) + 0.5, y: ((b.tile / w) | 0) + 0.5, radius: BARRAGE_RADIUS, tick: state.tick });
  const hit = new Map<number, number>(); // hostile owner -> tiles on the disc
  let hitTiles = 0;
  let silenced = 0;
  let destroyed = 0;
  const until = state.tick + Math.round(BARRAGE_DISABLE_SECONDS * TICKS_PER_SECOND);
  forEachInRadius(map, b.tile, BARRAGE_RADIUS, (i) => {
    const o = map.owner[i];
    if (hostile(state, b.owner, o)) {
      hit.set(o, (hit.get(o) ?? 0) + 1);
      hitTiles++;
    }
    const bl = buildingAt(state, i);
    if (!bl || !hostile(state, b.owner, bl.owner)) return;
    if (bl.type === 'fort' || bl.type === 'sam') {
      bl.hp -= BARRAGE_BUILDING_DAMAGE;
      bl.disabledUntil = Math.max(bl.disabledUntil, until);
      if (bl.hp <= 1e-9) {
        destroyBuilding(state, bl);
        destroyed++;
      } else silenced++;
    } else if (state.rng() < BARRAGE_DESTROY_CHANCE) {
      destroyBuilding(state, bl);
      destroyed++;
      addEvent(state, 'buildingLost', `${state.players[bl.owner].name} lost a ${BUILDINGS[bl.type].name} to shelling`, [bl.owner], i);
    }
  });
  const total = barrageKill(b.artillery);
  let killed = 0;
  for (const [o, n] of hit) {
    const p = state.players[o];
    const home = p.troops.infantry + p.troops.armor + p.troops.artillery;
    killed += killHome(state, o, Math.min((total * n) / hitTiles, BARRAGE_KILL_ARMY_SHARE * home), b.owner);
  }
  const victim = state.players[b.target];
  const parts = [`${Math.round(killed)} troops lost`];
  if (silenced) parts.push(silenced === 1 ? `a fort or SAM site silenced for ${BARRAGE_DISABLE_SECONDS} s` : `${silenced} forts or SAM sites silenced for ${BARRAGE_DISABLE_SECONDS} s`);
  if (destroyed) parts.push(`${destroyed} building${destroyed === 1 ? '' : 's'} destroyed`);
  addEvent(state, 'barrage', `${shooter.name} shelled ${victim?.name ?? 'the enemy'}: ${parts.join(', ')}`, [b.owner, ...hit.keys()], b.tile);
}

/** Lands the barrages whose time has come (in the order they were fired); drops those of eliminated shooters. */
export function updateBarrages(state: GameState): void {
  if (!state.barrages.length) return;
  let k = 0;
  const list = state.barrages;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!state.players[b.owner]?.alive) continue;
    if (b.hitTick <= state.tick) {
      impact(state, b);
      continue;
    }
    list[k++] = b;
  }
  list.length = k;
}
