// Title screen, game settings and the "How to play" page. Also hosts small DOM helpers shared with the HUD.
import { BUILDINGS, BUILDING_ORDER, MATCHUP, TECHS, TECH_ORDER, TERRAIN, VICTORY_LAND_SHARE } from '../sim/config';
import type { GameSettings, TerrainId } from '../sim/types';
import { rulesTextEntries } from './compat';
import { loadSetupPrefs, prefetchThumbs, randomSeed, settingsFromPrefs, SetupScreen, type SetupPrefs } from './setupScreen';
import { lineIcon, worldGlyph } from './hud/glyph';
import { MultiplayerScreen } from './lobby';
import type { NetClient } from '../net/client';
import { ABILITY_TEXT, BUILDING_SHORT, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect } from './hud/text';

// DOM helpers live in dom.ts (re-exported here for older imports).
export { button, el, rgbCss, setText } from './dom';
import { button, el, rgbCss } from './dom';

// ------------------------------------------------------------------------------------------------ settings

// The setup screen (map, players, presets, modifiers) and the remembered settings live in setupScreen.ts.
export { PLAYER_PALETTE, settingsFromPrefs } from './setupScreen';

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
  para(tribes, 'Tribes are small, weak peoples spread over the map: their land is a grey wash with an army number (the name shows when you zoom in). They are cheap to conquer and accept any alliance (but not from a traitor): easy land in the first minutes.');

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
  /** the multiplayer connection (created on first use) */
  net: () => NetClient;
}

/** Title screen with Play (settings) and How to play pages. */
export class Menu {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private prefs: SetupPrefs;
  private busy: HTMLElement;
  private mp: MultiplayerScreen | null = null;

  constructor(root: HTMLElement, private cb: MenuCallbacks) {
    this.prefs = loadSetupPrefs();
    this.el = el('div', 'menu');
    this.card = el('div', 'menu-card');
    this.busy = el('div', 'menu-busy hidden');
    this.el.append(this.card, this.busy);
    root.append(this.el);
    this.showTitle();
    // Map previews for the setup screen, made in the background while the title shows.
    setTimeout(() => prefetchThumbs(), 1500);
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
  show(page: 'title' | 'play' | 'help' | 'multiplayer' = 'title'): void {
    this.el.classList.remove('hidden');
    this.setBusy(null);
    if (page === 'play') this.showPlay();
    else if (page === 'help') this.showHelp();
    else if (page === 'multiplayer') this.showMultiplayer();
    else this.showTitle();
  }
  hide(): void {
    this.el.classList.add('hidden');
    this.closeMultiplayer();
  }
  /** Opens the multiplayer page; with a code, joins that lobby once connected (?lobby= links). */
  openMultiplayer(joinCode?: string): void {
    this.show('multiplayer');
    if (!joinCode) return;
    const net = this.cb.net();
    const tryJoin = () => {
      if (net.online) {
        this.mp?.join(joinCode);
        return true;
      }
      return false;
    };
    if (!tryJoin()) {
      const off = net.onStatus(() => {
        if (tryJoin()) off();
      });
    }
  }
  private closeMultiplayer(): void {
    this.mp?.destroy();
    this.mp = null;
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
  /** The settings the setup screen holds now (same seed). */
  currentSettings(): GameSettings {
    return settingsFromPrefs(this.prefs);
  }

  private reset(cls: string): void {
    this.closeMultiplayer();
    this.card.className = 'menu-card ' + cls;
    this.card.replaceChildren();
  }

  private showTitle(): void {
    this.reset('title');
    const kicker = el('div', 'menu-kicker', 'Territory command');
    const logo = el('h1', 'logo', 'Borderfall');
    const sub = el('div', 'tagline', 'Push your borders. Outthink every front.');
    const play = button('Single player', 'primary big', () => this.showPlay());
    play.dataset.test = 'menu-play';
    play.title = 'A game against AI nations, right here in the browser (no server needed)';
    const online = button('Multiplayer', 'big', () => this.showMultiplayer());
    online.dataset.test = 'menu-mp';
    online.title = 'Public games, or a private lobby with friends';
    const help = button('How to play', 'big', () => this.showHelp());
    const col = el('div', 'menu-buttons');
    col.append(play, online, help);
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

  private showMultiplayer(): void {
    this.reset('mp');
    this.mp = new MultiplayerScreen(this.card, this.prefs, { net: this.cb.net, onBack: () => this.showTitle() });
  }

  private showPlay(): void {
    this.reset('setup');
    new SetupScreen(this.card, this.prefs, {
      onBack: () => this.showTitle(),
      onStart: (settings) => this.cb.onStart(settings),
    });
  }
}
