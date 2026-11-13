// Units destroyed (client only, read-only): which units that were on the map at the last tick are gone because they
// were destroyed, not because they arrived. It never writes to the state (no marks on the units either), so the sim,
// its hash and multiplayer are untouched. fx/pixelFx.ts feeds it once per new tick and plays the deaths.
//
// How the sim removes a unit (src/sim): every unit leaving the map gets hp 0 and is filtered out at the end of its
// tick, whether it was destroyed or it arrived, so hp alone does not tell. What does:
//   - a destroyed ship, plane or missile gets the sim's kill blast, an 'explosion' effect of radius 1.5 put at the
//     unit's own centre in the same tick (units.ts sinkUnit and shotDown, specials.ts mineSink, techtree.ts carrier
//     fighters); one arriving gets none (a transport landing or bringing its troops home, a trade ship docking, a
//     bomber back at its airfield, a cargo plane dropping its troops, a recon plane landing; a rocket or atom bomb on
//     its target makes a blast of its own blast radius, 4 tiles and up, never the small one);
//   - a destroyed tank division (tanks.ts bombDivisions: bombed below 5% of a division) keeps its last troops aboard,
//     while every division leaving the map otherwise (spent, overrun and falling back, disbanded, wading home) hands
//     its troops back to its owner first, so it leaves with none;
//   - the units of a nation that is eliminated are dropped with hp 0 and no troops (state.ts): never a death here.
// So: a unit gone since the last tick, with hp <= 0, its owner still alive, and either the kill blast at its centre
// (ships, planes, missiles; each blast stands for one unit) or troops left aboard (tank divisions), was destroyed.
import type { GameState, Unit, UnitType } from '../../sim/types';
import type { DeathKind } from '../art/types';
import { SHOCKWAVE_MIN_RADIUS } from './map';

/** What kind of death a unit type dies (null: no death animation). */
export function deathKindOf(type: UnitType): DeathKind | null {
  switch (type) {
    case 'bomber':
    case 'fighter':
    case 'transportPlane':
    case 'reconPlane':
      return 'plane';
    case 'rocket':
    case 'atomBomb':
      return 'missile';
    case 'tankDivision':
      return 'tank';
    case 'transport':
    case 'warship':
    case 'tradeShip':
      return 'ship';
    default:
      return null;
  }
}

/** True for the sim's kill blast: an 'explosion' smaller than the rockets', bombs' and air strikes' (tiles). */
export function isKillBlast(radius: number): boolean {
  return radius < SHOCKWAVE_MIN_RADIUS;
}

/**
 * How far (tiles, each way) the kill blast may lie from the unit's centre: the sim puts it exactly there (u.x + 0.5,
 * u.y + 0.5, the position the dead unit keeps), so only a blast on that very spot is its own. A wider reach let a unit
 * that arrived next to a sunk one in the same tick (a transport landing beside its sunk escort) take that blast and
 * play a false death while the ship that really died played none.
 */
export const KILL_EXACT = 0.01;

const troopsOf = (u: Unit): number => {
  const t = u.troops;
  return t ? (t.infantry || 0) + (t.armor || 0) + (t.artillery || 0) : 0;
};

export class DeathWatch {
  /** the units on the map at the last tick seen (references: one removed since keeps its last position and hp) */
  private prev: Unit[] = [];
  private ids = new Set<number>();
  /** the kill blasts of this tick: tile x, y and whether a death took it */
  private bx: number[] = [];
  private by: number[] = [];
  private taken: boolean[] = [];
  private nb = 0;

  /** Forgets everything: the units of `state` are the ones on the map now. */
  reset(state: GameState | null): void {
    this.nb = 0;
    this.prev.length = 0;
    if (state) for (const u of state.units) this.prev.push(u);
  }

  /** A kill blast of the sim seen this tick (an 'explosion' effect that isKillBlast), at tile (x, y). */
  blast(x: number, y: number): void {
    const i = this.nb++;
    this.bx[i] = x;
    this.by[i] = y;
    this.taken[i] = false;
  }

  /** How many kill blasts this tick has, and whether blast `i` was a unit's death (after scan). */
  get blasts(): number {
    return this.nb;
  }
  blastX(i: number): number {
    return this.bx[i];
  }
  blastY(i: number): number {
    return this.by[i];
  }
  wasDeath(i: number): boolean {
    return this.taken[i] === true;
  }

  /**
   * The units destroyed since the last scan, written to `out` from index 0 (a reused list; the count is returned):
   * units that were on the map then and are gone now. Then the units of `state` are the ones on the map. Call once
   * per new tick, after this tick's kill blasts (blast); they are cleared by the next scan.
   */
  scan(state: GameState, out: Unit[]): number {
    const ids = this.ids;
    ids.clear();
    for (const u of state.units) ids.add(u.id);
    let n = 0;
    for (const u of this.prev) {
      if (ids.has(u.id) || !(u.hp <= 0)) continue;
      if (!state.players[u.owner]?.alive) continue;
      const kind = deathKindOf(u.type);
      if (!kind) continue;
      if (kind === 'tank') {
        if (troopsOf(u) > 0) out[n++] = u;
        continue;
      }
      // the kill blast exactly at its centre, not taken by another death (two units killed on one spot: one each)
      const cx = u.x + 0.5;
      const cy = u.y + 0.5;
      let best = -1;
      for (let i = 0; i < this.nb; i++) {
        if (this.taken[i]) continue;
        if (Math.abs(this.bx[i] - cx) < KILL_EXACT && Math.abs(this.by[i] - cy) < KILL_EXACT) {
          best = i;
          break;
        }
      }
      if (best < 0) continue;
      this.taken[best] = true;
      out[n++] = u;
    }
    out.length = n;
    const p = this.prev;
    p.length = 0;
    for (const u of state.units) p.push(u);
    return n;
  }

  /** Clears this tick's kill blasts (after they were played). */
  endTick(): void {
    this.nb = 0;
  }
}
