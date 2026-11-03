// Loads a save (format.ts) by replaying it: the game made from the save's settings runs tick by tick, and before
// each tick the actions recorded at that tick are applied in their order, exactly as the player's clicks were
// between two ticks. Each checkpoint's hash is compared on the way; the first difference stops the replay (the save
// came from other code). Runs in slices (run(maxTicks)) so the page can show a progress bar in between.
import { applyAction } from '../../sim/actions';
import { hashState } from '../../sim/hash';
import { tick } from '../../sim/sim';
import type { GameState } from '../../sim/types';
import type { SaveData } from './format';

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
  /** the first difference found (the replay stops there unless keepGoing() is called) */
  mismatch: ReplayMismatch | null = null;
  /** true once the state is at the save's tick with every action applied */
  done = false;
  private ignoreChecks = false;
  /** checkpoints compared and equal */
  checked = 0;

  constructor(
    readonly state: GameState,
    readonly save: Pick<SaveData, 'tick' | 'log' | 'checks'>,
    /** called after every tick (the end summary's history is fed from here) */
    private afterTick?: (state: GameState) => void,
  ) {}

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
      while (this.next < log.length && log[this.next][0] === state.tick) {
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
      if (state.tick >= save.tick) {
        this.done = true;
        return true;
      }
      const before = state.tick;
      tick(state);
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

  /** Compares every checkpoint that belongs to this moment (tick, actions applied); false on a difference. */
  private compare(): boolean {
    const checks = this.save.checks;
    const t = this.state.tick;
    while (this.check < checks.length) {
      const c = checks[this.check];
      if (c.t > t || (c.t === t && c.n > this.next)) break;
      this.check++;
      if (c.t < t || c.n < this.next || this.ignoreChecks) continue; // passed by (cannot happen with a valid save)
      if (hashState(this.state) !== c.h) {
        this.mismatch = { tick: t, kind: 'hash' };
        return false;
      }
      this.checked++;
    }
    return true;
  }
}
