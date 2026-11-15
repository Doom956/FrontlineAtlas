// What the fighting on the map sounds like (client only, read-only: it never writes to the state, so the sim, its
// hash and multiplayer are untouched). Fed by AudioManager.update() with each new sim effect and once per new tick,
// it turns them into cues at a map place; the manager then decides by the camera (sound/spatial.ts) what is heard.
//
//   'shot' from a warship          the cannon (shot); from a submarine a sonar ping; anti-air fire a soft shot
//   'barrage'                      artillery (bombard)
//   'explosion' 4 tiles and up     a big blast (rockets, bomb runs)
//   the sim's kill blast           the death of the unit it stands for (fx/deaths.ts): a plane crash, a ship
//                                  sinking, a missile shot down (small blast); else a hit (small blast)
//   a tank division destroyed      tankDestroyed
//   a tank division in a fight     a tank shot now and then (spearheads, and divisions next to a nation they fight)
//   a rocket or atom bomb appears  missileLaunch at its silo; a cruise missile: missileLaunch at its ship (softer)
//   'nuke'                         atomBomb
//   'capture', tanks firing        heat for the gunfire bed under the front
import type { Effect, GameState, Unit } from '../../sim/types';
import { DeathWatch, deathKindOf, isKillBlast } from '../fx/deaths';
import type { SoundId } from '../audio';

export interface BattleCue {
  /** a sound, or 'front': fighting here (feeds the gunfire bed) */
  id: SoundId | 'front';
  /** tile coordinates */
  x: number;
  y: number;
  volume: number;
  /** the unit is the human's (a loss of yours) */
  mine?: boolean;
}

/** Chance per tick (10 per second) that a division in a fight fires: about once every 2.5 s. */
export const TANK_FIRE_CHANCE = 0.04;
/** A division counts as in a fight when land of a nation it fights lies within this many tiles. */
const TANK_REACH = 3;

export class BattleEars {
  private deaths = new DeathWatch();
  private gone: Unit[] = [];
  private missiles = new Set<number>();
  private missilesNext = new Set<number>();
  private missileTargets = new Set<number>();
  private lastTick = -1;

  constructor(private rand: () => number = Math.random) {}

  /** Forgets everything: what `state` holds now is history. */
  reset(state: GameState | null): void {
    this.deaths.reset(state);
    this.missiles.clear();
    this.missileTargets.clear();
    if (state) for (const u of state.units) if (u.type === 'rocket' || u.type === 'atomBomb' || u.type === 'cruiseMissile') {
      this.missiles.add(u.id);
      this.missileTargets.add(u.target);
    }
    this.lastTick = state ? state.tick : -1;
  }

  /** One new sim effect (each once). Cues go to `out`. */
  effect(state: GameState, e: Effect, out: BattleCue[]): void {
    switch (e.kind) {
      case 'nuke':
        out.push({ id: 'atomBomb', x: e.x, y: e.y, volume: 1 });
        return;
      case 'barrage':
        out.push({ id: 'bombard', x: e.x, y: e.y, volume: 1 });
        out.push({ id: 'front', x: e.x, y: e.y, volume: 1 });
        return;
      case 'explosion': {
        if (isKillBlast(e.radius)) {
          this.deaths.blast(e.x, e.y); // told apart from a hit once the tick's units are read (tick())
          return;
        }
        const tile = Math.floor(e.y) * state.map.width + Math.floor(e.x);
        out.push({ id: 'explosionBig', x: e.x, y: e.y, volume: this.missileTargets.has(tile) ? 1 : 0.8 });
        return;
      }
      case 'shot': {
        const src = shotSource(state, e);
        if (src === 'cannon') out.push({ id: 'shot', x: e.x, y: e.y, volume: 1 });
        else if (src === 'torpedo') out.push({ id: 'sonarPing', x: e.x, y: e.y, volume: 1 });
        else out.push({ id: 'shot', x: e.x, y: e.y, volume: 0.3 });
        return;
      }
      case 'capture':
        out.push({ id: 'front', x: e.x, y: e.y, volume: e.radius > 2 ? 2 : 1 });
        return;
      default:
        return;
    }
  }

