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
import { buildingAt } from '../sim/buildings';
import { BUILDINGS } from '../sim/config';
import { gameSeconds } from '../sim/state';
import type { GameEvent, GameState, Player } from '../sim/types';
import type { AudioManager } from './audio';
import type { Camera } from './camera';
import { isTribe } from './compat';
import { AdvisorStrip } from './hud/advisor';
import { Cluster } from './hud/cluster';
import { CommandBar, techNear } from './hud/commandBar';
import { el, setText, setVisible, type DrawerId, type HudCtx } from './hud/dom';
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
import type { Dispatch, UiState } from './uiState';

export { techNear };

const SLOW_MS = 200; // ~5 Hz refresh of texts and lists
const TOAST_KINDS: Partial<Record<GameEvent['kind'], 'info' | 'good' | 'bad' | 'warn'>> = {
  underAttack: 'bad',
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
  defeat: 'bad',
};

export class Hud {
  /** Set by main: leave to the menu / start a new game with the same settings. */
  onMenu: () => void = () => {};
  onPlayAgain: () => void = () => {};

  private el: HTMLElement;
  private state: GameState | null = null;
  private lastSlow = -Infinity;
  private mouse = { x: 0, y: 0 };
  private ac = new AbortController();
  private ctx: HudCtx;

  private bar: CommandBar;
  private board: Leaderboard;
  private cluster: Cluster;
  private drawer: Drawer;
  private card: NationCard;
  private advisor: AdvisorStrip;
  private toasts: Toasts;
  private tooltip: MapTooltip;
  private events: EventsPage;
  private building: BuildingPage;
  private radial: RadialMenu;
  private ctxOpen: UiState['contextMenu'] = null;
  private tip: HTMLElement;
  private tipTarget: HTMLElement | null = null;
  private help: HTMLElement;
  private gameOver: HTMLElement;
  private gameOverShown = false;
  private spawnBar: HTMLElement;
  private spawnText: HTMLElement;
  private startNowBtn: HTMLButtonElement;
  private modeChip: HTMLElement;
  private modeText: HTMLElement;
  private seenEvents = new WeakSet<GameEvent>();
  private lastSelected = -1;
  private lastToast: UiState['toast'] = null;

  constructor(
    public root: HTMLElement,
    public ui: UiState,
    public dispatch: Dispatch,
    public camera: Camera,
    private audio: AudioManager | null = null,
  ) {
    this.el = el('div', 'hud');
    root.append(this.el);
    const self = this;
    this.ctx = {
      ui,
      dispatch,
      camera,
      state: () => self.state,
      me: () => (self.state ? self.state.players[self.state.humanId] ?? null : null),
      act: (a) => {
        const r = dispatch(a);
        self.refreshSoon();
        return r.ok;
      },
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
    });

    this.drawer = new Drawer(this.ctx);
    this.drawer.add(new ArmyPage(this.ctx));
    this.drawer.add(new ResearchPage(this.ctx));
    this.drawer.add(new DiplomacyPage(this.ctx));
    this.events = new EventsPage(this.ctx);
    this.drawer.add(this.events);
    this.drawer.add(new LegendPage());
    this.building = new BuildingPage(this.ctx);
    this.drawer.add(this.building);
    this.advisor = new AdvisorStrip(this.ctx);
    this.drawer.add(
      new SettingsPage(this.ctx, {
        audio: () => this.audio?.getSettings() ?? null,
        setVolume: (m, s, mu) => this.audio?.setVolume(m, s, mu),
        setMuted: (m) => this.audio?.setMuted(m),
        advisorOn: () => this.advisor.advisorOn,
        setAdvisor: (on) => this.advisor.setAdvisor(on),
        restartTutorial: () => {
          this.advisor.restartTutorial();
          this.drawer.hide();
        },
        leave: () => this.onMenu(),
      }),
    );

    this.bar = new CommandBar(this.ctx);
    const bottom = el('div', 'hud-bottom');
    bottom.append(this.advisor.el, this.bar.el);

