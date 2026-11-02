// The "New game" setup screen. A game type row (the presets), then three sections: Map (generated types and sizes,
// real-world maps with previews, folded map options: neutral land and seed), Players (AI nations, difficulty, mode
// and teams) and Rules (four common rules open, the other twelve folded under "More rules"). The footer is a plain
// briefing of the game and the Start button. Everything edits one GameSetup (src/sim/setup.ts), the same model the
// multiplayer lobby uses; the last settings are remembered.
import './setupScreen.css';
import { MAX_AI_COUNT, MAX_TRIBE_COUNT, VICTORY_LAND_SHARE } from '../sim/config';
import {
  activeModifiers,
  applyPreset,
  BUILD_SPEED_LIST,
  cloneSetup,
  DEFAULT_SETUP,
  defaultTribeCount,
  GOLD_MULTIPLIERS,
  GROWTH_MULTIPLIERS,
  landEstimate,
  mapLabel,
  MAP_SIZE_LIST,
  MAP_TYPE_LIST,
  mapSizeName,
  mapTypeName,
  matchPreset,
  MAX_TEAMS,
  MIN_TEAMS,
  PEACE_MINUTES,
  PRESETS,
  sanitizeSetup,
  STARTING_GOLD,
  TIME_LIMIT_MINUTES,
  tribesFor,
  VICTORY_SHARES,
} from '../sim/setup';
import type { BuildSpeed, Difficulty, GameMode, GameSettings, GameSetup, MapSize, MapType, Modifiers, PresetId, ResearchRule, StartingGold } from '../sim/types';
import { getWorldMap, listWorldMaps } from '../sim/worldmaps';
import { button, el, rgbCss, setText } from './dom';
import { lineIcon } from './hud/glyph';
import { requestThumb, type ThumbKey } from './mapThumbs';

/** Player colour palette (well separated from each other). */
export const PLAYER_PALETTE: [number, number, number][] = [
  [64, 160, 255],
  [255, 255, 255],
  [255, 92, 92],
  [255, 176, 46],
  [250, 230, 70],
  [110, 220, 90],
  [40, 200, 180],
  [170, 110, 255],
  [255, 110, 200],
  [150, 90, 50],
  [40, 40, 50],
  [140, 220, 255],
];

// ------------------------------------------------------------------------------------------------ remembered settings

export interface SetupPrefs {
  setup: GameSetup;
  playerName: string;
  /** palette index */
  color: number;
  seed: number;
}

const PREFS_KEY = 'borderfall.setup.v2';

export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999999);
}

/** The last settings (localStorage), or the defaults; a fresh seed every visit. */
export function loadSetupPrefs(): SetupPrefs {
  const d: SetupPrefs = { setup: cloneSetup(DEFAULT_SETUP), playerName: 'Player', color: 0, seed: randomSeed() };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<SetupPrefs>;
    return {
      setup: sanitizeSetup(p.setup),
      playerName: typeof p.playerName === 'string' && p.playerName.trim() ? p.playerName.slice(0, 20) : d.playerName,
      color: Number.isInteger(p.color) && (p.color as number) >= 0 && (p.color as number) < PLAYER_PALETTE.length ? (p.color as number) : 0,
      seed: d.seed,
    };
  } catch {
    return d;
  }
}

export function saveSetupPrefs(p: SetupPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ setup: p.setup, playerName: p.playerName, color: p.color }));
  } catch {
    /* storage unavailable: ignore */
  }
}

export function settingsFromPrefs(p: SetupPrefs): GameSettings {
  return {
    ...cloneSetup(p.setup),
    seed: p.seed,
    playerName: p.playerName.trim() || 'Player',
    playerColor: PLAYER_PALETTE[p.color] ?? PLAYER_PALETTE[0],
    humanPlayer: true,
  };
}

// ------------------------------------------------------------------------------------------------ option texts

