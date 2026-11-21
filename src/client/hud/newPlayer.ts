// The new-player pass (client only, no rule changes): for a player's first PASS_GAMES finished games the HUD starts with
// the few controls the first minutes need and each other control appears when it becomes useful, with a one-time
// "New:" note (one line, a toast). Never blocks: a control something else points at (the guide, the advisor, an offer
// that arrives) appears at once, and a drawer opened by a hotkey shows its button for good.
//
// Always there: the Attack slider, Build, City / Farm / Market, Troops, Gold, Standings, Help, Menu, Pause.
// Appear:
//   Research          after the first City, or at 1 min
//   Army, Forces      when you own your first unit
//   Diplomacy         when another nation borders you, or an offer arrives
//   Events, Alerts    on the first event / alert
//   Map key, season   at 2 min
//   the rest of the quick build slots with Research
// Doctrine (5 min) and the strikes bar (90 s or a strike unlocks) keep their own rules.
// The switch Settings > Gameplay > "Show all controls from the start" (and PASS_GAMES finished games) turns the pass
// off; spectators, tutorial games and games with the switch on see everything.
import { borders } from '../../sim/combat';
import { gameSeconds } from '../../sim/state';
import type { BuildingType, GameState, Player } from '../../sim/types';
import { isTribe } from '../../sim/types';

export type PassControl = 'research' | 'army' | 'forces' | 'diplomacy' | 'events' | 'alerts' | 'legend' | 'season' | 'moreBuilds';
export const PASS_CONTROLS: readonly PassControl[] = ['research', 'army', 'forces', 'diplomacy', 'events', 'alerts', 'legend', 'season', 'moreBuilds'];
/** The drawer buttons the pass can hide (ids of the cluster's drawers). */
export const PASS_DRAWERS: readonly string[] = ['research', 'army', 'forces', 'diplomacy', 'events', 'alerts', 'legend'];
/** The quick build slots that are there from the start. */
export const START_BUILDS: readonly BuildingType[] = ['city', 'farm', 'market'];

/** Seconds into the game when Research shows even without a City, and when the Map key and season chip show. */
export const RESEARCH_SECONDS = 60;
export const KEY_SECONDS = 120;

/** What the pass knows about the game. */
export interface PassFacts {
  seconds: number;
  hasCity: boolean;
  hasUnit: boolean;
  neighbour: boolean;
  offer: boolean;
  event: boolean;
  alert: boolean;
}

/** The controls these facts call for (pure). */
export function passWants(f: PassFacts): Record<PassControl, boolean> {
  const research = f.hasCity || f.seconds >= RESEARCH_SECONDS;
  return {
    research,
    army: f.hasUnit,
    forces: f.hasUnit,
    diplomacy: f.neighbour || f.offer,
    events: f.event,
    alerts: f.alert,
    legend: f.seconds >= KEY_SECONDS,
    season: f.seconds >= KEY_SECONDS,
    moreBuilds: research,
  };
}

/** The one-line "New:" note of a control. */
export const PASS_NOTES: Record<PassControl, string> = {
  research: 'New: Research in the top bar. Pick technologies for stronger troops and income.',
  army: 'New: Army in the top bar. Set your troop mix and watch your attacks.',
  forces: 'New: Forces in the top bar. Buy and command warships, aircraft and tanks.',
  diplomacy: 'New: Diplomacy in the top bar. Ask nations for alliances, peace and pacts.',
  events: 'New: Events in the top bar. A log of what happened.',
  alerts: 'New: Alerts in the top bar. Big events, click one to see it on the map.',
  legend: 'New: Map key in the top bar. What the colours and symbols mean.',
  season: 'New: the season chip. Seasons change how fast attacks and tanks move.',
  moreBuilds: 'New: more buildings in the bottom bar. Mines, Barracks and more.',
};

/** True when a state has this player's first unit (a ship, tank division, bomber or fighter, or one on order). */
export function ownsUnit(s: GameState, me: Player): boolean {
  if (s.units.some((u) => u.owner === me.id && u.hp > 0 && u.type !== 'tradeShip')) return true;
  if (s.unitQueue?.some((q) => q.owner === me.id)) return true;
  for (const b of s.buildings.values()) if (b.owner === me.id && b.type === 'airfield' && b.bombers + b.fighters > 0) return true;
  return false;
}

