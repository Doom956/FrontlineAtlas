// DOM HUD in the "war room" style: a calm default screen and depth one click away.
//
// Always visible (and nothing else, so the map stays readable):
//   bottom    command bar: troops (bar with the growth peak), attack share, gold (+ iron/oil/science chips once
//             they matter), build bar with category tabs (hud/commandBar.ts)
//   top-left  standings: top 5 + you, collapsible (hud/leaderboard.ts)
//   top-right cluster: drawer buttons, clock, pause / speed, sound, help, menu (hud/cluster.ts)
// Only when needed: toasts (top centre), the advisor line or tutorial step above the command bar, the spawn bar,
// the target-mode chip, the map tooltip / build preview at the cursor, the radial menu.
// One click away: the drawers on the right (army, research, diplomacy, events, map key, the selected building,
// menu), the nation card on the left, the help page.
//
// The DOM is built once. update() runs every frame but only does cheap work there; texts and lists refresh at
// ~5 Hz through each part's update().
import { reconHint } from './hud/variantOrders';
import { VARIANT_NAMES } from '../sim/variants';
import { buildingAt } from '../sim/buildings';
import { BUILDINGS, DOCTRINES, TICKS_PER_SECOND } from '../sim/config';
import { mods } from '../sim/rules';
import { gameSeconds } from '../sim/state';
import type { GameEvent, GameState, Player } from '../sim/types';
import type { AudioManager } from './audio';
import type { Camera } from './camera';
import { isTribe } from './compat';
import { AdvisorStrip } from './hud/advisor';
import { GuideController } from './guide/guide';
import { tutorialUiFacts } from './tutorial/controller';
import { Cluster } from './hud/cluster';
import { ModChips } from './hud/modChips';
import { CommandBar, techNear } from './hud/commandBar';
import { el, setText, setVisible, type DrawerId, type HudCtx, type UnitProbe } from './hud/dom';
import { ForcesPage } from './hud/forcesPage';
import { DoctrinePage } from './hud/doctrinePage';
import { DOCTRINE_KEY, doctrineIcon, fmtDuration, levelUpText } from './doctrineView';
import { UnitCard } from './hud/unitCard';
import { OrdersBar } from './hud/ordersBar';
import {
  ArmyPage,
  BuildingPage,
  DiplomacyPage,
  Drawer,
  EventsPage,
  LegendPage,
  ResearchPage,
  SettingsPage,
} from './hud/drawers';
import { gameOverCard } from './hud/gameOver';
import { ContinueRow, VictoryChip, type ContinueRole } from './hud/gameOverContinue';
import { AdminConsole } from './adminConsole';
import { pruneSelection, selectionChipText } from './selection';
import { iconSpan, lineIcon } from './hud/glyph';
import { Leaderboard } from './hud/leaderboard';
import { NationCard } from './hud/nationCard';
import { radialSpec as buildRadialSpec } from './hud/radialSpec';
import { Toasts } from './hud/toasts';
import { MapTooltip } from './hud/tooltip';
import { button, howToPlayContent } from './menu';
import { RadialMenu } from './radial';
import type { RadialSpec } from './radial';
import { addFloater } from './uiState';
import { allyEventKind, coalitionLeader } from './allies';
import { swatchCss } from './hud/swatch';
import { instruction, strikeToastText, type StrikeId } from './strikes';
import type { Dispatch, UiState } from './uiState';
import { GameHistory } from './summary/history';
import { summaryView } from './summary/view';

export { techNear };

const SLOW_MS = 200; // ~5 Hz refresh of texts and lists
/** Zoom the camera glides to when your start is placed and when the game starts (your 9x9 start ~40 px wide). */
const START_ZOOM = 4.5;
const TOAST_KINDS: Partial<Record<GameEvent['kind'], 'info' | 'good' | 'bad' | 'warn'>> = {
  underAttack: 'bad',
  surrounded: 'bad',
  capitalLost: 'bad',
  buildingLost: 'bad',
  nuke: 'bad',
  missile: 'bad',
  bombing: 'bad',
  researchDone: 'good',
  allianceFormed: 'good',
  allianceBroken: 'warn',
  allianceExpired: 'warn',
  eliminated: 'info',
  victory: 'good',
  warshipReady: 'good',
  tankDivisionReady: 'good',
  spearheadStarted: 'info',
  spearheadEnded: 'info',
  defeat: 'bad',
};

/** How the HUD runs: single player (default) or an online game. */
export interface HudOptions {
  /** online game: no pause or speed (the server's clock), an eliminated player keeps watching */
  online?: boolean;
  /** whether the Start now button shows (online: only the private lobby's host) */
  canStartNow?: () => boolean;
  /** game-over card: text of the first button (default "Play again") */
  againLabel?: string;
  /**
   * online pause: who may pause (the private lobby's host; 'guest' = a seat in a private game, 'none' = public), whether
   * the game is paused and by whom. Pausing goes through ui.paused (main sends it to the server).
   */
  pause?: () => { mode: 'host' | 'guest' | 'none'; paused: boolean; by: string };
  /** online: who may continue the finished game (gameOverContinue.ts); single player: always 'host' */
  continueRole?: () => ContinueRole;
  /** online: owner console login through the server (adminAuth) */
  adminAuth?: (code: string) => Promise<boolean>;
  /** a tutorial game (tutorial/controller.ts): the first-game steps and the advisor's hints stay quiet */
  tutorial?: boolean;
}

export class Hud {
  /** Set by main: leave to the menu / start a new game with the same settings. */
  onMenu: () => void = () => {};
  onPlayAgain: () => void = () => {};
  /** true while this client only watches: a spectator (humanId 0) or, online, after its nation was eliminated */
  watching = false;

  private el: HTMLElement;
  private state: GameState | null = null;
  private lastSlow = -Infinity;
  private mouse = { x: 0, y: 0 };
  private ac = new AbortController();
  private ctx: HudCtx;

