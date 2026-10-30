// Top-right cluster: drawer buttons (army, research, diplomacy, events, legend), the clock, pause and speed,
// sound and the menu. One row of small square buttons; each shows its hotkey in the tooltip.
import { TECHS } from '../../sim/config';
import { gameSeconds } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import { inOvertime, victoryShareNow } from '../../sim/victory';
import { SPEEDS } from '../input';
import { el, fmtTime, setClass, setText, setTip, type DrawerId, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';

export interface ClusterHooks {
  isOpen(id: DrawerId): boolean;
  muted(): boolean;
  toggleMute(): void;
  toggleHelp(): void;
  hasAudio(): boolean;
}

export class Cluster {
  readonly el: HTMLElement;
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private drawerBtns = new Map<DrawerId, HTMLButtonElement>();
  private speedBtns: HTMLButtonElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private pauseShown: boolean | null = null;
  private soundBtn: HTMLButtonElement;
  private soundShown: boolean | null = null;

  constructor(private ctx: HudCtx, private hooks: ClusterHooks) {
    this.el = el('div', 'cluster');
    this.el.dataset.test = 'cluster';
    const sq = (icon: string, tip: string, onClick: () => void, test?: string): HTMLButtonElement => {
      const b = el('button', 'sq');
      b.type = 'button';
      b.append(iconSpan(lineIcon(icon, 17)));
      b.dataset.tip = tip;
      b.setAttribute('aria-label', tip.split('\n')[0]);
      if (test) b.dataset.test = test;
      b.addEventListener('click', onClick);
      return b;
    };
    const drawers = el('div', 'cl-group');
    const dbtn = (id: DrawerId, icon: string, tip: string) => {
      const b = sq(icon, tip, () => ctx.openDrawer(id, true), `open-${id}`);
      // a short name next to the icon on wide screens, so the extra options are findable without hovering
      b.classList.add('labelled');
      b.append(el('span', 'sq-l', tip.split('  ')[0]));
      this.drawerBtns.set(id, b);
      drawers.append(b);
      return b;
    };
    dbtn('army', 'army', 'Army  (U)\nTroop mix, active attacks, air strikes');
    const rb = dbtn('research', 'science', 'Research  (T)\nPick technologies');
    const prog = el('span', 'sq-prog');
    rb.append(prog);
    const db = dbtn('diplomacy', 'diplomacy', 'Diplomacy  (P)\nAlliances and requests');
    const badge = el('span', 'sq-badge hidden');
    db.append(badge);
    const eb = dbtn('events', 'events', 'Events  (J)\nWhat happened so far');
    const dot = el('span', 'sq-dot hidden');
    eb.append(dot);
    dbtn('legend', 'legend', 'Map key  (L)\nTerrain, resources and map symbols');

    const clock = el('div', 'clock');
    clock.dataset.test = 'clock';
    const ct = el('span', 'clock-t');
    clock.append(ct);

    const speed = el('div', 'cl-group seg');
    this.pauseBtn = sq('pause', 'Pause  (Space)', () => (ctx.ui.paused = !ctx.ui.paused), 'pause');
    speed.append(this.pauseBtn);
    for (const s of SPEEDS) {
      const b = el('button', 'sq txt', `x${s}`);
      b.type = 'button';
      b.dataset.tip = `Game speed x${s}  (+ / -)`;
      b.addEventListener('click', () => {
        ctx.ui.speed = s;
        ctx.ui.paused = false;
      });
      this.speedBtns.push(b);
      speed.append(b);
    }

    const sys = el('div', 'cl-group');
    this.soundBtn = sq('sound', 'Sound on/off\nVolumes are in the menu', () => hooks.toggleMute(), 'sound');
    if (!hooks.hasAudio()) this.soundBtn.classList.add('hidden');
    const help = sq('help', 'How to play  (?)', () => hooks.toggleHelp(), 'help');
    const menu = sq('menu', 'Menu\nSettings, sound, leave the game', () => ctx.openDrawer('settings', true), 'menu');
    this.drawerBtns.set('settings', menu);
    sys.append(this.soundBtn, help, menu);
    this.el.append(drawers, clock, speed, sys);

    this.upd.push((s, me) => {
      const t = gameSeconds(s);
      const limit = s.settings.timeLimit;
      const base = s.phase === 'spawn' ? '0:00' : limit > 0 ? `${fmtTime(t)} / ${fmtTime(limit)}` : fmtTime(t);
      const need = Math.round(victoryShareNow(s) * 100);
      const ot = s.phase === 'playing' && inOvertime(s);
      setText(ct, base);
      setClass(clock, 'overtime', ot);
      setTip(clock, ot ? `Overtime: the land needed to win is falling, now ${need}%` : `Game time. Own ${need}% of the land to win.`);
      if (me.researching) {
        prog.style.width = `${Math.round(Math.min(1, me.researchProgress / TECHS[me.researching].science) * 100)}%`;
        setTip(rb, `Research  (T)\nResearching ${TECHS[me.researching].name}`);
      } else {
        prog.style.width = '0%';
        setTip(rb, me.auto.research ? 'Research  (T)\nAuto research is on' : 'Research  (T)\nNothing is being researched');
      }
      setClass(rb, 'idle', s.phase === 'playing' && !me.researching && !me.auto.research && gameSeconds(s) > 60);
      const req = s.allianceRequests.filter((r) => r.to === me.id).length;
      setText(badge, String(req));
      setClass(badge, 'hidden', req === 0);
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
    this.speedBtns.forEach((b, k) => setClass(b, 'on', SPEEDS[k] === ui.speed && !ui.paused));
    if (this.pauseShown !== ui.paused) {
      this.pauseShown = ui.paused;
      setClass(this.pauseBtn, 'on', ui.paused);
      this.pauseBtn.replaceChildren(iconSpan(lineIcon(ui.paused ? 'play' : 'pause', 17)));
      setTip(this.pauseBtn, ui.paused ? 'Resume  (Space)' : 'Pause  (Space)');
    }
    const m = this.hooks.muted();
    if (this.soundShown !== m) {
      this.soundShown = m;
      this.soundBtn.replaceChildren(iconSpan(lineIcon(m ? 'mute' : 'sound', 17)));
      setClass(this.soundBtn, 'off', m);
    }
    for (const [id, b] of this.drawerBtns) setClass(b, 'on', this.hooks.isOpen(id));
  }
}
