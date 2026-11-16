// What the Defense row (sim/defense.ts) shows outside the map art: the flak zones a player knows of (fog of war: the
// hostile Forts and Cities it sees or remembers), the flak on a strike's route, and the one line a Fort or City card
// gains. Client only, read-only.
import { DEFENSE, TICKS_PER_SECOND } from '../sim/config';
import { batteryRange, flakRadius, flakRate, flakSiteCut, flakWorking, isBatterySite, radarRadius } from '../sim/defense';
import { fortRadius } from '../sim/buildings';
import { areAllied } from '../sim/diplomacy';
import { hasTech } from '../sim/tech';
import { airVariantOf } from '../sim/variants';
import type { Building, GameState } from '../sim/types';
import { activeFog } from './fog/fogView';

/** A flak zone as this client knows it. */
export interface KnownFlak {
  tile: number;
  owner: number;
  r: number;
  rate: number;
  /** the share bombs lose flying to its centre (factor 1) */
  cut: number;
  building: Building;
}

const pct = (v: number): number => Math.round(v * 100);

/** The flak factor of `me`'s planes for a strike kind: bombers by its Air path, cargo planes, the stealth bomber. */
export function myFlakFactor(state: GameState, me: number, kind: 'bomb' | 'paradrop' | 'stealth'): number {
  if (kind === 'paradrop') return DEFENSE.flakVsCargo;
  if (kind === 'stealth') return DEFENSE.flakVsStealth;
  const v = airVariantOf(state, me);
  return v === 'groundAttack' ? DEFENSE.flakVsGroundAttack : v === 'heavyBomber' ? DEFENSE.flakVsHeavy : 1;
}

/**
 * Working flak zones hostile to `me` that it can see (fog of war: in view, or a remembered Fort / City of a nation
 * that holds Flak Guns). Own and allied zones are left out.
 */
export function knownEnemyFlak(state: GameState, me: number): KnownFlak[] {
  const out: KnownFlak[] = [];
  const fog = activeFog(state);
  for (const b of state.buildings.values()) {
    if ((b.type !== 'fort' && b.type !== 'city') || b.owner <= 0 || b.owner === me || areAllied(state, me, b.owner)) continue;
    const p = state.players[b.owner];
    if (!p || !p.alive || !hasTech(p, 'flakGuns') || !flakWorking(state, b)) continue;
    if (fog && fog.buildingAt(state, b.tile)?.type !== b.type) continue;
    out.push({ tile: b.tile, owner: b.owner, r: flakRadius(b), rate: flakRate(b), cut: flakSiteCut(b), building: b });
  }
  return out;
}

/** Wear a plane of `me` (flak factor `factor`) would gain flying from `from` to `to` through the known zones. */
export function routeFlak(state: GameState, me: number, from: number, to: number, factor: number): number {
  const zones = knownEnemyFlak(state, me);
  if (!zones.length || from < 0) return 0;
  const w = state.map.width;
  const fx = from % w;
  const fy = (from / w) | 0;
  const dx = (to % w) - fx;
  const dy = ((to / w) | 0) - fy;
  const len = Math.sqrt(dx * dx + dy * dy);
  const n = Math.max(1, Math.ceil(len));
  let wear = 0;
  const rates: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = fx + (dx * (k + 0.5)) / n;
    const y = fy + (dy * (k + 0.5)) / n;
    rates.length = 0;
    for (const z of zones) {
      const zx = z.tile % w;
      const zy = (z.tile / w) | 0;
      if ((zx - x) * (zx - x) + (zy - y) * (zy - y) <= z.r * z.r) rates.push(z.rate);
    }
    rates.sort((a, b) => b - a);
    for (let i = 0; i < Math.min(DEFENSE.flakMaxZones, rates.length); i++) wear += (len / n) * rates[i];
  }
  return Math.min(1, wear * factor);
}

/** The strike card's flak line ('' = no known flak on the way). */
export function routeFlakText(wear: number, what = 'bombs'): string {
  if (wear < 0.01) return '';
  if (wear >= DEFENSE.flakAbortAt) return 'Enemy flak on the way: the planes would turn back before they drop';
  return `Enemy flak on the way: ${what} about -${pct(Math.min(1 - DEFENSE.flakEffectFloor, wear))}%`;
}

/** The ring label of a known enemy flak zone ("Enemy flak: bombs -35%"), for a plane of flak factor `factor`. */
export function enemyFlakLabel(z: KnownFlak, factor: number): string {
  return `Enemy flak: bombs -${pct(flakSiteCut(z.building, factor))}%`;
}

/**
 * The Defense lines of an own Fort, City, SAM site or Port card: "Flak: 14 tiles, enemy bombs here -35%", "Tank traps:
 * dug-in land within 28 tiles slows enemy tanks to 40%", "Tracking Radar: spots stealth bombers within 30 tiles after
 * 3 s", "Coastal Battery: fires at enemy ships within 30 tiles every 2 s".
 */
export function defenseLines(state: GameState, b: Building): string[] {
  const p = state.players[b.owner];
  if (!p) return [];
  const out: string[] = [];
  const off = b.disabledUntil > state.tick ? Math.ceil((b.disabledUntil - state.tick) / TICKS_PER_SECOND) : 0;
  if ((b.type === 'fort' || b.type === 'city') && hasTech(p, 'flakGuns')) {
    if (b.buildLeft > 0) out.push('Flak: fires once it is built');
    else if (off > 0) out.push(`Flak: knocked out for ${off} s`);
    else out.push(`Flak: ${flakRadius(b)} tiles, enemy bombs here -${pct(flakSiteCut(b))}%`);
  }
  if (b.type === 'sam' && hasTech(p, 'trackingRadar')) {
    if (b.buildLeft > 0) out.push('Tracking Radar: works once it is built');
    else if (off > 0) out.push(`Tracking Radar: knocked out for ${off} s`);
    else out.push(`Tracking Radar: spots stealth bombers within ${Math.round(radarRadius(state, b))} tiles after ${DEFENSE.radarLockSeconds} s`);
  }
  if ((b.type === 'port' || b.type === 'fort') && isBatterySite(state, b)) {
    if (b.buildLeft > 0) out.push('Coastal Battery: fires once it is built');
    else if (off > 0) out.push(`Coastal Battery: knocked out for ${off} s`);
    else if (b.hp < DEFENSE.batteryFireHp) out.push(`Coastal Battery: shelled silent, fires again at ${pct(DEFENSE.batteryFireHp)}% health (now ${pct(b.hp)}%)`);
    else out.push(`Coastal Battery: fires at enemy ships within ${batteryRange(b)} tiles every ${DEFENSE.batteryFireSeconds} s`);
  }
  if (b.type === 'fort' && hasTech(p, 'tankTraps')) {
    if (b.buildLeft > 0) out.push('Tank traps: laid once it is built');
    else if (off > 0) out.push(`Tank traps: knocked out for ${off} s`);
    else out.push(`Tank traps: dug-in land within ${fortRadius(state, b)} tiles slows enemy tanks to ${pct(DEFENSE.trapHeadSpeed)}%`);
  }
  return out;
}