  private bar: CommandBar;
  private board: Leaderboard;
  private cluster: Cluster;
  private modChips = new ModChips();
  private drawer: Drawer;
  private card: NationCard;
  private advisor: AdvisorStrip;
  /** in-game guide (guide/guide.ts): opening steps and tips; none in Tutorial mode chapters */
  private guide: GuideController | null = null;
  private toasts: Toasts;
  private tooltip: MapTooltip;
  private unitCard: UnitCard;
  /** stance / mode bar while warships or tank divisions are selected (hud/ordersBar.ts) */
  private orders: OrdersBar;
  private probe: UnitProbe | null = null;
  private events: EventsPage;
  private building: BuildingPage;
  private radial: RadialMenu;
  /** a tutorial game: its steps say when to pick a doctrine, so the unlock toast stays quiet */
  private tutorialGame = false;
  private ctxOpen: UiState['contextMenu'] = null;
  private tip: HTMLElement;
  private tipTarget: HTMLElement | null = null;
  private help: HTMLElement;
  private gameOver: HTMLElement;
  private gameOverShown = false;
  private continueRow: ContinueRow | null = null;
  private lastContinue = 0;
  private victoryChip = new VictoryChip();
  /** land over time, battles, key moments: the end-of-game summary's data (summary/history.ts) */
  readonly history = new GameHistory();
  private historyFailed = false;
  /** the summary was reopened from the victory chip after a continued game (not the game-over card) */
  private reviewing = false;
  private admin: AdminConsole;
  private spawnBar: HTMLElement;
  private spawnText: HTMLElement;
  private startNowBtn: HTMLButtonElement;
  private modeChip: HTMLElement;
  private modeText: HTMLElement;
  /** online: "Paused by <host>" in the middle of the screen (the host also gets Resume) */
  private pauseBanner: HTMLElement;
  private pauseText: HTMLElement;
  private resumeBtn: HTMLButtonElement;
  private seenEvents = new WeakSet<GameEvent>();
  /** last start position / phase the camera followed (followStart); "" = none yet */
  private startKey = '';
  /** the command bar block (the free map area ends above it) */
  private bottomEl: HTMLElement | null = null;
  /** the help page paused the game (and resumes it when it closes) */
  private helpPaused = false;
  private lastSelected = -1;
  private lastToast: UiState['toast'] = null;
  /** own bombers already announced ("Bomber on its way"); null until the first look (no toasts for old ones) */
  private seenBombers: Set<number> | null = null;
  private coalitionSeen = 0;

