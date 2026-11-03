// Loads a save (format.ts) by replaying it: the game made from the save's settings runs tick by tick, and before
// each tick the actions recorded at that tick are applied in their order, exactly as the player's clicks were
// between two ticks. Each checkpoint's hash is compared on the way; the first difference stops the replay (the save
// came from other code). Runs in slices (run(maxTicks)) so the page can show a progress bar in between.
// A tick that threw while the game was played (main.ts pauses then, and the player can resume) throws again here at
// the same moment: the save notes where (tickErrors), so the replay calls it at that point too and carries on.
import { applyAction } from '../../sim/actions';
import { hashState } from '../../sim/hash';
import { tick } from '../../sim/sim';
import type { GameState } from '../../sim/types';
import type { SaveData, TickError } from './format';

/** Failed tries of one tick in a row before the replay gives up (a tick that never works can't be played past). */
export const MAX_TICK_RETRIES = 20;

export interface ReplayMismatch {
  /** tick of the first checkpoint that differed */
  tick: number;
  /** 'hash': the state differs; 'stuck': the game ended before the save's tick */
  kind: 'hash' | 'stuck';
}

export class Replayer {
  /** next log entry to apply */
  private next = 0;
  /** next checkpoint to compare */
  private check = 0;
  /** tick errors met so far (save.tickErrors[0..err) are behind) */
  private err = 0;
  /** failed tries of the current tick that the save did not note (an older save) */
  private retries = 0;
  /** every tick that threw in this replay, noted or not (the game that goes on from here keeps them) */
  private failed: TickError[] = [];
  /** the first difference found (the replay stops there unless keepGoing() is called) */
  mismatch: ReplayMismatch | null = null;
  /** true once the state is at the save's tick with every action applied */
  done = false;
  private ignoreChecks = false;
  /** checkpoints compared and equal */
  checked = 0;

  constructor(
    readonly state: GameState,
    readonly save: Pick<SaveData, 'tick' | 'log' | 'checks' | 'tickErrors'>,
    /** called after every tick (the end summary's history is fed from here) */
    private afterTick?: (state: GameState) => void,
    /** the sim step (tests pass a wrapped one) */
    private step: (state: GameState) => void = tick,
  ) {}

  /**
   * What the replay really applied, for the game that goes on from here: the whole log when done at the save's tick,
   * less when the game ended earlier in this version (a save loaded anyway). The rest never happened in this game.
   */
  played(): { log: SaveData['log']; tickErrors: TickError[] } {
    return { log: this.save.log.slice(0, this.next), tickErrors: this.failed.map((e) => [e[0], e[1]] as TickError) };
  }

  /** The tick error noted at this point of the replay (the tick, with `next` entries applied), if any. */
  private errHere(): boolean {
    const e = this.save.tickErrors?.[this.err];
    return !!e && e[0] === this.state.tick && e[1] === this.next;
  }

  /** 0..1 */
  get progress(): number {
    return this.save.tick > 0 ? Math.min(1, this.state.tick / this.save.tick) : 1;
  }

  /** After a mismatch: play the rest of the log without comparing hashes (the player chose to load it anyway). */
  keepGoing(): void {
    this.ignoreChecks = true;
    this.mismatch = null;
  }

  /** Runs at most `maxTicks` ticks; true when finished (done) or stopped at a mismatch. */
  run(maxTicks: number): boolean {
    const { state, save } = this;
    const log = save.log;
    for (let k = 0; k < maxTicks; k++) {
      if (this.done || this.mismatch) return true;
      if (!this.compare()) return true;
      // (<=: entries of a tick the replay already left are applied late rather than never, after a Load anyway)
      while (this.next < log.length && log[this.next][0] <= state.tick && !this.errHere()) {
        const [, action] = log[this.next];
        try {
          applyAction(state, state.humanId, action);
        } catch (err) {
          // the same error happened while playing (the game went on then too)
          console.warn('Replayed action failed', action, err);
        }
        this.next++;
        if (!this.compare()) return true;
      }
      const noted = this.errHere();
      if (!noted && state.tick >= save.tick) {
        this.done = true;
        return true;
      }
      const before = state.tick;
      try {
        this.step(state);
      } catch (err) {
        this.failed.push([before, this.next]);
        if (noted) {
          // it failed here while playing too: the player resumed, and so does the replay
          this.err++;
          this.retries = 0;
          continue;
        }
        // an older save that doesn't note it: try the tick again (it did while playing), but not forever
        if (++this.retries > MAX_TICK_RETRIES) throw err;
        console.warn('Replayed tick failed', before, err);
        continue;
      }
      this.retries = 0;
      if (noted) {
        // the tick failed while playing but works now: other code
        this.err++;
        if (!this.ignoreChecks) {
          this.mismatch = { tick: before, kind: 'hash' };
          return true;
        }
      }
      if (state.tick === before) {
        // the game is over here but the save goes on: it was not made from this game
        if (this.ignoreChecks) {
          this.done = true;
          return true;
        }
        this.mismatch = { tick: before, kind: 'stuck' };
        return true;
      }
      this.afterTick?.(state);
    }
    return this.done || !!this.mismatch;
  }

  /**
   * Compares every checkpoint that belongs to this moment (tick, actions applied, tick errors met); false on a
   * difference. A checkpoint further on waits; one already passed is skipped (cannot happen with a valid save).
   */
  private compare(): boolean {
    const checks = this.save.checks;
    const t = this.state.tick;
    while (this.check < checks.length) {
      const c = checks[this.check];
      const e = c.e ?? 0;
      if (c.t > t || (c.t === t && (c.n > this.next || (c.n === this.next && e > this.err)))) break;
      this.check++;
      if (c.t < t || c.n < this.next || e < this.err || this.ignoreChecks) continue;
      if (hashState(this.state) !== c.h) {
        this.mismatch = { tick: t, kind: 'hash' };
        return false;
      }
      this.checked++;
    }
    return true;
  }
}