const TYPE_HINT: Record<MapType, string> = {
  continents: 'A few big landmasses',
  pangaea: 'One supercontinent',
  archipelago: 'Islands, war by sea',
  highlands: 'Rugged, few passes',
};
const DIFFICULTY_OPTS: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Hard' },
  { id: 'brutal', label: 'Brutal' },
];
const DIFFICULTY_HINT: Record<Difficulty, string> = {
  easy: 'Gentle: the AIs grow slowly, leave you alone for the first 15 minutes and never use atom bombs. A good first game.',
  normal: 'Fair: the AIs leave you alone for 9 minutes, then expect a fight. Good once you know the basics.',
  hard: 'Tough: strong AIs that attack any time and gang up. For experienced players.',
  brutal: 'Ruthless: the strongest, fastest AIs. They will come for you early.',
};
const MODE_OPTS: { id: GameMode; label: string }[] = [
  { id: 'ffa', label: 'Free for all' },
  { id: 'teams', label: 'Teams' },
];
const GOLD_START_OPTS: { id: StartingGold; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High' },
  { id: 'veryHigh', label: 'Very high' },
];
const BUILD_OPTS: { id: BuildSpeed; label: string }[] = BUILD_SPEED_LIST.map((id) => ({ id, label: id === 'normal' ? 'Normal' : id === 'fast' ? 'Fast' : 'Instant' }));
const RESEARCH_OPTS: { id: ResearchRule; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'allUnlocked', label: 'All unlocked' },
  { id: 'off', label: 'Off' },
];
/** The game type row: short names and one plain line each (the sim's PRESETS keep their long names elsewhere). */
const PRESET_TEXT: Partial<Record<PresetId, { name: string; line: string }>> = {
  classic: { name: 'Classic', line: 'The standard game: a medium map, 8 AI nations and plenty of tribes.' },
  quickConquest: { name: 'Quick', line: 'A small map and everything twice as fast. About 15 to 25 minutes.' },
  grandWar: { name: 'Grand war', line: 'The whole world, 20 AI nations and a long war.' },
  islandHopping: { name: 'Islands', line: 'An archipelago: wars are fought by sea, and there is no air force.' },
  chaos: { name: 'Chaos', line: 'Two to four random rules. Pick it again for another roll.' },
};
const fmtK = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const DIFF_NAME: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard', brutal: 'Brutal' };

type Opt<T> = { id: T; label: string };

/** How many settings differ between two setups (difficulty, mode and teams aside, as for presets). */
function changeCount(a: GameSetup, b: GameSetup): number {
  let n = JSON.stringify(a.map) !== JSON.stringify(b.map) ? 1 : 0;
  if (a.aiCount !== b.aiCount) n++;
  if (a.tribeCount !== b.tribeCount) n++;
  if (a.timeLimit !== b.timeLimit) n++;
  if (a.victoryLandShare !== b.victoryLandShare) n++;
  for (const k of Object.keys(a.modifiers) as (keyof Modifiers)[]) if (a.modifiers[k] !== b.modifiers[k]) n++;
  return n;
}

/**
 * The game in two plain lines: "Medium continents map. You against 8 AI nations on Normal, free for all." and
 * "Changes: Fast game, No atom bombs" (or "Standard rules"). `lobby`: "The players and 8 AI nations ...".
 * The title screen's "Play again" row uses the first line too.
 */
export function setupBriefing(s: GameSetup, lobby = false): { main: string; rules: string; changes: number } {
  const map =
    s.map.kind === 'generated'
      ? `${mapSizeName(s.map.size)} ${mapTypeName(s.map.type).toLowerCase()} map`
      : `${mapLabel(s.map)} map`;
  const compact = s.modifiers.compactMap ? ' (compact)' : '';
  const ai = `${s.aiCount} AI ${s.aiCount === 1 ? 'nation' : 'nations'}`;
  const who = lobby ? `The players and ${ai}` : s.aiCount > 0 ? `You against ${ai}` : 'You alone with the tribes';
  const how = s.mode === 'teams' ? `in ${s.teamCount} teams${lobby ? '' : ' (you lead team 1)'}` : 'free for all';
  const diff = s.aiCount > 0 ? ` on ${DIFF_NAME[s.difficulty] ?? s.difficulty}` : '';
  const mods = activeModifiers(s).filter((m) => m.id !== 'teams');
  return {
    main: `${map}${compact}. ${who}${diff}, ${how}.`,
    rules: mods.length ? `Changes: ${mods.map((m) => m.label).join(', ')}` : 'Standard rules',
    changes: mods.length,
  };
}

// ------------------------------------------------------------------------------------------------ the screen

export interface SetupCallbacks {
  onBack: () => void;
  onStart: (settings: GameSettings) => void;
}

/**
 * The same screen as a multiplayer lobby: the host edits the settings (each change goes to the server through
 * onChange), everyone else sees them read-only; `side` (code, players, teams, Start, Leave) becomes the right-hand
 * column and `status` sits in the footer next to the briefing (there is no Start in the footer then).
 */
export interface LobbySetupMode {
  title: string;
  side: HTMLElement;
  status: HTMLElement;
  editable: boolean;
  onChange: (setup: GameSetup) => void;
}

/** Builds the setup screen into `card` (a .menu-card). */
export class SetupScreen {
  private syncs: (() => void)[] = [];
  private mapTab: 'generated' | 'world';
  private lastWorld: string;
  private lastGenerated: { type: MapType; size: MapSize };
  /** The preset last picked and the setup it gave: "Custom (n changes)" counts against it, Reset goes back to it. */
  private basePreset: PresetId = 'classic';
  private base: GameSetup;
  private cleanups: (() => void)[] = [];

  constructor(
    private card: HTMLElement,
    private prefs: SetupPrefs,
    private cb: SetupCallbacks,
    private lobby: LobbySetupMode | null = null,
  ) {
    const s = prefs.setup;
    this.mapTab = s.map.kind;
    this.lastWorld = s.map.kind === 'world' ? s.map.id : 'world';
    this.lastGenerated = s.map.kind === 'generated' ? { type: s.map.type, size: s.map.size } : { type: 'continents', size: 'medium' };
    this.base = applyPreset('classic', s);
    this.takeBase(s);
    this.build();
  }

