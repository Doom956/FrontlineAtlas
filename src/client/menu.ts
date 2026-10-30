// Title screen, game settings and the "How to play" page. Also hosts small DOM helpers shared with the HUD.
import {
  ATOM_RADIUS,
  BARRAGE_DISABLE_SECONDS,
  BARRAGE_MIN_ARTILLERY,
  BARRAGE_RANGE,
  BOMBER_RADIUS,
  BUILDINGS,
  BUILDING_ORDER,
  MATCHUP,
  PARADROP_RANGE,
  ROCKET_RADIUS,
  TECHS,
  TECH_ORDER,
  TERRAIN,
  VICTORY_LAND_SHARE,
  DOCTRINE_ADAPT_SECONDS,
  DOCTRINE_LEVEL_SECONDS,
  DOCTRINE_SWITCH_COOLDOWN,
  DOCTRINE_UNLOCK_SECONDS,
} from '../sim/config';
import type { GameSettings, TerrainId } from '../sim/types';
import { rulesTextEntries } from './compat';
import { loadSetupPrefs, prefetchThumbs, randomSeed, settingsFromPrefs, SetupScreen, type SetupPrefs } from './setupScreen';
import { lineIcon, worldGlyph } from './hud/glyph';
import { MultiplayerScreen } from './lobby';
import type { NetClient } from '../net/client';
import { BUILDING_SHORT, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect } from './hud/text';
import { iconDataUrl, type IconId } from './icons';
import { STRIKE_ORDER, STRIKES, type StrikeId } from './strikes';
import { UNIT_TEXT } from './forces';

// DOM helpers live in dom.ts (re-exported here for older imports).
export { button, el, rgbCss, setText } from './dom';
import { button, el, rgbCss } from './dom';

// ------------------------------------------------------------------------------------------------ settings

// The setup screen (map, players, presets, modifiers) and the remembered settings live in setupScreen.ts.
export { PLAYER_PALETTE, settingsFromPrefs } from './setupScreen';

// ------------------------------------------------------------------------------------------------ how to play

const TROOP_LABEL = { infantry: 'Infantry', armor: 'Armor', artillery: 'Artillery' } as const;

/** Help page: one line per strike, what it needs first and what it does. */
const STRIKE_HELP: Record<StrikeId, string> = {
  barrage: `Needs an Arsenal and ${BARRAGE_MIN_ARTILLERY.toLocaleString('en-US')} artillery. Shells enemy land up to ${BARRAGE_RANGE} tiles from your border: kills troops and silences forts and SAM sites for ${BARRAGE_DISABLE_SECONDS} s.`,
  bomb: `Needs Flight, an Airfield and a bomber built there. Wrecks buildings and kills troops within ${BOMBER_RADIUS} tiles.`,
  paradrop: `Needs Flight and an Airfield. Drops infantry up to ${PARADROP_RANGE} tiles away; they attack from where they land.`,
  rocket: `Needs Rocketry and a Missile Silo. Hits anywhere on the map: destroys enemy buildings within ${ROCKET_RADIUS} tiles.`,
  atomBomb: `Needs Nuclear Fission and a Missile Silo. Wipes out everything within ${ATOM_RADIUS} tiles, yours too; every nation turns on you.`,
};

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
    'Bottom: troops, attack share, gold (hover the small chip for iron, oil and science), the build bar (four category icons; hover a button for its name and price; Military also sells warships, bombers and fighters) and, when one is ready, the strike icons.',
    'Top left: the standings. Click a nation to see its card: army, land, Ally, Gift, Embargo, Attack.',
    'Top right: Army (U), Forces (Y: warships, aircraft, missiles, artillery), Research (T), Doctrine (Shift+D, from 5:00), Diplomacy (P), Events (J), Map key (L), pause, speed (click to change), the clock, sound, help and the menu.',
    'The advisor line above the bottom bar suggests a useful next step and folds into a small tab after a few seconds (hover it to read it again); switch it off in the menu.',
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

  const doc = section('Doctrines');
  para(
    doc,
    `At ${Math.round(DOCTRINE_UNLOCK_SECONDS / 60)}:00 (half that in a fast game) you can choose a doctrine (Shift+D or the book icon at the top right): a bonus for one style of play, such as Blitz, Fortress, Siege or Merchant. It only adds: every unit, building and strike stays open to everyone. The picker marks the three that suit your land and neighbours.`,
  );
  bullets(doc, [
    `Levels grow while you keep the same doctrine: level 2 after ${Math.round(DOCTRINE_LEVEL_SECONDS[1] / 60)} min, level 3 (a small extra perk) after ${Math.round(DOCTRINE_LEVEL_SECONDS[2] / 60)} min.`,
    `The first choice is free. Switching costs gold, leaves you ${DOCTRINE_ADAPT_SECONDS} s without any doctrine while your nation adapts, starts again at level 1, and then has a ${Math.round(DOCTRINE_SWITCH_COOLDOWN / 60)} min cooldown.`,
    'A neighbour\'s doctrine shows on its card and in the standings tip once you share a border, have a Watchtower near it or are allied: counter it.',
  ]);

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

  const strikes = section('Special strikes');
  para(strikes, 'A strike\'s picture appears at the right end of the bottom bar when it is ready (with a ring while it reloads). Press its key (or click it), then click the target; Esc or right-click cancels. The Forces drawer (Y) lists every strike and says how to unlock the locked ones.');
  const sl = el('ul', 'blist');
  const pic = (id: IconId): string => {
    try {
      return `<img src="${iconDataUrl(id, 18)}" width="18" height="18" alt="">`;
    } catch {
      return '';
    }
  };
  for (const id of STRIKE_ORDER) sl.append(glyphItem(pic(STRIKES[id].icon), STRIKES[id].name, STRIKE_HELP[id], STRIKES[id].key));
  strikes.append(sl);
  para(strikes, 'Counters: SAM sites shoot down planes and missiles (an atom bomb takes two hits). Fighters at an Airfield shoot down bombers and cargo planes. Nothing stops shells. Forts slow attacks down; artillery and barrages break them.');

  const nav = section('Special units');
  para(nav, 'Buy warships, bombers and fighters in the build bar\'s Military tab (or at a Port / Airfield). Forces (Y) lists everything you own with its orders. Click your warship on the map (or Select in Forces), then click water to move it; Esc cancels. Hover any unit, yours or an enemy\'s, to see what it is doing. Enemy units coming at you get a red ring.');
  const ul2 = el('ul', 'blist');
  for (const id of ['warship', 'transport', 'bomber', 'fighter', 'transportPlane', 'rocket', 'atomBomb', 'artillery'] as const) {
    const t = UNIT_TEXT[id];
    ul2.append(glyphItem(pic(t.icon), t.name, `${t.what} Counter: ${t.counter}`, ''));
  }
  nav.append(ul2);

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
    ['U  Y  T  P  J  L', 'Army, Forces, Research, Diplomacy, Events, Map key'],
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
