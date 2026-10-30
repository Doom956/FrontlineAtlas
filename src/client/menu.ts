// Title screen, game settings and the "How to play" page. Also hosts small DOM helpers shared with the HUD.
import { BUILDINGS, BUILDING_ORDER, DEFAULT_AI_COUNT, MATCHUP, MAX_AI_COUNT, TECHS, TECH_ORDER, TERRAIN, VICTORY_LAND_SHARE } from '../sim/config';
import type { Difficulty, GameSettings, MapSize, MapType, TerrainId } from '../sim/types';
import { defaultTribeCount, rulesTextEntries } from './compat';
import { lineIcon, worldGlyph } from './hud/glyph';
import { ABILITY_TEXT, BUILDING_SHORT, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect } from './hud/text';

// ------------------------------------------------------------------------------------------------ DOM helpers

/** Creates an element with an optional class string and text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Button with a click handler. */
export function button(label: string, cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el('button', 'btn ' + cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function rgbCss(c: readonly [number, number, number], a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Text setter that skips the DOM write when nothing changed. */
export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

// ------------------------------------------------------------------------------------------------ settings

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

const MAP_TYPES: { id: MapType; label: string }[] = [
  { id: 'continents', label: 'Continents' },
  { id: 'pangaea', label: 'Pangaea' },
  { id: 'archipelago', label: 'Archipelago' },
  { id: 'highlands', label: 'Highlands' },
];
const MAP_SIZES_UI: { id: MapSize; label: string }[] = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
  { id: 'huge', label: 'Huge' },
];
type TribeLevel = 'none' | 'few' | 'normal' | 'many';
const TRIBE_LEVELS: { id: TribeLevel; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'few', label: 'Few' },
  { id: 'normal', label: 'Normal' },
  { id: 'many', label: 'Many' },
];
const TRIBE_FACTOR: Record<TribeLevel, number> = { none: 0, few: 0.5, normal: 1, many: 1.5 };

/** Tribe count for a map size and menu level (config default x 0 / 0.5 / 1 / 1.5). */
export function tribesForLevel(size: MapSize, level: TribeLevel): number {
  return Math.round(defaultTribeCount(size) * TRIBE_FACTOR[level]);
}

const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Hard' },
];

interface MenuPrefs {
  mapType: MapType;
  mapSize: MapSize;
  aiCount: number;
  difficulty: Difficulty;
  seed: number;
  playerName: string;
  color: number; // palette index
  tribes: TribeLevel;
}

const PREFS_KEY = 'borderfall.menu';

function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999999);
}

function loadPrefs(): MenuPrefs {
  const d: MenuPrefs = { mapType: 'continents', mapSize: 'medium', aiCount: DEFAULT_AI_COUNT.medium, difficulty: 'normal', seed: randomSeed(), playerName: 'Player', color: 0, tribes: 'normal' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<MenuPrefs>;
    return {
      mapType: MAP_TYPES.some((m) => m.id === p.mapType) ? (p.mapType as MapType) : d.mapType,
      mapSize: MAP_SIZES_UI.some((m) => m.id === p.mapSize) ? (p.mapSize as MapSize) : d.mapSize,
      aiCount: Number.isInteger(p.aiCount) ? Math.max(2, Math.min(MAX_AI_COUNT, p.aiCount as number)) : d.aiCount,
      difficulty: DIFFICULTIES.some((m) => m.id === p.difficulty) ? (p.difficulty as Difficulty) : d.difficulty,
      seed: d.seed, // a fresh seed every visit
      playerName: typeof p.playerName === 'string' && p.playerName.trim() ? p.playerName.slice(0, 20) : d.playerName,
      color: Number.isInteger(p.color) && (p.color as number) >= 0 && (p.color as number) < PLAYER_PALETTE.length ? (p.color as number) : 0,
      tribes: TRIBE_LEVELS.some((m) => m.id === p.tribes) ? (p.tribes as TribeLevel) : d.tribes,
    };
  } catch {
    return d;
  }
}