    this.toasts = new Toasts();
    this.tooltip = new MapTooltip(this.ctx);
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
    cancel.append(iconSpan(lineIcon('close', 12, 2)), el('kbd', 'kc', 'Esc'));
    cancel.setAttribute('aria-label', 'Cancel (Esc)');
    cancel.addEventListener('click', () => {
      if (this.ui.mode.kind !== 'none') this.ui.mode = { kind: 'none' };
      else this.ui.paused = false;
    });
    this.modeChip.append(this.modeText, cancel);
    const top = el('div', 'hud-top');
    top.append(this.spawnBar, this.modeChip, this.toasts.el);

    // help page and game over (modals)
    this.help = el('div', 'modal hidden');
    const hCard = el('div', 'modal-card help');
    const hHead = el('div', 'modal-head');
    const hClose = el('button', 'sq');
    hClose.type = 'button';
    hClose.setAttribute('aria-label', 'Close');
    hClose.append(iconSpan(lineIcon('close', 16)));
    hClose.addEventListener('click', () => this.help.classList.add('hidden'));
    hHead.append(el('h2', '', 'How to play'), hClose);
    const hBody = el('div', 'modal-scroll');
    hBody.append(howToPlayContent());
    hCard.append(hHead, hBody);
    this.help.append(hCard);
    this.help.addEventListener('pointerdown', (e) => {
      if (e.target === this.help) this.help.classList.add('hidden');
    });
    this.gameOver = el('div', 'modal gameover hidden');

    this.el.append(left, this.cluster.el, this.drawer.el, bottom, top, this.tooltip.card, this.tooltip.odds, this.radial.el, this.help, this.gameOver, this.tip);