function hasCity(s: GameState, me: Player): boolean {
  for (const b of s.buildings.values()) if (b.owner === me.id && b.type === 'city') return true;
  return false;
}

/** Another living nation touches this player's land (tribes do not count). */
function bordersNation(s: GameState, me: Player): boolean {
  for (const p of s.players) {
    if (p.id <= 0 || p.id === me.id || !p.alive || isTribe(p)) continue;
    if (borders(s, me.id, p.id)) return true;
  }
  return false;
}

/** What the HUD hands the pass to show and hide parts. */
export interface PassTargets {
  /** shows or hides a drawer button (cluster) */
  setDrawer(id: string, shown: boolean): void;
  /** shows or hides the season chip (cluster) */
  setSeason(shown: boolean): void;
  /** limits the quick build slots to these types (null = all) */
  setBuilds(only: readonly BuildingType[] | null): void;
  /** the one-line note */
  note(key: string, text: string): void;
}

export class NewPlayerPass {
  private shown = new Set<PassControl>();
  private event = false;
  private alert = false;
  private lastSlow = -Infinity;
  private started = false;
  /** the first look at a game: what is already true (a saved game, a late join) shows without notes */
  private first = true;

  constructor(
    private t: PassTargets,
    /** false: the pass is off for this game (switch on, finished games, spectator, tutorial) */
    private active: () => boolean,
  ) {}

  /** The first event / alert that concerns the player arrived. */
  noteEvent(): void {
    this.event = true;
  }
  noteAlert(): void {
    this.alert = true;
  }

  /**
   * Something else needs this control now: it shows for good. note: say so with its "New:" note (the guide or the
   * advisor points at it; a drawer opened by a hotkey needs none).
   */
  reveal(c: PassControl, note = false): void {
    if (!this.started) return;
    this.show(c, note && !this.first);
  }
  /** A drawer id (cluster) a hotkey or a hint opens. */
  revealDrawer(id: string, note = false): void {
    if ((PASS_DRAWERS as readonly string[]).includes(id)) this.reveal(id as PassControl, note);
  }
  isShown(c: PassControl): boolean {
    return !this.started || this.shown.has(c);
  }

  private show(c: PassControl, note: boolean): void {
    if (this.shown.has(c)) return;
    this.shown.add(c);
    this.apply(c, true);
    if (note && c !== 'moreBuilds') this.t.note(`np-${c}`, PASS_NOTES[c]); // the build slots come with Research: one note
  }

  private apply(c: PassControl, on: boolean): void {
    if (c === 'season') this.t.setSeason(on);
    else if (c === 'moreBuilds') this.t.setBuilds(on ? null : START_BUILDS);
    else this.t.setDrawer(c, on);
  }

  /** Every ~5 Hz refresh. */
  update(s: GameState, me: Player): void {
    if (!this.active() || s.phase === 'over') {
      // pass off: everything shows (once)
      if (this.started) {
        this.started = false;
        this.first = true;
        for (const c of PASS_CONTROLS) this.apply(c, true);
        this.shown.clear();
      }
      return;
    }
    if (!this.started) {
      this.started = true;
      this.shown.clear();
      for (const c of PASS_CONTROLS) this.apply(c, false);
    }
    // a game loaded or joined late (a saved game, online): what is already true shows without notes
    const seconds = gameSeconds(s);
    const slow = seconds - this.lastSlow >= 1; // the border test is the costly part: once a second
    const f: PassFacts = {
      seconds,
      hasCity: hasCity(s, me),
      hasUnit: ownsUnit(s, me),
      neighbour: slow ? bordersNation(s, me) : this.shown.has('diplomacy'),
      offer: s.allianceRequests.some((r) => r.to === me.id) || (s.treatyOffers ?? []).some((o) => o.to === me.id && o.expiresTick > s.tick),
      event: this.event,
      alert: this.alert,
    };
    if (slow) this.lastSlow = seconds;
    const want = passWants(f);
    // at the start of a game (the first seconds) the notes would say what the HUD is: only controls that appear later get one
    const quiet = seconds < 1 || this.first;
    this.first = false;
    for (const c of PASS_CONTROLS) if (want[c]) this.show(c, !quiet);
  }
}
