// DOM HUD: top bar, build bar, attack panel, research modal, diplomacy/leaderboard, event log, tooltips, toasts,
// context menu, spawn banner, game-over screen.
//
// The DOM is built once. update() runs every frame but only does cheap work there (toast, banners, tooltip
// position, context menu open/close); texts, lists and enabled states refresh at ~5 Hz through "updater"
// closures registered by each section. Lists (attacks, nations, log) are keyed and only rebuilt when they change.
import {
  buildCostAt,
  buildingAt,
  buildingCost,
  buildingsOf,
  canBuild,
  countBuildings,
  fortMultiplierAt,
  hasIntel,
} from '../sim/buildings';
import { attacksOf, estimateAttack, supplyEfficiency } from '../sim/combat';
import {
  AIRCRAFT_MAX_PER_AIRFIELD,
  BUILDINGS,
  BUILDING_ORDER,
  CITY_MAX_LEVEL,
  RESOURCE_NAMES,
  SPAWN_SECONDS,
  TECHS,
  TECH_ORDER,
  TERRAIN,
  TICKS_PER_SECOND,
  UNITS,
} from '../sim/config';
import { areAllied, isTraitor } from '../sim/diplomacy';
import { armyTotal, convertCost, hasOilShortage, population } from '../sim/economy';
import { canResearch, hasTech } from '../sim/tech';
import { isWater } from '../sim/types';
import type { Building, BuildingType, GameEvent, GameState, Player, TechId, TerrainId, Troops } from '../sim/types';
import { allScores } from '../sim/victory';
import type { Camera } from './camera';
import { isAttackable, sendTransport, SPEEDS, troopSum, troopsToSend } from './input';
import { button, el, howToPlayContent, rgbCss, setText } from './menu';
import { formatCount } from './renderer';
import type { Dispatch, UiState } from './uiState';

const SLOW_MS = 200; // ~5 Hz refresh of texts and lists
const TOAST_MS = 3000;
const LOG_SIZE = 8;
const GIFT_GOLD = 200;
const TROOP_COLORS = { infantry: '#8fc06a', armor: '#e3a33b', artillery: '#e0675e' } as const;

type Shape = 'circle' | 'square' | 'diamond';
/** Same glyphs as the map icons (renderer.ts): economy circle, military square, strategic diamond. */
const GLYPHS: Record<BuildingType, { label: string; shape: Shape; fill: string }> = {
  city: { label: 'C', shape: 'circle', fill: '#f3ecd8' },
  farm: { label: 'Fa', shape: 'circle', fill: '#c9e08a' },
  market: { label: '$', shape: 'circle', fill: '#f2d36b' },
  mine: { label: 'Mi', shape: 'circle', fill: '#b4b7bf' },
  oilWell: { label: 'Oi', shape: 'circle', fill: '#8a8178' },
  barracks: { label: 'Ba', shape: 'square', fill: '#d9b48a' },
  factory: { label: 'Fy', shape: 'square', fill: '#c0a080' },
  arsenal: { label: 'Ar', shape: 'square', fill: '#d79a7a' },
  fort: { label: 'Ft', shape: 'square', fill: '#a9b3c2' },
  supplyDepot: { label: 'Sd', shape: 'square', fill: '#b9d1a6' },
  watchtower: { label: 'W', shape: 'square', fill: '#d4e2ee' },
  port: { label: 'Po', shape: 'circle', fill: '#9cc6ea' },
  lab: { label: 'Rl', shape: 'circle', fill: '#c6b3ee' },
  hospital: { label: '+', shape: 'circle', fill: '#f2f2f2' },
  airfield: { label: 'Af', shape: 'diamond', fill: '#b6d7f0' },
  sam: { label: 'SA', shape: 'diamond', fill: '#e6a6a6' },
  silo: { label: 'Si', shape: 'diamond', fill: '#eec07a' },
};

// Small inline SVG icons (16x16).
const ICONS = {
  gold: '<circle cx="8" cy="8" r="6.5" fill="#f2c94c"/><circle cx="8" cy="8" r="4" fill="none" stroke="#a8841c" stroke-width="1.3"/>',
  iron: '<path d="M1.5 12.5 4.5 5h7l3 7.5z" fill="#9aa5b5"/><path d="M4.5 5h7l-1 2.6h-5z" fill="#d3dae5"/>',
  oil: '<path d="M8 1.5S3 7.4 3 10.4a5 5 0 0 0 10 0C13 7.4 8 1.5 8 1.5z" fill="#c58b55"/><path d="M6 10.5a2 2 0 0 0 2 2" stroke="#f1d2b0" stroke-width="1.2" fill="none" stroke-linecap="round"/>',
  science: '<path d="M6.2 1.8v4.3L2.6 12.9a1.3 1.3 0 0 0 1.1 1.9h8.6a1.3 1.3 0 0 0 1.1-1.9L9.8 6.1V1.8" fill="none" stroke="#8fb3ff" stroke-width="1.4" stroke-linejoin="round"/><path d="M4.4 10h7.2l1.4 3.2H3z" fill="#8fb3ff"/><path d="M5.2 1.8h5.6" stroke="#8fb3ff" stroke-width="1.4" stroke-linecap="round"/>',
  pop: '<circle cx="8" cy="5" r="3" fill="#cfd6e4"/><path d="M2.5 14.5c0-3.1 2.5-5.2 5.5-5.2s5.5 2.1 5.5 5.2z" fill="#cfd6e4"/>',
  army: '<path d="M8 1.5l5.5 2v4.6c0 3.2-2.4 5.6-5.5 6.9-3.1-1.3-5.5-3.7-5.5-6.9V3.5z" fill="#e47a6c"/><path d="M8 4v8" stroke="#fff" stroke-opacity=".55" stroke-width="1.2"/>',
  clock: '<circle cx="8" cy="8" r="6.3" fill="none" stroke="#cfd6e4" stroke-width="1.4"/><path d="M8 4.3V8l2.6 1.7" fill="none" stroke="#cfd6e4" stroke-width="1.4" stroke-linecap="round"/>',
  pause: '<rect x="4" y="3" width="3" height="10" rx=".8" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx=".8" fill="currentColor"/>',
  play: '<path d="M5 3v10l8-5z" fill="currentColor"/>',
  exit: '<path d="M6.5 3H3.5v10h3M10 5l3 3-3 3M13 8H6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  swords: '<path d="M2.5 2.5l7 7M13.5 2.5l-7 7M9 11l2 2M7 11l-2 2M11.5 9.5l2.5 2.5-2 2-2.5-2.5M4.5 9.5 2 12l2 2 2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};
function icon(name: keyof typeof ICONS, cls = 'ic'): HTMLElement {
  const s = el('span', cls);
  s.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
}
function glyph(type: BuildingType, cls = 'glyph'): HTMLElement {
  const g = GLYPHS[type];
  const e = el('span', `${cls} ${g.shape}`);
  const inner = el('span', 'glyph-in', g.label);
  e.style.setProperty('--fill', g.fill);
  e.append(inner);
  return e;
}

function fmtRate(v: number): string {
  const a = Math.abs(v);
  const s = a < 10 ? a.toFixed(1) : formatCount(a);
  return (v < -0.05 ? '-' : '+') + s + '/s';
}
function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(r).padStart(2, '0');
}
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
function costText(gold: number, iron: number): string {
  return `${formatCount(gold)} gold` + (iron > 0 ? ` + ${formatCount(iron)} iron` : '');
}
function setVisible(e: HTMLElement, v: boolean): void {
  if (e.classList.contains('hidden') === v) e.classList.toggle('hidden', !v);
}
function setDisabled(b: HTMLButtonElement | HTMLInputElement, d: boolean): void {
  if (b.disabled !== d) b.disabled = d;
}
function setTip(e: HTMLElement, tip: string): void {
  if (e.dataset.tip !== tip) e.dataset.tip = tip;
}
function slider(min: number, max: number, step: number, cls = 'range'): HTMLInputElement {
  const r = el('input', cls);
  r.type = 'range';
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  return r;
}
/** Sets a slider's value from state unless the user is dragging it. */
function syncSlider(r: HTMLInputElement, v: number): void {
  if (document.activeElement === r) return;
  const s = String(v);
  if (r.value !== s) r.value = s;
}
/** Mini stacked bar of the three troop types. */
function troopBar(): { el: HTMLElement; set: (t: Troops) => void } {
  const bar = el('div', 'tbar');
  const parts = (['infantry', 'armor', 'artillery'] as const).map((k) => {
    const p = el('span');
    p.style.background = TROOP_COLORS[k];
    bar.append(p);
    return p;
  });
  return {
    el: bar,
    set: (t) => {
      const sum = troopSum(t) || 1;
      parts[0].style.width = pct(t.infantry / sum);
      parts[1].style.width = pct(t.armor / sum);
      parts[2].style.width = pct(t.artillery / sum);
    },
  };
}
function troopSplit(t: Troops): string {
  return `${formatCount(t.infantry)} / ${formatCount(t.armor)} / ${formatCount(t.artillery)}`;
}

