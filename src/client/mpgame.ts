// Lockstep runner for an online game (docs/MULTIPLAYER.md). The server sends `turn {n, intents}` every 100 ms; for
// each turn, strictly in order, every client applies the intents in array order and runs exactly one tick, so all
// clients hold the same state. Local actions are never applied directly: they go to the server as intents and come
// back in a turn (no prediction). Turns that arrive in a burst (catch-up after joining or reconnecting) are replayed
// quickly within a time budget per frame, so the page keeps rendering. Every HASH_INTERVAL_TURNS turns the client
// sends hashState for the server's desync vote.
import type { NetClient } from '../net/client';
import { expandCatchUp, HASH_INTERVAL_TURNS, isHashTurn } from '../net/protocol';
import type { GameOverMsg, GameStartMsg, PresenceMsg, ServerMessage, Turn } from '../net/protocol';
import { applyAction } from '../sim/actions';
import { hashState } from '../sim/hash';
import { tick } from '../sim/sim';
import { createGame } from '../sim/state';
import type { Action, ActionResult, GameState, MapData } from '../sim/types';
import { loadWorldMap } from '../sim/worldmaps';

/** At most this many turns per frame while catching up (and at most a time budget of work, see pump). */
export const MAX_TURNS_PER_FRAME = 200;
/** ms of sim work per frame: normal play, and while far behind (frames get slower, the replay finishes sooner). */
const BUDGET_MS = 24;
const CATCHUP_BUDGET_MS = 70;
/** Turns behind from which the bigger budget applies. */
const FAR_BEHIND = 30;
/** At most one army mix change per this many ms (slider drags). */
const MIX_INTERVAL_MS = 300;
/** A pause click the server hasn't confirmed after this long (while turns keep coming) is dropped. */
const PAUSE_CONFIRM_MS = 2500;
/** Hashes kept for the test hook and the desync banner (turn -> hash). */
const HASHES_KEPT = 120;

export interface MpHooks {
  /** one of our own intents was refused by the sim when its turn ran (same reason on every client) */
  onRefused?: (reason: string, action: Action) => void;
  /** the sim raised an error: the game can't continue on this client */
  onError?: (err: unknown) => void;
}

export interface DesyncInfo {
  turn: number;
  details: string;
}

/** One online game on this client: the state, the turn queue, intents out, hashes out. */
export class MpGame {
  readonly code: string;
  readonly start: GameStartMsg;
  /** our player id; 0 = spectator */
  readonly playerId: number;
  state: GameState | null = null;
  /** set while the map loads / the game is built; null once ready (or the error text) */
  loading: Promise<void>;
  loadError: string | null = null;
  /** the next turn number to run (= turns processed = state.tick) */
  nextTurn = 0;
  /** highest turn number known to exist on the server (catch-up progress) */
  knownTurns = 0;
  /** hashes sent, by turn */
  readonly hashes = new Map<number, number>();
  desync: DesyncInfo | null = null;
  /** the players' hashes disagreed without a majority (soft warning; the server keeps checking) */
  disagree: (DesyncInfo & { at: number }) | null = null;
  /** the server ended the game (abandoned, time limit, or the majority's finish) */
  serverOver: GameOverMsg | null = null;
  presence: PresenceMsg | null = null;
  /** true after reload(): the next gameStart rebuilds the game from turn 0 */
  rebuild = false;
  /** whether this client may send `startNow` (the private lobby's host) */
  canStartNow = false;
  /** a private game (its host may pause; public games never pause) */
  isPrivate = false;
  /** the host paused the game (server `pauseState`; set at once on the host's own click) */
  paused = false;
  /** who paused: a player id (0 = the server) */
  pausedBy: number | null = null;
  /** player id of the current host from the server's `pauseState` (-1 = not told yet: canStartNow decides) */
  hostId = -1;
  /** our own pause click not confirmed by the server yet (performance.now() of the click, 0 = none pending) */
  private pauseSentAt = 0;
  private queue: Turn[] = [];
  private mixPending: Extract<Action, { type: 'setArmyMix' }> | null = null;
  private mixSentAt = -Infinity;
  private mixTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUpTo = 0;
  private overSent = false;
  private failed = false;

  constructor(
    private net: NetClient,
    start: GameStartMsg,
    private hooks: MpHooks = {},
  ) {
    this.start = start;
    this.code = start.code;
    this.playerId = start.yourPlayerId;
    this.knownTurns = start.turnsPlayed;
    this.catchUpTo = start.turnsPlayed;
    this.loading = this.build();
  }

