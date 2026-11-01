// Advisor strip: one thin line above the command bar that folds itself into a small tab after a few seconds (hover
// or click the tab to read it again) and stays folded while a toast is up, so there is never more than one message
// talking at a time. A suggestion pops open once; later it only waits in the tab. It stays hidden while the in-game
// guide (guide/guide.ts, which replaced the old first-game tutorial steps) shows its bar (`suppressed`).
// - Advisor: the sim's suggestions() (advisor.ts), one at a time, cycling every 8 s, plus two client hints:
//   artillery when the main foe's front is fortified or hilly, units when they matter (unitAdvice: warships against
//   enemy fleets off your coast, fighters / SAM sites against enemy bombers; once each, ever), and once per strike (remembered in localStorage) a
//   first-use hint pointing at its button the first time it is ready ("Bombers ready: press X ...").
//   Click the button to act (enter build mode, open a drawer, centre the map); X dismisses that hint for a while;
//   it can be switched off in the menu.
import { mainFoe, fortifiedShare } from '../../sim/advisor';
import { buildingsOf, countBuildings } from '../../sim/buildings';
import { BUILDINGS, UNITS } from '../../sim/config';
import { areAllied } from '../../sim/diplomacy';
import { forEachInRadius } from '../../sim/grid';
import { buildingAllowed, unitAllowed } from '../../sim/rules';
import { hasTech } from '../../sim/tech';
import { buildUnit, isIncoming, unitBuildStatus } from '../forces';
import { enterWarshipSpawnMode } from '../selection';
import { gameSeconds } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import { isTribe } from '../compat';
import { adviceFor, type Suggestion } from '../simx';
import { STRIKES, strikeOfMode, type StrikeId } from '../strikes';
import type { StrikeBar } from './strikeBar';
import { el, setClass, setText, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { waysToPlayAdvice } from './spendPanel';
import { pillarAdvice } from './pillarAdvice';

const ADVISOR_KEY = 'borderfall.advisor.v1';
const CYCLE_MS = 8000;
const DISMISS_MS = 120000;
const STRIKE_HINTS_KEY = 'borderfall.strikeHints.v1';
/** a first-use strike hint stays this long (or until the strike is aimed or the hint dismissed) */
const STRIKE_HINT_MS = 15000;
/** the artillery check (main foe's front: forts, hills) runs this often */
const ARTILLERY_CHECK_MS = 3000;
/** the line folds into its tab after this long */
const OPEN_MS = 7000;
const UNIT_HINTS_KEY = 'borderfall.unitHints.v1';
/** enemy warships this close (tiles) to your land count as "off your coast" */
const FLEET_NEAR = 14;

/**
 * Units the moment calls for, most urgent first (each is shown once, ever): fighters or SAM sites when enemy bombers
 * or cargo planes are coming at you, warships when enemy warships sail off your coast.
 */
export function unitAdvice(s: GameState, me: Player): Suggestion[] {
  const out: Suggestion[] = [];
  let air = false;
  let fleet = false;
  for (const u of s.units) {
    if (u.owner === me.id || u.hp <= 0 || areAllied(s, me.id, u.owner)) continue;
    if (!air && (u.type === 'bomber' || u.type === 'transportPlane') && isIncoming(s, me.id, u)) air = true;
    if (!fleet && u.type === 'warship') {
      const w = s.map.width;
      const t = Math.round(u.y) * w + Math.round(u.x);
      if (t < 0 || t >= s.map.owner.length) continue;
      forEachInRadius(s.map, t, FLEET_NEAR, (i) => {
        if (s.map.owner[i] === me.id) fleet = true;
      });
    }
    if (air && fleet) break;
  }
  if (air && unitAllowed(s, 'fighter')) {
    const st = unitBuildStatus(s, me, 'fighter');
    const sams = hasTech(me, 'radar') && buildingAllowed(s, 'sam');
    if (st.ok) out.push({ key: 'unit-fighter', text: 'Enemy planes over your land: Fighters at your Airfield shoot them down', unit: 'fighter' });
    else if (sams) out.push({ key: 'unit-fighter', text: 'Enemy planes over your land: SAM sites shoot them down', building: 'sam' });
    else if (hasTech(me, 'flight')) out.push({ key: 'unit-fighter', text: 'Enemy planes over your land: an Airfield with Fighters shoots them down', building: 'airfield' });
    else out.push({ key: 'unit-fighter', text: 'Enemy planes over your land: research Flight for Fighters (then Radar for SAM sites)', drawer: 'research' });
  }
  if (fleet && unitAllowed(s, 'warship')) {
    const st = unitBuildStatus(s, me, 'warship');
    if (st.ok) out.push({ key: 'unit-warship', text: 'Enemy warships off your coast: build Warships of your own', unit: 'warship' });
    else if (!hasTech(me, 'navigation')) out.push({ key: 'unit-warship', text: 'Enemy warships off your coast: research Navigation, then build Warships at a Port', drawer: 'research' });
    else if (buildingsOf(s, me.id, 'port').length === 0) out.push({ key: 'unit-warship', text: 'Enemy warships off your coast: build a Port, then Warships', building: 'port' });
    else out.push({ key: 'unit-warship', text: 'Enemy warships off your coast: open Forces (Y) for your fleet', drawer: 'forces' });
  }
  return out;
}

/** First-use hint per strike: what is ready, the key to press and what to click. */
export const STRIKE_HINTS: Record<StrikeId, string> = {
  barrage: `Artillery ready: press ${STRIKES.barrage.key} and click enemy land near your border`,
  bomb: `Bombers ready: press ${STRIKES.bomb.key} and click an enemy building`,
  paradrop: `Paratroopers ready: press ${STRIKES.paradrop.key} and click enemy land in an Airfield's range`,
  rocket: `Rocket ready: press ${STRIKES.rocket.key} and click any enemy land on the map`,
  atomBomb: `Atom bomb ready: press ${STRIKES.atomBomb.key} and click a target. It hits your land too`,
};

const AIM_LABEL: Record<StrikeId, string> = { barrage: 'Aim barrage', bomb: 'Aim bombers', paradrop: 'Aim drop', rocket: 'Aim rocket', atomBomb: 'Aim atom bomb' };

/**
 * Artillery advice against the main foe: their front is under forts or on hills (where artillery hits hardest).
 * Without an Arsenal: build one; with one but little artillery in a hand-set mix: raise it. null = nothing to say.
 */
export function artilleryAdvice(s: GameState, me: Player): Suggestion | null {
  const { foe, frontTiles } = mainFoe(s, me.id);
  const fp = foe > 0 ? s.players[foe] : undefined;
  if (!fp || !fp.alive || isTribe(fp) || frontTiles.length < 4) return null;
  const forts = fortifiedShare(s, foe, frontTiles) > 0.25;
  let hills = 0;
  for (const t of frontTiles) if (s.map.terrain[t] === 4) hills++;
  const hilly = hills / frontTiles.length > 0.3;
  if (!forts && !hilly) return null;
  const what = forts ? `${fp.name}'s forts ahead` : `Hills ahead of ${fp.name}`;
  if (countBuildings(s, me.id, 'arsenal', true) === 0) return { key: 'art-arsenal', text: `${what}: build an Arsenal and use artillery`, building: 'arsenal' };
  if (!me.auto.mix && me.armyMix.artillery < 0.15) return { key: 'art-mix', text: `${what}: raise Artillery in the Army drawer`, drawer: 'army' };
  return null;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage blocked */
  }
}

