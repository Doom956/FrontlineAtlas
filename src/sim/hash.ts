// State hash for desync detection (lockstep multiplayer): two clients that ran the same actions must get the same
// number. FNV-1a (32 bit) over the parts of the state that every system feeds into: tick, RNG state, tile owners,
// players' stocks and troops (exact float bits), research (current tech, progress, techs), auto flags, traitor and
// embargoes, doctrines, phase and spawn time, alliances and alliance requests, attacks and units (positions rounded to 1/100
// tile), barrages and buildings (level, timers, hp).

import { hashAir } from './airwings';
import { hashArsenal } from './variants';
import type { GameState, Troops } from './types';
import { DIVISION_MODES, WARSHIP_STANCES } from './types';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Scratch views to read a float's exact bits (no state is kept between calls).
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function mixInt(h: number, v: number): number {
  // Four bytes of a 32-bit integer.
  h = Math.imul(h ^ (v & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 24) & 0xff), FNV_PRIME);
  return h;
}
function mixFloat(h: number, v: number): number {
  f64[0] = v === 0 ? 0 : v; // -0 and 0 hash the same
  h = mixInt(h, u32[0]);
  return mixInt(h, u32[1]);
}
function mixStr(h: number, v: string | null): number {
  if (v === null) return mixInt(h, -1);
  h = mixInt(h, v.length);
  for (let k = 0; k < v.length; k++) h = mixInt(h, v.charCodeAt(k));
  return h;
}
const PHASE_CODE = { spawn: 1, playing: 2, over: 3 } as const;
function mixTroops(h: number, t: Troops): number {
  h = mixFloat(h, t.infantry);
  h = mixFloat(h, t.armor);
  return mixFloat(h, t.artillery);
}

