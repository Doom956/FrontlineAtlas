// Watching a single-player game live (protocol 20, owner console). The owner's client rebuilds another player's
// single-player game from the setup and order log it streams (spLink -> server -> watchSetup/watchLog), in its OWN
// deterministic sim, exactly as save/replay.ts rebuilds a saved game: build the game from the settings, then apply
// the recorded orders at the ticks they were made and tick the sim forward to the game's current tick. It is one-way:
// the owner only reads the stream and can never send anything into the watched game, so it cannot desync it.
//
// The backlog (the game's history when watching started) comes first, in base chunks, the last marked final; then
// live orders arrive as they happen, each frame carrying the game's current tick so the sim keeps advancing across
// ticks that had no orders. This runs on the owner's screen only, never on the server.
import { applyAction } from '../sim/actions';
import { tick as stepSim } from '../sim/sim';
import { createGame } from '../sim/state';
import { loadWorldMap } from '../sim/worldmaps';
import type { GameSettings, GameState, MapData } from '../sim/types';
import type { WatchLogEntry } from '../net/protocol';

export class WatchGame {
  readonly settings: GameSettings;
  /** the rebuilt game (null while the map loads, or on an error) */
  state: GameState | null = null;
  /** resolves once the game is built (or loadError is set) */
  readonly loading: Promise<void>;
  loadError: string | null = null;
  /** true once the whole backlog has been applied and the sim reached the latest reported tick */
  caughtUp = false;
  /** orders not yet applied, in tick order */
  private pending: WatchLogEntry[] = [];
  /** the game tick the sim should advance to (the latest tick the stream reported) */
  private target = 0;
  /** the final backlog chunk has arrived (the whole history up to `target` is known) */
  private haveHistory = false;

  constructor(settings: GameSettings) {
    this.settings = settings;
    this.loading = this.build();
  }

  private async build(): Promise<void> {
    try {
      let preloaded: MapData | null = null;
      if (this.settings.map.kind === 'world') preloaded = await loadWorldMap(this.settings.map.id);
      this.state = createGame(this.settings, preloaded);
      this.target = this.state.tick;
    } catch (err) {
      console.error('Watch: could not build the game', err);
      this.loadError = 'This game could not be rebuilt in this version.';
    }
  }

  /** A relayed batch of orders and the game's current tick (base = part of the history, final = the last of it). */
  add(entries: WatchLogEntry[], tick: number, base: boolean, final: boolean): void {
    for (const e of entries) this.pending.push(e);
    if (tick > this.target) this.target = tick;
    if (final) this.haveHistory = true;
    // a late base frame means we are still backfilling
    if (base && !final) this.caughtUp = false;
  }

  /** 0..1 catch-up progress (ticks applied over the latest reported tick). */
  get progress(): number {
    const s = this.state;
    if (!s) return 0;
    return this.target > 0 ? Math.min(1, s.tick / this.target) : 1;
  }

  /**
   * Advances the sim toward the latest reported tick, applying each order just before the tick it was recorded at
   * (the same order replay.ts uses). Runs at most `maxTicks` ticks so the page keeps painting while catching up.
   */
  pump(maxTicks: number): void {
    const s = this.state;
    if (!s) return;
    let n = 0;
    while (s.tick < this.target && n < maxTicks && s.phase !== 'over') {
      this.applyDue(s.tick);
      try {
        stepSim(s);
      } catch (err) {
        console.error('Watch: sim error (stopped advancing)', err);
        this.target = s.tick; // stop trying to advance past the broken tick
        break;
      }
      n++;
    }
    this.applyDue(s.tick);
    if (this.haveHistory && s.tick >= this.target) this.caughtUp = true;
  }

  /** Applies every pending order recorded at or before `tick` (in order), before the sim runs that tick. */
  private applyDue(tick: number): void {
    const s = this.state;
    if (!s) return;
    while (this.pending.length && this.pending[0][0] <= tick) {
      const [, action] = this.pending.shift()!;
      try {
        applyAction(s, s.humanId, action);
      } catch (err) {
        // the same order may have failed harmlessly in the watched game too; keep going
        console.warn('Watch: order failed', action, err);
      }
    }
  }
}