  get spectator(): boolean {
    return this.playerId === 0;
  }
  get ready(): boolean {
    return !!this.state && !this.loadError;
  }
  /** Turns received but not run yet. */
  get behind(): number {
    return this.queue.length;
  }
  /** True while replaying turns the game had before we (re)joined. */
  get catchingUp(): boolean {
    return this.nextTurn < this.catchUpTo - 1;
  }
  /** Catching up or far behind: what happens now is old news (no toasts or sounds for it). */
  get replaying(): boolean {
    return this.catchingUp || this.queue.length > FAR_BEHIND;
  }

  private async build(): Promise<void> {
    const s = this.start.settings;
    let map: MapData | null = null;
    try {
      if (s.map.kind === 'world') map = await loadWorldMap(s.map.id);
      const state = createGame(s, map, { teams: this.start.teams?.byPlayer });
      // humanId is client-side only: which nation this client controls and views (0 = spectator).
      state.humanId = this.playerId;
      this.state = state;
    } catch (err) {
      console.error('Could not build the online game', err);
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---------------------------------------------------------------------------------------------- messages

  /** Feed every server message here while this game is current. */
  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'turn':
        // turns keep coming long after our pause click: the server didn't take it, show the game running again
        if (this.pauseSentAt && performance.now() - this.pauseSentAt > PAUSE_CONFIRM_MS) {
          this.pauseSentAt = 0;
          if (this.paused) this.paused = false;
        }
        this.enqueue({ n: msg.n, intents: msg.intents });
        break;
      case 'catchUp':
        this.catchUpTo = Math.max(this.catchUpTo, msg.toTurn);
        for (const t of expandCatchUp(msg)) this.enqueue(t);
        break;
      case 'desync':
        if (msg.majorityHash === null) this.disagree = { turn: msg.turn, details: msg.details, at: performance.now() };
        else this.desync = { turn: msg.turn, details: msg.details };
        break;
      case 'presence':
        this.presence = msg;
        break;
      case 'gameOver':
        this.serverOver = msg;
        this.paused = false;
        break;
      case 'pauseState':
        this.paused = msg.paused;
        this.pauseSentAt = 0;
        this.pausedBy = msg.by;
        // the host role can pass on during a game (the old host stayed away): it decides who may pause now
        this.hostId = msg.host;
        if (msg.host > 0) this.isPrivate = true;
        break;
      default:
        break;
    }
  }

  /**
   * The next turn number this client needs (turns before it are run or queued): sent as `resume.haveTurns` on a
   * reconnect so the server's catch-up starts there. 0 when the game will be rebuilt from the start.
   */
  haveTurns(): number {
    if (this.rebuild || this.loadError) return 0;
    return this.queue.length ? this.queue[this.queue.length - 1].n + 1 : this.nextTurn;
  }

  /** gameStart again for this game after a reconnect (the game is kept): the catch-up runs up to turnsPlayed. */
  resumed(start: GameStartMsg): void {
    this.catchUpTo = Math.max(this.catchUpTo, start.turnsPlayed);
    this.knownTurns = Math.max(this.knownTurns, start.turnsPlayed);
  }

  private enqueue(t: Turn): void {
    const last = this.queue.length ? this.queue[this.queue.length - 1].n : this.nextTurn - 1;
    if (t.n <= last) return; // already have it (a catchUp after a reconnect repeats old turns)
    if (t.n !== last + 1) {
      // A gap: some turns never reached us. Reconnect: the server's catchUp starts at the turn we need (haveTurns).
      console.warn(`Turn ${t.n} arrived, expected ${last + 1}: resyncing`);
      this.net.reconnectNow();
      return;
    }
    this.queue.push(t);
    this.knownTurns = Math.max(this.knownTurns, t.n + 1);
  }

  // ---------------------------------------------------------------------------------------------- running

  /**
   * Runs queued turns: all of them normally (one or two per frame at server pace); in a burst at most
   * MAX_TURNS_PER_FRAME and about BUDGET_MS of work (CATCHUP_BUDGET_MS when far behind), so the page keeps
   * rendering. Returns the number of turns run.
   */
  pump(): number {
    const state = this.state;
    if (!state || this.failed || !this.queue.length) return 0;
    const t0 = performance.now();
    const budget = this.queue.length > FAR_BEHIND ? CATCHUP_BUDGET_MS : BUDGET_MS;
    let n = 0;
    while (this.queue.length && n < MAX_TURNS_PER_FRAME) {
      if (n > 0 && performance.now() - t0 > budget) break;
      const turn = this.queue.shift()!;
      try {
        this.runTurn(state, turn);
      } catch (err) {
        this.failed = true;
        console.error('Simulation error in turn', turn.n, err);
        this.hooks.onError?.(err);
        return n;
      }
      n++;
    }
    return n;
  }