function savePrefs(p: MenuPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: ignore */
  }
}

export function settingsFromPrefs(p: MenuPrefs): GameSettings {
  return {
    seed: p.seed,
    mapType: p.mapType,
    mapSize: p.mapSize,
    aiCount: p.aiCount,
    difficulty: p.difficulty,
    playerName: p.playerName.trim() || 'Player',
    playerColor: PLAYER_PALETTE[p.color] ?? PLAYER_PALETTE[0],
    humanPlayer: true,
    timeLimit: 0,
    victoryLandShare: VICTORY_LAND_SHARE,
    tribeCount: tribesForLevel(p.mapSize, p.tribes),
  };
}

// ------------------------------------------------------------------------------------------------ how to play

const TROOP_LABEL = { infantry: 'Infantry', armor: 'Armor', artillery: 'Artillery' } as const;

/** Rules summary used by the menu and the in-game help overlay. */
export function howToPlayContent(): HTMLElement {
  const root = el('div', 'howto');
  const section = (title: string): HTMLElement => {
    const s = el('section', 'howto-sec');
    s.append(el('h3', '', title));
    root.append(s);
    return s;
  };
  const para = (parent: HTMLElement, text: string) => parent.append(el('p', '', text));
  const bullets = (parent: HTMLElement, items: string[]) => {
    const ul = el('ul', 'hlist');
    for (const t of items) ul.append(el('li', '', t));
    parent.append(ul);
  };
  const glyphItem = (icon: string, title: string, text: string, key?: string): HTMLLIElement => {
    const li = el('li');
    const ic = el('span', 'ico');
    ic.innerHTML = icon;
    const t = el('span');
    t.append(el('b', '', title));
    if (key) t.append(el('kbd', '', key));
    t.append(document.createTextNode(` ${text}`));
    li.append(ic, t);
    return li;
  };
  const rules = rulesTextEntries();

  const goal = section('Goal');
  para(goal, `Own ${Math.round(VICTORY_LAND_SHARE * 100)}% of the land or be the last nation standing. At the start, click a land tile to place your capital, then press Start now (or wait for the countdown).`);

  const loop = section('The basics');
  bullets(loop, [
    'Click land next to yours to attack its owner: the empty wilderness, a tribe or a nation. Your whole shared border moves, not just the clicked spot.',
    'ATTACK (bottom bar, keys [ and ]) is the share of your troops each click sends. Click again to send more. Sending more than the defender has at home loses fewer troops per tile.',
    'Your troops regrow by themselves, fastest near the brass marker on the troop bar (about 40% of the cap). A full bar barely grows: keep spending troops.',
    'More land, Cities and Farms raise the troop cap. Gold comes from land, cities and Markets.',
    'Right-click (or long-press) any tile for the radial menu: the middle button is the likely action, the ring has the rest.',
    'Everything has a hover tip. Press L for the map key: what each terrain, resource and symbol means.',
  ]);

  const screen = section('The screen');
  bullets(screen, [
    'Bottom: troops, attack share, gold, and the build bar (Economy, Military, Defence, Special).',
    'Top left: the standings. Click a nation to see its card: army, land, Ally, Gift, Embargo, Attack.',
    'Top right: Army (U), Research (T), Diplomacy (P), Events (J), Map key (L), the clock, speed, sound and the menu.',
    'The advisor line above the bottom bar suggests a useful next step; switch it off in the menu.',
  ]);

  if (rules.length) {
    const rs = section('Rules in short');
    for (const [k, t] of rules) {
      const p = el('p');
      if (k) p.append(el('b', '', k + ': '));
      p.append(t);
      rs.append(p);
    }
  }

  const tribes = section('Tribes');
  para(tribes, 'Tribes are small, weak peoples spread over the map: their land has a pale wash and small names. They are cheap to conquer and accept any alliance: easy land in the first minutes.');

  const troops = section('Troops and counters');
  para(troops, 'Infantry grows by itself. Factories turn infantry into Armor, Arsenals into Artillery. With Auto on (the default) your mix counters your neighbours; open Army (U) to set it yourself. Army sizes are public; the troop mix of a nation shows only near your Watchtowers or for allies.');
  const t = el('table', 'tbl');
  const head = el('tr');
  head.append(el('th', '', 'Attacker'));
  for (const d of ['infantry', 'armor', 'artillery'] as const) head.append(el('th', '', `vs ${TROOP_LABEL[d]}`));
  t.append(head);
  for (const a of ['infantry', 'armor', 'artillery'] as const) {
    const r = el('tr');
    r.append(el('td', 'b', TROOP_LABEL[a]));
    for (const d of ['infantry', 'armor', 'artillery'] as const) {
      const v = MATCHUP[a][d];
      r.append(el('td', v > 1.05 ? 'good' : v < 0.95 ? 'bad' : '', `x${v.toFixed(1)}`));
    }
    t.append(r);
  }
  troops.append(t);
  para(troops, 'Armor: fast and strong on open ground, poor in rough terrain, burns oil. Artillery: breaks forts, fragile alone. Infantry: best in forest, hills and mountains.');

  const ter = section('Terrain');
  const tl = el('ul', 'blist');
  for (const id of [2, 3, 4, 5, 6, 7, 8] as TerrainId[]) tl.append(glyphItem(worldGlyph(TERRAIN_GLYPH[id], 18), TERRAIN[id].name, terrainEffect(id) + '.'));
  ter.append(tl);
  para(ter, 'Fronts far from your capital, cities and supply depots fight weaker (supply overlay: B). Land a Fort protects is hatched.');

  const res = section('Resources');
  const rl = el('ul', 'blist');
  for (const [k, id] of [[1, 'iron'], [2, 'oil'], [3, 'fertile']] as const) rl.append(glyphItem(worldGlyph(id, 18), RESOURCE_TEXT[k].name, RESOURCE_TEXT[k].use));
  res.append(rl);

  const bld = section('Buildings');
  para(bld, 'Pick one in the build bar (or its hotkey) and click your land: it snaps to the nearest free spot, and building near one of yours of the same kind upgrades it. The preview at the cursor says which: green builds, blue upgrades, red explains why not. Buildings that need research appear once the tech is close.');
  const ul = el('ul', 'blist');
  for (const b of BUILDING_ORDER) {
    const info = BUILDINGS[b];
    ul.append(glyphItem(worldGlyph(b, 18), info.name, BUILDING_SHORT[b] + (info.tech ? ` (needs ${TECHS[info.tech].name})` : '') + '.', info.hotkey));
  }
  bld.append(ul);

  const rs2 = section('Research');
  para(rs2, `Science builds up over time (Research Labs add more). ${TECH_ORDER.length} techs in 4 tiers, each costs gold to start. With Auto research on, the next useful tech starts by itself; press T to choose yourself.`);

  const strikes = section('Strikes');
  const sl = el('ul', 'blist');
  sl.append(glyphItem(worldGlyph('paradrop', 18), 'Paratroopers', ABILITY_TEXT.paradrop));
  sl.append(glyphItem(worldGlyph('barrage', 18), 'Artillery barrage', ABILITY_TEXT.barrage));
  strikes.append(sl);
  para(strikes, 'Both are on the radial menu of enemy land and in the Army drawer (U). Planes and missiles flying at you show a red ring with a countdown; shells show a red disc.');

  const nav = section('Navy, air and missiles');
  para(nav, 'Transports carry troops to any coast (click land across the sea). Ports build warships and send trade ships. Airfields build bombers and fighters; silos launch rockets and atom bombs. SAM sites and fighters shoot down what flies over them.');

  const dip = section('Diplomacy');
  para(dip, 'Ally, gift and embargo from a nation\'s card or the radial menu. Allies cannot attack each other. Breaking an alliance makes you a traitor for a while: weaker defence and everyone trusts you less. Symbols next to names: crown = biggest nation, handshake = ally, envelope = alliance request, broken shield = traitor.');

  const ctl = section('Controls');
  const cl = el('table', 'tbl keys-tbl');
  const keys: [string, string][] = [
    ['Left click', 'attack land next to yours; select your building; place a building in build mode'],
    ['Right click / long press', 'radial menu'],
    ['Drag, WASD, arrows', 'pan the map'],
    ['Wheel', 'zoom'],
    ['1-9, 0, Q E R H F G N', 'building hotkeys (Shift to place several)'],
    ['[ and ]', 'attack share -/+'],
    ['U  T  P  J  L', 'Army, Research, Diplomacy, Events, Map key'],
    ['Space', 'pause'],
    ['+ and -', 'game speed'],
    ['V / B / M', 'resource overlay / supply overlay / minimap'],
    ['C', 'centre on your capital'],
    ['? or F1', 'this help'],
    ['Esc', 'cancel or close'],
  ];
  for (const [k, d] of keys) {
    const r = el('tr');
    const kc = el('td');
    kc.append(el('kbd', '', k));
    r.append(kc, el('td', '', d));
    cl.append(r);
  }
  ctl.append(cl);
  return root;
}