  constructor(
    public root: HTMLElement,
    public ui: UiState,
    public dispatch: Dispatch,
    public camera: Camera,
    private audio: AudioManager | null = null,
    private hudOpts: HudOptions = {},
  ) {
    this.el = el('div', 'hud');
    this.el.classList.toggle('online', !!hudOpts.online);
    root.append(this.el);
    const self = this;
    this.ctx = {
      probe: () => self.probe,
      ui,
      dispatch,
      camera,
      state: () => self.state,
      me: () => (self.state && !self.watching ? self.state.players[self.state.humanId] ?? null : null),
      act: (a) => {
        const r = dispatch(a);
        self.refreshSoon();
        // acknowledge what has no visible result yet (the answer comes later as an event)
        if (r.ok && a.type === 'requestAlliance') {
          const to = self.state?.players[a.to];
          if (to) self.toasts.show({ text: `Alliance request sent to ${to.name}`, kind: 'info', icon: 'diplomacy', key: `sent${a.to}` });
        }
        return r.ok;
      },
      confirm: (text, label, run) =>
        self.toasts.show({ text, kind: 'warn', ms: 8000, key: 'confirm', actions: [{ label, primary: true, run }, { label: 'Cancel', run: () => {} }] }),
      refreshSoon: () => self.refreshSoon(),
      openDrawer: (id, toggle) => self.openDrawer(id, toggle),
      closeDrawer: () => self.drawer.hide(),
      openNation: (id) => self.openNation(id),
      focusTile: (t, z) => self.focusTile(t, z),
      toast: (text, kind) => self.toasts.show({ text, kind: kind ?? 'info' }),
      sound: (id) => {
        try {
          self.audio?.play(id);
        } catch {
          /* no audio */
        }
      },
    };

    this.board = new Leaderboard(this.ctx);
    this.card = new NationCard(this.ctx);
    const left = el('div', 'hud-left');
    left.append(this.board.el, this.card.el);

    this.cluster = new Cluster(this.ctx, {
      isOpen: (id) => this.drawer?.open === id,
      muted: () => this.audio?.getSettings().muted ?? false,
      toggleMute: () => this.audio?.setMuted(!this.audio.getSettings().muted),
      toggleHelp: () => this.toggleHelp(),
      hasAudio: () => !!this.audio,
      pauseMode: () => (hudOpts.online ? hudOpts.pause?.().mode ?? 'none' : 'local'),
    });

    this.drawer = new Drawer(this.ctx);
    this.drawer.add(new ArmyPage(this.ctx));
    this.drawer.add(new ForcesPage(this.ctx));
    this.drawer.add(new ResearchPage(this.ctx));
    this.drawer.add(new DoctrinePage(this.ctx));
    this.drawer.add(new DiplomacyPage(this.ctx));
    this.events = new EventsPage(this.ctx);
    this.drawer.add(this.events);
    this.drawer.add(new LegendPage());
    this.building = new BuildingPage(this.ctx);
    this.drawer.add(this.building);
    this.advisor = new AdvisorStrip(this.ctx);
    if (hudOpts.tutorial) this.advisor.quiet();
    this.tutorialGame = !!hudOpts.tutorial;
    if (!hudOpts.tutorial) {
      this.guide = new GuideController(this.ctx, {
        ui: () => tutorialUiFacts(this.ui, this.tutorialView()),
        strike: (id) => this.bar?.strikes.statusOf(id)?.state ?? null,
        modal: () => this.tutorialView().modal,
        strikeTipShown: (id) => this.advisor.seenStrike(id),
        canStartNow: () => hudOpts.canStartNow?.() ?? true,
      });
      // the guide's alliance and air-defence tips: the advisor does not say the same again
      const guide = this.guide;
      this.advisor.covered = (key) => guide.covers(key);
    }
    this.drawer.add(
      new SettingsPage(this.ctx, {
        audio: () => this.audio?.getSettings() ?? null,
        setVolume: (m, s, mu) => this.audio?.setVolume(m, s, mu),
        setMuted: (m) => this.audio?.setMuted(m),
        advisorOn: () => this.advisor.advisorOn,
        setAdvisor: (on) => this.advisor.setAdvisor(on),
        guideOn: () => this.guide?.on ?? false,
        setGuide: (on) => this.guide?.setOn(on),
        restartGuide: () => {
          this.guide?.restart();
          this.drawer.hide();
        },
        leave: () => this.onMenu(),
      }),
    );

    this.bar = new CommandBar(this.ctx);
    const bottom = el('div', 'hud-bottom');
    this.bottomEl = bottom;
    this.orders = new OrdersBar(this.ctx);
    bottom.append(this.orders.el, this.advisor.el, this.bar.el);
    if (this.guide) this.el.append(this.guide.bar.el);

    this.toasts = new Toasts();
    this.tooltip = new MapTooltip(this.ctx);
    this.unitCard = new UnitCard(this.ctx);
    this.tip = el('div', 'tip hidden');
    this.radial = new RadialMenu(() => {
      this.ui.contextMenu = null;
      this.refreshSoon();
    });
    this.radial.el.dataset.test = 'radial';

    // spawn bar and the target-mode chip (top centre, only when needed)
    this.spawnBar = el('div', 'spawnbar hidden');
    this.spawnBar.dataset.test = 'spawnbar';
    this.spawnText = el('span', 'sb-text');
    this.startNowBtn = button('Start now', 'wr-btn primary', () => this.ctx.act({ type: 'startNow' }));
    this.startNowBtn.dataset.test = 'start-now';
    this.spawnBar.append(el('span', 'wr-sec', 'Deployment'), this.spawnText, this.startNowBtn);
    this.modeChip = el('div', 'modechip hidden');
    this.modeChip.dataset.test = 'mode-chip';
    this.modeText = el('span', 'mc-t');
    const cancel = el('button', 'mc-x');
    cancel.type = 'button';
    cancel.append(iconSpan(lineIcon('close', 12, 2)));
    cancel.setAttribute('aria-label', 'Cancel (Esc)');
    cancel.addEventListener('click', () => {
      if (this.ui.mode.kind !== 'none') this.ui.mode = { kind: 'none' };
      else if (this.ui.selection.length) {
        this.ui.selection = [];
        this.ui.pendingSpearhead = null;
      } else this.ui.paused = false;
    });
    this.modeChip.append(this.modeText, cancel);
    const top = el('div', 'hud-top');
    top.append(this.spawnBar, this.modeChip, this.toasts.el);
    this.pauseBanner = el('div', 'pause-banner hidden');
    this.pauseBanner.dataset.test = 'pause-banner';
    this.pauseBanner.setAttribute('role', 'status');
    this.pauseText = el('span', 'pb-t');
    this.resumeBtn = button('Resume', 'wr-btn primary', () => (this.ui.paused = false));
    this.resumeBtn.dataset.test = 'resume';
    this.pauseBanner.append(iconSpan(lineIcon('pause', 18), 'pb-ic'), this.pauseText, this.resumeBtn);

    // help page and game over (modals)
    this.help = el('div', 'modal hidden');
    const hCard = el('div', 'modal-card help');
    const hHead = el('div', 'modal-head');
    const hClose = el('button', 'sq');
    hClose.type = 'button';
    hClose.setAttribute('aria-label', 'Close');
    hClose.append(iconSpan(lineIcon('close', 16)));
    hClose.addEventListener('click', () => this.setHelp(false));
    hHead.append(el('h2', '', 'How to play'), hClose);
    const hBody = el('div', 'modal-scroll');
    hBody.append(howToPlayContent());
    hCard.append(hHead, hBody);
    this.help.append(hCard);
    this.help.addEventListener('pointerdown', (e) => {
      if (e.target === this.help) this.setHelp(false);
    });
    this.gameOver = el('div', 'modal gameover hidden');

    this.el.append(left, this.cluster.el, this.modChips.el, this.drawer.el, bottom, top, this.pauseBanner, this.tooltip.card, this.tooltip.odds, this.unitCard.el, this.radial.el, this.help, this.gameOver, this.tip);
    // after "Continue playing": the recorded winner in the top-right cluster
    this.cluster.el.append(this.victoryChip.el);
    this.victoryChip.onOpen = () => {
      const st = this.state;
      if (st) this.showSummary(st);
    };
    // the hidden owner console ("|"; adminConsole.ts)
    this.admin = new AdminConsole({
      root: this.el,
      ui,
      dispatch,
      state: () => self.state,
      online: !!hudOpts.online,
      auth: hudOpts.adminAuth,
      toast: (text, kind) => self.toasts.show({ text, kind: kind ?? 'info' }),
    });

    const opts = { signal: this.ac.signal };
    // HUD size: 1 up to ~1500 px wide, then grows a little with the window (up to 1.15): readable on big screens
    // without covering more of the map
    const scaleUi = (): void => {
      const k = Math.min(window.innerWidth / 1500, window.innerHeight / 860);
      this.el.style.setProperty('--ui', Math.max(1, Math.min(1.15, k)).toFixed(3));
    };
    scaleUi();
    window.addEventListener('resize', scaleUi, opts);
    window.addEventListener(
      'pointermove',
      (e) => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.tooltip.setMouse(e.clientX, e.clientY);
      },
      opts,
    );
    // Hover tips for any HUD element with data-tip.
    this.el.addEventListener('pointerover', (e) => this.onTipOver(e.target), opts);
    this.el.addEventListener('pointerleave', () => this.hideTip(), opts);
    this.el.addEventListener('pointerdown', () => this.hideTip(), opts);
    // UI sounds
    this.el.addEventListener(
      'click',
      (e) => {
        const b = (e.target as Element | null)?.closest?.('button');
        if (b && !(b as HTMLButtonElement).disabled) this.ctx.sound('uiClick');
      },
      opts,
    );
    // Clicks outside the radial menu close it (presses on the map close it in input.ts, swallowing that click).
    window.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target as Element | null;
        if (this.ui.contextMenu && !this.radial.contains(t) && !t?.closest?.('canvas.map')) this.ui.contextMenu = null;
      },
      { signal: this.ac.signal, capture: true },
    );
  }

  // ============================================================================================ public API

  /** Called every frame; texts and lists refresh at ~5 Hz. */
  update(state: GameState): void {
    const now = performance.now();
    if (this.state !== state) {
      this.state = state;
      this.lastSlow = -Infinity;
    }
    this.feedHistory(state);
    const own = state.humanId > 0 ? state.players[state.humanId] : undefined;
    // Watching: a spectator, or an online player whose nation fell while the others play on. The neutral entry
    // (id 0) stands in for "me" then: nothing is ours, every action UI is hidden.
    // a continued game (Keep watching) is watched the same way in single player
    const watching = !own || ((!!this.hudOpts.online || !!state.continued) && !own.alive && state.phase !== 'over');
    if (watching !== this.watching) this.setWatching(watching);
    const me = own && !watching ? own : own ?? state.players[0];
    if (!me) return;
    this.drainEvents(state, me);
    if (!watching) this.followStart(state, me);
    this.updateFast(state, me);
    if (!watching) this.guide?.frame();
    this.modChips.update(state);
    this.admin.update(state);
    if (now - this.lastSlow >= SLOW_MS) {
      this.lastSlow = now;
      if (!watching) this.bar.update(state, me);
      this.board.update(state, me);
      this.cluster.update(state, me);
      if (!watching) this.card.update(state, me);
      this.drawer.update(state, me);
      this.advisor.toastUp = this.toasts.count > 0;
      if (this.guide) {
        if (watching) this.guide.bar.render(null);
        else this.guide.update(state, me, now);
        // one line at a time: the advisor waits while the guide shows something
        this.advisor.suppressed = this.guide.showing && !watching;
      }
      if (!watching) this.advisor.update(state, me, this.bar.strikes);
      if (!watching) this.announceBombers(state, me);
      if (!watching) this.announceCoalition(state, me);
      this.toasts.update();
      if (!watching) this.tooltip.update(state, me, true);
      this.updateSpawn(state, me);
      // units sunk or lost drop out of the selection (selection.ts)
      if (this.ui.selection.length) this.ui.selection = pruneSelection(state, state.humanId, this.ui.selection);
    }
  }

  /**
   * Marks every event the state holds now as seen (no toasts or history entries for them): an online client replaying
   * a catch-up calls it each frame, so minutes of replayed events don't flood the screen.
   */
  skipEvents(state: GameState): void {
    for (const e of state.events) this.seenEvents.add(e);
  }

  /** The renderer's unit hit test: hover cards for any unit and the selected warship's card follow it. */
  setUnitProbe(p: UnitProbe): void {
    this.probe = p;
  }

  /** Extra HUD parts (the online status line) live inside the HUD so they go away with it. */
  addOverlay(node: HTMLElement): void {
    this.el.append(node);
  }

  private setWatching(on: boolean): void {
    this.watching = on;
    this.el.classList.toggle('watching', on);
    if (on) {
      this.ui.mode = { kind: 'none' };
      this.ui.contextMenu = null;
      this.ui.selectedTile = -1;
      this.card.close();
      if (this.drawer.open && this.drawer.open !== 'events' && this.drawer.open !== 'legend' && this.drawer.open !== 'settings') this.drawer.hide();
      this.radial.close();
    }
  }

  openResearch(): void {
    this.openDrawer('research', true);
  }
  /** A strike hotkey: aim it when ready, else say in one line why not. */
  strike(id: StrikeId): void {
    if (this.watching) return;
    this.bar.strikes.aim(id);
  }
  /** Opens a drawer (closing another); with toggle, a second press closes it. */
  openDrawer(id: DrawerId, toggle = false): void {
    // a watcher has no army, forces, research, diplomacy or buildings of its own
    if (this.watching && id !== 'events' && id !== 'legend' && id !== 'settings') return;
    if (toggle && this.drawer.open === id) {
      this.drawer.hide();
      return;
    }
    // the picker answers "Choose a doctrine" and shows a choice itself: its toast would cover the picker's title
    if (id === 'doctrine') this.toasts.dismiss('doctrine');
    if (id === 'events') {
      this.cluster.setUnread(false);
    }
    this.setHelp(false);
    this.drawer.show(id);
    this.refreshSoon();
  }
  toggleDrawer(id: DrawerId): void {
    this.openDrawer(id, true);
  }
  toggleHelp(): void {
    this.setHelp(this.help.classList.contains('hidden'));
  }
  /** Shows or hides the How to play page; single player pauses while it is open (and resumes if it paused it). */
  private setHelp(open: boolean): void {
    setVisible(this.help, open);
    if (this.hudOpts.online) return;
    if (open && !this.ui.paused) {
      this.ui.paused = true;
      this.helpPaused = true;
    } else if (!open && this.helpPaused) {
      this.helpPaused = false;
      this.ui.paused = false;
    }
  }
  /** Closes the topmost overlay (help, drawer, nation card); true if one was open. */
  closeOverlay(): boolean {
    if (this.admin.close()) return true;
    if (!this.help.classList.contains('hidden')) {
      this.setHelp(false);
      return true;
    }
    if (this.drawer.open) {
      if (this.drawer.open === 'building') this.ui.selectedTile = -1;
      this.drawer.hide();
      return true;
    }
    if (this.card.isOpen) {
      this.card.close();
      return true;
    }
    if (this.reviewing) {
      this.closeSummary();
      return true;
    }
    return false;
  }
  // ------------------------------------------------------------------------------------------ tutorial mode

  /** What is open now, for the tutorial's step checks (tutorial/controller.ts). */
  tutorialView(): { drawer: DrawerId | null; researchTab: 'research' | 'arsenal'; buildMenu: boolean; nationCard: number; modal: boolean } {
    return {
      drawer: this.drawer.open,
      researchTab: this.drawer.page<ResearchPage>('research').currentTab,
      buildMenu: this.bar.quick.menu.open,
      nationCard: this.card.id,
      modal: !this.help.classList.contains('hidden') || !this.gameOver.classList.contains('hidden'),
    };
  }
  /** Opens a panel for a tutorial step: a drawer, the Research drawer on its Arsenal tab, or the build menu. */
  openTutorialPanel(name: DrawerId | 'build' | 'arsenal'): void {
    if (name === 'build') {
      this.drawer.hide();
      this.bar.quick.menu.show();
      return;
    }
    if (this.bar.quick.menu.open) this.bar.quick.menu.close();
    const id: DrawerId = name === 'arsenal' ? 'research' : name;
    if (this.drawer.open !== id) this.openDrawer(id);
    if (id === 'research') this.drawer.page<ResearchPage>('research').setTab(name === 'arsenal' ? 'arsenal' : 'research');
  }
  /** Centres a tile (zooms in when far out). */
  centreOn(tile: number): void {
    this.focusTile(tile, true);
  }

  /** What the radial menu offers for a tile (kept public for tests). */
  radialSpec(state: GameState, me: Player, tile: number): RadialSpec {
    return buildRadialSpec(this.ctx, state, me, tile);
  }
  destroy(): void {
    this.ac.abort();
    this.admin.destroy();
    this.toasts.clear();
    this.el.remove();
    this.root.classList.remove('mm-on');
    this.state = null;
  }

  // ============================================================================================ internals

  private refreshSoon(): void {
    this.lastSlow = -Infinity;
  }

  private openNation(id: number): void {
    const s = this.state;
    const p = s?.players[id];
    if (!s || !p) return;
    if (p.capital >= 0) this.camera.centerOn((p.capital % s.map.width) + 0.5, ((p.capital / s.map.width) | 0) + 0.5);
    if (this.watching) return;
    if (id !== s.humanId) this.card.open(id);
    else this.card.close();
  }

  /**
   * Brings a new player to their land: when they place their start and again when the game starts, the camera glides
   * to the capital at START_ZOOM unless they are already looking at it from close up.
   */
  private followStart(state: GameState, me: Player): void {
    const key = `${me.spawned ? me.capital : -1}:${state.phase === 'spawn' ? 's' : 'p'}`;
    if (key === this.startKey) return;
    const first = this.startKey === '';
    this.startKey = key;
    if (!me.spawned || me.capital < 0 || state.phase === 'over') return;
    // a reload / rejoin into a running game: once, at the start of this view
    if (first && state.phase === 'playing' && gameSeconds(state) > 20) return;
    const w = state.map.width;
    const cx = (me.capital % w) + 0.5;
    const cy = ((me.capital / w) | 0) + 0.5;
    const cam = this.camera;
    const sp = cam.tileToScreen(cx, cy);
    const onScreen = sp.x > cam.viewW * 0.15 && sp.x < cam.viewW * 0.85 && sp.y > cam.viewH * 0.15 && sp.y < cam.viewH * 0.85;
    if (cam.zoom >= START_ZOOM && onScreen) return;
    // centre it in the map area that the HUD leaves free (the command bar and the advisor take the bottom)
    const z = Math.max(cam.zoom, START_ZOOM);
    const top = 60;
    const bottomTop = this.bottomEl?.getBoundingClientRect().top ?? cam.viewH;
    const free = bottomTop > top + 80 ? (top + bottomTop) / 2 : cam.viewH / 2;
    cam.flyTo(cx, cy + (cam.viewH / 2 - free) / z, z, 900);
  }

  private focusTile(tile: number, zoomIn = true): void {
    const s = this.state;
    if (!s || tile < 0) return;
    const w = s.map.width;
    this.camera.centerOn((tile % w) + 0.5, ((tile / w) | 0) + 0.5);
    if (zoomIn && this.camera.zoom < START_ZOOM) this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, START_ZOOM / this.camera.zoom);
  }

  private updateSpawn(state: GameState, me: Player): void {
    const spawn = state.phase === 'spawn';
    setVisible(this.spawnBar, spawn);
    if (!spawn) return;
    const t = Math.ceil(state.spawnLeft);
    let placed = 0;
    let total = 0;
    for (const p of state.players) {
      if (!p || p.id === 0 || p.id === me.id || isTribe(p)) continue;
      total++;
      if (p.spawned) placed++;
    }
    const random = mods(state).randomSpawn;
    if (this.watching) {
      setText(this.spawnText, `Players are choosing their starts: ${placed} of ${total} nations placed, war in ${t} s.`);
      setVisible(this.startNowBtn, false);
      return;
    }
    setText(
      this.spawnText,
      me.spawned
        ? `${random ? 'Your start was picked at random.' : 'Start chosen. Click again to move it.'} ${placed} of ${total} nations placed, war in ${t} s.`
        : `Click a land tile to place your capital. ${t} s.`,
    );
    setVisible(this.startNowBtn, me.spawned && (this.hudOpts.canStartNow?.() ?? true));
  }

  private updateFast(state: GameState, me: Player): void {
    const ui = this.ui;
    // legacy toast channel (dispatch failures, input messages)
    if (ui.toast && ui.toast !== this.lastToast) {
      this.lastToast = ui.toast;
      this.toasts.show({ text: ui.toast.text, kind: 'bad', ms: Math.max(1500, ui.toast.until - performance.now()) });
    }
    this.root.classList.toggle('mm-on', ui.showMinimap);
    // target mode chip
    let chip = '';
    if (state.phase === 'playing') {
      const m = ui.mode;
      if (m.kind === 'build') chip = `Build ${BUILDINGS[m.building].name}: click your land. Esc to cancel.`;
      else if (m.kind === 'transport') chip = 'Transport: click a coast to land on. Esc to cancel.';
      else if (m.kind === 'moveWarship') chip = 'Warship selected: click water to move it. Esc to cancel.';
      else if (m.kind === 'spawnWarship') chip = `${m.variant ? VARIANT_NAMES[m.variant] : 'Warship'}: click water near your port (shaded) where it should appear. Esc to cancel.`;
      else if (m.kind === 'recon') chip = reconHint();
      else if (m.kind === 'buildTankDivision') chip = 'Tank division: click one of your factories. Esc to cancel.';
      else if (m.kind === 'adminTile') chip = m.label;
      else if (m.kind === 'pillarPick') chip = m.label;
      else if (m.kind !== 'none') chip = instruction(state, me, m);
      else if (ui.selection.length && !this.watching) chip = selectionChipText(state, ui);
      else if (ui.paused && !this.hudOpts.online) chip = 'Paused';
    }
    // online pause: a calm banner for everyone
    const pz = this.hudOpts.online ? this.hudOpts.pause?.() : undefined;
    const banner = !!pz && pz.paused && state.phase !== 'over';
    setVisible(this.pauseBanner, banner);
    if (banner) {
      setText(this.pauseText, `Paused by ${pz.by}`);
      setVisible(this.resumeBtn, pz.mode === 'host');
    }
    // heartland glow on the map only while the Army drawer or the map key is open
    ui.showHeartland = !this.watching && (this.drawer.open === 'army' || this.drawer.open === 'legend');
    setText(this.modeText, chip);
    // the wide research tree and doctrine picker cover the chip's spot at the top
    setVisible(this.modeChip, chip !== '' && this.drawer.open !== 'research' && this.drawer.open !== 'doctrine');
    this.modeChip.classList.toggle('paused', chip === 'Paused');

    this.bar.fast();
    this.cluster.fast();

    // own building selected (click on it): its drawer
    if (ui.selectedTile !== this.lastSelected) {
      this.lastSelected = ui.selectedTile;
      const b = ui.selectedTile >= 0 && ui.selectedTile < state.map.owner.length ? buildingAt(state, ui.selectedTile) : undefined;
      if (b && b.owner === me.id && !this.watching) {
        this.building.tile = ui.selectedTile;
        this.openDrawer('building');
      } else if (this.drawer.open === 'building') this.drawer.hide();
    }
    if (this.drawer.open === 'building' && !this.building.current(state, me)) {
      this.drawer.hide();
      ui.selectedTile = -1;
    }

    // radial menu open / close
    if (ui.contextMenu !== this.ctxOpen) {
      this.ctxOpen = ui.contextMenu;
      const cm = ui.contextMenu;
      const spec = cm && state.phase === 'playing' && !this.watching ? this.radialSpec(state, me, cm.tile) : null;
      if (cm && spec && (spec.centre || spec.slices.length)) this.radial.open(cm.x, cm.y, spec);
      else {
        this.radial.close();
        if (ui.contextMenu) ui.contextMenu = null;
        this.ctxOpen = null;
      }
    }

    if (!this.watching) this.tooltip.update(state, me, false);
    if (!this.watching) this.unitCard.update(state, me);
    if (!this.watching) this.orders.update(state, me);
    if (state.phase === 'over' && !this.gameOverShown) this.showGameOver(state, me);
    else if (this.gameOverShown && state.phase !== 'over' && !this.reviewing) {
      // the game was continued (continueGame): play on, the winner stays on the chip
      this.gameOverShown = false;
      this.continueRow = null;
      this.gameOver.classList.add('hidden');
    }
    this.victoryChip.update(state);
    if (this.continueRow && performance.now() - this.lastContinue > SLOW_MS) {
      this.lastContinue = performance.now();
      this.continueRow.update();
    }
  }

  // ---- events: history drawer, toasts for what matters, floaters on the map ----

  private drainEvents(state: GameState, me: Player): void {
    const evs = state.events;
    let k = evs.length - 1;
    while (k >= 0 && !this.seenEvents.has(evs[k])) k--;
    for (let i = k + 1; i < evs.length; i++) {
      const e = evs[i];
      this.seenEvents.add(e);
      if (e.players.length && !e.players.includes(me.id)) continue;
      const focus = this.eventFocus(state, e);
      this.events.add(state, e, focus);
      if (this.drawer.open !== 'events' && e.kind !== 'tradeDelivered' && e.kind !== 'info') {
        this.cluster.setUnread(true);
      }
      this.eventToast(state, me, e, focus);
      this.eventFloater(state, e);
    }
  }

  private eventToast(state: GameState, me: Player, e: GameEvent, focus: number): void {
    const go = focus >= 0 ? () => this.focusTile(focus, true) : undefined;
    if (this.doctrineToast(me, e)) return;
    if (this.allyToast(state, me, e, go)) return;
    if (e.kind === 'info' && e.players[0] === me.id) {
      // our gift arrived / our alliance request was turned down: say so (other info events stay in the drawer)
      if (/ sent .+ to /.test(e.message)) {
        this.toasts.show({ text: e.message.startsWith(me.name) ? `You${e.message.slice(me.name.length)}` : e.message, kind: 'good', icon: 'gift', onClick: go });
        return;
      }
      if (/ rejected the alliance with /.test(e.message)) {
        this.toasts.show({ text: e.message, kind: 'warn', icon: 'diplomacy', onClick: go, key: `sent${e.players[1]}` });
        return;
      }
    }
    if (e.kind === 'allianceRequest') {
      const req = state.allianceRequests.find((r) => r.to === me.id && e.players.includes(r.from));
      if (req) {
        const from = req.from;
        this.toasts.show({
          text: e.message,
          kind: 'info',
          icon: 'diplomacy',
          key: `req${from}`,
          sticky: () => !!this.state?.allianceRequests.some((r) => r.from === from && r.to === me.id),
          actions: [
            { label: 'Accept', primary: true, run: () => this.ctx.act({ type: 'answerAlliance', from, accept: true }) },
            { label: 'Decline', run: () => this.ctx.act({ type: 'answerAlliance', from, accept: false }) },
          ],
          onClick: () => this.openNation(from),
        });
        return;
      }
    }
    // strikes: a warning when they hit us, a short report for our own (and planes shot down either way)
    const strike = strikeToastText(e, me);
    if (strike) {
      // one toast per strike type and other side: the report replaces the launch note instead of stacking up
      this.toasts.show({ text: strike.text, kind: strike.kind, icon: strike.icon, onClick: go, ms: strike.kind === 'bad' ? 6000 : 5000, key: `${e.kind === 'nuke' ? 'missile' : e.kind}:${e.players.find((id) => id !== me.id) ?? 0}:${strike.icon}` });
      return;
    }
    const kind = TOAST_KINDS[e.kind];
    // a few kinds only: the rest lives in the events drawer
    const show =
      kind !== undefined &&
      (e.kind !== 'eliminated' || !e.players.length || e.players[0] === me.id) &&
      (e.kind !== 'buildingLost' || e.players[0] === me.id) &&
      (e.kind !== 'capitalLost' || e.players[0] === me.id) &&
      (e.kind !== 'surrounded' || e.players[0] === me.id);
    if (e.kind === 'underAttack' && gameSeconds(state) < 5) return;
    // "<you> is under attack by X" reads better as "You are under attack by X"
    const text = e.message.startsWith(`${me.name} is under attack`) ? `You are${e.message.slice(me.name.length + 3)}` : e.message;
    if (show) this.toasts.show({ text, kind, onClick: go, ms: kind === 'bad' ? 5000 : 4000, key: e.kind === 'underAttack' ? `ua${e.message}` : undefined });
  }

  /**
   * Doctrine news: unlocked (one calm toast), our own choice or switch, a new level. Another nation's choice (sent to
   * nations that border or watch it) stays in the events drawer. True when handled.
   */
  private doctrineToast(me: Player, e: GameEvent): boolean {
    if (e.kind !== 'doctrineUnlocked' && e.kind !== 'doctrineChosen' && e.kind !== 'doctrineLevelUp') return false;
    const open = () => this.openDrawer('doctrine');
    const d = me.doctrine;
    if (e.kind === 'doctrineUnlocked') {
      // the guide's doctrine tip says the same, with an arrow: no toast while it is due
      if (!d?.id && !this.tutorialGame && !this.guide?.due('doctrine')) this.toasts.show({ text: `Choose a doctrine  (${DOCTRINE_KEY})`, kind: 'info', icon: 'doctrine', ms: 7000, key: 'doctrine', onClick: open });
    } else if (e.kind === 'doctrineChosen') {
      // ours: made this tick, at our capital (the news about others carries their capital)
      if (d?.id && e.tick === d.chosenTick && e.tile === me.capital && this.drawer.open !== 'doctrine') {
        const name = DOCTRINES[d.id].name;
        const wait = (d.adaptUntilTick - e.tick) / TICKS_PER_SECOND;
        this.toasts.show({
          text: wait > 0.5 ? `Switching to ${name}: no doctrine bonus for ${fmtDuration(wait)}` : `${name} chosen. It grows stronger the longer you keep it.`,
          kind: 'good',
          icon: doctrineIcon(d.id),
          key: 'doctrine',
          onClick: open,
        });
      }
    } else if (d?.id && d.level > 1) {
      this.toasts.show({ text: levelUpText(d.id, d.level), kind: 'good', icon: doctrineIcon(d.id), ms: 5000, key: 'doctrine', onClick: open });
    }
    return true;
  }

  /**
   * Ally news (joined your war, sent troops, said no) with the ally's colour. True when handled.
   */
  private allyToast(state: GameState, me: Player, e: GameEvent, go: (() => void) | undefined): boolean {
    const ak = allyEventKind(e);
    if (ak) {
      const other = e.players.find((id) => id > 0 && id !== me.id) ?? 0;
      const p = other ? state.players[other] : undefined;
      this.toasts.show({
        text: e.message,
        kind: ak === 'allyRefused' ? 'warn' : 'good',
        icon: ak === 'allyAid' ? 'troops' : ak === 'allyJoined' ? 'attack' : 'diplomacy',
        swatch: p ? swatchCss(p, me.id) : undefined,
        ms: 5000,
        key: `ally:${ak}:${other}`,
        onClick: go ?? (p ? () => this.openNation(other) : undefined),
      });
      return true;
    }
    // a human ally asks us for help (only a note: we decide ourselves)
    const ask = e.kind === 'info' && e.players[0] === me.id ? / asks you (to attack (.+)|for troops)$/.exec(e.message) : null;
    if (ask) {
      const from = state.players.find((p) => p && p.id > 0 && e.message.startsWith(`${p.name} asks you`));
      this.toasts.show({ text: e.message, kind: 'info', icon: 'diplomacy', swatch: from ? swatchCss(from, me.id) : undefined, ms: 7000, key: `allyask:${from?.id ?? 0}`, onClick: go });
      return true;
    }
    return false;
  }

  /** The sim has no coalition event: say so when a runaway leader appears (a warning when it is you). */
  private announceCoalition(state: GameState, me: Player): void {
    const leaderId = coalitionLeader(state);
    const prev = this.coalitionSeen;
    this.coalitionSeen = leaderId;
    if (!leaderId || leaderId === prev) return;
    const leader = state.players[leaderId];
    if (!leader) return;
    const mine = leaderId === me.id;
    this.toasts.show({
      text: mine ? 'Nations are forming a coalition against you. Expect attacks from several sides.' : `Nations are forming a coalition against ${leader.name}.`,
      kind: mine ? 'bad' : 'info',
      icon: 'shield',
      swatch: swatchCss(leader, me.id),
      ms: mine ? 9000 : 5000,
      key: `coalition:${leaderId}`,
      onClick: leader.capital >= 0 ? () => this.focusTile(leader.capital, true) : undefined,
    });
  }

  /** A bombing run has no launch event: say that the bomber took off (the report follows when the bombs fall). */
  private announceBombers(state: GameState, me: Player): void {
    const first = this.seenBombers === null;
    const seen = (this.seenBombers ??= new Set());
    for (const u of state.units) {
      if (u.type !== 'bomber' || u.owner !== me.id || u.hp <= 0 || seen.has(u.id)) continue;
      seen.add(u.id);
      if (first || u.state !== 0) continue;
      const to = state.players[u.targetOwner]?.name ?? 'the target';
      this.toasts.show({ text: `Bomber on its way to ${to}. SAM sites and fighters can shoot it down.`, kind: 'info', icon: 'bomb', ms: 3500, key: `bombing:${u.targetOwner}:bomb` });
    }
    if (seen.size > 200) this.seenBombers = new Set(state.units.filter((u) => u.type === 'bomber' && u.owner === me.id).map((u) => u.id));
  }

  /** Map point an event is about: its tile, else the capital of a player it concerns or names, else -1. */
  private eventFocus(state: GameState, e: GameEvent): number {
    if (e.tile >= 0) return e.tile;
    const h = state.humanId;
    const cap = (id: number) => {
      const p = state.players[id];
      return p && p.capital >= 0 ? p.capital : -1;
    };
    for (const id of e.players) if (id !== h && cap(id) >= 0) return cap(id);
    let best = -1;
    let len = 0;
    for (const p of state.players) {
      if (!p || p.id === 0 || p.name.length <= len || !e.message.includes(p.name)) continue;
      if (p.capital >= 0) {
        best = p.capital;
        len = p.name.length;
      }
    }
    if (best >= 0) return best;
    for (const id of e.players) if (cap(id) >= 0) return cap(id);
    return -1;
  }

  /** "+gold" and "+building" texts on the map for trade deliveries and captured buildings. */
  private eventFloater(state: GameState, e: GameEvent): void {
    if (e.tile < 0) return;
    const w = state.map.width;
    const x = (e.tile % w) + 0.5;
    const y = ((e.tile / w) | 0) + 0.5;
    const born = performance.now();
    if (e.kind === 'tradeDelivered') {
      const m = /(\d[\d,.]*)\s*gold/.exec(e.message);
      addFloater(this.ui, { x, y, text: m ? `+${m[1]} gold` : '+gold', color: '#e2bf4a', born });
    } else if (e.kind === 'buildingCaptured' && e.players[0] === state.humanId) {
      const m = /captured an? (.+?) of /.exec(e.message);
      addFloater(this.ui, { x, y, text: `+${m ? m[1] : 'building'}`, color: '#b8c77a', born });
    } else if (e.kind === 'buildingDone' && e.players[0] === state.humanId && /upgraded/i.test(e.message)) {
      addFloater(this.ui, { x, y, text: e.message.replace(/.*upgraded to (level )?/i, 'Level ').replace(/\.$/, ''), color: '#e8dcb5', born });
    }
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
    const lines = (t.dataset.tip ?? '').split('\n');
    this.tip.replaceChildren();
    lines.forEach((l, k) => this.tip.append(el(k === 0 && lines.length > 1 ? 'b' : 'span', k === 0 && lines.length > 1 ? 'tip-h' : 'tip-l', l)));
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

  /** Feeds the end-of-game history (also called by the test hook's fast-forward); a failure only costs the summary. */
  feedHistory(state: GameState): void {
    if (this.historyFailed) return;
    try {
      this.history.update(state);
    } catch (err) {
      this.historyFailed = true;
      console.error('Game history error (the end summary is off for this game)', err);
    }
  }

  /** The summary block for the game-over card, or undefined (the short card) if it can't be built. */
  private summaryBlock(state: GameState): HTMLElement | undefined {
    if (this.historyFailed) return undefined;
    try {
      return summaryView(state, this.history);
    } catch (err) {
      console.error('Summary error', err);
      return undefined;
    }
  }

  /** The summary again after a continued game (victory chip): same card, "Back to the game" instead of Continue. */
  private showSummary(state: GameState): void {
    const own = state.humanId > 0 ? state.players[state.humanId] : undefined;
    const me = own ?? state.players[0];
    if (!me || state.phase === 'over') return;
    this.reviewing = true;
    this.drawer.hide();
    this.gameOver.replaceChildren(
      gameOverCard(state, me, () => this.onPlayAgain(), () => this.onMenu(), () => this.closeSummary(), this.hudOpts.againLabel, {
        summary: this.summaryBlock(state),
        lookLabel: 'Back to the game',
      }),
    );
    this.gameOver.classList.remove('hidden');
  }
  private closeSummary(): void {
    this.reviewing = false;
    this.gameOver.classList.add('hidden');
    this.gameOver.replaceChildren();
  }

  private showGameOver(state: GameState, me: Player): void {
    this.gameOverShown = true;
    this.reviewing = false;
    this.ui.contextMenu = null;
    this.ui.mode = { kind: 'none' };
    this.drawer.hide();
    this.gameOver.replaceChildren(
      gameOverCard(
        state,
        me,
        () => this.onPlayAgain(),
        () => this.onMenu(),
        () => this.gameOver.classList.add('hidden'),
        this.hudOpts.againLabel,
        { summary: this.summaryBlock(state) },
      ),
    );
    // Continue playing / Keep watching (gameOverContinue.ts) next to Play again and Main menu
    const role = this.hudOpts.continueRole ?? ((): ContinueRole => 'host');
    this.continueRow = new ContinueRow(me, role, () => this.ctx.act({ type: 'continueGame' }));
    this.gameOver.querySelector('.over-btns')?.prepend(this.continueRow.el);
    this.gameOver.classList.remove('hidden');
  }
}

