// Top-right cluster: drawer buttons (army, forces, research, diplomacy, events, legend), the clock, pause and one
// speed button (click cycles x1 / x2 / x4), sound, help and the menu. One slim row of icon buttons in a single panel;
// Pixel Clean: every button shows its icon over a plain word (Army, Forces, Research ...), so nothing needs a hover.
import { DOCTRINES, TECHS } from '../../sim/config';
import { gameSeconds } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import { inOvertime, victoryShareNow } from '../../sim/victory';
import { unreadBadge } from '../alerts';
import { SPEEDS } from '../input';
import { doctrineIcon, doctrineStatus, fmtDuration } from '../doctrineView';
import { el, fmtTime, setClass, setText, setTip, type DrawerId, type HudCtx } from './dom';
import { catSpan, pixelIcon, type IconCat } from './pixelIcons';

/** Top bar icons that belong to a colour family (the rest stay neutral grey). */
const ICON_CAT: Record<string, IconCat> = { army: 'armor', warship: 'navy', science: 'science' };
const topIcon = (name: string): HTMLSpanElement => catSpan(pixelIcon(name, 16), ICON_CAT[name] ?? null);

export interface ClusterHooks {
  isOpen(id: DrawerId): boolean;
  muted(): boolean;
  toggleMute(): void;
  toggleHelp(): void;
  hasAudio(): boolean;
  /** 'local' = single player; online: 'host' may pause, 'guest' sees a disabled button, 'none' (public) sees none */
  pauseMode(): 'local' | 'host' | 'guest' | 'none';
  /** alerts not seen in the Alerts drawer yet (the bell's badge) */
  alertsUnread(): number;
}

export class Cluster {
  readonly el: HTMLElement;
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private drawerBtns = new Map<DrawerId, HTMLButtonElement>();
  private speedBtn: HTMLButtonElement;
  private speedNum: HTMLElement;
  private speedShown = -1;
  private pauseBtn: HTMLButtonElement;
  private pauseShown: boolean | null = null;
  private pauseModeShown = '';
  private speedGroup: HTMLElement;
  private soundBtn: HTMLButtonElement;
  private soundShown: boolean | null = null;

