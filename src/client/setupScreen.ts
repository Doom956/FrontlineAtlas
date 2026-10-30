// The "New game" setup screen: map (generated types and sizes, real-world maps with previews), nations and tribes,
// difficulty, mode and teams, presets, and the modifiers grouped as Economy, Combat and Rules. Everything edits one
// GameSetup (src/sim/setup.ts), the same model the multiplayer lobby uses; the last settings are remembered.
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
  MAP_SIZE_LIST,
  MAP_TYPE_LIST,
  mapLabel,
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
];
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
const fmtK = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

type Opt<T> = { id: T; label: string };

// ------------------------------------------------------------------------------------------------ the screen

export interface SetupCallbacks {
  onBack: () => void;
  onStart: (settings: GameSettings) => void;
}

/**
 * The same screen as a multiplayer lobby: the host edits the settings (each change goes to the server through
 * onChange), everyone else sees them read-only; `side` (players, code, teams, start) becomes a third column and
 * `status` replaces the footer (name, colour, seed, Start).
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
    this.build();
  }

  private get s(): GameSetup {
    return this.prefs.setup;
  }

  /** After any change: preset detection, every control, the summary, and remember it (lobby: send it). */
  private changed(fromPreset = false, remote = false): void {
    if (!fromPreset) this.s.preset = matchPreset(this.s);
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
    this.setEditable(editable);
    this.changed(true, true);
  }

  /** Lobby: everything but the side column read-only for non-hosts. */
  setEditable(on: boolean): void {
    if (this.lobby) this.lobby.editable = on;
    this.card.classList.toggle('readonly', !on);
    for (const c of this.card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.setup-body .setup-col button, .setup-body .setup-col input, .preset-chips button')) {
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

  /** One modifier row: name and a one-line explanation, the control on the trailing side. */
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

  // ---------------------------------------------------------------------------------------------- layout

  private build(): void {
    const card = this.card;
    card.className = 'menu-card setup';
    card.replaceChildren();

    // Head: back, title, presets.
    const top = el('div', 'menu-head setup-head');
    const back = button('Back', 'ghost', () => this.cb.onBack());
    const presets = el('div', 'preset-chips');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Presets');
    for (const p of PRESETS) {
      if (p.id === 'custom') continue;
      const b = button(p.name, 'preset', () => {
        this.prefs.setup = applyPreset(p.id, this.s, Math.random);
        if (this.s.map.kind === 'world') this.lastWorld = this.s.map.id;
        else this.lastGenerated = { type: this.s.map.type, size: this.s.map.size };
        this.mapTab = this.s.map.kind;
        this.changed(true);
      });
      b.dataset.preset = p.id;
      b.title = p.description;
      presets.append(b);
      this.syncs.push(() => {
        const on = this.s.preset === p.id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    const custom = el('span', 'preset-custom', 'Custom');
    custom.title = 'Your own mix of settings';
    presets.append(custom);
    this.syncs.push(() => custom.classList.toggle('hidden', this.s.preset !== 'custom'));
    top.append(back, el('h2', '', this.lobby?.title ?? 'New game'), presets);

    const body = el('div', 'setup-body');
    body.append(this.mapColumn(), this.rulesColumn());
    if (this.lobby) {
      body.classList.add('with-side');
      body.append(this.lobby.side);
    }

    // Summary and start.
    const summary = el('div', 'setup-summary');
    summary.setAttribute('role', 'status');
    const sumMain = el('span', 'sum-main');
    const sumRules = el('span', 'sum-rules');
    summary.append(sumMain, sumRules);
    this.syncs.push(() => {
      const s = this.s;
      const tribes = tribesFor(s);
      const teams = s.mode === 'teams' ? `, ${s.teamCount} teams${this.lobby ? '' : ' (you lead team 1)'}` : '';
      const nations = this.lobby ? `the players + ${s.aiCount} AI nations` : `${s.aiCount} AI nations`;
      setText(sumMain, `${mapLabel(s.map)}${s.modifiers.compactMap ? ' (compact)' : ''}: ${nations}, ${tribes} tribes${teams}.`);
      const mods = activeModifiers(s).filter((m) => m.id !== 'teams');
      setText(sumRules, mods.length ? `Modifiers: ${mods.map((m) => m.label).join(', ')}` : 'Standard rules');
      sumRules.classList.toggle('has-mods', mods.length > 0);
    });

    const foot = el('div', 'menu-foot setup-foot');
    const you = el('div', 'setup-you');
    const name = el('input', 'input');
    name.type = 'text';
    name.maxLength = 20;
    name.value = this.prefs.playerName;
    name.setAttribute('aria-label', 'Your name');
    name.addEventListener('input', () => {
      this.prefs.playerName = name.value;
      saveSetupPrefs(this.prefs);
    });
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
    you.append(el('span', 'form-label', 'You'), name, colors);

    const seedRow = el('div', 'seed-row');
    const seed = el('input', 'input seed-in');
    seed.type = 'number';
    seed.min = '1';
    seed.value = String(this.prefs.seed);
    seed.setAttribute('aria-label', 'Map seed');
    seed.addEventListener('input', () => {
      const v = Math.floor(Number(seed.value));
      if (Number.isFinite(v) && v > 0) this.prefs.seed = v;
    });
    const dice = button('', 'icon-btn', () => {
      this.prefs.seed = randomSeed();
      seed.value = String(this.prefs.seed);
    });
    dice.setAttribute('aria-label', 'New random seed');
    dice.title = 'New random seed';
    dice.innerHTML = lineIcon('shuffle', 16);
    seedRow.append(el('span', 'form-label', 'Seed'), seed, dice);

    const start = button('Start game', 'primary big', () => {
      saveSetupPrefs(this.prefs);
      this.cb.onStart(settingsFromPrefs(this.prefs));
    });
    start.dataset.test = 'menu-start';
    foot.append(you, seedRow, start);

    if (this.lobby) {
      card.append(top, body, summary, this.lobby.status);
      this.changed(true, true);
      this.setEditable(this.lobby.editable);
      return;
    }
    card.append(top, body, summary, foot);
    this.changed(true);
    start.focus({ preventScroll: true });
  }

  private mapColumn(): HTMLElement {
    const col = el('section', 'setup-col map-col');
    col.setAttribute('aria-label', 'Map and players');
    const head = el('div', 'setup-sec-head');
    head.append(el('h3', 'setup-h', 'Map'));
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
    head.append(tabs);

    const grid = el('div', 'map-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', 'Maps');
    const thumb = (key: ThumbKey, title: string, meta: string, tip: string, isOn: () => boolean, pick: () => void): HTMLButtonElement => {
      const b = el('button', 'map-thumb');
      b.type = 'button';
      b.setAttribute('role', 'option');
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
        b.setAttribute('aria-selected', String(on));
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
    const worldNote = el('div', 'setup-note');
    this.syncs.push(() => {
      sizeField.classList.toggle('hidden', this.s.map.kind !== 'generated');
      worldNote.classList.toggle('hidden', this.s.map.kind !== 'world');
      if (this.s.map.kind === 'world') {
        const info = getWorldMap(this.s.map.id);
        setText(worldNote, info ? `AI nations are real countries and start at their capitals (${info.spawns.length} on this map). Made with Natural Earth.` : '');
      }
    });

    // Players.
    const players = el('div', 'setup-sec-head');
    players.append(el('h3', 'setup-h', 'Players'));

    const aiOut = el('output', 'range-val');
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
    });
    const aiRow = el('div', 'range-row');
    aiRow.append(ai, aiOut);

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
    auto.title = 'The default for this map: more land, more tribes';
    this.syncs.push(() => {
      const n = tribesFor(this.s);
      tr.value = String(n);
      const isAuto = this.s.tribeCount < 0;
      setText(trOut, isAuto ? `${n} auto` : String(n));
      auto.classList.toggle('on', isAuto);
      auto.setAttribute('aria-pressed', String(isAuto));
      auto.title = `Default for this map: ${defaultTribeCount(this.s.map, this.s.modifiers.compactMap, landEstimate(this.s.map, this.s.modifiers.compactMap))} tribes`;
    });
    const trRow = el('div', 'range-row');
    trRow.append(tr, trOut, auto);

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

    col.append(
      head,
      grid,
      sizeField,
      worldNote,
      players,
      this.field('AI nations', aiRow),
      this.field('Tribes', trRow),
      this.field('Difficulty', this.seg<Difficulty>('Difficulty', DIFFICULTY_OPTS, () => this.s.difficulty, (v) => (this.s.difficulty = v))),
      this.field('Mode', modeRow),
    );
    return col;
  }

  private rulesColumn(): HTMLElement {
    const col = el('section', 'setup-col rules-col');
    col.setAttribute('aria-label', 'Modifiers');
    const m = (): Modifiers => this.s.modifiers;
    const group = (title: string, rows: HTMLElement[]): HTMLElement => {
      const g = el('div', 'mod-group');
      g.append(el('h3', 'setup-h', title), ...rows);
      return g;
    };
    const flag = (key: 'randomSpawn' | 'compactMap' | 'noAlliances' | 'noNukes' | 'noAir' | 'noNavy' | 'noSams' | 'fastGame', name: string, detail: string) =>
      this.modRow(name, detail, this.toggle(name, () => m()[key], (v) => (m()[key] = v)));
    const mult = (x: number) => `×${x}`;

    const economy = group('Economy', [
      this.modRow('Starting gold', () => `Every nation starts with ${STARTING_GOLD[m().startingGold].toLocaleString('en-US')} gold`, this.seg<StartingGold>('Starting gold', GOLD_START_OPTS, () => m().startingGold, (v) => (m().startingGold = v))),
      this.modRow('Gold income', 'From land, cities and markets', this.seg<number>('Gold income', GOLD_MULTIPLIERS.map((x) => ({ id: x, label: mult(x) })), () => m().goldMultiplier, (v) => (m().goldMultiplier = v))),
      this.modRow('Troop growth', 'How fast troops regrow toward the cap', this.seg<number>('Troop growth', GROWTH_MULTIPLIERS.map((x) => ({ id: x, label: mult(x) })), () => m().troopGrowth, (v) => (m().troopGrowth = v))),
      this.modRow('Build speed', () => (m().buildSpeed === 'instant' ? 'Buildings and upgrades finish at once' : m().buildSpeed === 'fast' ? 'Buildings and upgrades take a third of the time' : 'Buildings and upgrades take their usual time'), this.seg<BuildSpeed>('Build speed', BUILD_OPTS, () => m().buildSpeed, (v) => (m().buildSpeed = v))),
      this.modRow('Research', () => (m().research === 'allUnlocked' ? 'Every nation starts with every technology' : m().research === 'off' ? 'No research: what needs a technology stays locked' : 'Technologies are researched with science and gold'), this.seg<ResearchRule>('Research', RESEARCH_OPTS, () => m().research, (v) => (m().research = v))),
    ]);
    const combat = group('Combat', [
      this.modRow('Peace time', () => (m().peaceMinutes > 0 ? `Nations can't attack each other for ${m().peaceMinutes} minutes; tribes can be attacked` : 'Wars between nations can start at once'), this.seg<number>('Peace time', PEACE_MINUTES.map((x) => ({ id: x, label: x ? `${x} min` : 'Off' })), () => m().peaceMinutes, (v) => (m().peaceMinutes = v))),
      flag('noNukes', 'No atom bombs', 'Silos launch rockets only'),
      flag('noAir', 'No air force', 'No airfields, bombers, fighters or paratroopers'),
      flag('noNavy', 'No warships', 'Transports and trade ships still sail'),
      flag('noSams', 'No SAM sites', 'Only fighters can stop bombers and missiles'),
    ]);
    const rules = group('Rules', [
      flag('randomSpawn', 'Random starts', 'Every start is picked for you, at random'),
      flag('compactMap', 'Compact map', 'Half the size: a quarter of the land, fewer tribes'),
      flag('noAlliances', 'No alliances', 'Nobody can ally (teammates stay allied)'),
      flag('fastGame', 'Fast game', 'Income, growth, building, research and fronts at double speed'),
      this.modRow('Time limit', () => (this.s.timeLimit > 0 ? 'When time runs out, the highest score wins' : 'Play until someone wins'), this.seg<number>('Time limit', TIME_LIMIT_MINUTES.map((x) => ({ id: x * 60, label: x ? `${x} min` : 'Off' })), () => this.s.timeLimit, (v) => (this.s.timeLimit = v))),
      this.modRow('Victory', () => `Hold ${Math.round(this.s.victoryLandShare * 100)}% of the land to win${this.s.victoryLandShare === VICTORY_LAND_SHARE ? ' (standard)' : ''}`, this.seg<number>('Land share to win', VICTORY_SHARES.map((x) => ({ id: x, label: `${Math.round(x * 100)}%` })), () => this.s.victoryLandShare, (v) => (this.s.victoryLandShare = v))),
    ]);
    const reset = button('Standard rules', 'ghost mini-btn', () => {
      const keep = cloneSetup(this.s);
      this.prefs.setup = { ...keep, modifiers: { ...DEFAULT_SETUP.modifiers }, timeLimit: 0, victoryLandShare: VICTORY_LAND_SHARE };
      this.changed();
    });
    reset.title = 'Turn every modifier off';
    const head = el('div', 'setup-sec-head');
    head.append(el('h3', 'setup-h', 'Modifiers'), reset);
    const scroll = el('div', 'rules-scroll');
    scroll.append(economy, combat, rules);
    col.append(head, scroll);
    return col;
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