interface Panel {
  root: HTMLElement;
  body: HTMLElement;
}

interface NationRow {
  root: HTMLElement;
  name: HTMLElement;
  tiles: HTMLElement;
  army: HTMLElement;
  rel: HTMLElement;
  actions: HTMLElement;
  ally: HTMLButtonElement;
  accept: HTMLButtonElement;
  decline: HTMLButtonElement;
  brk: HTMLButtonElement;
  gift: HTMLButtonElement;
  embargo: HTMLButtonElement;
}

interface AttackRow {
  root: HTMLElement;
  target: HTMLElement;
  troops: HTMLElement;
  progress: HTMLElement;
}

interface MenuItem {
  label: string;
  hint?: string;
  disabled?: string; // reason when disabled
  danger?: boolean;
  submenu?: () => MenuItem[];
  run?: () => void;
}

/** Build bar labels that fit the narrow buttons (full names are in the tooltip). */
const SHORT_NAMES: Partial<Record<BuildingType, string>> = {
  supplyDepot: 'Depot',
  watchtower: 'Tower',
  lab: 'Lab',
  silo: 'Silo',
  sam: 'SAM',
};

export class Hud {
  /** Set by main: leave to the menu / start a new game with the same settings. */
  onMenu: () => void = () => {};
  onPlayAgain: () => void = () => {};

  private el: HTMLElement;
  private state: GameState | null = null;
  private lastSlow = -Infinity;
  private slow: ((s: GameState, me: Player) => void)[] = [];
  private mouse = { x: 0, y: 0 };
  private ac = new AbortController();

  // overlays
  private tip!: HTMLElement;
  private tipTarget: HTMLElement | null = null;
  private tooltip!: HTMLElement;
  private tooltipKey = '';
  private toast!: HTMLElement;
  private banner!: HTMLElement;
  private ctx!: HTMLElement;
  private ctxOpen: UiState['contextMenu'] = null;
  private research!: HTMLElement;
  private researchUpd: ((s: GameState, me: Player) => void)[] = [];
  private help!: HTMLElement;
  private gameOver!: HTMLElement;
  private gameOverShown = false;

  // build bar
  private buildBtns = new Map<BuildingType, HTMLButtonElement>();
  // lists
  private attackList!: HTMLElement;
  private attackRows = new Map<number, AttackRow>();
  private attackEmpty!: HTMLElement;
  private nationList!: HTMLElement;
  private nationRows = new Map<number, NationRow>();
  private nationOrder = '';
  private logList!: HTMLElement;
  private seenEvents = new WeakSet<GameEvent>();
  private logCount = 0;
  // selected building panel
  private selPanel!: Panel;
  private selKey = '';
  private selUpd: ((s: GameState, me: Player, b: Building) => void)[] = [];
  // top bar dynamic bits
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn!: HTMLButtonElement;
  private pauseShown: boolean | null = null;
  private customBox!: HTMLElement;
  private mixBtns: HTMLButtonElement[] = [];

