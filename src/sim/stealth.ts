// Stealth strike (Air Mastery; DESIGN section 7, config STEALTH and UNITS.stealthBomber): what a strike would do,
// and how AI nations use it. The rules (Action stealthStrike, the flight, the warning, the bombs, the recharge) live
// in units.ts next to the bombers (launchStealth, stealthReason); who can see it in stealthSight.ts.
//
// The AI (aiStealth, from ai.ts airAndMissiles every air turn): an AI nation with Air Mastery at war, whose stealth
// bomber is home and recharged, picks the most valuable building of a nation it fights that it knows of (fog of war)
// within reach of one of its airfields and under strong SAM cover (at least STEALTH.aiMinCover ready SAM shots it knows
// of over the route and the target: where its bombers and rockets would be shot down; elsewhere those do the job):
// silos, airfields, factories, SAM sites (a SAM cluster), arsenals, ports, cities. Each other building in the blast
// adds to the score, more SAM shots add a little (the deeper the wall, the more the stealth bomber is worth), and SAMs,
// silos and airfields near a landing of its own on the way score much higher (they would shoot the landing's cover
// down). Air superiority over the target cuts the score like it cuts the bombs. It keeps STEALTH.aiReserve strike
// prices in gold. Easy AIs never send it at a human. A human's stealth bomber flies only when told to.
import { buildingAt, buildingsOf } from './buildings';
import { BOMBER_BUILDING_HIT, STEALTH } from './config';
import { aiAttackLevel } from './aiattack';
import { applyAction } from './actions';
import { superiorityBombMul } from './airwings';
import { samCoverOnRoute } from './cruise';
import { areAllied } from './diplomacy';
import { forEachInRadius } from './grid';
import { knownTile } from './fog';
import { atPeace } from './rules';
import { nightEffectMul } from './specials';
import { hasTech } from './tech';
import { techBombBuildingHit } from './techtree';
import { stealthPlayerReason, stealthRadius, stealthReach, stealthReason, stealthSite, unitCost } from './units';
import type { Building, BuildingType, GameState } from './types';