/** FNV-1a hash of the simulation state (unsigned 32-bit). Cheap enough to run every few ticks. */
export function hashState(state: GameState): number {
  let h = FNV_OFFSET;
  h = mixInt(h, state.tick);
  h = mixInt(h, state.rngState.s);
  h = mixInt(h, state.nextId);
  h = mixInt(h, PHASE_CODE[state.phase]);
  h = mixFloat(h, state.spawnLeft);
  const owner = state.map.owner;
  // Owners are Uint16: two per 32-bit word.
  const n = owner.length;
  let i = 0;
  for (; i + 1 < n; i += 2) h = mixInt(h, owner[i] | (owner[i + 1] << 16));
  if (i < n) h = mixInt(h, owner[i]);
  for (const p of state.players) {
    h = mixInt(h, p.id);
    h = mixInt(h, (p.alive ? 1 : 0) | (p.spawned ? 2 : 0));
    h = mixInt(h, p.tiles);
    h = mixInt(h, p.capital);
    h = mixTroops(h, p.troops);
    h = mixFloat(h, p.gold);
    h = mixFloat(h, p.iron);
    h = mixFloat(h, p.oil);
    h = mixFloat(h, p.science);
    h = mixFloat(h, p.armyMix.armor);
    h = mixFloat(h, p.armyMix.artillery);
    h = mixInt(h, p.barrageReadyTick);
    h = mixStr(h, p.researching);
    h = mixFloat(h, p.researchProgress);
    // Arsenal orders (procurement.ts).
    const ord = p.procuring ?? [];
    h = mixInt(h, ord.length);
    for (const o of ord) {
      h = mixStr(h, o.tech);
      h = mixInt(h, o.readyTick);
    }
    h = mixInt(h, p.techs.length);
    for (const t of p.techs) h = mixStr(h, t);
    h = mixInt(h, (p.auto.mix ? 1 : 0) | (p.auto.research ? 2 : 0));
    h = mixInt(h, p.traitorUntil);
    h = mixInt(h, p.embargoes.length);
    for (const e of p.embargoes) h = mixInt(h, e);
    h = mixInt(h, p.heartTile);
    h = mixInt(h, p.heartMoveTick);
    h = mixInt(h, p.allyAskTick);
    const d = p.doctrine;
    if (d) {
      h = mixStr(h, d.id);
      h = mixInt(h, d.level);
      h = mixInt(h, d.chosenTick);
      h = mixInt(h, d.adaptUntilTick);
      h = mixInt(h, d.lastSwitchTick);
    }
    // Gold uses (spending.ts) and the Carriers timer (techtree.ts).
    const sp = p.spend;
    if (sp) {
      h = mixFloat(h, sp.mercRecent);
      h = mixInt(h, sp.mercWindowTick);
      h = mixInt(h, sp.bondsUntil);
      h = mixInt(h, sp.bondsReadyTick);
      h = mixInt(h, sp.carrierReadyTick);
    }
  }
  // Funded allies (spending.ts).
  const funds = state.allyFunds ?? [];
  h = mixInt(h, funds.length);
  for (const f of funds) {
    h = mixInt(h, f.from);
    h = mixInt(h, f.ally);
    h = mixFloat(h, f.bonus);
    h = mixInt(h, f.untilTick);
  }
  h = mixInt(h, state.alliances.length);
  for (const al of state.alliances) {
    h = mixInt(h, al.a);
    h = mixInt(h, al.b);
    h = mixInt(h, al.expiresTick);
  }
  h = mixInt(h, state.allianceRequests.length);
  for (const r of state.allianceRequests) {
    h = mixInt(h, r.from);
    h = mixInt(h, r.to);
    h = mixInt(h, r.expiresTick);
  }
  h = mixInt(h, state.allyRequests.length);
  for (const r of state.allyRequests) {
    h = mixInt(h, r.from);
    h = mixInt(h, r.ally);
    h = mixInt(h, r.kind === 'attack' ? 1 : 2);
    h = mixInt(h, r.target);
    h = mixInt(h, r.expiresTick);
  }
  h = mixInt(h, state.allyPledges.length);
  for (const pl of state.allyPledges) {
    h = mixInt(h, pl.helper);
    h = mixInt(h, pl.friend);
    h = mixInt(h, pl.target);
    h = mixInt(h, pl.untilTick);
  }
  for (const a of state.attacks) {
    h = mixInt(h, a.id);
    h = mixInt(h, a.target);
    h = mixTroops(h, a.troops);
  }
  for (const u of state.units) {
    h = mixInt(h, u.id);
    h = mixInt(h, Math.round(u.x * 100));
    h = mixInt(h, Math.round(u.y * 100));
    h = mixFloat(h, u.hp);
    h = mixTroops(h, u.troops);
    // Orders and chase / spearhead state (navy.ts, tanks.ts).
    h = mixInt(h, u.state);
    h = mixInt(h, u.target);
    h = mixInt(h, u.pathPos);
    h = mixInt(h, u.path.length);
    h = mixFloat(h, u.cargo);
    h = mixInt(h, u.chase ?? 0);
    h = mixInt(h, u.chaseLost ?? 0);
    h = mixInt(h, u.launch ?? -1);
    h = mixFloat(h, u.strength0 ?? -1);
    h = mixInt(h, u.targetOwner ?? 0);
    // Stances, stations, veterancy and division modes (naval2.ts, armor2.ts).
    h = mixInt(h, u.stance ? WARSHIP_STANCES.indexOf(u.stance) + 1 : 0);
    h = mixInt(h, u.station ?? -1);
    h = mixFloat(h, u.xp ?? 0);
    h = mixInt(h, u.vet ?? 0);
    h = mixInt(h, u.mode ? DIVISION_MODES.indexOf(u.mode) + 1 : 0);
    h = mixInt(h, u.retryTick ?? 0);
    if (u.wading) h = mixInt(h, u.wading); // Amphibious Tanks (specials.ts)
  }
  // Recent wars (naval2.ts).
  const wm = state.warMemory ?? [];
  h = mixInt(h, wm.length);
  for (const v of wm) h = mixInt(h, v);
  // Units under construction (navy.ts, tanks.ts).
  const queue = state.unitQueue ?? [];
  h = mixInt(h, queue.length);
  for (const q of queue) {
    h = mixInt(h, q.id);
    h = mixInt(h, q.owner);
    h = mixInt(h, q.tile);
    h = mixInt(h, q.readyTick);
    h = mixTroops(h, q.troops);
  }
  // A continued game, the owner console's switches and the settings it can change (admin.ts).
  h = mixInt(h, state.continued ? 1 : 0);
  const ad = state.admin;
  if (ad) {
    h = mixInt(h, (ad.aiFrozen ? 1 : 0) | 4);
    for (const list of [ad.aiPassive, ad.godMode, ad.revealIntel]) {
      h = mixInt(h, list.length);
      for (const id of list) h = mixInt(h, id);
    }
    h = mixStr(h, state.settings.difficulty);
    h = mixFloat(h, state.settings.modifiers.peaceMinutes);
  }
  // Tutorial rules (tutorialScenario.ts).
  const tu = state.tutorial;
  if (tu) {
    h = mixStr(h, tu.chapter);
    h = mixInt(h, tu.human);
    h = mixInt(h, (tu.noElimination ? 1 : 0) | (tu.doctrinesEarly ? 2 : 0) | 8);
    h = mixInt(h, tu.minTiles);
    h = mixInt(h, tu.home);
    h = mixInt(h, tu.frozen.length);
    for (const id of tu.frozen) h = mixInt(h, id);
  }
  for (const b of state.barrages) {
    h = mixInt(h, b.id);
    h = mixInt(h, b.tile);
    h = mixInt(h, b.hitTick);
    h = mixFloat(h, b.artillery);
    h = mixFloat(h, b.radius ?? 0);
  }
  h = mixInt(h, state.buildings.size);
  for (const b of state.buildings.values()) {
    h = mixInt(h, b.id);
    h = mixInt(h, b.owner);
    h = mixInt(h, b.level);
    h = mixFloat(h, b.upgradeLeft);
    h = mixFloat(h, b.cooldown);
    h = mixFloat(h, b.dropCooldown);
    h = mixInt(h, b.disabledUntil);
    h = mixFloat(h, b.hp);
    // Bulk build queue (bulkbuild.ts).
    h = mixInt(h, b.queuedLevels || 0);
    if (b.queuedPaid) {
      h = mixFloat(h, b.queuedPaid.gold);
      h = mixFloat(h, b.queuedPaid.iron);
    }
  }
  // Air wings, support zones, raids, stored aircraft, mission planes (airwings.ts).
  h = hashAir(state, h, mixInt, mixFloat);
  // Unit variants, recon reveals, hold zones, recon timers (variants.ts).
  h = hashArsenal(state, h, mixInt, mixFloat);
  return h >>> 0;
}