  private get s(): GameSetup {
    return this.prefs.setup;
  }

  /** A named preset (from a click, the saved settings or the server) becomes the base for "Custom (n changes)". */
  private takeBase(s: GameSetup): void {
    const p = s.preset;
    if (!p || p === 'custom') return;
    this.basePreset = p;
    this.base = p === 'chaos' ? cloneSetup(s) : applyPreset(p, s);
  }

  /** After any change: preset detection, every control, the summary, and remember it (lobby: send it). */
  private changed(fromPreset = false, remote = false): void {
    if (!fromPreset) this.s.preset = changeCount(this.s, this.base) === 0 ? this.basePreset : matchPreset(this.s);
    for (const f of this.syncs) f();
    if (!this.lobby) saveSetupPrefs(this.prefs);
    else if (!remote) this.lobby.onChange(cloneSetup(this.s));
  }

  /** Lobby: shows the server's settings (and whether this client may edit them). */
  setSetup(setup: GameSetup, editable: boolean): void {
    this.prefs.setup = cloneSetup(setup);
    const s = this.s;
    this.mapTab = s.map.kind;
    if (s.map.kind === 'world') this.lastWorld = s.map.id;
    else this.lastGenerated = { type: s.map.type, size: s.map.size };
    this.takeBase(s);
    this.setEditable(editable);
    this.changed(true, true);
  }

  /** Lobby: the settings read-only for non-hosts (the folded sections still open, so guests can read every rule). */
  setEditable(on: boolean): void {
    if (this.lobby) this.lobby.editable = on;
    this.card.classList.toggle('readonly', !on);
    for (const c of this.card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.setup-main button, .setup-main input, .setup-type button')) {
      c.disabled = !on;
    }
  }

  // ---------------------------------------------------------------------------------------------- controls

  private seg<T extends string | number>(name: string, opts: Opt<T>[], get: () => T, set: (v: T) => void, cls = ''): HTMLElement {
    const g = el('div', 'seg setup-seg ' + cls);
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', name);
    const btns = opts.map((o) => {
      const b = button(o.label, '', () => {
        set(o.id);
        this.changed();
      });
      g.append(b);
      return b;
    });
    this.syncs.push(() => btns.forEach((b, k) => {
      const on = opts[k].id === get();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }));
    return g;
  }

