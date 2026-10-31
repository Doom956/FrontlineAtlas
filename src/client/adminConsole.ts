// Owner console (client). Nothing in the UI points to it:
//   - the pipe key "|" opens a one-line prompt at the bottom left that only says "terminal line" with a blinking
//     caret; Esc closes it. The right code + Enter opens the Command console; a wrong one just clears the line.
//   - single player checks the code against a hash (admin.ts); online the relay server checks it (adminAuth) and
//     relays the console's actions only from that session. An unlock lasts for the browser session.
//   - every change is an Action { type: 'admin', op, ... } (src/sim/admin.ts) sent through the normal dispatch, so
//     online games stay in sync; nothing announces the console to other players.
// Map picks (a nation, a tile, a brush) use the 'adminTile' target mode: clicks go to the console until Esc.
import { BUILDINGS, BUILDING_ORDER, DOCTRINES, TECHS } from '../sim/config';
import { DOCTRINE_IDS, isWater } from '../sim/types';
import type { Action, AdminOp, BuildingType, GameState, TechId, Troops } from '../sim/types';
import { el, setText } from './dom';
import { formatCount } from './render/common';
import { checkAdminCode, isUnlocked, setUnlocked, type AdminScope } from './admin';
import type { Dispatch, UiState } from './uiState';

/** Rolling cost of one sim tick (ms), kept by main.ts for the debug overlay. */
export const adminPerf = { tickMs: 0 };

/** The hidden hotkey: the pipe key ("|", Shift+Backslash on most layouts). */
export function isConsoleHotkey(e: { key: string; code: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (e.ctrlKey || e.metaKey) return false;
  return e.key === '|' || (e.code === 'Backslash' && e.shiftKey);
}

/** The console's action (an AdminAction: the sim checks the fields, admin.ts ADMIN_OPS). */
export function adminAction(op: AdminOp, fields: { player?: number; other?: number; tile?: number; amount?: number; key?: string; flag?: boolean; troops?: Troops } = {}): Action {
  const a: Record<string, unknown> = { type: 'admin', op };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) a[k] = v;
  return a as unknown as Action;
}

export type ResourceKey = 'gold' | 'iron' | 'oil' | 'science';
export const RESOURCE_KEYS: readonly ResourceKey[] = ['gold', 'iron', 'oil', 'science'];
/** Quick +/- step of each resource (the buttons add -step, +step and +10 x step). */
export const QUICK_STEP: Record<ResourceKey, number> = { gold: 10_000, iron: 1_000, oil: 1_000, science: 1_000 };

export interface AdminConsoleDeps {
  /** where the line and the console live (the HUD) */
  root: HTMLElement;
  ui: UiState;
  dispatch: Dispatch;
  state: () => GameState | null;
  /** online game: the server checks the code (and relays the console's actions only from this session) */
  online: boolean;
  /** online login: resolves true when the server accepted the code */
  auth?: (code: string) => Promise<boolean>;
  toast: (text: string, kind?: 'info' | 'good' | 'bad' | 'warn') => void;
}

type Tab = 'resources' | 'troops' | 'research' | 'buildings' | 'units' | 'territory' | 'diplomacy' | 'ai' | 'player' | 'game';
const TABS: [Tab, string][] = [
  ['resources', 'Resources'],
  ['troops', 'Troops'],
  ['research', 'Research'],
  ['buildings', 'Buildings'],
  ['units', 'Units'],
  ['territory', 'Territory'],
  ['diplomacy', 'Diplomacy'],
  ['ai', 'AI'],
  ['player', 'Player'],
  ['game', 'Game'],
];
const SLOW_MS = 250;

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return true;
  return t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'button';
}

