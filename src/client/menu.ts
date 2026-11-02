// Title screen, game settings and the "How to play" page. Also hosts small DOM helpers shared with the HUD.
import type { GameSettings, GameSetup } from '../sim/types';
import { getWorldMap } from '../sim/worldmaps';
import { mapSizeName, mapTypeName } from '../sim/setup';
import { loadSetupPrefs, prefetchThumbs, randomSeed, settingsFromPrefs, SetupScreen, type SetupPrefs } from './setupScreen';
import { activeLobby, MultiplayerScreen } from './lobby';
import type { NetClient } from '../net/client';
import { tutorialButton } from './tutorial/menuEntry';
import { iconSpan, lineIcon } from './hud/glyph';
import './menu.css';

// DOM helpers live in dom.ts (re-exported here for older imports).
export { button, el, rgbCss, setText } from './dom';
import { button, el, rgbCss } from './dom';

// ------------------------------------------------------------------------------------------------ settings

// The setup screen (map, players, presets, modifiers) and the remembered settings live in setupScreen.ts.
export { PLAYER_PALETTE, settingsFromPrefs } from './setupScreen';

// The page itself lives in howto.ts (kept here as an export for older imports).
export { howToPlayContent } from './howto';
import { howToPlayContent } from './howto';

// ------------------------------------------------------------------------------------------------ menu

export interface MenuCallbacks {
  onStart: (settings: GameSettings) => void;
  /** the multiplayer connection (created on first use) */
  net: () => NetClient;
  /** start the tutorial (a single-player practice game) */
  onTutorial?: () => void;
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
    this.el.classList.toggle('at-title', cls === 'title');
    this.card.className = 'menu-card ' + cls;
    this.card.replaceChildren();
  }

  /**
   * The start page: a command column on the leading side over the dimmed live map. One brass action (Play, or Rejoin
   * while the player is still in a lobby), a "Play again" line for returning players, then quiet rows.
   */
  private showTitle(): void {
    this.reset('title');
    const head = el('header', 'menu-title-head');
    head.append(el('h1', 'logo', 'Frontline Atlas'), el('p', 'tagline', 'Push your borders. Outthink every front.'));
    this.card.append(head);

    const lobby = activeLobby();
    if (lobby) {
      const row = el('div', 'menu-rejoin');
      const text = el('span', 'menu-rejoin-text', 'You are in lobby ');
      text.append(el('strong', '', lobby), document.createTextNode('.'));
      const go = button('Rejoin', 'primary', () => this.openMultiplayer());
      go.dataset.test = 'menu-rejoin';
      row.append(text, go);
      this.card.append(row);
    }

    const play = button('', `big menu-play${lobby ? '' : ' primary'}`, () => this.showPlay());
    play.dataset.test = 'menu-play';
    play.title = 'A game against AI nations, right here in the browser (no server needed)';
    play.append(el('span', '', 'Play'), el('span', 'menu-play-note', 'Against AI'));
    this.card.append(play);

    if (hasSavedSetup()) {
      const again = el('div', 'menu-replay');
      const text = el('span', 'menu-replay-text', 'Last setup: ');
      text.append(el('span', 'menu-replay-sum', setupLine(this.prefs.setup)));
      const go = button('Play again', 'ghost', () => this.cb.onStart(this.replaySettings()));
      go.classList.add('mini');
      go.dataset.test = 'menu-replay';
      go.title = 'Start the same setup at once, on a new map seed';
      again.append(text, go);
      this.card.append(again);
    }

    const rows = el('nav', 'menu-rows');
    rows.setAttribute('aria-label', 'More');
    const online = menuRow('Multiplayer', 'Public games, or a private lobby with friends', () => this.showMultiplayer());
    online.dataset.test = 'menu-mp';
    rows.append(online);
    if (this.cb.onTutorial) rows.append(tutorialButton(() => this.cb.onTutorial?.()));
    rows.append(menuRow('How to play', 'The rules and controls on one page', () => this.showHelp()));
    this.card.append(rows);
    // Enter starts: the main action holds the focus (Rejoin while in a lobby).
    requestAnimationFrame(() => {
      if (!this.visible || !this.card.classList.contains('title')) return;
      const main = this.card.querySelector<HTMLButtonElement>('.menu-rejoin .btn, .menu-play');
      main?.focus({ preventScroll: true });
    });
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

// ------------------------------------------------------------------------------------------------ start page helpers

/** A quiet row on the start page: a label, a chevron on the trailing side. */
function menuRow(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button('', 'menu-row', onClick);
  b.title = title;
  b.append(el('span', 'menu-row-label', label), iconSpan(lineIcon('chevronRight', 16, 2)));
  return b;
}

/** True once the setup screen has saved a setup (setupScreen.ts PREFS_KEY). */
function hasSavedSetup(): boolean {
  try {
    return localStorage.getItem('borderfall.setup.v2') !== null;
  } catch {
    return false;
  }
}

const DIFFICULTY_WORD: Record<GameSetup['difficulty'], string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard', brutal: 'Brutal' };

/** "Medium continents, 8 AI nations, Normal" (teams: ", 3 teams"). */
function setupLine(s: GameSetup): string {
  const map = s.map.kind === 'world' ? `${getWorldMap(s.map.id)?.name ?? 'World'} map` : `${mapSizeName(s.map.size)} ${mapTypeName(s.map.type).toLowerCase()}`;
  const ai = s.aiCount === 1 ? '1 AI nation' : `${s.aiCount} AI nations`;
  const teams = s.mode === 'teams' ? `, ${s.teamCount} teams` : '';
  return `${map}, ${ai}, ${DIFFICULTY_WORD[s.difficulty]}${teams}`;
}
