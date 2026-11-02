// HUD-style reads between ticks: every sim function the client calls while drawing (src/client imports), with
// arguments taken from the game the way the panels pick them (own border, ports, units, the nation card's target).
// A rendering client calls these with the NEXT tick's number, before that tick's work; a client that is busy (several
// turns per frame) or catching up calls them less often or not at all. They must not change what the sim decides.
import { mainFoe, fortifiedShare, openness, suggestions } from '../src/sim/advisor';
import { airRaidOn, airSortieCost, airZones } from '../src/sim/airwings';
import { allyRefusal, allyStatus, runawayLeader } from '../src/sim/allies';
import { buildManyPreview, upgradeBuildingsPreview } from '../src/sim/bulkbuild';
import { barrageReadyIn, canBarrage } from '../src/sim/barrage';
import { buildCostAt, buildingsOf, canBuild, hasIntel, resolveBuildTarget } from '../src/sim/buildings';
import { attacksOf, borders, coreDefenseAt, estimateAttack, lastStandFactor, supplyEfficiency } from '../src/sim/combat';
import { BUILDING_ORDER, TECH_ORDER } from '../src/sim/config';
import { convertCost, hasOilShortage } from '../src/sim/economy';
import { atWar, blockadedPorts, portBlockadedBy } from '../src/sim/naval2';
import { canOrderWarship, warshipOrderCost } from '../src/sim/navy';
import { arsenalPrice, canProcure } from '../src/sim/procurement';
import { minefields } from '../src/sim/specials';
import { warBondsInfo, mercenaryPrice, fundAllyEffect } from '../src/sim/spending';
import { bestFactory, canBuildTankDivision, spearheadPreview, tankDivisionLimit } from '../src/sim/tanks';
import { canResearch } from '../src/sim/tech';
import { techStatus } from '../src/sim/techtree';
import { borderTiles, coastCount, depositCount } from '../src/sim/territory';
import { canParadrop } from '../src/sim/units';
import { canReconFlight, reconCooldownLeft, revealsOf } from '../src/sim/variants';
import { allScores, victoryShareNow } from '../src/sim/victory';
import type { GameState } from '../src/sim/types';

type Read = (s: GameState, pid: number, k: number) => void;

/** A few of a player's border tiles and the owners across them (deterministic picks, rotating with k). */
function frontTiles(s: GameState, pid: number, k: number, n: number): number[] {
  const b = borderTiles(s, pid);
  const out: number[] = [];
  if (!b.len) return out;
  for (let j = 0; j < n; j++) out.push(b.list[(k * 7 + j * 131) % b.len]);
  return out;
}
/** Tiles next to a border tile that someone else owns (where the attack tooltip and front lines look). */
function acrossTiles(s: GameState, pid: number, k: number, n: number): number[] {
  const w = s.map.width;
  const out: number[] = [];
  for (const t of frontTiles(s, pid, k, n)) {
    for (const d of [1, -1, w, -w]) {
      const u = t + d;
      if (u >= 0 && u < s.map.owner.length && s.map.owner[u] !== pid) {
        out.push(u);
        break;
      }
    }
  }
  return out;
}
const troops = { infantry: 5000, armor: 2000, artillery: 500 };

export const READS: Record<string, Read> = {
  attack: (s, pid, k) => {
    for (const t of acrossTiles(s, pid, k, 6)) {
      estimateAttack(s, pid, t, troops);
      supplyEfficiency(s, pid, t);
      const o = s.map.owner[t];
      if (o > 0) {
        coreDefenseAt(s, o, t);
        lastStandFactor(s, o, pid);
        borders(s, pid, o);
      }
    }
    attacksOf(s, pid);
  },
  naval: (s, pid) => {
    for (const p of s.players) if (p.id > 0 && p.id !== pid) atWar(s, pid, p.id);
    blockadedPorts(s, pid);
    for (const b of buildingsOf(s, pid, 'port')) portBlockadedBy(s, b.tile);
    canOrderWarship(s, pid, buildingsOf(s, pid, 'port')[0]?.tile ?? -1);
    warshipOrderCost(s, pid);
  },
  allies: (s, pid) => {
    runawayLeader(s);
    for (const p of s.players) {
      if (p.id <= 0 || p.id === pid || !p.alive) continue;
      allyStatus(s, pid, p.id);
      allyRefusal(s, p.id, pid, 'any');
      allyRefusal(s, p.id, pid, 'attack', mainFoe(s, pid).foe);
      hasIntel(s, pid, p.id);
      fundAllyEffect(s, pid, p.id, 500);
    }
  },
  advisor: (s, pid, k) => {
    suggestions(s, pid);
    const f = mainFoe(s, pid);
    openness(s, f.frontTiles);
    if (f.foe > 0) fortifiedShare(s, f.foe, f.frontTiles);
    frontTiles(s, pid, k, 3);
  },
  economy: (s, pid) => {
    coastCount(s, pid);
    depositCount(s, pid, 1);
    depositCount(s, pid, 2);
    hasOilShortage(s, pid);
    convertCost(s.players[pid], 'armor', s);
    convertCost(s.players[pid], 'artillery', s);
    warBondsInfo(s, pid);
    mercenaryPrice(s, pid, 1000);
    allScores(s);
    victoryShareNow(s);
  },
  build: (s, pid, k) => {
    const tiles = frontTiles(s, pid, k + 3, 3);
    for (const t of tiles) {
      const type = BUILDING_ORDER[(k + t) % BUILDING_ORDER.length];
      canBuild(s, pid, type, t);
      buildCostAt(s, pid, type, t);
      resolveBuildTarget(s, pid, type, t);
      buildManyPreview(s, pid, type, t, 4);
    }
    const own = buildingsOf(s, pid).slice(0, 6).map((b) => b.tile);
    upgradeBuildingsPreview(s, pid, own, 1);
  },
  research: (s, pid) => {
    for (const t of TECH_ORDER) {
      techStatus(s, pid, t);
      canResearch(s, pid, t);
      canProcure(s, pid, t);
      arsenalPrice(s, pid, t);
    }
  },
  forces: (s, pid, k) => {
    const across = acrossTiles(s, pid, k + 5, 2);
    for (const u of s.units) {
      if (u.owner !== pid || u.hp <= 0) continue;
      if (u.type === 'tankDivision' && across.length) spearheadPreview(s, pid, u.id, across[0]);
    }
    bestFactory(s, pid);
    tankDivisionLimit(s, pid);
    if (across.length) {
      canBuildTankDivision(s, pid, across[0]);
      canBarrage(s, pid, across[0]);
      for (const b of buildingsOf(s, pid, 'airfield')) {
        canParadrop(s, pid, b.tile, across[0], 1000);
        canReconFlight(s, pid, b.tile, across[0]);
        reconCooldownLeft(s, b);
      }
    }
    barrageReadyIn(s, pid);
    airRaidOn(s, pid);
    airSortieCost(s, pid);
    revealsOf(s, pid);
  },
  map: (s) => {
    minefields(s);
    airZones(s);
  },
};
export const GROUPS = Object.keys(READS);

/** One frame's reads: for one or two nations (the viewer and the nation card), rotating through the players. */
export function hudReads(s: GameState, groups: readonly string[], k: number): void {
  const n = s.players.length;
  if (n < 2) return;
  const viewers = [1 + (k % (n - 1)), 1 + ((k * 5 + 3) % (n - 1))];
  for (const pid of viewers) {
    if (!s.players[pid]?.alive) continue;
    for (const g of groups) READS[g](s, pid, k);
  }
}