  constructor(public root: HTMLElement, public ui: UiState, public dispatch: Dispatch, public camera: Camera) {
    this.el = el('div', 'hud');
    root.append(this.el);
    this.buildTopBar();
    const left = el('div', 'col col-left');
    const right = el('div', 'col col-right');
    this.el.append(left, right);
    left.append(this.buildAttackPanel().root, this.buildMixPanel().root, this.buildLogPanel().root);
    this.selPanel = this.panel('Building', 'sel-panel');
    this.selPanel.root.classList.add('hidden');
    right.append(this.selPanel.root, this.buildNationsPanel().root);
    this.buildBuildBar();
    this.buildOverlays();

    const opts = { signal: this.ac.signal };
    window.addEventListener(
      'pointermove',
      (e) => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
      },
      opts,
    );
    // Hover tips for any HUD element with data-tip.
    this.el.addEventListener('pointerover', (e) => this.onTipOver(e.target), opts);
    this.el.addEventListener('pointerleave', () => this.hideTip(), opts);
    // Clicks outside the context menu close it.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.ui.contextMenu && !this.ctx.contains(e.target as Node)) this.ui.contextMenu = null;
      },
      { signal: this.ac.signal, capture: true },
    );
  }

  // ============================================================================================ frame update

  /** Called every frame; throttle expensive DOM updates internally (e.g. 5 Hz). */
  update(state: GameState): void {
    const now = performance.now();
    if (this.state !== state) {
      this.state = state;
      this.lastSlow = -Infinity;
    }
    const me = state.players[state.humanId];
    if (!me) return;
    this.drainEvents(state);
    this.updateFast(state, me, now);
    if (now - this.lastSlow >= SLOW_MS) {
      this.lastSlow = now;
      for (const f of this.slow) f(state, me);
      if (!this.research.classList.contains('hidden')) for (const f of this.researchUpd) f(state, me);
      this.updateTooltipContent(state, me, true);
    }
  }

  openResearch(): void {
    const open = this.research.classList.contains('hidden');
    setVisible(this.research, open);
    if (open) {
      this.help.classList.add('hidden');
      this.lastSlow = -Infinity;
    }
  }
  toggleHelp(): void {
    const open = this.help.classList.contains('hidden');
    setVisible(this.help, open);
    if (open) this.research.classList.add('hidden');
  }
  /** Closes an open modal; true if one was open. */
  closeOverlay(): boolean {
    for (const m of [this.research, this.help]) {
      if (!m.classList.contains('hidden')) {
        m.classList.add('hidden');
        return true;
      }
    }
    return false;
  }
  destroy(): void {
    this.ac.abort();
    this.el.remove();
    this.state = null;
  }

  private refreshSoon(): void {
    this.lastSlow = -Infinity;
  }
  private act(action: Parameters<Dispatch>[0]): boolean {
    const r = this.dispatch(action);
    this.refreshSoon();
    return r.ok;
  }

  private updateFast(state: GameState, me: Player, now: number): void {
    const ui = this.ui;
    // Toast
    if (ui.toast && ui.toast.until > now) {
      setText(this.toast, ui.toast.text);
      setVisible(this.toast, true);
    } else {
      if (ui.toast) ui.toast = null;
      setVisible(this.toast, false);
    }
    // Banner: spawn countdown, target mode hint, paused
    let banner = '';
    if (state.phase === 'spawn') {
      const t = Math.ceil(state.spawnLeft);
      banner = me.spawned
        ? `Starting position chosen · click again to move it · war begins in ${t}s`
        : `Click to choose your starting position · ${t}s`;
    } else if (state.phase === 'playing') {
      const m = ui.mode;
      if (m.kind === 'build') banner = `Build ${BUILDINGS[m.building].name}: click your land · Shift to place several · Esc to cancel`;
      else if (m.kind === 'transport') banner = 'Transport: click a coastal tile to land on · Esc to cancel';
      else if (m.kind === 'bomb') banner = 'Bomber: click a target · Esc to cancel';
      else if (m.kind === 'missile') banner = `${m.missile === 'atomBomb' ? 'Atom bomb' : 'Rocket'}: click a target · Esc to cancel`;
      else if (m.kind === 'moveWarship') banner = 'Warship: click water to patrol · Esc to cancel';
      else if (ui.paused) banner = 'Paused · Space to resume';
    }
    setText(this.banner, banner);
    setVisible(this.banner, banner !== '');
    this.banner.classList.toggle('spawn', state.phase === 'spawn');

    // Build bar selection, speed and pause buttons (cheap class toggles)
    const sel = ui.mode.kind === 'build' ? ui.mode.building : null;
    for (const [b, btn] of this.buildBtns) btn.classList.toggle('on', b === sel);
    this.speedBtns.forEach((b, k) => b.classList.toggle('on', SPEEDS[k] === ui.speed));
    if (this.pauseShown !== ui.paused) {
      this.pauseShown = ui.paused;
      this.pauseBtn.classList.toggle('on', ui.paused);
      this.pauseBtn.replaceChildren(icon(ui.paused ? 'play' : 'pause'));
    }

    // Context menu open/close
    if (ui.contextMenu !== this.ctxOpen) {
      this.ctxOpen = ui.contextMenu;
      if (ui.contextMenu) this.openContextMenu(state, me, ui.contextMenu);
      else setVisible(this.ctx, false);
    }

    // Hover tooltip
    this.updateTooltipContent(state, me, false);
    if (!this.tooltip.classList.contains('hidden')) this.place(this.tooltip, this.mouse.x + 18, this.mouse.y + 18);

    // Game over
    if (state.phase === 'over' && !this.gameOverShown) this.showGameOver(state, me);
  }

  /** Positions a floating element near (x, y), flipped to stay inside the window. */
  private place(e: HTMLElement, x: number, y: number): void {
    const w = e.offsetWidth;
    const h = e.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let px = x;
    let py = y;
    if (px + w > W - 6) px = Math.max(6, x - w - 30);
    if (py + h > H - 6) py = Math.max(6, y - h - 30);
    e.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  }

  // ============================================================================================ layout helpers

  private panel(title: string, cls = '', collapsible = true): Panel {
    const root = el('section', 'panel ' + cls);
    const head = el('header', 'panel-head');
    const t = el('h4', '', title);
    head.append(t);
    const body = el('div', 'panel-body');
    if (collapsible) {
      const chev = el('span', 'chev', '▾');
      head.append(chev);
      head.classList.add('clickable');
      head.addEventListener('click', () => root.classList.toggle('collapsed'));
    }
    root.append(head, body);
    return { root, body };
  }

  // ============================================================================================ top bar

  private buildTopBar(): void {
    const bar = el('div', 'topbar');
    const left = el('div', 'tb-group');
    const right = el('div', 'tb-group tb-right');
    bar.append(left, right);
    this.el.append(bar);

    const res = (name: 'gold' | 'iron' | 'oil' | 'science', label: string, get: (p: Player) => number, rate: (p: Player) => number) => {
      const box = el('div', 'stat');
      const v = el('span', 'stat-v');
      const r = el('span', 'stat-r');
      const txt = el('div', 'stat-txt');
      txt.append(v, r);
      box.append(icon(name), txt);
      box.dataset.tip = label;
      left.append(box);
      this.slow.push((_s, me) => {
        setText(v, formatCount(Math.floor(get(me))));
        const rv = rate(me);
        setText(r, fmtRate(rv));
        r.classList.toggle('neg', rv < -0.05);
      });
    };
    res('gold', 'Gold: workers pay taxes; markets add more. Buildings, research and units cost gold.', (p) => p.gold, (p) => p.income.gold);
    res('iron', 'Iron: from Mines next to iron deposits. Armor, artillery and military buildings need it.', (p) => p.iron, (p) => p.income.iron);
    res('oil', 'Oil: from Oil Wells next to oil deposits. Armor and aircraft burn it; without oil armor fights at 50%.', (p) => p.oil, (p) => p.income.oil);
    res(
      'science',
      'Science: spent on research (T). Research Labs add more.',
      (p) => (p.researching ? p.researchProgress : p.science),
      (p) => p.income.science,
    );

    // Population
    const pop = el('div', 'stat wide');
    const pv = el('span', 'stat-v');
    const pr = el('span', 'stat-r');
    const ptxt = el('div', 'stat-txt');
    ptxt.append(pv, pr);
    pop.append(icon('pop'), ptxt);
    pop.dataset.tip = 'Population / maximum. More land and cities raise the maximum.';
    left.append(el('span', 'sep'), pop);
    this.slow.push((_s, me) => {
      setText(pv, me.maxPop > 0 ? `${formatCount(population(me))} / ${formatCount(me.maxPop)}` : formatCount(population(me)));
      setText(pr, fmtRate(me.income.pop));
    });

    // Army with split
    const army = el('div', 'stat wide army');
    const av = el('span', 'stat-v');
    const tb = troopBar();
    const as = el('span', 'stat-r');
    const atxt = el('div', 'stat-txt');
    atxt.append(av, tb.el, as);
    army.append(icon('army'), atxt);
    left.append(army);
    this.slow.push((_s, me) => {
      setText(av, formatCount(armyTotal(me.troops)));
      tb.set(me.troops);
      setText(as, troopSplit(me.troops));
      setTip(army, `Army at home: ${Math.round(me.troops.infantry)} infantry, ${Math.round(me.troops.armor)} armor, ${Math.round(me.troops.artillery)} artillery`);
    });

    // Army ratio slider
    const ratio = el('div', 'stat ratio');
    const rl = el('span', 'stat-label');
    const rr = slider(10, 90, 1);
    rr.dataset.test = 'army-ratio';
    rr.addEventListener('input', () => {
      this.dispatch({ type: 'setArmyRatio', value: Number(rr.value) / 100 });
      setText(rl, `Army ratio ${rr.value}%`);
    });
    ratio.append(rl, rr);
    ratio.dataset.tip = 'Share of your population kept as army. More army = less gold. Lowering it slowly demobilises infantry.';
    left.append(el('span', 'sep'), ratio);
    this.slow.push((_s, me) => {
      const v = Math.round(me.armyRatio * 100);
      syncSlider(rr, v);
      if (document.activeElement !== rr) setText(rl, `Army ratio ${v}%`);
    });

    // Right: research shortcut, clock, speed, pause, help, menu
    const rb = el('button', 'btn research-btn');
    rb.type = 'button';
    rb.append(icon('science'));
    const rbt = el('span', 'rb-text', 'Research');
    const rbp = el('span', 'rb-prog');
    rb.append(rbt, rbp);
    rb.addEventListener('click', () => this.openResearch());
    rb.dataset.tip = 'Research tree (T)';
    right.append(rb);
    this.slow.push((_s, me) => {
      if (me.researching) {
        const info = TECHS[me.researching];
        setText(rbt, info.name);
        rbp.style.width = pct(Math.min(1, me.researchProgress / info.science));
      } else {
        setText(rbt, 'Research');
        rbp.style.width = '0%';
      }
      rb.classList.toggle('idle', !me.researching);
    });

    const clock = el('div', 'clock');
    clock.append(icon('clock'));
    const ct = el('span', 'clock-t');
    clock.append(ct);
    right.append(clock);
    this.slow.push((s) => {
      const t = s.tick / TICKS_PER_SECOND - SPAWN_SECONDS;
      const limit = s.settings.timeLimit;
      setText(ct, s.phase === 'spawn' ? '0:00' : limit > 0 ? `${fmtTime(t)} / ${fmtTime(limit)}` : fmtTime(t));
    });

    const speed = el('div', 'seg small');
    this.pauseBtn = button('', 'icon-btn', () => (this.ui.paused = !this.ui.paused));
    this.pauseBtn.dataset.tip = 'Pause (Space)';
    this.pauseBtn.dataset.test = 'pause';
    speed.append(this.pauseBtn);
    for (const s of SPEEDS) {
      const b = button(`x${s}`, '', () => {
        this.ui.speed = s;
        this.ui.paused = false;
      });
      b.dataset.tip = 'Game speed (+ / -)';
      this.speedBtns.push(b);
      speed.append(b);
    }
    right.append(speed);

    const help = button('?', 'icon-btn', () => this.toggleHelp());
    help.dataset.tip = 'How to play (?)';
    let confirmUntil = 0;
    const exit = button('', 'icon-btn', () => {
      const now = performance.now();
      if (now < confirmUntil || this.state?.phase === 'over') {
        this.onMenu();
        return;
      }
      confirmUntil = now + 2500;
      this.ui.toast = { text: 'Click again to leave this game', until: confirmUntil };
    });
    exit.append(icon('exit'));
    exit.dataset.tip = 'Leave to the main menu';
    right.append(help, exit);
  }

  // ============================================================================================ attack panel

  private buildAttackPanel(): Panel {
    const p = this.panel('Attack', 'attack-panel');
    const b = p.body;
    const ui = this.ui;

    // Share slider + preview
    const shareRow = el('div', 'row');
    const shareLabel = el('span', 'lbl', 'Send');
    const share = slider(1, 100, 1);
    share.dataset.test = 'attack-share';
    const shareVal = el('span', 'val');
    share.addEventListener('input', () => {
      ui.attackShare = Number(share.value) / 100;
      setText(shareVal, `${share.value}%`);
    });
    shareRow.append(shareLabel, share, shareVal);
    shareRow.dataset.tip = 'Share of your army sent per attack or transport ( [ and ] )';
    const preview = el('div', 'preview');
    const pvTotal = el('span', 'pv-total');
    const pvBar = troopBar();
    const pvSplit = el('span', 'pv-split');
    preview.append(pvTotal, pvBar.el, pvSplit);
    b.append(shareRow, preview);

    // Composition
    const compRow = el('div', 'row');
    compRow.append(el('span', 'lbl', 'Mix'));
    const seg = el('div', 'seg small grow');
    for (const m of ['all', 'custom'] as const) {
      const btn = button(m === 'all' ? 'All types' : 'Custom', '', () => {
        ui.attackMixMode = m;
        this.refreshSoon();
      });
      btn.dataset.tip = m === 'all' ? 'Send every troop type in proportion to your army' : 'Choose the weight of each troop type';
      this.mixBtns.push(btn);
      seg.append(btn);
    }
    compRow.append(seg);
    b.append(compRow);
    this.customBox = el('div', 'custom-mix');
    const customSliders = (['infantry', 'armor', 'artillery'] as const).map((k) => {
      const r = el('div', 'row');
      const dot = el('span', 'dot');
      dot.style.background = TROOP_COLORS[k];
      const s = slider(0, 100, 5);
      s.addEventListener('input', () => {
        ui.customMix[k] = Number(s.value) / 100;
        this.refreshSoon();
      });
      const v = el('span', 'val');
      r.append(dot, el('span', 'lbl', k === 'infantry' ? 'Inf' : k === 'armor' ? 'Arm' : 'Art'), s, v);
      this.customBox.append(r);
      return { k, s, v };
    });
    b.append(this.customBox);

    // Active attacks
    const head = el('div', 'subhead', 'Active attacks');
    this.attackList = el('div', 'list attacks');
    this.attackEmpty = el('div', 'empty', 'No attacks. Click neutral or enemy land.');
    const transports = el('div', 'muted small');
    b.append(head, this.attackList, this.attackEmpty, transports);

    this.slow.push((s, me) => {
      const v = Math.round(ui.attackShare * 100);
      syncSlider(share, v);
      setText(shareVal, `${v}%`);
      const send = troopsToSend(me, ui);
      setText(pvTotal, formatCount(troopSum(send)) + ' troops');
      pvBar.set(send);
      setText(pvSplit, troopSplit(send));
      this.mixBtns[0].classList.toggle('on', ui.attackMixMode === 'all');
      this.mixBtns[1].classList.toggle('on', ui.attackMixMode === 'custom');
      setVisible(this.customBox, ui.attackMixMode === 'custom');
      const wsum = ui.customMix.infantry + ui.customMix.armor + ui.customMix.artillery || 1;
      for (const c of customSliders) {
        syncSlider(c.s, Math.round(ui.customMix[c.k] * 100));
        setText(c.v, pct(ui.customMix[c.k] / wsum));
      }
      this.updateAttackList(s, me);
      let ships = 0;
      for (const u of s.units) if (u.owner === me.id && u.type === 'transport') ships++;
      setText(transports, ships ? `Transports at sea: ${ships}` : '');
    });
    return p;
  }

  private updateAttackList(state: GameState, me: Player): void {
    const attacks = attacksOf(state, me.id);
    const ids = new Set(attacks.map((a) => a.id));
    for (const [id, row] of this.attackRows) {
      if (!ids.has(id)) {
        row.root.remove();
        this.attackRows.delete(id);
      }
    }
    for (const a of attacks) {
      let row = this.attackRows.get(a.id);
      if (!row) {
        const root = el('div', 'atk');
        const target = el('span', 'atk-target');
        const troops = el('span', 'atk-troops');
        const progress = el('span', 'atk-prog');
        const id = a.id;
        const ret = button('Retreat', 'tiny danger', () => this.act({ type: 'retreat', attackId: id }));
        ret.dataset.tip = 'Call the attack off: troops come home, 10% are lost';
        const centre = () => {
          const w = state.map.width;
          const cur = this.state?.attacks.find((x) => x.id === id);
          if (cur) this.camera.centerOn((cur.focusTile % w) + 0.5, ((cur.focusTile / w) | 0) + 0.5);
        };
        target.addEventListener('click', centre);
        const info = el('div', 'atk-info');
        info.append(troops, progress);
        root.append(target, info, ret);
        row = { root, target, troops, progress };
        this.attackRows.set(a.id, row);
        this.attackList.append(row.root);
      }
      const tp = state.players[a.target];
      setText(row.target, a.target === 0 ? 'Neutral land' : tp?.name ?? '?');
      row.target.style.setProperty('--c', a.target === 0 ? '#9aa3b2' : rgbCss(tp.color));
      setText(row.troops, `${formatCount(troopSum(a.troops))} troops`);
      setText(row.progress, `+${a.tilesTaken} tiles · lost ${formatCount(a.losses)}`);
    }
    setVisible(this.attackEmpty, attacks.length === 0);
  }

  // ============================================================================================ army mix

  private buildMixPanel(): Panel {
    const p = this.panel('Army mix', 'mix-panel');
    const b = p.body;
    const mk = (kind: 'armor' | 'artillery') => {
      const r = el('div', 'row');
      const dot = el('span', 'dot');
      dot.style.background = TROOP_COLORS[kind];
      const s = slider(0, 80, 5);
      s.dataset.test = `mix-${kind}`;
      const v = el('span', 'val wide');
      r.append(dot, el('span', 'lbl', kind === 'armor' ? 'Armor' : 'Artillery'), s, v);
      r.dataset.tip =
        kind === 'armor'
          ? 'Target armor share. Factories convert infantry into armor (gold + iron each); armor burns oil.'
          : 'Target artillery share. Arsenals convert infantry into artillery (gold + iron each).';
      b.append(r);
      return { s, v };
    };
    const armor = mk('armor');
    const art = mk('artillery');
    const send = () =>
      this.act({ type: 'setArmyMix', armor: Number(armor.s.value) / 100, artillery: Number(art.s.value) / 100 });
    armor.s.addEventListener('input', send);
    art.s.addEventListener('input', send);
    const counts = el('div', 'muted small');
    const status = el('div', 'status');
    b.append(counts, status);

    this.slow.push((s, me) => {
      syncSlider(armor.s, Math.round(me.armyMix.armor * 100));
      syncSlider(art.s, Math.round(me.armyMix.artillery * 100));
      const army = armyTotal(me.troops) || 1;
      setText(armor.v, `${pct(me.troops.armor / army)} → ${pct(me.armyMix.armor)}`);
      setText(art.v, `${pct(me.troops.artillery / army)} → ${pct(me.armyMix.artillery)}`);
      const fac = countBuildings(s, me.id, 'factory');
      const ars = countBuildings(s, me.id, 'arsenal');
      setText(counts, `Factories ${fac} · Arsenals ${ars}`);

      // Conversion status: what is happening or what is missing.
      const msgs: string[] = [];
      let cls = 'ok';
      const needArmor = me.armyMix.armor * army - me.troops.armor > 1;
      const needArt = me.armyMix.artillery * army - me.troops.artillery > 1;
      for (const [need, n, kind, bname] of [
        [needArmor, fac, 'armor', 'Factory'],
        [needArt, ars, 'artillery', 'Arsenal'],
      ] as const) {
        if (!need) continue;
        if (n === 0) {
          msgs.push(`Build ${/^[AEIOU]/.test(bname) ? 'an' : 'a'} ${bname} to make ${kind}`);
          cls = 'warn';
          continue;
        }
        const c = convertCost(me, kind);
        if (me.gold < c.gold || me.iron < c.iron) {
          msgs.push(`${kind[0].toUpperCase() + kind.slice(1)}: need ${me.iron < c.iron ? 'iron' : 'gold'}`);
          cls = 'warn';
        } else if (me.troops.infantry < 1) {
          msgs.push('No infantry to convert');
          cls = 'warn';
        } else msgs.push(`Converting to ${kind}…`);
      }
      if (hasOilShortage(s, me.id)) {
        msgs.push('Out of oil: armor fights at 50%');
        cls = 'bad';
      }
      setText(status, msgs.length ? msgs.join(' · ') : 'Mix target reached');
      status.className = 'status ' + cls;
    });
    return p;
  }

  // ============================================================================================ event log

  private buildLogPanel(): Panel {
    const p = this.panel('Events', 'log-panel');
    this.logList = el('div', 'list log');
    p.body.append(this.logList);
    return p;
  }

  private drainEvents(state: GameState): void {
    const evs = state.events;
    const h = state.humanId;
    // Walk back from the newest event to the first one already seen (the sim may drop old ones from the front).
    let k = evs.length - 1;
    while (k >= 0 && !this.seenEvents.has(evs[k])) k--;
    for (let i = k + 1; i < evs.length; i++) {
      const e = evs[i];
      this.seenEvents.add(e);
      if (e.players.length && !e.players.includes(h)) continue;
      this.addLog(state, e);
    }
  }

  private addLog(state: GameState, e: GameEvent): void {
    const row = el('div', `log-row k-${e.kind}`);
    const t = Math.max(0, e.tick / TICKS_PER_SECOND - SPAWN_SECONDS);
    row.append(el('span', 'log-t', fmtTime(t)), el('span', 'log-m', e.message));
    if (e.tile >= 0) {
      row.classList.add('clickable');
      const w = state.map.width;
      row.addEventListener('click', () => this.camera.centerOn((e.tile % w) + 0.5, ((e.tile / w) | 0) + 0.5));
      row.dataset.tip = 'Click to centre the map here';
    }
    this.logList.prepend(row);
    this.logCount++;
    while (this.logList.childElementCount > LOG_SIZE) this.logList.lastElementChild?.remove();
    if (e.kind === 'allianceRequest' || e.kind === 'capitalLost' || e.kind === 'nuke' || e.kind === 'researchDone') {
      this.ui.toast = { text: e.message, until: performance.now() + TOAST_MS };
    }
  }

  // ============================================================================================ nations

  private buildNationsPanel(): Panel {
    const p = this.panel('Nations', 'nations-panel');
    this.nationList = el('div', 'list nations');
    p.body.append(this.nationList);
    this.slow.push((s, me) => this.updateNations(s, me));
    return p;
  }

  private makeNationRow(id: number): NationRow {
    const root = el('div', 'nation');
    const top = el('div', 'n-top');
    const name = el('span', 'n-name');
    const tiles = el('span', 'n-tiles');
    const army = el('span', 'n-army');
    top.append(name, tiles, army);
    const bottom = el('div', 'n-bottom');
    const rel = el('span', 'n-rel');
    const actions = el('div', 'n-actions');
    const ally = button('Ally', 'tiny', () => this.act({ type: 'requestAlliance', to: id }));
    ally.dataset.tip = 'Ask for an alliance';
    const accept = button('Accept', 'tiny good', () => this.act({ type: 'answerAlliance', from: id, accept: true }));
    const decline = button('Decline', 'tiny', () => this.act({ type: 'answerAlliance', from: id, accept: false }));
    const brk = button('Break', 'tiny danger', () => this.act({ type: 'breakAlliance', with: id }));
    brk.dataset.tip = 'Break the alliance: you become a traitor for a while (weaker defence, everyone dislikes you)';
    const gift = button(`Gift ${GIFT_GOLD}`, 'tiny', () => this.act({ type: 'gift', to: id, gold: GIFT_GOLD, troops: 0 }));
    gift.dataset.tip = `Give ${GIFT_GOLD} gold: improves their opinion of you`;
    const embargo = button('Embargo', 'tiny', () => this.act({ type: 'toggleEmbargo', with: id }));
    actions.append(ally, accept, decline, brk, gift, embargo);
    bottom.append(rel, actions);
    root.append(top, bottom);
    top.addEventListener('click', () => {
      const s = this.state;
      const p = s?.players[id];
      if (s && p && p.capital >= 0) this.camera.centerOn((p.capital % s.map.width) + 0.5, ((p.capital / s.map.width) | 0) + 0.5);
    });
    top.dataset.tip = 'Click to centre on their capital';
    return { root, name, tiles, army, rel, actions, ally, accept, decline, brk, gift, embargo };
  }

  private updateNations(state: GameState, me: Player): void {
    const alive = state.players.filter((p) => p.id !== 0 && p.alive && p.spawned);
    alive.sort((a, b) => b.tiles - a.tiles || a.id - b.id);
    for (const [id, row] of this.nationRows) {
      if (!alive.some((p) => p.id === id)) {
        row.root.remove();
        this.nationRows.delete(id);
      }
    }
    const order = alive.map((p) => p.id).join(',');
    const land = Math.max(1, state.map.landTileCount);
    for (const p of alive) {
      let row = this.nationRows.get(p.id);
      if (!row) {
        row = this.makeNationRow(p.id);
        this.nationRows.set(p.id, row);
      }
      const isMe = p.id === me.id;
      row.root.style.setProperty('--c', rgbCss(p.color));
      row.root.classList.toggle('me', isMe);
      setText(row.name, isMe && p.name.trim().toLowerCase() !== 'you' ? `${p.name} (you)` : p.name);
      setText(row.tiles, `${((p.tiles / land) * 100).toFixed(1)}%`);
      const intel = hasIntel(state, me.id, p.id);
      setText(row.army, intel ? formatCount(armyTotal(p.troops)) : '?');
      setTip(row.army, intel ? `Army: ${troopSplit(p.troops)} (inf / arm / art)` : 'Unknown army: build a Watchtower near them');
      setVisible(row.actions, !isMe);
      let rel = '';
      let relCls = '';
      if (!isMe) {
        const allied = areAllied(state, me.id, p.id);
        const outReq = state.allianceRequests.some((r) => r.from === me.id && r.to === p.id);
        const inReq = state.allianceRequests.some((r) => r.from === p.id && r.to === me.id);
        const embargoed = me.embargoes.includes(p.id);
        if (allied) {
          const al = state.alliances.find((a) => (a.a === me.id && a.b === p.id) || (a.a === p.id && a.b === me.id));
          rel = al ? `Ally · ${fmtTime((al.expiresTick - state.tick) / TICKS_PER_SECOND)}` : 'Ally';
          relCls = 'ally';
        } else if (inReq) {
          rel = 'Wants alliance';
          relCls = 'req';
        } else if (outReq) {
          rel = 'Request sent';
          relCls = 'pending';
        } else if (state.attacks.some((a) => (a.attacker === me.id && a.target === p.id) || (a.attacker === p.id && a.target === me.id))) {
          rel = 'At war';
          relCls = 'war';
        }
        if (isTraitor(state, p.id)) {
          rel = rel ? `${rel} · Traitor` : 'Traitor';
          relCls += ' traitor';
        }
        setVisible(row.ally, !allied && !outReq && !inReq);
        setVisible(row.accept, inReq);
        setVisible(row.decline, inReq);
        setVisible(row.brk, allied);
        setDisabled(row.gift, me.gold < GIFT_GOLD);
        setText(row.embargo, embargoed ? 'Lift embargo' : 'Embargo');
        row.embargo.classList.toggle('on', embargoed);
        setTip(row.embargo, embargoed ? 'Allow trade ships with them again' : 'Stop trade ships between you and them');
      } else if (isTraitor(state, p.id)) {
        rel = 'Traitor';
        relCls = 'traitor';
      }
      setText(row.rel, rel);
      row.rel.className = 'n-rel ' + relCls;
    }
    if (order !== this.nationOrder) {
      this.nationOrder = order;
      for (const p of alive) this.nationList.append(this.nationRows.get(p.id)!.root);
    }
  }

  // ============================================================================================ build bar

  private buildBuildBar(): void {
    const bar = el('div', 'buildbar');
    this.el.append(bar);
    for (const type of BUILDING_ORDER) {
      const info = BUILDINGS[type];
      const b = el('button', 'bb');
      b.type = 'button';
      b.dataset.test = `build-${type}`;
      const hk = el('span', 'bb-key', info.hotkey);
      const name = el('span', 'bb-name', SHORT_NAMES[type] ?? info.name);
      const cost = el('span', 'bb-cost');
      const costGold = el('span', 'cg');
      const costIron = el('span', 'ci');
      cost.append(costGold, costIron);
      b.append(glyph(type), name, cost, hk);
      b.addEventListener('click', () => {
        const m = this.ui.mode;
        this.ui.mode = m.kind === 'build' && m.building === type ? { kind: 'none' } : { kind: 'build', building: type };
        this.ui.contextMenu = null;
      });
      this.buildBtns.set(type, b);
      bar.append(b);
      this.slow.push((s, me) => {
        const c = buildingCost(s, me.id, type);
        setText(costGold, formatCount(c.gold));
        setText(costIron, c.iron > 0 ? formatCount(c.iron) : '');
        let reason = '';
        if (info.tech && !hasTech(me, info.tech)) reason = `Needs research: ${TECHS[info.tech].name}`;
        else if (me.gold < c.gold) reason = `Not enough gold (${formatCount(c.gold)})`;
        else if (me.iron < c.iron) reason = `Not enough iron (${formatCount(c.iron)})`;
        b.classList.toggle('disabled', reason !== '');
        b.classList.toggle('locked', !!info.tech && !hasTech(me, info.tech));
        const owned = countBuildings(s, me.id, type, true);
        setTip(
          b,
          `${info.name} [${info.hotkey}]\n${info.description}\nCost ${formatCount(c.gold)} gold${c.iron ? `, ${formatCount(c.iron)} iron` : ''}` +
            ` · build ${info.buildTime}s · you own ${owned}` +
            (reason ? `\n⚠ ${reason}` : ''),
        );
      });
    }
  }

  // ============================================================================================ selected building

  private updateSelected(state: GameState, me: Player): void {
    const tile = this.ui.selectedTile;
    const b = tile >= 0 && tile < state.map.owner.length ? buildingAt(state, tile) : undefined;
    if (tile >= 0 && state.map.owner[tile] !== me.id) this.ui.selectedTile = -1;
    if (!b || b.owner !== me.id) {
      setVisible(this.selPanel.root, false);
      this.selKey = '';
      return;
    }
    const warships = state.units.filter((u) => u.owner === me.id && u.type === 'warship').map((u) => u.id);
    const key = `${b.id}|${b.type}|${b.level}|${b.buildLeft > 0}|${me.techs.length}|${b.type === 'port' ? warships.join(',') : ''}`;
    if (key !== this.selKey) {
      this.selKey = key;
      this.buildSelected(state, me, b, warships);
    }
    setVisible(this.selPanel.root, true);
    for (const f of this.selUpd) f(state, me, b);
  }

  private buildSelected(state: GameState, me: Player, b: Building, warships: number[]): void {
    const body = this.selPanel.body;
    body.replaceChildren();
    this.selUpd = [];
    const info = BUILDINGS[b.type];
    const tile = b.tile;
    const head = this.selPanel.root.querySelector('h4');
    if (head) head.textContent = b.type === 'city' ? `${info.name} · level ${b.level}` : info.name;

    const top = el('div', 'sel-top');
    top.append(glyph(b.type, 'glyph big'), el('div', 'sel-desc', info.description));
    body.append(top);

    // Construction / upgrade progress
    const prog = el('div', 'progress');
    const fill = el('span');
    prog.append(fill);
    const progText = el('div', 'muted small');
    body.append(prog, progText);
    this.selUpd.push((_s, _me, bb) => {
      const building = bb.buildLeft > 0;
      const upgrading = bb.type === 'city' && bb.buildLeft <= 0 && bb.cooldown > 0;
      setVisible(prog, building || upgrading);
      if (building) {
        fill.style.width = pct(1 - bb.buildLeft / info.buildTime);
        setText(progText, `Under construction · ${Math.ceil(bb.buildLeft)}s`);
      } else if (upgrading) {
        fill.style.width = pct(1 - bb.cooldown / info.buildTime);
        setText(progText, `Upgrading to level ${bb.level + 1} · ${Math.ceil(bb.cooldown)}s`);
      } else setText(progText, bb.hp < 1 ? `Damaged: ${pct(bb.hp)}` : '');
    });

    const actions = el('div', 'sel-actions');
    body.append(actions);
    const addBtn = (label: string, cls: string, run: () => void, check: (s: GameState, me: Player, bb: Building) => string) => {
      const btn = button(label, cls, run);
      actions.append(btn);
      this.selUpd.push((s, m, bb) => {
        const why = check(s, m, bb);
        setDisabled(btn, why !== '');
        setTip(btn, why);
      });
      return btn;
    };

    if (b.type === 'city' && b.level < CITY_MAX_LEVEL) {
      const c = buildCostAt(state, me.id, 'city', tile);
      addBtn(`Upgrade (${costText(c.gold, c.iron)})`, 'small primary', () => this.act({ type: 'build', building: 'city', tile }), (s, m) => {
        const r = canBuild(s, m.id, 'city', tile);
        return r.ok ? '' : r.reason ?? '';
      });
    }
    if (b.type === 'airfield') {
      const counts = el('div', 'counts');
      body.insertBefore(counts, actions);
      this.selUpd.push((_s, _m, bb) => setText(counts, `Bombers ${bb.bombers} · Fighters ${bb.fighters} (max ${AIRCRAFT_MAX_PER_AIRFIELD})`));
      for (const kind of ['bomber', 'fighter'] as const) {
        const u = UNITS[kind];
        addBtn(
          `+ ${u.name} (${costText(u.gold, u.iron)})`,
          'small',
          () => this.act({ type: 'buildAircraft', airfield: tile, kind }),
          (_s, m, bb) =>
            bb.buildLeft > 0 ? 'Under construction' : bb.bombers + bb.fighters >= AIRCRAFT_MAX_PER_AIRFIELD ? 'Airfield is full' : m.gold < u.gold ? 'Not enough gold' : m.iron < u.iron ? 'Not enough iron' : m.oil < u.oil ? 'Not enough oil' : '',
        );
      }
      addBtn('Bomb target…', 'small danger', () => (this.ui.mode = { kind: 'bomb', airfield: tile }), (_s, _m, bb) => (bb.bombers > 0 ? '' : 'No bombers here'));
    }
    if (b.type === 'silo') {
      const cd = el('div', 'counts');
      body.insertBefore(cd, actions);
      this.selUpd.push((_s, _m, bb) => setText(cd, bb.buildLeft > 0 ? '' : bb.cooldown > 0 ? `Reloading · ${Math.ceil(bb.cooldown)}s` : 'Ready to launch'));
      for (const kind of ['rocket', 'atomBomb'] as const) {
        const u = UNITS[kind];
        addBtn(
          `${u.name}… (${costText(u.gold, u.iron)})`,
          'small danger',
          () => (this.ui.mode = { kind: 'missile', silo: tile, missile: kind }),
          (_s, m, bb) =>
            u.tech && !hasTech(m, u.tech) ? `Needs research: ${TECHS[u.tech].name}` : bb.buildLeft > 0 ? 'Under construction' : bb.cooldown > 0 ? 'Reloading' : m.gold < u.gold ? 'Not enough gold' : m.iron < u.iron ? 'Not enough iron' : m.oil < u.oil ? 'Not enough oil' : '',
        );
      }
    }
    if (b.type === 'port') {
      const u = UNITS.warship;
      addBtn(
        `+ Warship (${costText(u.gold, u.iron)})`,
        'small',
        () => this.act({ type: 'buildWarship', port: tile }),
        (_s, m, bb) => (!hasTech(m, 'navigation') ? 'Needs research: Navigation' : bb.buildLeft > 0 ? 'Under construction' : m.gold < u.gold ? 'Not enough gold' : m.iron < u.iron ? 'Not enough iron' : ''),
      );
      addBtn('Launch transport…', 'small', () => (this.ui.mode = { kind: 'transport', from: tile }), (_s, _m, bb) => (bb.buildLeft > 0 ? 'Under construction' : ''));
      if (warships.length) {
        const list = el('div', 'ships');
        list.append(el('div', 'subhead', 'Warships'));
        warships.slice(0, 8).forEach((id, k) => {
          const r = el('div', 'ship-row');
          r.append(el('span', '', `Warship ${k + 1}`), button('Move…', 'tiny', () => (this.ui.mode = { kind: 'moveWarship', unitId: id })));
          list.append(r);
        });
        body.append(list);
      }
    }
    let confirmUntil = 0;
    const demo = button('Demolish', 'small ghost danger', () => {
      const now = performance.now();
      if (now > confirmUntil) {
        confirmUntil = now + 2500;
        demo.textContent = 'Confirm demolish';
        setTimeout(() => (demo.textContent = 'Demolish'), 2500);
        return;
      }
      if (this.act({ type: 'demolish', tile })) this.ui.selectedTile = -1;
    });
    demo.dataset.tip = 'Remove this building (25% refund)';
    actions.append(demo);
  }

  // ============================================================================================ overlays

  private buildOverlays(): void {
    this.toast = el('div', 'toast hidden');
    this.toast.dataset.test = 'toast';
    this.banner = el('div', 'banner hidden');
    this.tooltip = el('div', 'tooltip hidden');
    this.tip = el('div', 'tip hidden');
    this.ctx = el('div', 'ctxmenu hidden');
    this.ctx.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.append(this.banner, this.toast, this.tooltip, this.ctx);

    // Research modal
    this.research = el('div', 'modal hidden');
    const rCard = el('div', 'modal-card research');
    const rHead = el('div', 'modal-head');
    const rTitle = el('h2', '', 'Research');
    const rInfo = el('span', 'muted');
    rHead.append(rTitle, rInfo, button('×', 'icon-btn close', () => this.research.classList.add('hidden')));
    const tiers = el('div', 'tiers');
    rCard.append(rHead, tiers);
    this.research.append(rCard);
    this.research.addEventListener('pointerdown', (e) => {
      if (e.target === this.research) this.research.classList.add('hidden');
    });
    this.researchUpd.push((_s, me) => {
      const cur = me.researching ? TECHS[me.researching] : null;
      setText(rInfo, cur ? `Researching ${cur.name}: ${pct(me.researchProgress / cur.science)} · +${me.income.science.toFixed(1)} science/s` : `Science stored ${Math.floor(me.science)} · +${me.income.science.toFixed(1)}/s · pick a tech`);
    });
    const maxTier = Math.max(...TECH_ORDER.map((t) => TECHS[t].tier));
    for (let tier = 1; tier <= maxTier; tier++) {
      const col = el('div', 'tier');
      col.append(el('div', 'tier-title', `Tier ${tier}`));
      for (const t of TECH_ORDER.filter((x) => TECHS[x].tier === tier)) col.append(this.techCard(t));
      tiers.append(col);
    }

    // Help modal
    this.help = el('div', 'modal hidden');
    const hCard = el('div', 'modal-card help');
    const hHead = el('div', 'modal-head');
    hHead.append(el('h2', '', 'How to play'), button('×', 'icon-btn close', () => this.help.classList.add('hidden')));
    const hBody = el('div', 'modal-scroll');
    hBody.append(howToPlayContent());
    hCard.append(hHead, hBody);
    this.help.append(hCard);
    this.help.addEventListener('pointerdown', (e) => {
      if (e.target === this.help) this.help.classList.add('hidden');
    });

    this.gameOver = el('div', 'modal gameover hidden');
    this.el.append(this.research, this.help, this.gameOver, this.tip);
    this.slow.push((s, me) => this.updateSelected(s, me));
  }

  private techCard(t: TechId): HTMLElement {
    const info = TECHS[t];
    const card = el('button', 'tech');
    card.type = 'button';
    card.dataset.test = `tech-${t}`;
    const name = el('div', 'tech-name', info.name);
    const desc = el('div', 'tech-desc', info.description);
    const stateLine = el('div', 'tech-state');
    const bar = el('div', 'progress');
    const fill = el('span');
    bar.append(fill);
    card.append(name, desc, bar, stateLine);
    card.addEventListener('click', () => this.act({ type: 'research', tech: t }));
    this.researchUpd.push((s, me) => {
      const done = hasTech(me, t);
      const active = me.researching === t;
      const missing = info.requires.filter((r) => !hasTech(me, r));
      let cls = 'avail';
      let text = `${info.gold} gold · ${info.science} science`;
      if (done) {
        cls = 'done';
        text = '✓ Researched';
      } else if (active) {
        cls = 'active';
        text = `Researching · ${pct(me.researchProgress / info.science)}`;
      } else if (missing.length) {
        cls = 'locked';
        text = `Needs ${missing.map((r) => TECHS[r].name).join(' + ')}`;
      }
      card.className = 'tech ' + cls;
      setText(stateLine, text);
      setVisible(bar, active);
      if (active) fill.style.width = pct(me.researchProgress / info.science);
      const r = canResearch(s, me.id, t);
      card.disabled = done || active || !r.ok;
      setTip(card, r.ok ? (me.researching ? `Start ${info.name} (replaces ${TECHS[me.researching].name}; its progress is lost)` : `Start ${info.name}`) : r.reason ?? '');
    });
    return card;
  }

  // ---- data-tip hover tips ----
  private onTipOver(target: EventTarget | null): void {
    const t = target instanceof Element ? (target.closest('[data-tip]') as HTMLElement | null) : null;
    if (t === this.tipTarget) return;
    this.tipTarget = t;
    if (!t || !t.dataset.tip) {
      this.hideTip();
      return;
    }
    this.showTip(t);
  }
  private showTip(t: HTMLElement): void {
    this.tip.textContent = t.dataset.tip ?? '';
    setVisible(this.tip, true);
    const r = t.getBoundingClientRect();
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    let y = r.top - h - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(window.innerWidth - w - 6, x));
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  private hideTip(): void {
    this.tipTarget = null;
    setVisible(this.tip, false);
  }

  // ---- hover tooltip over the map ----
  private updateTooltipContent(state: GameState, me: Player, force: boolean): void {
    const tile = this.ui.hoverTile;
    const show = tile >= 0 && tile < state.map.owner.length && !this.ui.contextMenu && state.phase !== 'over';
    if (!show) {
      setVisible(this.tooltip, false);
      this.tooltipKey = '';
      return;
    }
    const key = `${tile}|${this.ui.attackShare}|${this.ui.attackMixMode}`;
    if (!force && key === this.tooltipKey) return;
    this.tooltipKey = key;
    const map = state.map;
    const terrainId = map.terrain[tile] as TerrainId;
    const terr = TERRAIN[terrainId];
    const lines: [string, string, string?][] = [];
    const owner = map.owner[tile];
    const op = state.players[owner];
    const res = map.resource[tile];
    const title = terr.name + (res ? ` · ${RESOURCE_NAMES[res]}` : '');
    if (!isWater(terrainId)) {
      lines.push(['Owner', owner ? op.name + (owner === me.id ? ' (you)' : '') : 'Unclaimed']);
      if (owner && owner !== me.id) {
        const intel = hasIntel(state, me.id, owner);
        lines.push(['Army', intel ? `${formatCount(armyTotal(op.troops))} (${troopSplit(op.troops)})` : '?']);
      }
      const b = buildingAt(state, tile);
      if (b) lines.push(['Building', BUILDINGS[b.type].name + (b.type === 'city' ? ` L${b.level}` : '') + (b.buildLeft > 0 ? ' (building)' : '')]);
      const def = terr.defense * (owner ? fortMultiplierAt(state, tile, owner) : 1);
      lines.push(['Defence', `x${def.toFixed(2)}`]);
      if (map.fallout[tile] > 0) lines.push(['Fallout', `${Math.ceil(map.fallout[tile])}s`, 'bad']);
      if (state.phase === 'playing') {
        if (owner === me.id) {
          lines.push(['Supply', pct(supplyEfficiency(state, me.id, tile))]);
        } else if (isAttackable(state, me.id, tile)) {
          const send = troopsToSend(me, this.ui);
          const est = estimateAttack(state, me.id, tile, send);
          if (est) {
            const n = troopSum(send);
            lines.push(['Attack', `≈${formatCount(est.lossPerTile)} lost/tile · ${est.tilesPerSecond.toFixed(1)} tiles/s`]);
            if (est.lossPerTile > 0) lines.push(['Can take', `≈${formatCount(n / est.lossPerTile)} tiles with ${formatCount(n)}`]);
          }
        } else if (owner && areAllied(state, me.id, owner)) lines.push(['Relation', 'Ally', 'good']);
      }
    }
    this.tooltip.replaceChildren();
    const h = el('div', 'tt-title', title);
    if (owner) h.style.setProperty('--c', rgbCss(op.color));
    this.tooltip.append(h);
    for (const [k, v, cls] of lines) {
      const r = el('div', 'tt-row' + (cls ? ' ' + cls : ''));
      r.append(el('span', 'tt-k', k), el('span', 'tt-v', v));
      this.tooltip.append(r);
    }
    setVisible(this.tooltip, true);
  }

  // ---- context menu ----
  private openContextMenu(state: GameState, me: Player, cm: { x: number; y: number; tile: number }): void {
    const items = this.contextItems(state, me, cm.tile);
    this.renderMenu(state, cm, items, null);
    setVisible(this.ctx, true);
    this.place(this.ctx, cm.x + 4, cm.y + 4);
  }

  private renderMenu(state: GameState, cm: { x: number; y: number; tile: number }, items: MenuItem[], back: MenuItem[] | null): void {
    const c = this.ctx;
    c.replaceChildren();
    const map = state.map;
    const owner = map.owner[cm.tile];
    const title = el('div', 'cm-title');
    const terr = TERRAIN[map.terrain[cm.tile] as TerrainId];
    title.append(el('span', '', terr.name), el('span', 'muted', owner ? state.players[owner].name : isWater(map.terrain[cm.tile]) ? '' : 'Unclaimed'));
    if (owner) title.style.setProperty('--c', rgbCss(state.players[owner].color));
    c.append(title);
    if (back) {
      const b = el('button', 'cm-item');
      b.type = 'button';
      b.textContent = '‹ Back';
      b.addEventListener('click', () => this.renderMenu(state, cm, back, null));
      c.append(b);
    }
    if (!items.length) c.append(el('div', 'cm-empty', 'Nothing to do here'));
    for (const it of items) {
      const b = el('button', 'cm-item' + (it.danger ? ' danger' : ''));
      b.type = 'button';
      b.append(el('span', 'cm-label', it.label));
      if (it.hint) b.append(el('span', 'cm-hint', it.hint));
      if (it.submenu) b.append(el('span', 'cm-hint', '›'));
      if (it.disabled) {
        b.disabled = true;
        b.dataset.tip = it.disabled;
        b.classList.add('disabled');
      }
      b.addEventListener('click', () => {
        if (it.disabled) return;
        if (it.submenu) {
          this.renderMenu(state, cm, it.submenu(), items);
          this.place(this.ctx, cm.x + 4, cm.y + 4);
          return;
        }
        this.ui.contextMenu = null;
        it.run?.();
        this.refreshSoon();
      });
      c.append(b);
    }
  }

  private contextItems(state: GameState, me: Player, tile: number): MenuItem[] {
    const map = state.map;
    const h = me.id;
    const owner = map.owner[tile];
    const water = isWater(map.terrain[tile]);
    const items: MenuItem[] = [];
    const w = map.width;
    const near = (a: number) => {
      const dx = (a % w) - (tile % w);
      const dy = ((a / w) | 0) - ((tile / w) | 0);
      return dx * dx + dy * dy;
    };

    if (!water && owner === h) {
      items.push({
        label: 'Build',
        submenu: () =>
          BUILDING_ORDER.map((type) => {
            const r = canBuild(state, h, type, tile);
            const c = buildCostAt(state, h, type, tile);
            return {
              label: BUILDINGS[type].name,
              hint: costText(c.gold, c.iron),
              disabled: r.ok ? undefined : r.reason ?? 'Cannot build here',
              run: () => this.act({ type: 'build', building: type, tile }),
            };
          }),
      });
      const b = buildingAt(state, tile);
      if (b && b.owner === h) {
        if (b.type === 'city' && b.level < CITY_MAX_LEVEL) {
          const r = canBuild(state, h, 'city', tile);
          const c = buildCostAt(state, h, 'city', tile);
          items.push({ label: `Upgrade city to level ${b.level + 1}`, hint: costText(c.gold, c.iron), disabled: r.ok ? undefined : r.reason, run: () => this.act({ type: 'build', building: 'city', tile }) });
        }
        items.push({ label: `${BUILDINGS[b.type].name} details`, run: () => (this.ui.selectedTile = tile) });
        items.push({ label: `Demolish ${BUILDINGS[b.type].name}`, danger: true, run: () => this.act({ type: 'demolish', tile }) });
      }
    }

    if (!water && owner !== h && isAttackable(state, h, tile)) {
      const send = troopsToSend(me, this.ui);
      items.push({
        label: owner ? `Attack ${state.players[owner].name}` : 'Expand here',
        hint: `${formatCount(troopSum(send))} troops`,
        run: () => this.act({ type: 'attack', tile, troops: troopsToSend(me, this.ui) }),
      });
      if (map.coastal[tile]) {
        items.push({ label: 'Launch transport here', hint: `${formatCount(troopSum(send))} troops`, run: () => sendTransport(state, this.ui, this.dispatch, -1, tile) });
      }
      if (owner) {
        const fields = buildingsOf(state, h, 'airfield').filter((b) => b.buildLeft <= 0 && b.bombers > 0);
        if (fields.length) {
          fields.sort((a, b) => near(a.tile) - near(b.tile));
          items.push({ label: 'Send bomber here', danger: true, run: () => this.act({ type: 'bomb', airfield: fields[0].tile, tile }) });
        }
      }
      const silos = owner ? buildingsOf(state, h, 'silo').filter((b) => b.buildLeft <= 0) : [];
      if (silos.length) {
        const ready = silos.filter((b) => b.cooldown <= 0).sort((a, b) => near(a.tile) - near(b.tile));
        for (const kind of ['rocket', 'atomBomb'] as const) {
          const u = UNITS[kind];
          if (u.tech && !hasTech(me, u.tech)) continue;
          items.push({
            label: `Launch ${u.name.toLowerCase()} here`,
            hint: costText(u.gold, u.iron),
            danger: true,
            disabled: ready.length ? undefined : 'All silos are reloading',
            run: () => this.act({ type: 'launchMissile', silo: ready[0].tile, kind, tile }),
          });
        }
      }
    }

    if (water) {
      const ships = state.units.filter((u) => u.owner === h && u.type === 'warship');
      if (ships.length) {
        ships.sort((a, b) => Math.hypot(a.x - (tile % w), a.y - ((tile / w) | 0)) - Math.hypot(b.x - (tile % w), b.y - ((tile / w) | 0)));
        items.push({ label: 'Move nearest warship here', run: () => this.act({ type: 'moveWarship', unitId: ships[0].id, tile }) });
      }
    }

    if (owner && owner !== h && state.players[owner].alive) {
      const o = owner;
      const name = state.players[o].name;
      const allied = areAllied(state, h, o);
      const inReq = state.allianceRequests.some((r) => r.from === o && r.to === h);
      const outReq = state.allianceRequests.some((r) => r.from === h && r.to === o);
      if (inReq) {
        items.push({ label: `Accept alliance with ${name}`, run: () => this.act({ type: 'answerAlliance', from: o, accept: true }) });
        items.push({ label: 'Decline alliance', run: () => this.act({ type: 'answerAlliance', from: o, accept: false }) });
      } else if (allied) {
        items.push({ label: `Break alliance with ${name}`, danger: true, run: () => this.act({ type: 'breakAlliance', with: o }) });
      } else {
        items.push({ label: `Request alliance with ${name}`, disabled: outReq ? 'Request already sent' : undefined, run: () => this.act({ type: 'requestAlliance', to: o }) });
      }
      items.push({ label: `Gift ${GIFT_GOLD} gold`, disabled: me.gold < GIFT_GOLD ? 'Not enough gold' : undefined, run: () => this.act({ type: 'gift', to: o, gold: GIFT_GOLD, troops: 0 }) });
      const emb = me.embargoes.includes(o);
      items.push({ label: emb ? 'Lift embargo' : 'Embargo trade', run: () => this.act({ type: 'toggleEmbargo', with: o }) });
      const mine = state.attacks.filter((a) => a.attacker === h && a.target === o);
      if (mine.length) {
        items.push({
          label: `Retreat attacks on ${name}`,
          danger: true,
          run: () => {
            for (const a of mine) this.dispatch({ type: 'retreat', attackId: a.id });
          },
        });
      }
    } else if (!water && owner === 0) {
      const mine = state.attacks.filter((a) => a.attacker === h && a.target === 0);
      if (mine.length) {
        items.push({ label: 'Stop expanding', danger: true, run: () => mine.forEach((a) => this.dispatch({ type: 'retreat', attackId: a.id })) });
      }
    }
    return items;
  }

  // ---- game over ----
  private showGameOver(state: GameState, me: Player): void {
    this.gameOverShown = true;
    this.ui.contextMenu = null;
    this.ui.mode = { kind: 'none' };
    const won = state.winner === me.id;
    const winner = state.players[state.winner];
    const card = el('div', 'modal-card over-card');
    const title = el('h1', won ? 'win' : 'lose', won ? 'Victory' : 'Defeat');
    const sub = el('div', 'over-sub');
    if (winner && state.winner) {
      const dot = el('span', 'dot');
      dot.style.background = rgbCss(winner.color);
      sub.append(dot, won ? 'Your nation rules the map.' : `${winner.name} wins.`);
    } else sub.append('Nobody wins.');
    const scores = allScores(state);
    const ranked = state.players.filter((p) => p.id !== 0).sort((a, b) => scores[b.id] - scores[a.id]);
    const place = ranked.findIndex((p) => p.id === me.id) + 1;
    const st = me.stats;
    const stats: [string, string][] = [
      ['Score', formatCount(scores[me.id])],
      ['Place', `${place} of ${ranked.length}`],
      ['Peak land', `${formatCount(st.tilesMax)} tiles (${((st.tilesMax / Math.max(1, state.map.landTileCount)) * 100).toFixed(1)}%)`],
      ['Tiles captured', formatCount(st.tilesCaptured)],
      ['Enemy troops killed', formatCount(st.troopsKilled)],
      ['Troops lost', formatCount(st.troopsLost)],
      ['Buildings built', formatCount(st.buildingsBuilt)],
      ['Gold earned', formatCount(st.goldEarned)],
      ['Game time', fmtTime(state.tick / TICKS_PER_SECOND - SPAWN_SECONDS)],
    ];
    const grid = el('div', 'stats');
    for (const [k, v] of stats) grid.append(el('span', 'k', k), el('span', 'v', v));
    const btns = el('div', 'over-btns');
    const again = button('Play again', 'primary big', () => this.onPlayAgain());
    again.dataset.test = 'play-again';
    btns.append(again, button('Main menu', 'big', () => this.onMenu()), button('Look at the map', 'big ghost', () => this.gameOver.classList.add('hidden')));
    card.append(title, sub, grid, btns);
    this.gameOver.replaceChildren(card);
    this.gameOver.classList.remove('hidden');
  }
}
