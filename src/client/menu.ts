// Title screen, game settings and the "How to play" page. Also hosts small DOM helpers shared with the HUD.
import { BUILDINGS, BUILDING_ORDER, MATCHUP, TECHS, TECH_ORDER, TERRAIN, VICTORY_LAND_SHARE } from '../sim/config';
import type { Difficulty, GameSettings, MapSize, MapType, TerrainId } from '../sim/types';

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
];
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
}

const PREFS_KEY = 'borderfall.menu';

function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999999);
}

function loadPrefs(): MenuPrefs {
  const d: MenuPrefs = { mapType: 'continents', mapSize: 'medium', aiCount: 7, difficulty: 'normal', seed: randomSeed(), playerName: 'Player', color: 0 };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<MenuPrefs>;
    return {
      mapType: MAP_TYPES.some((m) => m.id === p.mapType) ? (p.mapType as MapType) : d.mapType,
      mapSize: MAP_SIZES_UI.some((m) => m.id === p.mapSize) ? (p.mapSize as MapSize) : d.mapSize,
      aiCount: Number.isInteger(p.aiCount) ? Math.max(2, Math.min(15, p.aiCount as number)) : d.aiCount,
      difficulty: DIFFICULTIES.some((m) => m.id === p.difficulty) ? (p.difficulty as Difficulty) : d.difficulty,
      seed: d.seed, // a fresh seed every visit
      playerName: typeof p.playerName === 'string' && p.playerName.trim() ? p.playerName.slice(0, 20) : d.playerName,
      color: Number.isInteger(p.color) && (p.color as number) >= 0 && (p.color as number) < PLAYER_PALETTE.length ? (p.color as number) : 0,
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

  const goal = section('Goal');
  para(goal, `Grow your nation by pushing your borders. Own ${Math.round(VICTORY_LAND_SHARE * 100)}% of the land or be the last nation standing. ` +
    'At the start, click a land tile to place your capital.');

  const troops = section('Troops and counters');
  para(troops, 'Your population is split into workers (make gold) and army. Infantry grows by itself; Factories turn infantry into Armor and Arsenals into Artillery (set the target mix in the Army mix panel).');
  const t = el('table', 'tbl');
  const head = el('tr');
  head.append(el('th', '', 'Attacker → vs'));
  for (const d of ['infantry', 'armor', 'artillery'] as const) head.append(el('th', '', TROOP_LABEL[d]));
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
  para(troops, 'Armor: strong and fast on plains and desert, weak in forest, mountains and swamp, burns oil. Artillery: x2.5 against fortified tiles, fragile without escort. Infantry: best in rough terrain.');

  const ter = section('Terrain');
  const tt = el('table', 'tbl');
  const th = el('tr');
  for (const h of ['Terrain', 'Defence', 'Speed', 'Inf', 'Arm', 'Art']) th.append(el('th', '', h));
  tt.append(th);
  for (const id of [2, 3, 4, 5, 6, 7, 8] as TerrainId[]) {
    const info = TERRAIN[id];
    const r = el('tr');
    const name = el('td', 'b');
    const sw = el('span', 'swatch');
    sw.style.background = rgbCss(info.color);
    name.append(sw, info.name);
    r.append(name, el('td', '', `x${info.defense}`), el('td', '', `x${info.speed}`));
    for (const k of ['infantry', 'armor', 'artillery'] as const) {
      const v = info.attack[k];
      r.append(el('td', v > 1.05 ? 'good' : v < 0.95 ? 'bad' : '', `x${v}`));
    }
    tt.append(r);
  }
  ter.append(tt);

  const sup = section('Supply');
  para(sup, 'Your capital, cities and supply depots are supply sources. Fronts far from them fight weaker (down to 45%). Use the supply overlay (B) to see your reach.');

  const bld = section('Buildings');
  const ul = el('ul', 'blist');
  for (const b of BUILDING_ORDER) {
    const info = BUILDINGS[b];
    const li = el('li');
    li.append(el('kbd', '', info.hotkey), el('b', '', info.name + ': '), info.description + (info.tech ? ` (needs ${TECHS[info.tech].name})` : ''));
    ul.append(li);
  }
  bld.append(ul);

  const res = section('Research');
  para(res, `Science builds up over time (Research Labs add more). Press T to open the tree: ${TECH_ORDER.length} techs in 4 tiers, each costs gold to start.`);

  const nav = section('Navy, air and missiles');
  para(nav, 'Transports carry troops over water to any coast (right-click a coastal tile). Ports build warships and send trade ships. Airfields build bombers and fighters; silos launch rockets and atom bombs. SAM sites shoot them down.');

  const dip = section('Diplomacy');
  para(dip, 'Request alliances, gift gold, embargo trade in the Nations panel. Allies cannot attack each other. Breaking an alliance makes you a traitor for a while: weaker defence and everyone dislikes you.');

  const ctl = section('Controls');
  const cl = el('ul', 'keys');
  const keys: [string, string][] = [
    ['Left click', 'attack enemy/neutral land with the attack panel settings; select own tile'],
    ['Right click', 'context menu (build, attack, transport, bomb, diplomacy)'],
    ['Drag / WASD / arrows', 'pan the map'],
    ['Wheel', 'zoom'],
    ['1-9, 0, Q E R H F G N', 'building hotkeys (hold Shift to place several)'],
    ['[ and ]', 'attack share -/+ 10%'],
    ['T', 'research'],
    ['Space', 'pause'],
    ['+ and -', 'game speed'],
    ['V / B', 'resource / supply overlay'],
    ['C', 'centre on your capital'],
    ['? or F1', 'this help'],
    ['Esc', 'cancel / close'],
  ];
  for (const [k, d] of keys) {
    const li = el('li');
    li.append(el('kbd', '', k), ' ' + d);
    cl.append(li);
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
    const logo = el('h1', 'logo', 'BORDERFALL');
    const sub = el('div', 'tagline', 'Push your borders. Outthink every front.');
    const play = button('Play', 'primary big', () => this.showPlay());
    play.dataset.test = 'menu-play';
    const help = button('How to play', 'big', () => this.showHelp());
    const col = el('div', 'menu-buttons');
    col.append(play, help);
    this.card.append(logo, sub, col);
  }

  private showHelp(): void {
    this.reset('wide');
    const top = el('div', 'menu-head');
    top.append(button('‹ Back', 'ghost', () => this.showTitle()), el('h2', '', 'How to play'));
    const body = el('div', 'menu-scroll');
    body.append(howToPlayContent());
    this.card.append(top, body);
  }

  private showPlay(): void {
    this.reset('settings');
    const p = this.prefs;
    const top = el('div', 'menu-head');
    top.append(button('‹ Back', 'ghost', () => this.showTitle()), el('h2', '', 'New game'));
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
    row('Map size', segmented(MAP_SIZES_UI, () => p.mapSize, (v) => (p.mapSize = v)));

    const ai = el('div', 'range-row');
    const aiIn = el('input', 'range');
    aiIn.type = 'range';
    aiIn.min = '2';
    aiIn.max = '15';
    aiIn.value = String(p.aiCount);
    const aiVal = el('span', 'range-val', String(p.aiCount));
    aiIn.addEventListener('input', () => {
      p.aiCount = Number(aiIn.value);
      aiVal.textContent = aiIn.value;
    });
    ai.append(aiIn, aiVal);
    row('AI nations', ai);

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
    const dice = button('\u{1F3B2}', 'icon-btn', () => {
      p.seed = randomSeed();
      seed.value = String(p.seed);
    });
    dice.title = 'Random seed';
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
