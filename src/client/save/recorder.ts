// Records a single-player game for its save (format.ts): every action the player issued, in order, with the tick it
// was applied at, plus a state hash at each save. Client only; it reads the state (hashState) and never writes it.
import { hashState } from '../../sim/hash';
import { gameSeconds } from '../../sim/state';
import type { Action, GameSettings, GameState } from '../../sim/types';
import { SAVE_FORMAT, saveBuildId, saveMapName, type Checkpoint, type LogEntry, type SaveData, type TickError } from './format';

/** Checkpoints kept at most (older ones are thinned out; the newest always stays). */
export const MAX_CHECKS = 24;

export class GameRecorder {
  readonly settings: GameSettings;
  readonly log: LogEntry[];
  readonly checks: Checkpoint[];
  /** ticks that threw while playing (the game paused and was resumed) */
  readonly tickErrors: TickError[];
  /** set when saving is off for this game (too big for the browser's storage) */
  disabled = false;

  constructor(settings: GameSettings, from?: Pick<SaveData, 'log' | 'checks' | 'tickErrors'>) {
    // a copy: the menu may reuse its settings object for the next game
    this.settings = JSON.parse(JSON.stringify(settings)) as GameSettings;
    this.log = from ? from.log.slice() : [];
    this.checks = from ? from.checks.slice() : [];
    this.tickErrors = from?.tickErrors ? from.tickErrors.map((e) => [e[0], e[1]] as TickError) : [];
  }

  /** Notes that the tick at `tick` threw (main.ts pauses the game; a load must fail at the same point). */
  noteTickError(tick: number): void {
    this.tickErrors.push([tick, this.log.length]);
  }

  /**
   * Notes an action just before it is applied at state.tick. A copy is kept (the UI may reuse the object). A slider
   * drag sends many army mix changes in one tick: only the last one counts then, so it replaces the one before it
   * (unless a checkpoint was taken or a tick failed in between).
   */
  record(tick: number, action: Action): void {
    let copy: Action;
    try {
      copy = JSON.parse(JSON.stringify(action)) as Action;
    } catch {
      return;
    }
    const last = this.log[this.log.length - 1];
    const lastCheck = this.checks[this.checks.length - 1];
    const lastErr = this.tickErrors[this.tickErrors.length - 1];
    const between = (lastCheck && lastCheck.n === this.log.length) || (lastErr && lastErr[1] === this.log.length);
    if (last && last[0] === tick && last[1].type === 'setArmyMix' && copy.type === 'setArmyMix' && !between) {
      last[1] = copy;
      return;
    }
    this.log.push([tick, copy]);
  }

  /** True when the game moved on since the last checkpoint (worth saving again). */
  changedSince(state: GameState): boolean {
    const c = this.checks[this.checks.length - 1];
    return !c || c.t !== state.tick || c.n !== this.log.length || (c.e ?? 0) !== this.tickErrors.length;
  }

  /** The save for the game as it is now (adds a checkpoint). */
  snapshot(state: GameState, tickMs: number, now: number): SaveData {
    if (this.changedSince(state)) {
      const c: Checkpoint = { t: state.tick, n: this.log.length, h: hashState(state) };
      if (this.tickErrors.length) c.e = this.tickErrors.length;
      this.checks.push(c);
    }
    thinChecks(this.checks, MAX_CHECKS);
    const me = state.players[state.humanId];
    const land = me && state.map.landTileCount > 0 ? me.tiles / state.map.landTileCount : 0;
    const data: SaveData = {
      format: SAVE_FORMAT,
      build: saveBuildId(),
      savedAt: now,
      settings: this.settings,
      tick: state.tick,
      log: this.log,
      checks: this.checks,
      meta: { map: saveMapName(this.settings), minutes: gameSeconds(state) / 60, land, tickMs: Math.round(tickMs * 100) / 100 },
    };
    if (this.tickErrors.length) data.tickErrors = this.tickErrors;
    return data;
  }
}

/** Drops every other checkpoint (oldest first) until at most `max` are left; the newest one always stays. */
export function thinChecks(checks: Checkpoint[], max: number): void {
  while (checks.length > max) {
    const keep: Checkpoint[] = [];
    for (let i = 0; i < checks.length - 1; i++) if (i % 2 === 0) keep.push(checks[i]);
    keep.push(checks[checks.length - 1]);
    checks.splice(0, checks.length, ...keep);
  }
}