  private runTurn(state: GameState, turn: Turn): void {
    for (const { playerId, action } of turn.intents) {
      const r = applyAction(state, playerId, action);
      if (!r.ok && playerId === this.playerId && playerId > 0 && !this.catchingUp) this.hooks.onRefused?.(r.reason ?? 'Not possible', action);
    }
    tick(state);
    this.nextTurn = turn.n + 1;
    if (isHashTurn(turn.n)) {
      const h = hashState(state);
      this.hashes.set(turn.n, h);
      if (this.hashes.size > HASHES_KEPT) this.hashes.delete(this.hashes.keys().next().value as number);
      // During a catch-up only the last few hashes count (the server rate-limits old ones anyway).
      if (turn.n >= this.catchUpTo - HASH_INTERVAL_TURNS) this.net.send({ type: 'hash', turn: turn.n, hash: h });
    }
    if (state.phase === 'over' && !this.overSent) {
      this.overSent = true;
      this.net.send({ type: 'gameOver', turn: turn.n, winner: state.winner });
    }
  }

  // ---------------------------------------------------------------------------------------------- actions

  /** Whether this client may act (a seat, alive, the game running). */
  canAct(): boolean {
    const s = this.state;
    if (!s || this.spectator || this.serverOver || s.phase === 'over') return false;
    const me = s.players[this.playerId];
    return !!me && me.alive;
  }

  /**
   * Sends an action as an intent. The answer is optimistic (ok when it was sent): the sim checks it when its turn
   * runs, and a refusal comes back through hooks.onRefused.
   */
  dispatch(action: Action): ActionResult {
    if (!this.state) return { ok: false, reason: 'The game is still loading' };
    if (this.spectator) return { ok: false, reason: 'You are watching this game' };
    if (!this.canAct()) return { ok: false, reason: this.state.phase === 'over' || this.serverOver ? 'The game is over' : 'You have been eliminated' };
    if (action.type === 'startNow' && !this.canStartNow) return { ok: false, reason: 'Only the host can start early' };
    if (!this.net.online) return { ok: false, reason: 'Not connected: reconnecting…' };
    if (action.type === 'setArmyMix') return this.sendMix(action);
    return this.net.send({ type: 'intent', action }) ? { ok: true } : { ok: false, reason: 'Not connected' };
  }

  /**
   * Army mix sliders fire on every drag step: send at most one setArmyMix per MIX_INTERVAL_MS, the latest value
   * last, so a drag doesn't spend the server's per-player action budget.
   */
  private sendMix(action: Extract<Action, { type: 'setArmyMix' }>): ActionResult {
    this.mixPending = action;
    const wait = this.mixSentAt + MIX_INTERVAL_MS - performance.now();
    if (wait <= 0) return this.flushMix() ? { ok: true } : { ok: false, reason: 'Not connected' };
    if (!this.mixTimer) this.mixTimer = setTimeout(() => this.flushMix(), wait);
    return { ok: true };
  }

  private flushMix(): boolean {
    if (this.mixTimer) clearTimeout(this.mixTimer);
    this.mixTimer = null;
    const a = this.mixPending;
    this.mixPending = null;
    if (!a) return true;
    this.mixSentAt = performance.now();
    return this.net.send({ type: 'intent', action: a });
  }

  /** Only the private lobby's host may pause an online game. */
  get canPause(): boolean {
    if (this.spectator) return false;
    return this.hostId >= 0 ? this.hostId === this.playerId : this.canStartNow && this.isPrivate;
  }

  /** Name of whoever paused (the host): for the "Paused by …" banner. */
  pausedByName(): string {
    const by = this.pausedBy;
    if (by && by === this.playerId) return 'you';
    const p = by ? this.state?.players[by] : undefined;
    return p?.name ?? (this.canPause ? 'you' : 'the host');
  }

  /** The host pauses or resumes: shown at once, confirmed by the server's `pauseState` to everyone. */
  setPause(paused: boolean): boolean {
    if (!this.canPause || this.serverOver || paused === this.paused) return false;
    const sent = this.net.send({ type: 'setPause', paused });
    if (sent) {
      this.paused = paused;
      this.pausedBy = this.playerId;
      this.pauseSentAt = paused ? performance.now() : 0;
    }
    return sent;
  }

  /** After a desync: rejoin; the server sends gameStart + every turn again and the game is rebuilt from turn 0. */
  reload(): void {
    this.rebuild = true;
    this.net.reconnectNow();
  }

  /** Hash of the current state (test hook). */
  hashNow(): number {
    return this.state ? hashState(this.state) : 0;
  }
}
