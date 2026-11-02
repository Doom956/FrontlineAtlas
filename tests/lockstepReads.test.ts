// Lockstep: what the client reads between ticks (front lines and attack tooltips through combat.estimateAttack, which
// asks tanks.tankDefenseAt; the ally panel and the game summary through allies.runawayLeader) must not change the sim.
// Those reads come with the next tick's number, before that tick moves divisions and land, so a per-tick cache they
// fill would hand the sim stale data on rendering clients only (a hash mismatch between players).
import { describe, expect, it } from 'vitest';
import { runawayLeader } from '../src/sim/allies';
import { estimateAttack } from '../src/sim/combat';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import type { GameState } from '../src/sim/types';
import { makeTestGame } from './helpers';

/** Front-line reads: an estimate onto a tile next to every tank division, plus the runaway leader. */
function clientReads(s: GameState): void {
  runawayLeader(s);
  const w = s.map.width;
  for (const u of s.units) {
    if (u.type !== 'tankDivision' || u.hp <= 0) continue;
    const t = Math.round(u.y) * w + Math.round(u.x);
    for (const d of [0, 1, -1, w, -w]) {
      const tile = t + d;
      if (tile < 0 || tile >= s.map.owner.length) continue;
      for (let a = 1; a < s.players.length; a++) {
        if (s.players[a].alive && s.map.owner[tile] !== a) estimateAttack(s, a, tile, { infantry: 5000, armor: 2000, artillery: 500 });
      }
    }
  }
}

describe('lockstep: division and leader reads between ticks', () => {
  it('a rendering client (front lines next to moving divisions) stays in sync with one that does not render', () => {
    const make = (): GameState => {
      const s = makeTestGame({ seed: 77, aiCount: 6, humanPlayer: false, mapType: 'continents', mapSize: 'small', mods: { research: 'allUnlocked', startingGold: 'veryHigh', fastGame: true } });
      for (const p of s.players) {
        if (p.id === 0) continue;
        p.iron = 1e5;
        p.oil = 1e5;
      }
      return s;
    };
    const quiet = make();
    const rendering = make();
    let diverged = -1;
    let divisions = 0;
    for (let k = 0; k < 3000 && diverged < 0; k++) {
      clientReads(rendering);
      tick(quiet);
      tick(rendering);
      divisions = Math.max(divisions, quiet.units.filter((u) => u.type === 'tankDivision').length);
      if (hashState(quiet) !== hashState(rendering)) diverged = quiet.tick;
    }
    expect(divisions).toBeGreaterThan(0); // the reads had divisions to look at
    expect(diverged).toBe(-1);
  }, 300_000);
});