  /** Once per frame after the effects: deaths, tank fire and launches of each new tick. */
  tick(state: GameState, out: BattleCue[]): void {
    if (state.tick === this.lastTick && this.deaths.blasts === 0) return;
    const ticks = this.lastTick < 0 ? 1 : Math.max(0, Math.min(10, state.tick - this.lastTick));
    this.lastTick = state.tick;
    const me = state.humanId;
    // deaths
    const n = this.deaths.scan(state, this.gone);
    for (let i = 0; i < n; i++) {
      const u = this.gone[i];
      const kind = deathKindOf(u.type);
      const x = u.x + 0.5;
      const y = u.y + 0.5;
      const mine = me > 0 && u.owner === me;
      if (kind === 'plane') out.push({ id: 'planeCrash', x, y, volume: 1, mine });
      else if (kind === 'ship') out.push({ id: 'shipSunk', x, y, volume: u.type === 'warship' ? 1 : 0.8, mine });
      else if (kind === 'tank') out.push({ id: mine ? 'unitLost' : 'tankDestroyed', x, y, volume: 1, mine });
      else if (kind === 'missile') out.push({ id: 'explosion', x, y, volume: 0.8 });
    }
    for (let i = 0; i < this.deaths.blasts; i++) {
      if (this.deaths.wasDeath(i)) continue;
      out.push({ id: 'explosion', x: this.deaths.blastX(i), y: this.deaths.blastY(i), volume: 0.6 });
    }
    this.deaths.endTick();
    this.gone.length = 0;
    if (ticks === 0) return;
    // launches, and the targets of the missiles in flight (their blast is a big one)
    const next = this.missilesNext;
    next.clear();
    this.missileTargets.clear();
    const fighting = ticks > 0 ? warPairs(state) : null;
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      if (u.type === 'rocket' || u.type === 'atomBomb' || u.type === 'cruiseMissile') {
        next.add(u.id);
        this.missileTargets.add(u.target);
        if (!this.missiles.has(u.id)) out.push({ id: 'missileLaunch', x: u.x + 0.5, y: u.y + 0.5, volume: u.type === 'atomBomb' ? 1 : u.type === 'cruiseMissile' ? 0.7 : 0.85 });
        continue;
      }
      if (u.type !== 'tankDivision' || !fighting) continue;
      if (!tankInFight(state, u, fighting)) continue;
      out.push({ id: 'front', x: u.x + 0.5, y: u.y + 0.5, volume: 0.05 * ticks });
      // each division fires now and then (several ticks since the last frame: as many chances)
      if (1 - Math.pow(1 - TANK_FIRE_CHANCE, ticks) > this.rand()) out.push({ id: 'tankShot', x: u.x + 0.5, y: u.y + 0.5, volume: 1 });
    }
    this.missilesNext = this.missiles;
    this.missiles = next;
  }
}

/** Who fired a 'shot': a warship's guns, a submarine's torpedo, or anti-air fire (SAM sites, airfields, carriers). */
export function shotSource(state: GameState, e: Effect): 'cannon' | 'torpedo' | 'tracer' {
  if (e.x2 === undefined || e.y2 === undefined) return 'tracer';
  for (const u of state.units) {
    if ((u.type === 'bomber' || u.type === 'transportPlane' || u.type === 'fighter' || u.type === 'reconPlane' || u.type === 'stealthBomber') && Math.abs(u.x + 0.5 - e.x2) + Math.abs(u.y + 0.5 - e.y2) < 1.5) return 'tracer';
  }
  let ship: Unit | null = null;
  let bd = 1.2;
  for (const u of state.units) {
    if (u.type !== 'warship') continue;
    const d = Math.abs(u.x + 0.5 - e.x) + Math.abs(u.y + 0.5 - e.y);
    if (d < bd) {
      bd = d;
      ship = u;
    }
  }
  if (!ship || ship.variant === 'carrier') return 'tracer';
  return ship.variant === 'submarine' ? 'torpedo' : 'cannon';
}

/** Pairs of nations with an attack running between them (key a * 4096 + b, both ways). */
function warPairs(state: GameState): Set<number> {
  const s = new Set<number>();
  for (const a of state.attacks) {
    if (a.target <= 0) continue;
    s.add(a.attacker * 4096 + a.target);
    s.add(a.target * 4096 + a.attacker);
  }
  return s;
}

function tankInFight(state: GameState, u: Unit, pairs: Set<number>): boolean {
  if (u.state === 3) return true; // a spearhead is fighting its way in
  if (!pairs.size) return false;
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const cx = Math.floor(u.x);
  const cy = Math.floor(u.y);
  for (let dy = -TANK_REACH; dy <= TANK_REACH; dy += TANK_REACH) {
    for (let dx = -TANK_REACH; dx <= TANK_REACH; dx += TANK_REACH) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const o = map.owner[y * w + x];
      if (o > 0 && o !== u.owner && pairs.has(u.owner * 4096 + o)) return true;
    }
  }
  return false;
}