    const opts = { signal: this.ac.signal };
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
    const me = state.players[state.humanId];
    if (!me) return;
    this.drainEvents(state, me);
    this.updateFast(state, me);
    if (now - this.lastSlow >= SLOW_MS) {
      this.lastSlow = now;
      this.bar.update(state, me);
      this.board.update(state, me);
      this.cluster.update(state, me);
      this.card.update(state, me);
      this.drawer.update(state, me);
      this.advisor.update(state, me);
      this.toasts.update();
      this.tooltip.update(state, me, true);
      this.updateSpawn(state, me);
    }
  }

  openResearch(): void {
    this.openDrawer('research', true);
  }
  /** Opens a drawer (closing another); with toggle, a second press closes it. */
  openDrawer(id: DrawerId, toggle = false): void {
    if (toggle && this.drawer.open === id) {
      this.drawer.hide();
      return;
    }
    if (id === 'research') this.advisor.researchOpened = true;
    if (id === 'events') {
      this.cluster.setUnread(false);
    }
    this.help.classList.add('hidden');
    this.drawer.show(id);
    this.refreshSoon();
  }
  toggleDrawer(id: DrawerId): void {
    this.openDrawer(id, true);
  }
  toggleHelp(): void {
    const open = this.help.classList.contains('hidden');
    setVisible(this.help, open);
  }
  /** Closes the topmost overlay (help, drawer, nation card); true if one was open. */
  closeOverlay(): boolean {
    if (!this.help.classList.contains('hidden')) {
      this.help.classList.add('hidden');
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
    return false;
  }
  /** What the radial menu offers for a tile (kept public for tests). */
  radialSpec(state: GameState, me: Player, tile: number): RadialSpec {
    return buildRadialSpec(this.ctx, state, me, tile);
  }
  destroy(): void {
    this.ac.abort();
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
    if (id !== s.humanId) this.card.open(id);
    else this.card.close();
  }

  private focusTile(tile: number, zoomIn = true): void {
    const s = this.state;
    if (!s || tile < 0) return;
    const w = s.map.width;
    this.camera.centerOn((tile % w) + 0.5, ((tile / w) | 0) + 0.5);
    if (zoomIn && this.camera.zoom < 3) this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, 3 / this.camera.zoom);
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
    setText(this.spawnText, me.spawned ? `Start chosen. Click again to move it. ${placed} of ${total} nations placed, war in ${t} s.` : `Click a land tile to place your capital. ${t} s.`);
    setVisible(this.startNowBtn, me.spawned);
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
      if (m.kind === 'build') chip = `Build ${BUILDINGS[m.building].name}: click your land`;
      else if (m.kind === 'transport') chip = 'Transport: click a coast to land on';
      else if (m.kind === 'bomb') chip = 'Bomber: click a target';
      else if (m.kind === 'missile') chip = `${m.missile === 'atomBomb' ? 'Atom bomb' : 'Rocket'}: click a target`;
      else if (m.kind === 'moveWarship') chip = 'Warship: click water to patrol';
      else if (m.kind === 'paradrop') chip = 'Paratroopers: click a drop zone';
      else if (m.kind === 'barrage') chip = 'Barrage: click the area to shell';
      else if (ui.paused) chip = 'Paused';
    }
    setText(this.modeText, chip);
    setVisible(this.modeChip, chip !== '');
    this.modeChip.classList.toggle('paused', chip === 'Paused');

    this.bar.fast();
    this.cluster.fast();

    // own building selected (click on it): its drawer
    if (ui.selectedTile !== this.lastSelected) {
      this.lastSelected = ui.selectedTile;
      const b = ui.selectedTile >= 0 && ui.selectedTile < state.map.owner.length ? buildingAt(state, ui.selectedTile) : undefined;
      if (b && b.owner === me.id) {
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
      const spec = cm && state.phase === 'playing' ? this.radialSpec(state, me, cm.tile) : null;
      if (cm && spec && (spec.centre || spec.slices.length)) this.radial.open(cm.x, cm.y, spec);
      else {
        this.radial.close();
        if (ui.contextMenu) ui.contextMenu = null;
        this.ctxOpen = null;
      }
    }

    this.tooltip.update(state, me, false);
    if (state.phase === 'over' && !this.gameOverShown) this.showGameOver(state, me);
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
    // strikes: a warning when they hit us, a short report for our own
    if (e.kind === 'paradrop' || e.kind === 'barrage') {
      const ours = e.message.startsWith(me.name);
      // one toast per strike type and shooter: a new report replaces the last instead of stacking up
      this.toasts.show({ text: e.message, kind: ours ? 'good' : 'bad', icon: e.kind === 'paradrop' ? 'paradrop' : 'barrage', onClick: go, ms: ours ? 3500 : 6000, key: `${e.kind}:${e.players.find((id) => id !== me.id) ?? 0}` });
      return;
    }
    const kind = TOAST_KINDS[e.kind];
    // a few kinds only: the rest lives in the events drawer
    const show =
      kind !== undefined &&
      (e.kind !== 'eliminated' || !e.players.length || e.players[0] === me.id) &&
      (e.kind !== 'buildingLost' || e.players[0] === me.id) &&
      (e.kind !== 'capitalLost' || e.players[0] === me.id);
    if (e.kind === 'underAttack' && gameSeconds(state) < 5) return;
    // "<you> is under attack by X" reads better as "You are under attack by X"
    const text = e.message.startsWith(`${me.name} is under attack`) ? `You are${e.message.slice(me.name.length + 3)}` : e.message;
    if (show) this.toasts.show({ text, kind, onClick: go, ms: kind === 'bad' ? 5000 : 4000, key: e.kind === 'underAttack' ? `ua${e.message}` : undefined });
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
      addFloater(this.ui, { x, y, text: e.message.replace(/.*upgraded to /i, 'Level ').replace(/\.$/, ''), color: '#e8dcb5', born });
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

  private showGameOver(state: GameState, me: Player): void {
    this.gameOverShown = true;
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
      ),
    );
    this.gameOver.classList.remove('hidden');
  }
}