  private toggle(name: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement {
    const b = el('button', 'switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', name);
    b.append(el('span', 'switch-knob'));
    b.addEventListener('click', () => {
      set(!get());
      this.changed();
    });
    this.syncs.push(() => {
      const on = get();
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    });
    return b;
  }

  /** One rule: name and a one-line explanation, the control on the trailing side. */
  private modRow(name: string, detail: string | (() => string), control: HTMLElement): HTMLElement {
    const r = el('div', 'mod-row');
    const t = el('div', 'mod-text');
    const d = el('div', 'mod-detail');
    t.append(el('div', 'mod-name', name), d);
    if (typeof detail === 'string') d.textContent = detail;
    else this.syncs.push(() => setText(d, detail()));
    r.append(t, control);
    return r;
  }

  private field(label: string, control: HTMLElement, extra?: HTMLElement): HTMLElement {
    const r = el('div', 'setup-field');
    r.append(el('span', 'form-label', label), control);
    if (extra) r.append(extra);
    return r;
  }

  private section(title: string, cls: string, label = title): HTMLElement {
    const sec = el('section', 'setup-sec ' + cls);
    sec.setAttribute('aria-label', label);
    const head = el('div', 'setup-sec-head');
    head.append(el('h3', 'setup-h', title));
    sec.append(head);
    return sec;
  }

  /** A folded part: a summary line with a live value on the trailing side, the rows inside. */
  private fold(title: string, cls: string, value: () => string, test?: string): { box: HTMLDetailsElement; body: HTMLElement; valueEl: HTMLElement } {
    const box = el('details', 'setup-fold ' + cls);
    const sum = el('summary', 'fold-sum');
    if (test) sum.dataset.test = test;
    const chev = el('span', 'fold-chev');
    chev.setAttribute('aria-hidden', 'true');
    chev.innerHTML = lineIcon('chevronRight', 14);
    const valueEl = el('span', 'fold-val');
    sum.append(chev, el('span', 'fold-title', title), valueEl);
    this.syncs.push(() => setText(valueEl, value()));
    const body = el('div', 'fold-body');
    box.append(sum, body);
    return { box, body, valueEl };
  }

  /** Scroll boxes on wide screens: the edge fades while there is more below. */
  private fadeEdge(box: HTMLElement): void {
    const check = (): void => {
      const more = box.scrollHeight - box.clientHeight - box.scrollTop > 4;
      box.classList.toggle('more-below', more);
    };
    box.addEventListener('scroll', check, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(check);
      ro.observe(box);
      for (const c of Array.from(box.children)) ro.observe(c);
      this.cleanups.push(() => ro.disconnect());
    }
    this.syncs.push(() => requestAnimationFrame(check));
  }

  // ---------------------------------------------------------------------------------------------- layout

  private build(): void {
    const card = this.card;
    card.className = 'menu-card setup';
    card.replaceChildren();
    // the card is emptied or rebuilt when the screen changes: drop the document listeners and observers with it
    const mo = new MutationObserver(() => {
      if (top.isConnected) return;
      for (const f of this.cleanups) f();
      this.cleanups = [];
      mo.disconnect();
    });
    mo.observe(card, { childList: true });

    // Head: back, title, and (single player) who you play as.
    const top = el('div', 'menu-head setup-head');
    const back = button('Back', 'ghost', () => this.cb.onBack());
    top.append(back, el('h2', '', this.lobby?.title ?? 'New game'));
    if (!this.lobby) top.append(this.youChip());

    const body = el('div', 'setup-body');
    const main = el('div', 'setup-main');
    const mapCol = el('div', 'setup-col map-col');
    mapCol.append(this.mapSection());
    const sideCol = el('div', 'setup-col play-col');
    sideCol.append(this.playersSection(), this.rulesSection());
    main.append(mapCol, sideCol);
    body.append(main);
    if (this.lobby) {
      body.classList.add('with-side');
      main.classList.add('fade-scroll');
      this.fadeEdge(main);
      body.append(this.lobby.side);
    } else {
      for (const c of [mapCol, sideCol]) {
        c.classList.add('fade-scroll');
        this.fadeEdge(c);
      }
    }

    // Footer: the briefing (what game this is, in plain words) and Start.
    const foot = el('div', 'menu-foot setup-foot');
    const brief = el('div', 'setup-brief setup-summary');
    brief.setAttribute('role', 'status');
    const sumMain = el('p', 'sum-main');
    const sumRules = el('p', 'sum-rules');
    brief.append(sumMain, sumRules);
    this.syncs.push(() => {
      const b = setupBriefing(this.s, !!this.lobby);
      setText(sumMain, b.main);
      setText(sumRules, b.rules);
      sumRules.classList.toggle('has-mods', b.changes > 0);
      brief.title = `${b.main} ${b.rules}.`;
    });
    foot.append(brief);

    if (this.lobby) {
      foot.classList.add('lobby-mode');
      foot.append(this.lobby.status);
      card.append(top, this.typeRow(), body, foot);
      this.changed(true, true);
      this.setEditable(this.lobby.editable);
      return;
    }
    const start = button('Start game', 'primary big', () => {
      saveSetupPrefs(this.prefs);
      this.cb.onStart(settingsFromPrefs(this.prefs));
    });
    start.dataset.test = 'menu-start';
    foot.append(start);
    card.append(top, this.typeRow(), body, foot);
    this.changed(true);
    start.focus({ preventScroll: true });
  }

  /** "Game type": the presets as one segmented row, the picked one's line under it, or "Custom (n changes)". */
  private typeRow(): HTMLElement {
    const row = el('div', 'setup-type');
    const label = el('span', 'form-label', 'Game type');
    label.id = 'setup-type-label';
    const presets = el('div', 'seg preset-chips');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-labelledby', label.id);
    for (const p of PRESETS) {
      if (p.id === 'custom') continue;
      const text = PRESET_TEXT[p.id];
      const b = button(text?.name ?? p.name, 'preset', () => {
        this.prefs.setup = applyPreset(p.id, this.s, Math.random);
        const s = this.s;
        if (s.map.kind === 'world') this.lastWorld = s.map.id;
        else this.lastGenerated = { type: s.map.type, size: s.map.size };
        this.mapTab = s.map.kind;
        this.basePreset = p.id;
        this.base = cloneSetup(s);
        this.changed(true);
      });
      b.dataset.preset = p.id;
      b.title = text?.line ?? p.description;
      presets.append(b);
      this.syncs.push(() => {
        const on = this.s.preset === p.id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    const line = el('p', 'type-line');
    const custom = el('div', 'type-custom');
    const customText = el('span', 'type-custom-text');
    const reset = button('Reset', 'ghost mini-btn', () => {
      const keep = this.s;
      this.prefs.setup = { ...cloneSetup(this.base), difficulty: keep.difficulty, mode: keep.mode, teamCount: keep.teamCount, preset: this.basePreset };
      const s = this.s;
      this.mapTab = s.map.kind;
      if (s.map.kind === 'world') this.lastWorld = s.map.id;
      else this.lastGenerated = { type: s.map.type, size: s.map.size };
      this.changed(true);
    });
    custom.append(customText, reset);
    this.syncs.push(() => {
      const isCustom = this.s.preset === 'custom';
      const baseName = PRESET_TEXT[this.basePreset]?.name ?? 'Classic';
      line.classList.toggle('hidden', isCustom);
      custom.classList.toggle('hidden', !isCustom);
      if (isCustom) {
        const n = changeCount(this.s, this.base);
        setText(customText, `Custom: ${n} ${n === 1 ? 'change' : 'changes'} to ${baseName}`);
        reset.title = `Back to ${baseName}`;
        reset.setAttribute('aria-label', `Reset to ${baseName}`);
      } else setText(line, PRESET_TEXT[this.s.preset]?.line ?? '');
    });
    const lead = el('div', 'type-lead');
    lead.append(label, presets);
    row.append(lead, line, custom);
    return row;
  }

  /** Your name and colour: a small chip that opens a popover (single player). */
  private youChip(): HTMLElement {
    const wrap = el('div', 'setup-you');
    const chip = el('button', 'btn ghost you-chip');
    chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', 'false');
    const sw = el('i', 'you-sw');
    const nm = el('span', 'you-name');
    chip.append(el('span', 'you-label', 'You'), sw, nm);
    const pop = el('div', 'you-pop hidden');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Your name and colour');
    const name = el('input', 'input');
    name.type = 'text';
    name.maxLength = 20;
    name.value = this.prefs.playerName;
    name.id = 'setup-you-name';
    name.addEventListener('input', () => {
      this.prefs.playerName = name.value;
      saveSetupPrefs(this.prefs);
      setText(nm, name.value.trim() || 'Player');
    });
    const nameLabel = el('label', 'form-label', 'Name');
    nameLabel.htmlFor = name.id;
    const colors = el('div', 'palette');
    colors.setAttribute('role', 'group');
    colors.setAttribute('aria-label', 'Your colour');
    PLAYER_PALETTE.forEach((c, k) => {
      const b = el('button', 'swatch-btn');
      b.type = 'button';
      b.style.background = rgbCss(c);
      b.setAttribute('aria-label', `Colour ${k + 1}`);
      b.addEventListener('click', () => {
        this.prefs.color = k;
        this.changed();
      });
      colors.append(b);
      this.syncs.push(() => {
        b.classList.toggle('on', this.prefs.color === k);
        b.setAttribute('aria-pressed', String(this.prefs.color === k));
      });
    });
    pop.append(nameLabel, name, el('span', 'form-label', 'Colour'), colors);
    this.syncs.push(() => {
      sw.style.background = rgbCss(PLAYER_PALETTE[this.prefs.color] ?? PLAYER_PALETTE[0]);
      setText(nm, this.prefs.playerName.trim() || 'Player');
      chip.title = 'Your name and colour';
    });

    const open = (on: boolean, focus = true): void => {
      pop.classList.toggle('hidden', !on);
      chip.setAttribute('aria-expanded', String(on));
      if (on && focus) name.focus();
      else if (!on && focus) chip.focus();
    };
    chip.addEventListener('click', () => open(pop.classList.contains('hidden')));
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        open(false);
      }
    });
    const outside = (e: PointerEvent): void => {
      if (!pop.classList.contains('hidden') && !wrap.contains(e.target as Node)) open(false, false);
    };
    document.addEventListener('pointerdown', outside);
    this.cleanups.push(() => document.removeEventListener('pointerdown', outside));
    wrap.append(chip, pop);
    return wrap;
  }

  private mapSection(): HTMLElement {
    const sec = this.section('Map', 'map-sec');
    const tabs = this.seg<'generated' | 'world'>(
      'Map kind',
      [
        { id: 'generated', label: 'Generated' },
        { id: 'world', label: 'Real world' },
      ],
      () => this.mapTab,
      (v) => {
        this.mapTab = v;
        this.s.map = v === 'world' ? { kind: 'world', id: this.lastWorld } : { kind: 'generated', ...this.lastGenerated };
      },
      'map-tabs',
    );
    sec.querySelector('.setup-sec-head')!.append(tabs);

    const grid = el('div', 'map-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Maps');
    const thumb = (key: ThumbKey, title: string, meta: string, tip: string, isOn: () => boolean, pick: () => void): HTMLButtonElement => {
      const b = el('button', 'map-thumb');
      b.type = 'button';
      b.title = tip;
      const pic = el('div', 'map-pic');
      pic.append(el('span', 'map-pic-wait', 'Loading preview'));
      b.append(pic, el('span', 'map-name', title), el('span', 'map-meta', meta));
      b.addEventListener('click', () => {
        pick();
        this.changed();
      });
      // Previews are made one at a time in the background (each one decodes or generates a map).
      requestThumb(key, (url) => {
        const img = el('img');
        img.src = url;
        img.alt = '';
        pic.replaceChildren(img);
      });
      this.syncs.push(() => {
        const on = isOn();
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      return b;
    };
    const genItems = MAP_TYPE_LIST.map((t) =>
      thumb(`gen:${t}`, mapTypeName(t), TYPE_HINT[t], `${mapTypeName(t)}: ${TYPE_HINT[t].toLowerCase()}. Each seed makes a new map.`, () => this.s.map.kind === 'generated' && this.s.map.type === t, () => {
        const size = this.s.map.kind === 'generated' ? this.s.map.size : this.lastGenerated.size;
        this.s.map = { kind: 'generated', type: t, size };
        this.lastGenerated = { type: t, size };
      }),
    );
    const worldItems = listWorldMaps().map((m) =>
      thumb(`world:${m.id}`, m.name, `${fmtK(m.landTiles)} land tiles`, `${m.name}: ${m.spawns.length} countries. ${m.description}`, () => this.s.map.kind === 'world' && this.s.map.id === m.id, () => {
        this.s.map = { kind: 'world', id: m.id };
        this.lastWorld = m.id;
      }),
    );
    grid.append(...genItems, ...worldItems);
    this.fadeEdge(grid);
    this.syncs.push(() => {
      for (const b of genItems) b.classList.toggle('hidden', this.mapTab !== 'generated');
      for (const b of worldItems) b.classList.toggle('hidden', this.mapTab !== 'world');
      grid.classList.toggle('world', this.mapTab === 'world');
    });

    const size = this.seg<MapSize>(
      'Map size',
      MAP_SIZE_LIST.map((id) => ({ id, label: mapSizeName(id) })),
      () => (this.s.map.kind === 'generated' ? this.s.map.size : 'medium'),
      (v) => {
        if (this.s.map.kind !== 'generated') return;
        this.s.map = { ...this.s.map, size: v };
        this.lastGenerated = { type: this.s.map.type, size: v };
      },
    );
    const sizeField = this.field('Size', size);
    const worldNote = el('p', 'setup-note world-note');
    this.syncs.push(() => {
      sizeField.classList.toggle('hidden', this.s.map.kind !== 'generated');
      worldNote.classList.toggle('hidden', this.s.map.kind !== 'world');
      if (this.s.map.kind === 'world') {
        const info = getWorldMap(this.s.map.id);
        setText(worldNote, info ? `AI nations are real countries and start at their capitals (${info.spawns.length} on this map). Map data: Natural Earth.` : '');
      }
    });

    sec.append(grid, sizeField, worldNote, this.mapOptions());
    return sec;
  }

  /** Folded: neutral land (tribes) and, in single player, the seed. */
  private mapOptions(): HTMLElement {
    const fold = this.fold('Map options', 'map-opts', () => {
      const n = tribesFor(this.s);
      const tribes = `${n} tribes${this.s.tribeCount < 0 ? ' (auto)' : ''}`;
      return this.lobby ? tribes : `${tribes}, seed ${this.prefs.seed}`;
    });

    // Neutral land: Auto, or a number on the slider.
    const trOut = el('output', 'range-val wide');
    const tr = el('input', 'range');
    tr.type = 'range';
    tr.min = '0';
    tr.max = String(MAX_TRIBE_COUNT);
    tr.step = '10';
    tr.setAttribute('aria-label', 'Tribes');
    tr.addEventListener('input', () => {
      this.s.tribeCount = Number(tr.value);
      this.changed();
    });
    const auto = button('Auto', 'mini-btn', () => {
      this.s.tribeCount = -1;
      this.changed();
    });
    this.syncs.push(() => {
      const n = tribesFor(this.s);
      tr.value = String(n);
      const isAuto = this.s.tribeCount < 0;
      setText(trOut, String(n));
      auto.classList.toggle('on', isAuto);
      auto.setAttribute('aria-pressed', String(isAuto));
      auto.title = `Pick the number for this map (${defaultTribeCount(this.s.map, this.s.modifiers.compactMap, landEstimate(this.s.map, this.s.modifiers.compactMap))} tribes)`;
    });
    const trRow = el('div', 'range-row');
    trRow.append(auto, tr, trOut);
    fold.body.append(
      this.field('Neutral land (tribes)', trRow),
      el('p', 'setup-note field-note', 'Small tribes you can take before you meet other nations. More tribes, more land to grab early.'),
    );

    if (!this.lobby) {
      const seedRow = el('div', 'seed-row');
      const seed = el('input', 'input seed-in');
      seed.type = 'number';
      seed.min = '1';
      seed.value = String(this.prefs.seed);
      seed.setAttribute('aria-label', 'Map seed');
      seed.addEventListener('input', () => {
        const v = Math.floor(Number(seed.value));
        if (Number.isFinite(v) && v > 0) {
          this.prefs.seed = v;
          setText(fold.valueEl, `${tribesFor(this.s)} tribes${this.s.tribeCount < 0 ? ' (auto)' : ''}, seed ${v}`);
        }
      });
      const dice = button('', 'icon-btn', () => {
        this.prefs.seed = randomSeed();
        seed.value = String(this.prefs.seed);
        for (const f of this.syncs) f();
      });
      dice.setAttribute('aria-label', 'New random seed');
      dice.title = 'New random seed';
      dice.innerHTML = lineIcon('shuffle', 16);
      seedRow.append(seed, dice);
      fold.body.append(this.field('Seed', seedRow), el('p', 'setup-note field-note', 'The same seed and settings make the same map.'));
    }
    return fold.box;
  }

  private playersSection(): HTMLElement {
    const sec = this.section('Players', 'players-sec');

    // AI nations: a stepper (easy on phones) and a slider for big jumps.
    const aiOut = el('output', 'step-val');
    aiOut.setAttribute('aria-live', 'polite');
    const step = (d: number): void => {
      this.s.aiCount = Math.max(0, Math.min(MAX_AI_COUNT, this.s.aiCount + d));
      this.changed();
    };
    const minus = button('', 'icon-btn step-btn', () => step(-1));
    minus.innerHTML = lineIcon('minus', 14);
    minus.setAttribute('aria-label', 'One AI nation fewer');
    const plus = button('', 'icon-btn step-btn', () => step(1));
    plus.innerHTML = lineIcon('plus', 14);
    plus.setAttribute('aria-label', 'One AI nation more');
    const ai = el('input', 'range');
    ai.type = 'range';
    ai.min = '0';
    ai.max = String(MAX_AI_COUNT);
    ai.setAttribute('aria-label', 'AI nations');
    ai.addEventListener('input', () => {
      this.s.aiCount = Number(ai.value);
      this.changed();
    });
    this.syncs.push(() => {
      ai.value = String(this.s.aiCount);
      setText(aiOut, String(this.s.aiCount));
      minus.disabled = this.s.aiCount <= 0 || this.card.classList.contains('readonly');
      plus.disabled = this.s.aiCount >= MAX_AI_COUNT || this.card.classList.contains('readonly');
    });
    const stepper = el('div', 'stepper');
    stepper.append(minus, aiOut, plus);
    const aiRow = el('div', 'range-row ai-row');
    aiRow.append(stepper, ai);

    const teamsSeg = this.seg<number>(
      'Number of teams',
      Array.from({ length: MAX_TEAMS - MIN_TEAMS + 1 }, (_, k) => ({ id: MIN_TEAMS + k, label: String(MIN_TEAMS + k) })),
      () => this.s.teamCount,
      (v) => (this.s.teamCount = v),
      'teams-seg',
    );
    teamsSeg.title = this.lobby ? 'Number of teams' : 'Number of teams (you lead team 1)';
    this.syncs.push(() => teamsSeg.classList.toggle('hidden', this.s.mode !== 'teams'));
    const modeRow = el('div', 'mode-row');
    modeRow.append(this.seg<GameMode>('Mode', MODE_OPTS, () => this.s.mode, (v) => (this.s.mode = v)), teamsSeg);

    const diffNote = el('p', 'setup-note field-note diff-note');
    this.syncs.push(() => setText(diffNote, DIFFICULTY_HINT[this.s.difficulty] ?? ''));
    sec.append(
      this.field('AI nations', aiRow),
      this.field('Difficulty', this.seg<Difficulty>('Difficulty', DIFFICULTY_OPTS, () => this.s.difficulty, (v) => (this.s.difficulty = v))),
      diffNote,
      this.field('Mode', modeRow),
    );
    return sec;
  }

  private rulesSection(): HTMLElement {
    const sec = this.section('Rules', 'rules-col');
    const m = (): Modifiers => this.s.modifiers;
    const flag = (key: 'randomSpawn' | 'compactMap' | 'noAlliances' | 'noNukes' | 'noAir' | 'noNavy' | 'noSams', name: string, detail: string) =>
      this.modRow(name, detail, this.toggle(name, () => m()[key], (v) => (m()[key] = v)));
    const mult = (x: number) => `×${x}`;
    const group = (title: string, rows: HTMLElement[]): HTMLElement => {
      const g = el('div', 'mod-group');
      g.append(el('h4', 'mod-group-h', title), ...rows);
      return g;
    };

    // The four rules most players touch.
    const common = el('div', 'mod-list');
    common.append(
      this.modRow('Peace time', () => (m().peaceMinutes > 0 ? `Nations can't attack each other for ${m().peaceMinutes} minutes; tribes can be attacked` : 'Wars between nations can start at once'), this.seg<number>('Peace time', PEACE_MINUTES.map((x) => ({ id: x, label: x ? `${x} min` : 'Off' })), () => m().peaceMinutes, (v) => (m().peaceMinutes = v))),
      this.modRow('Game speed', () => (m().fastGame ? 'Income, growth, building, research and fronts at double speed' : 'Everything at its usual pace'), this.seg<'normal' | 'fast'>('Game speed', [{ id: 'normal', label: 'Normal' }, { id: 'fast', label: 'Fast' }], () => (m().fastGame ? 'fast' : 'normal'), (v) => (m().fastGame = v === 'fast'), 'speed-seg')),
      this.modRow('Time limit', () => (this.s.timeLimit > 0 ? 'When time runs out, the highest score wins' : 'Play until someone wins'), this.seg<number>('Time limit', TIME_LIMIT_MINUTES.map((x) => ({ id: x * 60, label: x ? `${x} min` : 'Off' })), () => this.s.timeLimit, (v) => (this.s.timeLimit = v))),
      this.modRow('Research', () => (m().research === 'allUnlocked' ? 'Every nation starts with every technology' : m().research === 'off' ? 'No research: what needs a technology stays locked' : 'Research techs with science and gold; buy Arsenal items'), this.seg<ResearchRule>('Research', RESEARCH_OPTS, () => m().research, (v) => (m().research = v))),
    );

    // The other twelve, folded, in three groups.
    const economy = group('Economy', [
      this.modRow('Starting gold', () => `Every nation starts with ${STARTING_GOLD[m().startingGold].toLocaleString('en-US')} gold`, this.seg<StartingGold>('Starting gold', GOLD_START_OPTS, () => m().startingGold, (v) => (m().startingGold = v))),
      this.modRow('Gold income', 'From land, cities and markets', this.seg<number>('Gold income', GOLD_MULTIPLIERS.map((x) => ({ id: x, label: mult(x) })), () => m().goldMultiplier, (v) => (m().goldMultiplier = v))),
      this.modRow('Troop growth', 'How fast troops regrow toward the cap', this.seg<number>('Troop growth', GROWTH_MULTIPLIERS.map((x) => ({ id: x, label: mult(x) })), () => m().troopGrowth, (v) => (m().troopGrowth = v))),
      this.modRow('Build speed', () => (m().buildSpeed === 'instant' ? 'Buildings and upgrades finish at once' : m().buildSpeed === 'fast' ? 'Buildings and upgrades take a third of the time' : 'Buildings and upgrades take their usual time'), this.seg<BuildSpeed>('Build speed', BUILD_OPTS, () => m().buildSpeed, (v) => (m().buildSpeed = v))),
    ]);
    const combat = group('Combat', [
      flag('noNukes', 'No atom bombs', 'Silos launch rockets only'),
      flag('noAir', 'No air force', 'No airfields, bombers, fighters or paratroopers'),
      flag('noNavy', 'No warships', 'Transports and trade ships still sail'),
      flag('noSams', 'No SAM sites', 'Only fighters can stop bombers and missiles'),
    ]);
    const mapWin = group('Map and victory', [
      flag('randomSpawn', 'Random starts', 'Every start is picked for you, at random'),
      flag('compactMap', 'Compact map', 'Half the size: a quarter of the land, fewer tribes'),
      flag('noAlliances', 'No alliances', 'Nobody can ally (teammates stay allied)'),
      this.modRow('Victory', () => `Hold ${Math.round(this.s.victoryLandShare * 100)}% of the land to win${this.s.victoryLandShare === VICTORY_LAND_SHARE ? ' (standard)' : ''}`, this.seg<number>('Land share to win', VICTORY_SHARES.map((x) => ({ id: x, label: `${Math.round(x * 100)}%` })), () => this.s.victoryLandShare, (v) => (this.s.victoryLandShare = v))),
    ]);
    const moreChanged = (): number => {
      const s = this.s;
      const d = DEFAULT_SETUP.modifiers;
      const keys: (keyof Modifiers)[] = ['startingGold', 'goldMultiplier', 'troopGrowth', 'buildSpeed', 'noNukes', 'noAir', 'noNavy', 'noSams', 'randomSpawn', 'compactMap', 'noAlliances'];
      return keys.filter((k) => s.modifiers[k] !== d[k]).length + (s.victoryLandShare !== VICTORY_LAND_SHARE ? 1 : 0);
    };
    const fold = this.fold('More rules (12)', 'more-rules', () => {
      const n = moreChanged();
      return n ? `${n} changed` : '';
    }, 'more-rules');
    this.syncs.push(() => fold.box.classList.toggle('has-changes', moreChanged() > 0));

    const reset = button('Reset rules', 'ghost mini-btn', () => {
      const keep = cloneSetup(this.s);
      this.prefs.setup = { ...keep, modifiers: { ...DEFAULT_SETUP.modifiers }, timeLimit: 0, victoryLandShare: VICTORY_LAND_SHARE };
      this.changed();
    });
    reset.title = 'Every rule back to standard, the four above included';
    this.syncs.push(() => {
      reset.disabled = this.card.classList.contains('readonly') || activeModifiers(this.s).filter((x) => x.id !== 'teams').length === 0;
    });
    const resetRow = el('div', 'fold-foot');
    resetRow.append(reset);
    fold.body.append(economy, combat, mapWin, resetRow);
    sec.append(common, fold.box);
    return sec;
  }
}

/** Starts making every map preview in the background (the title screen calls it so the setup screen opens ready). */
export function prefetchThumbs(): void {
  for (const t of MAP_TYPE_LIST) requestThumb(`gen:${t}`, () => {});
  for (const m of listWorldMaps()) requestThumb(`world:${m.id}`, () => {});
}

/** Preset name for an id (the in-game chips' tooltip). */
export function presetName(id: PresetId): string {
  return PRESETS.find((p) => p.id === id)?.name ?? 'Custom';
}
