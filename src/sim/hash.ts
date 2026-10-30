// State hash for desync detection (lockstep multiplayer): two clients that ran the same actions must get the same
// number. FNV-1a (32 bit) over the parts of the state that every system feeds into: tick, RNG state, tile owners,
// players' stocks and troops (exact float bits), attacks and units (positions rounded to 1/100 tile), barrages and
// buildings (level, timers, hp).

import type { GameState, Troops } from './types';

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
  }
  for (const b of state.barrages) {
    h = mixInt(h, b.id);
    h = mixInt(h, b.tile);
    h = mixInt(h, b.hitTick);
    h = mixFloat(h, b.artillery);
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
  }
  return h >>> 0;
}