function num(v: string, fallback = 0): number {
  const n = Number(v.replace(/[\s,_]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export class AdminConsole {
  readonly el: HTMLElement;
  private line: HTMLElement;
  private lineInput: HTMLInputElement;
  private panel: HTMLElement;
  private body: HTMLElement;
  private status: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private tab: Tab = 'resources';
  private target = 0;
  private targetSel: HTMLSelectElement;
  private targetSig = '';
  private live: (() => void)[] = [];
  private lastSlow = -Infinity;
  private checking = false;
  private debug: HTMLElement;
  private frames: number[] = [];
  private ac = new AbortController();
  private scope: AdminScope;

  constructor(private deps: AdminConsoleDeps) {
    this.scope = deps.online ? 'online' : 'local';
    this.el = el('div', 'adm');
    // the hidden line
    this.line = el('div', 'adm-line hidden');
    this.line.dataset.test = 'terminal-line';
    this.lineInput = el('input', 'adm-in');
    this.lineInput.type = 'text';
    this.lineInput.autocomplete = 'off';
    this.lineInput.spellcheck = false;
    this.lineInput.setAttribute('aria-label', 'terminal line');
    this.line.append(el('span', 'adm-lbl', 'terminal line'), this.lineInput);
    this.lineInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeLine();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void this.submit();
      }
    });
    // the console
    this.panel = el('div', 'adm-panel hidden');
    this.panel.dataset.test = 'admin-console';
    const head = el('div', 'adm-head');
    const close = el('button', 'adm-x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.setOpen(false));
    head.append(el('div', 'adm-title', 'Command console'), close);
    const tgt = el('div', 'adm-target');
    this.targetSel = el('select', 'adm-sel');
    this.targetSel.addEventListener('change', () => {
      this.target = Number(this.targetSel.value);
      this.render();
    });
    const pick = this.btn('Pick on map', () =>
      this.pickTile('Console: click a nation to target it', (t) => {
        const s = this.deps.state();
        if (!s) return;
        const o = s.map.owner[t];
        if (o > 0) {
          this.target = o;
          this.syncTargets(s, true);
          this.render();
        }
        this.deps.ui.mode = { kind: 'none' };
      }),
    );
    const meBtn = this.btn('Me', () => {
      this.target = this.deps.state()?.humanId ?? 0;
      this.syncTargets(this.deps.state(), true);
      this.render();
    });
    tgt.append(el('span', 'adm-k', 'Target'), this.targetSel, pick, meBtn);
    const tabs = el('div', 'adm-tabs');
    for (const [id, label] of TABS) {
      const b = el('button', 'adm-tab', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.tab = id;
        this.render();
      });
      this.tabBtns.set(id, b);
      tabs.append(b);
    }
    this.body = el('div', 'adm-body');
    this.status = el('div', 'adm-status', '');
    this.panel.append(head, tgt, tabs, this.body, this.status);
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isTyping(e.target)) {
        (e.target as HTMLElement).blur();
        e.stopPropagation();
      }
    });
    this.debug = el('div', 'adm-debug hidden');
    this.debug.dataset.test = 'debug-overlay';
    this.el.append(this.line, this.panel, this.debug);
    deps.root.append(this.el);

    window.addEventListener(
      'keydown',
      (e) => {
        if (!isConsoleHotkey(e) || e.altKey || isTyping(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (isUnlocked(this.scope)) this.setOpen(this.panel.classList.contains('hidden'));
        else this.openLine();
      },
      { signal: this.ac.signal, capture: true },
    );
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  /** Esc from the HUD: closes the line or the console (not while a map pick is on: Esc ends the pick first). */
  close(): boolean {
    if (!this.line.classList.contains('hidden')) {
      this.closeLine();
      return true;
    }
    if (this.isOpen && this.deps.ui.mode.kind !== 'adminTile') {
      this.setOpen(false);
      return true;
    }
    return false;
  }

  destroy(): void {
    this.ac.abort();
    if (this.deps.ui.mode.kind === 'adminTile') this.deps.ui.mode = { kind: 'none' };
    this.el.remove();
  }

  /** Every frame (cheap): live values at ~4 Hz, the debug overlay. */
  update(state: GameState): void {
    const now = performance.now();
    if (this.deps.ui.debugOverlay) {
      this.frames.push(now);
      while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    }
    if (now - this.lastSlow < SLOW_MS) return;
    this.lastSlow = now;
    this.updateDebug(state);
    if (!this.isOpen) return;
    this.syncTargets(state, false);
    for (const f of this.live) f();
  }

  // ---------------------------------------------------------------------------------------- line and unlock

  private openLine(): void {
    this.line.classList.remove('hidden');
    this.lineInput.value = '';
    this.lineInput.focus();
  }
  private closeLine(): void {
    this.lineInput.value = '';
    this.line.classList.add('hidden');
    this.lineInput.blur();
  }
  private async submit(): Promise<void> {
    if (this.checking) return;
    const code = this.lineInput.value;
    this.lineInput.value = '';
    if (!code) return;
    this.checking = true;
    let ok = false;
    try {
      ok = this.deps.online ? !!(await this.deps.auth?.(code)) : await checkAdminCode(code);
    } catch {
      ok = false;
    }
    this.checking = false;
    if (!ok) return; // wrong: the line just clears
    setUnlocked(this.scope, true);
    this.closeLine();
    this.setOpen(true);
  }

  private setOpen(open: boolean): void {
    this.panel.classList.toggle('hidden', !open);
    if (open) {
      const s = this.deps.state();
      if (!this.target && s) this.target = s.humanId;
      this.syncTargets(s, true);
      this.render();
    } else if (this.deps.ui.mode.kind === 'adminTile') this.deps.ui.mode = { kind: 'none' };
  }

  // ---------------------------------------------------------------------------------------- helpers

  private btn(label: string, run: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', `adm-btn ${cls}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }
  private input(value: string | number, width = 90, type = 'text'): HTMLInputElement {
    const i = el('input', 'adm-num');
    i.type = type;
    i.value = String(value);
    i.style.width = `${width}px`;
    i.spellcheck = false;
    return i;
  }
  private select(options: [string, string][], value = ''): HTMLSelectElement {
    const s = el('select', 'adm-sel');
    for (const [v, l] of options) {
      const o = el('option', '', l);
      o.value = v;
      s.append(o);
    }
    if (value) s.value = value;
    return s;
  }
  private row(label: string, ...parts: HTMLElement[]): HTMLElement {
    const r = el('div', 'adm-row');
    r.append(el('span', 'adm-k', label), ...parts);
    return r;
  }
  private section(title: string): HTMLElement {
    const s = el('div', 'adm-sec', title);
    this.body.append(s);
    return s;
  }
  private say(text: string, bad = false): void {
    setText(this.status, text);
    this.status.classList.toggle('bad', bad);
  }
  /** Sends one console action; says whether it worked. */
  private send(op: AdminOp, fields: Parameters<typeof adminAction>[1] = {}): boolean {
    const r = this.deps.dispatch(adminAction(op, fields));
    this.say(r.ok ? (this.deps.online ? 'Sent' : 'Done') : r.reason ?? 'Not possible', !r.ok);
    return r.ok;
  }
  private targetName(s: GameState | null): string {
    const p = s?.players[this.target];
    return p ? (p.id === s!.humanId ? `${p.name} (you)` : p.name) : 'nobody';
  }
  private liveText(f: (s: GameState) => string): HTMLElement {
    const e = el('span', 'adm-v');
    const run = () => {
      const s = this.deps.state();
      if (s) setText(e, f(s));
    };
    run();
    this.live.push(run);
    return e;
  }
  /** Map pick: clicks go to `pick` until Esc (brush: dragging paints too). */
  private pickTile(label: string, pick: (tile: number) => void, brush = false, radius = 0): void {
    this.deps.ui.contextMenu = null;
    this.deps.ui.selection = [];
    this.deps.ui.mode = { kind: 'adminTile', label: `${label}. Esc to stop.`, pick, brush, radius };
  }

  private syncTargets(s: GameState | null, force: boolean): void {
    if (!s) return;
    if (!s.players[this.target] || this.target <= 0) this.target = s.humanId > 0 ? s.humanId : 1;
    const sig = s.players.map((p) => (p && p.id > 0 ? `${p.id}${p.alive ? '' : 'x'}` : '')).join(',');
    if (!force && sig === this.targetSig && this.targetSel.value === String(this.target)) return;
    this.targetSig = sig;
    const opts: HTMLOptionElement[] = [];
    const list = s.players.filter((p) => p && p.id > 0);
    list.sort((a, b) => (a.id === s.humanId ? -1 : b.id === s.humanId ? 1 : Number(b.alive) - Number(a.alive) || a.id - b.id));
    for (const p of list) {
      const o = el('option', '', `${p.name}${p.id === s.humanId ? ' (you)' : ''}${p.alive ? '' : ' (out)'}`);
      o.value = String(p.id);
      opts.push(o);
    }
    this.targetSel.replaceChildren(...opts);
    this.targetSel.value = String(this.target);
  }

  private playerOptions(s: GameState, includeNone = false): [string, string][] {
    const out: [string, string][] = includeNone ? [['0', '—']] : [];
    for (const p of s.players) if (p && p.id > 0) out.push([String(p.id), `${p.name}${p.id === s.humanId ? ' (you)' : ''}${p.alive ? '' : ' (out)'}`]);
    return out;
  }

  // ---------------------------------------------------------------------------------------- tabs

  private render(): void {
    this.live = [];
    this.body.replaceChildren();
    for (const [id, b] of this.tabBtns) b.classList.toggle('on', id === this.tab);
    const s = this.deps.state();
    if (!s) return;
    const P = () => this.target;
    switch (this.tab) {
      case 'resources':
        this.section(`Resources of ${this.targetName(s)}`);
        for (const key of RESOURCE_KEYS) {
          const inp = this.input(QUICK_STEP[key]);
          const step = QUICK_STEP[key];
          const quick = (d: number) => this.btn(`${d > 0 ? '+' : '−'}${formatCount(Math.abs(d))}`, () => this.send('addResource', { player: P(), key, amount: d }), 'q');
          const r = this.row(
            key,
            this.liveText((st) => formatCount(st.players[P()]?.[key] ?? 0)),
            inp,
            this.btn('Set', () => this.send('setResource', { player: P(), key, amount: num(inp.value) })),
            this.btn('Add', () => this.send('addResource', { player: P(), key, amount: num(inp.value) })),
          );
          r.dataset.test = `adm-res-${key}`;
          const q = this.row('', quick(-step), quick(step), quick(step * 10));
          q.classList.add('adm-quick');
          q.dataset.test = `adm-quick-${key}`;
          this.body.append(r, q);
        }
        break;
      case 'troops': {
        this.section(`Troops of ${this.targetName(s)}`);
        this.body.append(
          this.row(
            'Now',
            this.liveText((st) => {
              const p = st.players[P()];
              return p ? `${formatCount(p.troops.infantry)} inf · ${formatCount(p.troops.armor)} armor · ${formatCount(p.troops.artillery)} art · cap ${formatCount(p.maxPop)}` : '';
            }),
          ),
        );
        const inf = this.input(50000);
        const arm = this.input(0);
        const art = this.input(0);
        this.body.append(this.row('Infantry', inf), this.row('Armor', arm), this.row('Artillery', art));
        const troops = (): Troops => ({ infantry: Math.max(0, num(inf.value)), armor: Math.max(0, num(arm.value)), artillery: Math.max(0, num(art.value)) });
        this.body.append(
          this.row(
            '',
            this.btn('Give', () => this.send('addTroops', { player: P(), troops: troops() })),
            this.btn('Set', () => this.send('setTroops', { player: P(), troops: troops() })),
            this.btn('Fill to cap', () => this.send('fillTroops', { player: P() })),
          ),
        );
        break;
      }
      case 'research': {
        this.section(`Research of ${this.targetName(s)}`);
        this.body.append(
          this.row(
            'Current',
            this.liveText((st) => {
              const p = st.players[P()];
              return p?.researching ? TECHS[p.researching].name : 'nothing';
            }),
            this.btn('Finish it', () => this.send('finishResearch', { player: P() })),
          ),
        );
        const techs = (Object.keys(TECHS) as TechId[]).map((t): [string, string] => [t, TECHS[t].name]).sort((a, b) => a[1].localeCompare(b[1]));
        const sel = this.select(techs);
        this.body.append(
          this.row('Tech', sel, this.btn('Unlock', () => this.send('unlockTech', { player: P(), key: sel.value })), this.btn('Remove', () => this.send('removeTech', { player: P(), key: sel.value }))),
          this.row('', this.btn('Unlock all techs', () => this.send('unlockAllTechs', { player: P() }), 'wide')),
          this.row('Known', this.liveText((st) => `${st.players[P()]?.techs.length ?? 0} of ${Object.keys(TECHS).length} techs`)),
        );
        break;
      }
      case 'buildings': {
        this.section(`Buildings (owner: ${this.targetName(s)})`);
        this.body.append(this.row('', this.btn('Finish all constructions', () => this.send('finishConstructions', { player: P() }), 'wide')));
        const types = BUILDING_ORDER.map((b): [string, string] => [b, BUILDINGS[b].name]);
        const sel = this.select(types, 'city');
        const lvl = this.input(1, 50, 'number');
        this.body.append(
          this.row(
            'Place',
            sel,
            el('span', 'adm-k', 'level'),
            lvl,
            this.btn('Click map', () => this.pickTile(`Console: click to place a ${BUILDINGS[sel.value as BuildingType].name}`, (t) => this.send('placeBuilding', { player: P(), key: sel.value, tile: t, amount: Math.max(1, num(lvl.value, 1)) }))),
          ),
        );
        const lv2 = this.input(3, 50, 'number');
        this.body.append(
          this.row('Delete', this.btn('Click a building', () => this.pickTile('Console: click a building to delete it', (t) => this.send('deleteBuilding', { tile: t })))),
          this.row('Set level', lv2, this.btn('Click a building', () => this.pickTile('Console: click a building to set its level', (t) => this.send('setBuildingLevel', { tile: t, amount: Math.max(1, num(lv2.value, 1)) })))),
        );
        break;
      }
      case 'units': {
        this.section('Units (instant, no cost)');
        const nShips = this.input(3, 50, 'number');
        const nPlanes = this.input(3, 50, 'number');
        const kind = this.select([
          ['bomber', 'Bombers'],
          ['fighter', 'Fighters'],
        ]);
        this.body.append(
          this.row('Warships', nShips, this.btn('Click a port', () => this.pickTile('Console: click a port to add warships', (t) => this.send('giveWarships', { tile: t, amount: Math.max(1, num(nShips.value, 1)) })))),
          this.row('Aircraft', kind, nPlanes, this.btn('Click an airfield', () => this.pickTile('Console: click an airfield to add aircraft', (t) => this.send('giveAircraft', { tile: t, key: kind.value, amount: Math.max(1, num(nPlanes.value, 1)) })))),
          this.row('Charges', this.btn('Click a silo / SAM', () => this.pickTile('Console: click a silo or SAM site to reload it', (t) => this.send('giveCharges', { tile: t })))),
          this.row('Spawn', this.btn('Warship at water', () => this.pickTile(`Console: click water to spawn a warship for ${this.targetName(this.deps.state())}`, (t) => this.send('spawnWarship', { player: P(), tile: t })))),
          this.row('', this.btn('Tank division on land', () => this.pickTile(`Console: click ${this.targetName(this.deps.state())}'s land to spawn a tank division`, (t) => this.send('spawnTankDivision', { player: P(), tile: t })))),
        );
        break;
      }
      case 'territory': {
        this.section(`Territory (for ${this.targetName(s)})`);
        const r = el('input', 'adm-range');
        r.type = 'range';
        r.min = '0';
        r.max = '30';
        r.value = '4';
        const rv = el('span', 'adm-v', '4');
        r.addEventListener('input', () => {
          setText(rv, r.value);
          const m = this.deps.ui.mode;
          if (m.kind === 'adminTile' && m.brush) m.radius = Number(r.value);
        });
        this.body.append(
          this.row('Brush radius', r, rv),
          this.row(
            'Paint',
            this.btn('Capture (brush)', () => this.pickTile(`Console: paint land for ${this.targetName(this.deps.state())} (drag)`, (t) => this.send('paintTiles', { player: P(), tile: t, amount: Number(r.value) }), true, Number(r.value))),
            this.btn('Make neutral (brush)', () => this.pickTile('Console: make land neutral (drag)', (t) => this.send('neutralizeTiles', { tile: t, amount: Number(r.value) }), true, Number(r.value))),
          ),
          this.row('Capital', this.btn('Click to move it', () => this.pickTile('Console: click the new capital tile', (t) => this.send('moveCapital', { player: P(), tile: t })))),
        );
        break;
      }
      case 'diplomacy': {
        this.section('Diplomacy');
        const a = this.select(this.playerOptions(s), String(this.target));
        const b = this.select(this.playerOptions(s));
        const firstOther = s.players.find((p) => p && p.id > 0 && p.id !== this.target && p.alive);
        if (firstOther) b.value = String(firstOther.id);
        const op = this.input(50, 60, 'number');
        const A = () => Number(a.value);
        const B = () => Number(b.value);
        this.body.append(
          this.row('Nation A', a),
          this.row('Nation B', b),
          this.row('', this.btn('Force alliance', () => this.send('forceAlliance', { player: A(), other: B() })), this.btn('Break alliance', () => this.send('breakAlliance', { player: A(), other: B() }))),
          this.row('', this.btn('AI A declares war on B', () => this.send('declareWar', { player: A(), other: B() }), 'wide')),
          this.row('Opinion', op, this.btn('Set A about B', () => this.send('setOpinion', { player: A(), other: B(), amount: Math.max(-100, Math.min(100, num(op.value))) }))),
        );
        break;
      }
      case 'ai': {
        this.section('AI');
        const passive = this.toggle(
          () => !!this.deps.state()?.admin?.aiPassive.includes(P()),
          (on) => this.send('aiPassive', { player: P(), flag: on }),
          () => `No AI attacks ${this.targetName(this.deps.state())}`,
        );
        const frozen = this.toggle(
          () => !!this.deps.state()?.admin?.aiFrozen,
          (on) => this.send('freezeAI', { flag: on }),
          () => 'Freeze all AI',
        );
        const diff = this.select(
          [
            ['easy', 'Easy'],
            ['normal', 'Normal'],
            ['hard', 'Hard'],
            ['brutal', 'Brutal'],
          ],
          s.settings.difficulty,
        );
        this.body.append(this.row('', passive), this.row('', frozen), this.row('Difficulty', diff, this.btn('Set', () => this.send('setDifficulty', { key: diff.value }))));
        break;
      }
      case 'player': {
        this.section(`Player: ${this.targetName(s)}`);
        const god = this.toggle(
          () => !!this.deps.state()?.admin?.godMode.includes(P()),
          (on) => this.send('godMode', { player: P(), flag: on }),
          () => 'God mode (land can\'t be captured)',
        );
        const doc = this.select([['none', 'No doctrine'], ...DOCTRINE_IDS.map((d): [string, string] => [d, DOCTRINES[d].name])], s.players[this.target]?.doctrine?.id ?? 'none');
        const lvl = this.select([
          ['1', 'Level 1'],
          ['2', 'Level 2'],
          ['3', 'Level 3'],
        ]);
        const troops = this.input(50000);
        let armed = 0;
        const elim = this.btn('Eliminate', () => {
          const now = performance.now();
          if (now - armed > 3000) {
            armed = now;
            this.say('Click Eliminate again to confirm');
            return;
          }
          armed = 0;
          this.send('eliminate', { player: P() });
        }, 'danger');
        this.body.append(
          this.row('', god),
          this.row('Doctrine', doc, lvl, this.btn('Set', () => this.send('setDoctrine', { player: P(), key: doc.value, amount: Number(lvl.value) }))),
          this.row('', elim),
          this.row(
            'Revive',
            troops,
            this.btn('Click a tile', () => this.pickTile(`Console: click land to revive ${this.targetName(this.deps.state())}`, (t) => {
              const st = this.deps.state();
              if (st && isWater(st.map.terrain[t])) {
                this.say('Click a land tile', true);
                return;
              }
              if (this.send('revive', { player: P(), tile: t, amount: Math.max(1000, num(troops.value, 50000)) })) this.deps.ui.mode = { kind: 'none' };
            })),
          ),
        );
        break;
      }
      case 'game': {
        this.section('Game');
        const speeds = el('div', 'adm-seg');
        for (const sp of [1, 2, 4, 8, 16] as const) {
          const b = this.btn(`x${sp}`, () => {
            if (this.deps.online) return this.say('Speed is set by the server online', true);
            this.deps.ui.speed = sp;
            this.say(`Speed x${sp}`);
          }, 'q');
          b.disabled = this.deps.online;
          speeds.append(b);
        }
        const peace = this.input(5, 50, 'number');
        const intel = this.toggle(
          () => !!this.deps.state()?.admin?.revealIntel.includes(this.deps.state()?.humanId ?? -1),
          (on) => this.send('revealIntel', { player: this.deps.state()?.humanId, flag: on }),
          () => 'Reveal all intel (for you)',
        );
        const dbg = this.toggle(
          () => this.deps.ui.debugOverlay,
          (on) => {
            this.deps.ui.debugOverlay = on;
            this.updateDebug(this.deps.state());
          },
          () => 'Debug overlay (fps, ms per tick, AI attacks)',
        );
        this.body.append(
          this.row('Speed', speeds),
          this.row('Peace', this.btn('End peace time', () => this.send('setPeace', { amount: 0 })), peace, el('span', 'adm-k', 'min'), this.btn('Set', () => this.send('setPeace', { amount: Math.max(0, num(peace.value)) * 60 }))),
          this.row('', intel),
          this.row('', dbg),
        );
        break;
      }
    }
  }

  /** A checkbox row that follows the state. */
  private toggle(get: () => boolean, set: (on: boolean) => void, label: () => string): HTMLElement {
    const lab = el('label', 'adm-tog');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = get();
    const txt = el('span', '', label());
    box.addEventListener('change', () => set(box.checked));
    lab.append(box, txt);
    this.live.push(() => {
      if (document.activeElement !== box) box.checked = get();
      setText(txt, label());
    });
    return lab;
  }

  // ---------------------------------------------------------------------------------------- debug overlay

  private updateDebug(state: GameState | null): void {
    const on = this.deps.ui.debugOverlay && !!state;
    this.debug.classList.toggle('hidden', !on);
    if (!on || !state) return;
    const fps = this.frames.length;
    const lines: string[] = [`${fps} fps · ${adminPerf.tickMs.toFixed(2)} ms/tick · tick ${state.tick}`, `${state.units.length} units · ${state.attacks.length} attacks · ${state.buildings.size} buildings`];
    const ai = state.attacks.filter((a) => !state.players[a.attacker]?.isHuman).sort((a, b) => b.troops.infantry + b.troops.armor + b.troops.artillery - (a.troops.infantry + a.troops.armor + a.troops.artillery));
    if (ai.length) lines.push('AI attacks:');
    for (const a of ai.slice(0, 8)) {
      const t = a.troops.infantry + a.troops.armor + a.troops.artillery;
      lines.push(`  ${state.players[a.attacker]?.name ?? a.attacker} → ${a.target ? state.players[a.target]?.name ?? a.target : 'neutral'} (${formatCount(t)})`);
    }
    if (state.admin?.aiFrozen) lines.push('AI frozen');
    setText(this.debug, lines.join('\n'));
  }
}