  constructor(private ctx: HudCtx, private hooks: ClusterHooks) {
    this.el = el('div', 'cluster');
    this.el.dataset.test = 'cluster';
    const sq = (icon: string, tip: string, onClick: () => void, test?: string, word?: string): HTMLButtonElement => {
      const b = el('button', word ? 'sq lbl' : 'sq');
      b.type = 'button';
      b.append(topIcon(icon));
      if (word) b.append(el('span', 'sq-w', word));
      b.dataset.tip = tip;
      b.setAttribute('aria-label', tip.split('\n')[0]);
      if (test) b.dataset.test = test;
      b.addEventListener('click', onClick);
      return b;
    };
    const drawers = el('div', 'cl-group');
    const dbtn = (id: DrawerId, icon: string, tip: string, word: string) => {
      const b = sq(icon, tip, () => ctx.openDrawer(id, true), `open-${id}`, word);
      this.drawerBtns.set(id, b);
      drawers.append(b);
      return b;
    };
    dbtn('army', 'army', 'Army\nTroop mix, artillery, active attacks', 'Army');
    dbtn('forces', 'warship', 'Forces\nWarships, aircraft, missiles and artillery: buy, select, fire', 'Forces');
    const rb = dbtn('research', 'science', 'Research\nPick technologies', 'Research');
    const prog = el('span', 'sq-prog');
    rb.append(prog);
    // doctrine: hidden until doctrines unlock; then a brass dot until one is chosen, afterwards its picture with
    // three level pips (a ring fills around it while the nation adapts after a switch)
    const docB = dbtn('doctrine', 'doctrine', 'Doctrine', 'Doctrine');
    docB.classList.add('sq-doc', 'hidden');
    const docRing = el('span', 'sq-ring');
    const docPips = el('span', 'sq-pips');
    for (let k = 0; k < 3; k++) docPips.append(el('i'));
    const docDot = el('span', 'sq-dot brass hidden');
    docB.append(docRing, docPips, docDot);
    let docIcon = 'doctrine';
    const db = dbtn('diplomacy', 'diplomacy', 'Diplomacy\nAlliances and requests', 'Diplomacy');
    const badge = el('span', 'sq-badge hidden');
    db.append(badge);
    const eb = dbtn('events', 'events', 'Events\nWhat happened so far', 'Events');
    const dot = el('span', 'sq-dot hidden');
    eb.append(dot);
    // the bell: the Alerts drawer (big events, click one to jump there); a red count of the ones not seen yet
    const bell = dbtn('alerts', 'bell', 'Alerts\nBig events. Click one to see it on the map', 'Alerts');
    const bellBadge = el('span', 'sq-badge al-badge hidden');
    bell.append(bellBadge);
    dbtn('legend', 'legend', 'Map key\nTerrain, resources, overlays and map symbols', 'Map key');

    const clock = el('div', 'clock');
    clock.dataset.test = 'clock';
    const ct = el('span', 'clock-t');
    clock.append(ct);

    const speed = el('div', 'cl-group seg cl-speed');
    this.speedGroup = speed;
    this.pauseBtn = sq('pause', 'Pause', () => {
      // a guest's button only explains (aria-disabled keeps its tooltip working)
      if (this.hooks.pauseMode() !== 'guest') ctx.ui.paused = !ctx.ui.paused;
    }, 'pause', 'Pause');
    speed.append(this.pauseBtn);
    // one button: shows the speed, a click goes to the next one (x1 -> x2 -> x4 -> x1)
    this.speedBtn = el('button', 'sq lbl txt cl-spd');
    this.speedNum = el('span', 'sq-n', 'x1');
    this.speedBtn.append(this.speedNum, el('span', 'sq-w', 'Speed'));
    this.speedBtn.type = 'button';
    this.speedBtn.dataset.test = 'speed';
    this.speedBtn.addEventListener('click', () => {
      ctx.ui.speed = SPEEDS[(SPEEDS.indexOf(ctx.ui.speed) + 1) % SPEEDS.length];
      ctx.ui.paused = false;
    });
    speed.append(this.speedBtn);

    const sys = el('div', 'cl-group');
    this.soundBtn = sq('sound', 'Sound on/off\nVolumes are in the menu', () => hooks.toggleMute(), 'sound', 'Sound');
    if (!hooks.hasAudio()) this.soundBtn.classList.add('hidden');
    const help = sq('help', 'How to play', () => hooks.toggleHelp(), 'help', 'Help');
    const menu = sq('menu', 'Menu\nSettings, sound, leave the game', () => ctx.openDrawer('settings', true), 'menu', 'Menu');
    this.drawerBtns.set('settings', menu);
    sys.append(this.soundBtn, help, menu);
    this.el.append(drawers, speed, clock, sys);

    this.upd.push((s, me) => {
      // single player: real seconds played (steady at any speed); online: the server's game clock
      const t = this.hooks.pauseMode() === 'local' ? Math.floor(this.ctx.ui.playRealMs / 1000) : gameSeconds(s);
      const limit = s.settings.timeLimit;
      const base = s.phase === 'spawn' ? '0:00' : limit > 0 ? `${fmtTime(t)} / ${fmtTime(limit)}` : fmtTime(t);
      const need = Math.round(victoryShareNow(s) * 100);
      const ot = s.phase === 'playing' && inOvertime(s);
      setText(ct, base);
      setClass(clock, 'overtime', ot);
      setTip(clock, ot ? `Overtime: the land needed to win is falling, now ${need}%` : `Game time. Own ${need}% of the land to win.`);
      if (me.researching) {
        prog.style.width = `${Math.round(Math.min(1, me.researchProgress / TECHS[me.researching].science) * 100)}%`;
        setTip(rb, `Research\nResearching ${TECHS[me.researching].name}`);
      } else {
        prog.style.width = '0%';
        setTip(rb, me.auto.research ? 'Research\nAuto research is on' : 'Research\nNothing is being researched');
      }
      setClass(rb, 'idle', s.phase === 'playing' && !me.researching && !me.auto.research && gameSeconds(s) > 60);
      // doctrine button
      const ds = doctrineStatus(s, me);
      setClass(docB, 'hidden', ds.phase === 'locked');
      if (ds.phase !== 'locked') {
        const ic = ds.id ? doctrineIcon(ds.id) : 'doctrine';
        if (ic !== docIcon) {
          docIcon = ic;
          docB.querySelector('.ico')?.replaceWith(topIcon(ic));
        }
        setClass(docDot, 'hidden', ds.phase !== 'none');
        setClass(docB, 'chosen', !!ds.id);
        setClass(docB, 'adapting', ds.phase === 'adapting');
        docB.style.setProperty('--dc', ds.id ? DOCTRINES[ds.id].color : '');
        docRing.style.setProperty('--p', ds.adaptDone.toFixed(3));
        const lit = ds.phase === 'active' ? ds.level : 0;
        [...docPips.children].forEach((p, k) => setClass(p as HTMLElement, 'on', k < lit));
        const name = ds.id ? DOCTRINES[ds.id].name : '';
        let tip = 'Doctrine\nChoose one: a bonus for your style of play';
        if (ds.phase === 'adapting') tip = `Doctrine: adapting to ${name}\nNo doctrine bonus for ${fmtDuration(ds.adaptLeft)}`;
        else if (ds.id) {
          tip = `Doctrine: ${name}, level ${ds.level}\n${DOCTRINES[ds.id].levels[Math.max(0, ds.level - 1)]}`;
          if (ds.level < 3) tip += `\nLevel ${ds.level + 1} in ${fmtDuration(ds.nextLevelIn)}`;
        }
        setTip(docB, tip);
        docB.setAttribute('aria-label', tip.split('\n')[0]);
      }
      const req = s.allianceRequests.filter((r) => r.to === me.id).length;
      setText(badge, String(req));
      setClass(badge, 'hidden', req === 0);
      const unread = hooks.alertsUnread();
      setText(bellBadge, unreadBadge(unread));
      setClass(bellBadge, 'hidden', unread === 0);
      bell.setAttribute('aria-label', unread ? `Alerts, ${unread} new` : 'Alerts');
    });
    this.eventsDot = dot;
  }