function hostileTo(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** What a stealth strike by pid from `airfield` (-1 = the nearest in reach) at `tile` would do. Pure read. */
export interface StealthPreview {
  ok: boolean;
  /** why not ('' = it can fly) */
  reason: string;
  /** the airfield it flies from (-1 = none) */
  airfield: number;
  radius: number;
  /** hostile land tiles and buildings in the blast, the buildings it should destroy, the main nation hit (0 = none) */
  enemyTiles: number;
  enemyBuildings: number;
  buildingsHit: number;
  victim: number;
  /** hostile SAM sites whose cover the route crosses, and their ready shots: none of them can see it */
  samSites: number;
  samShots: number;
  /** the victim's fighters guard the target (air superiority): the numbers above are already cut */
  guarded: boolean;
}

export function stealthPreview(state: GameState, pid: number, airfield: number, tile: number): StealthPreview {
  const out: StealthPreview = { ok: false, reason: stealthReason(state, pid, airfield, tile), airfield: -1, radius: stealthRadius(state, pid), enemyTiles: 0, enemyBuildings: 0, buildingsHit: 0, victim: 0, samSites: 0, samShots: 0, guarded: false };
  if (!Number.isInteger(tile) || tile < 0 || tile >= state.map.owner.length) return out;
  const site = stealthSite(state, pid, airfield, tile);
  if (typeof site !== 'string') out.airfield = site.tile;
  const per = new Map<number, number>();
  const targets: Building[] = [];
  forEachInRadius(state.map, tile, out.radius, (i) => {
    const o = state.map.owner[i];
    if (hostileTo(state, pid, o) && state.players[o]?.alive) {
      out.enemyTiles++;
      per.set(o, (per.get(o) ?? 0) + 1);
    }
    const b = buildingAt(state, i);
    if (b && hostileTo(state, pid, b.owner)) targets.push(b);
  });
  let best = 0;
  for (const [o, n] of per) {
    if (n > best || (n === best && o < out.victim)) {
      best = n;
      out.victim = o;
    }
  }
  const hit = Math.min(1, techBombBuildingHit(state, pid, BOMBER_BUILDING_HIT) * nightEffectMul(state, pid) * STEALTH.payload);
  out.enemyBuildings = targets.length;
  for (const b of targets) out.buildingsHit += hit * superiorityBombMul(state, pid, b.owner, tile);
  out.guarded = out.victim > 0 && superiorityBombMul(state, pid, out.victim, tile) < 1;
  if (out.airfield >= 0) {
    const w = state.map.width;
    const cover = samCoverOnRoute(state, pid, out.airfield % w, (out.airfield / w) | 0, tile, false);
    out.samSites = cover.sams.length;
    out.samShots = cover.shots;
  }
  if (!out.reason && out.enemyTiles === 0 && out.enemyBuildings === 0) out.reason = 'Nothing of the enemy to hit there';
  out.ok = out.reason === '';
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/** How much an AI wants a building gone by its stealth bomber (0 = not a target). */
const VALUE: Partial<Record<BuildingType, number>> = { sam: 60, silo: 50, airfield: 46, factory: 40, arsenal: 28, port: 22, city: 18, lab: 14, barracks: 10, fort: 10, market: 8, oilWell: 8, mine: 6 };
/** SAMs, silos and airfields: what would shoot down or bomb a landing's cover. */
const LANDING_KINDS: ReadonlySet<BuildingType> = new Set<BuildingType>(['sam', 'silo', 'airfield']);

/** The nations pid fights now (an attack either way), alive, hostile. */
function foesOf(state: GameState, pid: number): number[] {
  const out = new Set<number>();
  for (const a of state.attacks) {
    if (a.attacker === pid && a.target > 0) out.add(a.target);
    else if (a.target === pid && a.attacker > 0) out.add(a.attacker);
  }
  return [...out].filter((q) => state.players[q]?.alive && hostileTo(state, pid, q)).sort((a, b) => a - b);
}

/** The best stealth strike target for AI nation pid now (see the file comment), or null. Pure read. */
export function aiStealthPick(state: GameState, pid: number): { airfield: number; tile: number; score: number } | null {
  const p = state.players[pid];
  if (!p || pid === 0 || !p.alive || p.isHuman || !hasTech(p, 'airMastery')) return null;
  if (stealthPlayerReason(state, pid)) return null; // in the air, recharging, too poor, no air force
  const c = unitCost(state, pid, 'stealthBomber');
  if (p.gold < c.gold * (1 + STEALTH.aiReserve) || p.oil < c.oil * 2) return null; // the reserve stays
  const foes = foesOf(state, pid);
  if (!foes.length) return null;
  const fields = buildingsOf(state, pid, 'airfield').filter((b) => b.buildLeft <= 0 && b.owner === pid);
  if (!fields.length) return null;
  const easy = aiAttackLevel(state) < 1;
  const w = state.map.width;
  const d2 = (a: number, b: number): number => {
    const dx = (a % w) - (b % w);
    const dy = ((a / w) | 0) - ((b / w) | 0);
    return dx * dx + dy * dy;
  };
  const landings: { tile: number; owner: number }[] = [];
  for (const u of state.units) if (u.type === 'transport' && u.owner === pid && u.hp > 0 && u.targetOwner > 0) landings.push({ tile: u.target, owner: u.targetOwner });
  const R = stealthRadius(state, pid);
  let best: { airfield: number; tile: number; score: number } | null = null;
  for (const q of foes) {
    if (easy && state.players[q].isHuman) continue;
    for (const [type, value] of Object.entries(VALUE) as [BuildingType, number][]) {
      for (const b of buildingsOf(state, q, type)) {
        if (b.buildLeft > 0 || state.map.owner[b.tile] !== q || !knownTile(state, pid, b.tile)) continue; // fog: known only
        // the nearest own airfield in reach (then by id)
        let af: Building | null = null;
        let afD = Infinity;
        for (const f of fields) {
          const r = stealthReach(state, f);
          const d = d2(f.tile, b.tile);
          if (d > r * r) continue;
          if (d < afD || (d === afD && af !== null && f.id < af.id)) {
            af = f;
            afD = d;
          }
        }
        if (!af) continue;
        const cover = samCoverOnRoute(state, pid, af.tile % w, (af.tile / w) | 0, b.tile, true).shots;
        if (cover < STEALTH.aiMinCover) continue; // weak cover: bombers and rockets do this job
        let others = 0;
        forEachInRadius(state.map, b.tile, R, (i) => {
          const o = buildingAt(state, i);
          if (o && o !== b && o.buildLeft <= 0 && hostileTo(state, pid, o.owner) && knownTile(state, pid, i)) others++;
        });
        let score = value + (type === 'city' ? b.level * 2 : 0) + others * 6 + Math.min(cover, 8) * 3;
        if (landings.some((l) => l.owner === q && d2(l.tile, b.tile) <= STEALTH.aiLandingNear * STEALTH.aiLandingNear)) score += LANDING_KINDS.has(type) ? 30 : 10;
        score *= superiorityBombMul(state, pid, q, b.tile); // air superiority cuts its bombs too
        if (!best || score > best.score || (score === best.score && b.tile < best.tile)) best = { airfield: af.tile, tile: b.tile, score };
      }
    }
  }
  return best;
}

/** AI stealth strike for nation pid (see the file comment); true when it sent one. Deterministic: no randomness. */
export function aiStealth(state: GameState, pid: number): boolean {
  const pick = aiStealthPick(state, pid);
  if (!pick) return false;
  return applyAction(state, pid, { type: 'stealthStrike', airfield: pick.airfield, tile: pick.tile }).ok;
}
