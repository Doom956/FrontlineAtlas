// The tank shots the map fires (fx/tankFire.ts pushes them) for the sound to play (sound/battle.ts drains it every
// frame), so each muzzle flash comes with its bang. Client only and read-only like the rest of fx/. Kept apart from
// fx/tankFire.ts so the sound does not import the art and the settings store (audio.ts <- settings/store.ts).
import type { GameState } from '../../sim/types';

/** A tank shot for the sound (tile coordinates of the tank). */
export interface TankShotCue {
  state: GameState;
  x: number;
  y: number;
  volume: number;
}
const BUS_CAP = 32;

/** The shots fired since the sound last looked (sound/battle.ts drains it every frame). */
export class TankShotBus {
  private q: TankShotCue[] = [];
  push(c: TankShotCue): void {
    if (this.q.length >= BUS_CAP) this.q.shift();
    this.q.push(c);
  }
  /** Hands over the shots of game `state` (others are dropped: the menu's background game) and empties the bus. */
  drain(state: GameState, take: (c: TankShotCue) => void): void {
    for (const c of this.q) if (c.state === state) take(c);
    this.q.length = 0;
  }
  clear(): void {
    this.q.length = 0;
  }
  get size(): number {
    return this.q.length;
  }
}
export const tankShotBus = new TankShotBus();
