// Title screen, game settings and the "How to play" page. Also hosts small DOM helpers shared with the HUD.
import type { GameSettings } from '../sim/types';
import { loadSetupPrefs, prefetchThumbs, randomSeed, settingsFromPrefs, SetupScreen, type SetupPrefs } from './setupScreen';
import { MultiplayerScreen } from './lobby';
import type { NetClient } from '../net/client';
import { tutorialButton, tutorialHint } from './tutorial/menuEntry';

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
    this.card.className = 'menu-card ' + cls;
    this.card.replaceChildren();
  }

  private showTitle(): void {
    this.reset('title');
    const kicker = el('div', 'menu-kicker', 'Territory command');
    const logo = el('h1', 'logo', 'Frontline Atlas');
    const sub = el('div', 'tagline', 'Push your borders. Outthink every front.');
    const play = button('Single player', 'primary big', () => this.showPlay());
    play.dataset.test = 'menu-play';
    play.title = 'A game against AI nations, right here in the browser (no server needed)';
    const online = button('Multiplayer', 'big', () => this.showMultiplayer());
    online.dataset.test = 'menu-mp';
    online.title = 'Public games, or a private lobby with friends';
    const tut = tutorialButton(() => this.cb.onTutorial?.());
    const help = button('How to play', 'big', () => this.showHelp());
    const col = el('div', 'menu-buttons');
    col.append(play, online, tut, help);
    this.card.append(kicker, logo, sub, col);
    const hint = this.cb.onTutorial ? tutorialHint(() => this.cb.onTutorial?.()) : null;
    if (hint) this.card.append(hint);
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