// ------------------------------------------------------------------------------------------------ menu

export interface MenuCallbacks {
  onStart: (settings: GameSettings) => void;
}

/** Title screen with Play (settings) and How to play pages. */
export class Menu {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private prefs: MenuPrefs;
  private busy: HTMLElement;

  constructor(root: HTMLElement, private cb: MenuCallbacks) {
    this.prefs = loadPrefs();
    this.el = el('div', 'menu');
    this.card = el('div', 'menu-card');
    this.busy = el('div', 'menu-busy hidden');
    this.el.append(this.card, this.busy);
    root.append(this.el);
    this.showTitle();
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
  show(page: 'title' | 'play' | 'help' = 'title'): void {
    this.el.classList.remove('hidden');
    this.setBusy(null);
    if (page === 'play') this.showPlay();
    else if (page === 'help') this.showHelp();
    else this.showTitle();
  }
  hide(): void {
    this.el.classList.add('hidden');
  }
  setBusy(text: string | null): void {
    this.busy.classList.toggle('hidden', !text);
    this.busy.textContent = text ?? '';
  }
  /** Settings of the last game started from the menu with a new seed (for "Play again"). */
  replaySettings(): GameSettings {
    this.prefs.seed = randomSeed();
    return settingsFromPrefs(this.prefs);
  }

  private reset(cls: string): void {
    this.card.className = 'menu-card ' + cls;
    this.card.replaceChildren();
  }

  private showTitle(): void {
    this.reset('title');
    const kicker = el('div', 'menu-kicker', 'Territory command');
    const logo = el('h1', 'logo', 'Borderfall');
    const sub = el('div', 'tagline', 'Push your borders. Outthink every front.');
    const play = button('New game', 'primary big', () => this.showPlay());
    play.dataset.test = 'menu-play';
    const help = button('How to play', 'big', () => this.showHelp());
    const col = el('div', 'menu-buttons');
    col.append(play, help);
    this.card.append(kicker, logo, sub, col);
  }

  private showHelp(): void {
    this.reset('wide');
    const top = el('div', 'menu-head');
    top.append(button('Back', 'ghost', () => this.showTitle()), el('h2', '', 'How to play'));
    const body = el('div', 'menu-scroll');
    body.append(howToPlayContent());
    this.card.append(top, body);
  }

  private showPlay(): void {
    this.reset('settings');
    const p = this.prefs;
    const top = el('div', 'menu-head');
    top.append(button('Back', 'ghost', () => this.showTitle()), el('h2', '', 'New game'));
    const form = el('div', 'form');

    const row = (label: string, control: HTMLElement): void => {
      const r = el('label', 'form-row');
      r.append(el('span', 'form-label', label), control);
      form.append(r);
    };
    const segmented = <T extends string>(opts: { id: T; label: string }[], get: () => T, set: (v: T) => void): HTMLElement => {
      const g = el('div', 'seg');
      const sync = () => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
      for (const o of opts) {
        const b = button(o.label, '', () => {
          set(o.id);
          sync();
        });
        b.dataset.v = o.id;
        g.append(b);
      }
      sync();
      return g;
    };

    const name = el('input', 'input');
    name.type = 'text';
    name.maxLength = 20;
    name.value = p.playerName;
    name.addEventListener('input', () => (p.playerName = name.value));
    row('Your name', name);

    const colors = el('div', 'palette');
    PLAYER_PALETTE.forEach((c, k) => {
      const b = el('button', 'swatch-btn');
      b.type = 'button';
      b.style.background = rgbCss(c);
      b.title = `Colour ${k + 1}`;
      b.addEventListener('click', () => {
        p.color = k;
        colors.querySelectorAll('.swatch-btn').forEach((x, j) => x.classList.toggle('on', j === k));
      });
      if (k === p.color) b.classList.add('on');
      colors.append(b);
    });
    row('Colour', colors);

    row('Map type', segmented(MAP_TYPES, () => p.mapType, (v) => (p.mapType = v)));
    // Picking a size resets the AI count to that size's default (the slider below can change it).
    let setAiCount = (_n: number): void => {};
    let syncTribes = (): void => {};
    row('Map size', segmented(MAP_SIZES_UI, () => p.mapSize, (v) => {
      p.mapSize = v;
      setAiCount(DEFAULT_AI_COUNT[v]);
      syncTribes();
    }));

    const ai = el('div', 'range-row');
    const aiIn = el('input', 'range');
    aiIn.type = 'range';
    aiIn.min = '2';
    aiIn.max = String(MAX_AI_COUNT);
    aiIn.value = String(p.aiCount);
    const aiVal = el('span', 'range-val', String(p.aiCount));
    aiIn.addEventListener('input', () => {
      p.aiCount = Number(aiIn.value);
      aiVal.textContent = aiIn.value;
    });
    setAiCount = (n: number): void => {
      p.aiCount = n;
      aiIn.value = String(n);
      aiVal.textContent = String(n);
    };
    ai.append(aiIn, aiVal);
    row('AI nations', ai);

    const tribeRow = el('div', 'range-row');
    const tribeVal = el('span', 'range-val');
    syncTribes = (): void => {
      tribeVal.textContent = String(tribesForLevel(p.mapSize, p.tribes));
    };
    const tribes = segmented(TRIBE_LEVELS, () => p.tribes, (v) => {
      p.tribes = v;
      syncTribes();
    });
    tribes.title = 'Small weak AI tribes: easy early targets that accept any alliance';
    syncTribes();
    tribeRow.append(tribes, tribeVal);
    row('Tribes', tribeRow);

    row('Difficulty', segmented(DIFFICULTIES, () => p.difficulty, (v) => (p.difficulty = v)));

    const seedRow = el('div', 'seed-row');
    const seed = el('input', 'input');
    seed.type = 'number';
    seed.min = '1';
    seed.value = String(p.seed);
    seed.addEventListener('input', () => {
      const v = Math.floor(Number(seed.value));
      if (Number.isFinite(v) && v > 0) p.seed = v;
    });
    const dice = button('', 'icon-btn', () => {
      p.seed = randomSeed();
      seed.value = String(p.seed);
    });
    dice.title = 'Random seed';
    dice.innerHTML = lineIcon('shuffle', 16);
    seedRow.append(seed, dice);
    row('Seed', seedRow);

    const start = button('Start game', 'primary big', () => {
      savePrefs(p);
      this.cb.onStart(settingsFromPrefs(p));
    });
    start.dataset.test = 'menu-start';
    const foot = el('div', 'menu-foot');
    foot.append(start);
    this.card.append(top, form, foot);
  }
}