export class AdvisorStrip {
  readonly el: HTMLElement;
  private tag = el('span', 'adv-tag');
  private icon = el('span', 'adv-ic');
  private text = el('span', 'adv-text');
  private doBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private on = load(ADVISOR_KEY) !== 'off';
  private current: Suggestion | null = null;
  private idx = 0;
  private shownAt = 0;
  private dismissed = new Map<string, number>();
  /** strikes whose first-use hint was shown (ever) */
  private hintsSeen = new Set<string>((load(STRIKE_HINTS_KEY) ?? '').split(',').filter(Boolean));
  /** first-use strike hints waiting to be shown, and the one on screen with its end time */
  private hintQueue: StrikeId[] = [];
  private hint: { id: StrikeId; until: number } | null = null;
  private art: { at: number; s: Suggestion | null } = { at: -Infinity, s: null };
  /** newer ways to play: tech choices, tank divisions, mercenaries, funding allies, Build x5 (spendPanel.ts) */
  private ways: { at: number; s: Suggestion | null } = { at: -Infinity, s: null };
  /** pillar hint (hud/pillarAdvice.ts): bombard a coastal front, armor on open ground, air on a stuck front */
  private pillar: { at: number; s: Suggestion | null } = { at: -Infinity, s: null };
  private units: { at: number; list: Suggestion[] } = { at: -Infinity, list: [] };
  /** unit hints shown (ever) */
  private unitSeen = new Set<string>((load(UNIT_HINTS_KEY) ?? '').split(',').filter(Boolean));
  /** what the line shows now (a change opens it again) and until when it stays open */
  private shownKey = '';
  private openUntil = 0;
  /** suggestion keys that already popped open once (they wait in the folded tab afterwards) */
  private popped = new Set<string>();
  /** a toast is up (set by the HUD): the line stays folded */
  toastUp = false;
  /** the guide's bar is up (set by the HUD): the line stays hidden, so only one of them talks */
  suppressed = false;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'advisor hidden');
    this.el.dataset.test = 'advisor';
    this.doBtn = el('button', 'wr-btn mini primary adv-do', 'Do it');
    this.doBtn.type = 'button';
    this.doBtn.addEventListener('click', () => this.act());
    this.closeBtn = el('button', 'adv-x');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Dismiss this hint');
    this.closeBtn.append(iconSpan(lineIcon('close', 12, 2)));
    this.closeBtn.addEventListener('click', () => {
      this.hint = null;
      if (this.current) this.dismissed.set(this.current.key, performance.now() + DISMISS_MS);
      this.current = null;
      this.shownAt = 0;
      setVisible(this.el, false);
    });
    this.text.addEventListener('click', () => this.act());
    // the folded tab: a click opens the line again
    this.tag.addEventListener('click', () => {
      this.openUntil = performance.now() + OPEN_MS;
      setClass(this.el, 'mini', false);
    });
    this.el.append(this.tag, this.icon, this.text, this.doBtn, this.closeBtn);
  }

  get advisorOn(): boolean {
    return this.on;
  }
  setAdvisor(on: boolean): void {
    this.on = on;
    save(ADVISOR_KEY, on ? 'on' : 'off');
    if (!on) setVisible(this.el, false);
  }
  /** A tutorial game (tutorial mode): no advisor or first-use hints; nothing is saved. */
  quiet(): void {
    this.quietMode = true;
    setVisible(this.el, false);
  }
  private quietMode = false;
  /** The guide explained this strike: its first-use hint is not needed any more (remembered). */
  seenStrike(id: StrikeId): void {
    this.hintQueue = this.hintQueue.filter((x) => x !== id);
    if (this.hint?.id === id) this.hint = null;
    if (this.hintsSeen.has(id)) return;
    this.hintsSeen.add(id);
    save(STRIKE_HINTS_KEY, [...this.hintsSeen].join(','));
  }

  /**
   * Shows the line for `key`: open for `ms` when it is new (`once`: only the first time this key ever shows), folded
   * into its tab otherwise, while a toast is up, or once the time is over (hover or focus keeps it open).
   */
  private present(key: string, ms: number, once: boolean): void {
    const now = performance.now();
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.openUntil = once && this.popped.has(key) ? 0 : now + ms;
      this.popped.add(key);
    }
    if (this.el.matches(':hover') || this.el.contains(document.activeElement)) this.openUntil = Math.max(this.openUntil, now + 1500);
    setClass(this.el, 'mini', this.toastUp || now > this.openUntil);
    setVisible(this.el, true);
  }

  // ------------------------------------------------------------------------------------------ advisor

  update(s: GameState, me: Player, strikes?: StrikeBar): void {
    if (this.quietMode || !me.alive || s.phase === 'over') {
      setVisible(this.el, false);
      return;
    }
    for (const id of strikes?.takeNewlyReady() ?? []) if (!this.hintsSeen.has(id) && !this.hintQueue.includes(id)) this.hintQueue.push(id);
    if (this.suppressed || !this.on || s.phase !== 'playing' || gameSeconds(s) < 8) {
      setVisible(this.el, false);
      return;
    }
    const now = performance.now();
    if (this.strikeHint(now, strikes)) return;
    const list = adviceFor(s, me.id).filter((x) => (this.dismissed.get(x.key) ?? 0) < now);
    if (now - this.units.at > ARTILLERY_CHECK_MS) this.units = { at: now, list: unitAdvice(s, me).filter((x) => !this.unitSeen.has(x.key)) };
    const fresh = this.units.list.find((x) => !this.unitSeen.has(x.key));
    if (fresh) {
      // a unit hint goes first, once ever
      this.unitSeen.add(fresh.key);
      save(UNIT_HINTS_KEY, [...this.unitSeen].join(','));
      this.units.list = this.units.list.filter((x) => x !== fresh);
      this.current = fresh;
      this.shownAt = now;
      this.idx = 0;
    }
    if (this.current && this.current.key.startsWith('unit-') && now - this.shownAt < CYCLE_MS * 2) list.unshift(this.current);
    if (now - this.art.at > ARTILLERY_CHECK_MS) this.art = { at: now, s: artilleryAdvice(s, me) };
    const art = this.art.s;
    if (art && (this.dismissed.get(art.key) ?? 0) < now && !list.some((x) => x.key === 'build-arsenal')) list.splice(Math.min(1, list.length), 0, art);
    if (now - this.ways.at > ARTILLERY_CHECK_MS) this.ways = { at: now, s: waysToPlayAdvice(s, me) };
    const way = this.ways.s;
    if (way && (this.dismissed.get(way.key) ?? 0) < now && !list.some((x) => x.key === way.key)) list.push(way);
    if (now - this.pillar.at > ARTILLERY_CHECK_MS) this.pillar = { at: now, s: pillarAdvice(s, me) };
    const pil = this.pillar.s;
    if (pil && (this.dismissed.get(pil.key) ?? 0) < now && !list.some((x) => x.key === pil.key)) list.splice(Math.min(2, list.length), 0, pil);
    if (!list.length) {
      this.current = null;
      setVisible(this.el, false);
      return;
    }
    // keep the shown one while it is still suggested and its time is not up, else move on
    const stillThere = this.current && list.find((x) => x.key === this.current!.key);
    if (!stillThere || now - this.shownAt > CYCLE_MS) {
      this.idx = stillThere ? (this.idx + 1) % Math.min(3, list.length) : 0;
      this.current = list[Math.min(this.idx, list.length - 1)];
      this.shownAt = now;
    } else this.current = stillThere;
    const c = this.current;
    setText(this.tag, 'Advisor');
    this.icon.innerHTML = c.unit ? lineIcon(c.unit === 'warship' ? 'warship' : 'plane', 16) : c.building ? worldGlyph(c.building, 16) : c.mode ? worldGlyph(c.mode, 16) : lineIcon(c.drawer === 'research' ? 'science' : c.drawer === 'diplomacy' ? 'diplomacy' : c.tile !== undefined ? 'target' : 'info', 16);
    setText(this.text, c.text);
    const label = c.unit
      ? `Build ${UNITS[c.unit].name}`
      : c.building
      ? `Build ${BUILDINGS[c.building].name}`
      : c.mode === 'barrage'
        ? 'Aim barrage'
        : c.mode === 'paradrop'
          ? 'Aim drop'
          : c.drawer === 'research'
            ? 'Research'
            : c.drawer === 'army'
              ? 'Army'
              : c.drawer === 'forces'
              ? 'Forces'
              : c.drawer === 'diplomacy'
                ? 'Diplomacy'
                : c.tile !== undefined
                  ? 'Show'
                  : '';
    setText(this.doBtn, label);
    setVisible(this.doBtn, label !== '');
    this.present(c.key, OPEN_MS, true);
  }

  /** Shows the first-use hint of a strike that just became ready (once per strike, ever); true while one shows. */
  private strikeHint(now: number, strikes?: StrikeBar): boolean {
    if (!strikes) return false;
    const h = this.hint;
    if (h && (now > h.until || strikeOfMode(this.ctx.ui.mode) === h.id || strikes.statusOf(h.id)?.state !== 'ready')) this.hint = null;
    if (!this.hint) {
      const id = this.hintQueue.shift();
      if (!id || strikes.statusOf(id)?.state !== 'ready') return false;
      this.hint = { id, until: now + STRIKE_HINT_MS };
      this.hintsSeen.add(id);
      save(STRIKE_HINTS_KEY, [...this.hintsSeen].join(','));
    }
    const id = this.hint.id;
    this.current = null;
    setText(this.tag, 'New');
    this.icon.innerHTML = lineIcon(STRIKES[id].line, 16);
    setText(this.text, STRIKE_HINTS[id]);
    setText(this.doBtn, AIM_LABEL[id]);
    setVisible(this.doBtn, true);
    this.present(`hint${id}`, OPEN_MS, false);
    this.strikes = strikes;
    return true;
  }
  private strikes: StrikeBar | null = null;

  private act(): void {
    if (this.hint && this.strikes) {
      const id = this.hint.id;
      this.hint = null;
      this.strikes.aim(id);
      return;
    }
    const c = this.current;
    if (!c) return;
    if (c.unit) {
      const s = this.ctx.state();
      const me = this.ctx.me();
      if (!s || !me) return;
      if (c.unit === 'warship') {
        const no = enterWarshipSpawnMode(this.ctx.ui, s, me);
        this.ctx.toast(no ? `Warship: ${no}` : 'Warship: click a water tile near your port. Esc cancels.', no ? 'info' : 'good');
        return;
      }
      const why = buildUnit(s, me, (a) => this.ctx.dispatch(a), c.unit, { x: this.ctx.camera.x, y: this.ctx.camera.y });
      this.ctx.toast(why ? `${UNITS[c.unit].name}: ${why}` : `${UNITS[c.unit].name} built. Open Forces (Y) to command it.`, why ? 'info' : 'good');
      this.ctx.refreshSoon();
    } else if (c.building) {
      this.ctx.ui.mode = { kind: 'build', building: c.building };
      if (c.tile !== undefined) this.ctx.focusTile(c.tile, false);
    } else if (c.mode) {
      this.ctx.ui.mode = c.mode === 'barrage' ? { kind: 'barrage' } : { kind: 'paradrop', airfield: -1 };
      if (c.tile !== undefined) this.ctx.focusTile(c.tile, false);
    } else if (c.drawer) this.ctx.openDrawer(c.drawer);
    else if (c.tile !== undefined) this.ctx.focusTile(c.tile, true);
  }
}