  private eventsDot: HTMLElement;
  setUnread(on: boolean): void {
    setClass(this.eventsDot, 'hidden', !on);
  }

  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }

  fast(): void {
    const ui = this.ctx.ui;
    if (this.speedShown !== ui.speed) {
      this.speedShown = ui.speed;
      setText(this.speedNum, `x${ui.speed}`);
      const next = SPEEDS[(SPEEDS.indexOf(ui.speed) + 1) % SPEEDS.length];
      setTip(this.speedBtn, `Game speed x${ui.speed}: click for x${next}  (+ / -)`);
      this.speedBtn.setAttribute('aria-label', `Game speed x${ui.speed}, click for x${next}`);
    }
    setClass(this.speedBtn, 'fast', ui.speed > 1 && !ui.paused);
    const pm = this.hooks.pauseMode();
    if (this.pauseShown !== ui.paused || this.pauseModeShown !== pm) {
      this.pauseShown = ui.paused;
      this.pauseModeShown = pm;
      // online: no speed button; the pause button only in private games (working for the host)
      setClass(this.speedBtn, 'hidden', pm !== 'local');
      setClass(this.speedGroup, 'hidden', pm === 'none');
      setClass(this.pauseBtn, 'on', ui.paused);
      setClass(this.pauseBtn, 'dis', pm === 'guest');
      if (pm === 'guest') this.pauseBtn.setAttribute('aria-disabled', 'true');
      else this.pauseBtn.removeAttribute('aria-disabled');
      this.pauseBtn.replaceChildren(topIcon(ui.paused ? 'play' : 'pause'), el('span', 'sq-w', ui.paused ? 'Resume' : 'Pause'));
      const tip = pm === 'guest' ? 'Only the host can pause' : ui.paused ? 'Resume' : 'Pause';
      setTip(this.pauseBtn, tip);
      this.pauseBtn.setAttribute('aria-label', tip);
    }
    const m = this.hooks.muted();
    if (this.soundShown !== m) {
      this.soundShown = m;
      this.soundBtn.replaceChildren(topIcon(m ? 'mute' : 'sound'), el('span', 'sq-w', m ? 'Muted' : 'Sound'));
      setClass(this.soundBtn, 'off', m);
    }
    for (const [id, b] of this.drawerBtns) setClass(b, 'on', this.hooks.isOpen(id));
  }
}
