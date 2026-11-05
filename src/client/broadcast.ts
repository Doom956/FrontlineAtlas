// What players see of the server's broadcasts (protocol: `announcement`, `notice`, `spectacle`): a banner across the
// top, a small card for one player, a countdown, a ring on a map tile with a "Look here" label, confetti, fireworks
// and a short screen shake. All of it is decoration on top of the page (menu or game): nothing here touches the game
// state, so it can't desync. One layer for the whole page, made once by main.ts.
//
// Safety: every text from the server is cleaned again (clipBroadcastText: control and bidi characters out, length
// capped) and only ever set with textContent. Nothing is a link. Styles and kinds outside the known lists are dropped.
// Motion: with prefers-reduced-motion there is no shake, a tenth of the particles and no banner slide (CSS).
import {
  ANNOUNCE_SECONDS,
  ANNOUNCE_STYLES,
  BROADCAST_LABEL_MAX,
  BROADCAST_TEXT_MAX,
  BROADCAST_TITLE_MAX,
  COUNTDOWN_SECONDS,
  SPECTACLE_KINDS,
  clipBroadcastText,
} from '../net/protocol';
import type { AnnounceStyle, ServerMessage, SpectacleKind } from '../net/protocol';
import { el, setText } from './dom';

/** The map the layer can point at (null in the menu). */
export interface BroadcastView {
  /** room code of the game on screen (tile effects for another room are ignored) */
  code: string;
  mapWidth: number;
  mapHeight: number;
  /** tile coordinates (float) to CSS pixels relative to the map canvas */
  tileToScreen(tx: number, ty: number): { x: number; y: number };
  /** the map canvas (its page offset) */
  canvas: HTMLElement;
  /** glide the camera to a tile (the "Look here" chip when the spot is off screen) */
  focus(tile: number): void;
}

/** What a style is called when the sender gave no title. */
export const STYLE_TITLE: Record<AnnounceStyle, string> = { info: 'Announcement', warning: 'Announcement', celebration: 'Announcement' };
/** Notices (one player) show this small heading. */
export const NOTICE_TITLE = 'Message';
export const PING_MS = 6000;
const MAX_NOTICES = 3;
const NOTICE_SECONDS = 8;

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback);
const styleOf = (v: unknown): AnnounceStyle => ((ANNOUNCE_STYLES as readonly unknown[]).includes(v) ? (v as AnnounceStyle) : 'info');

/** A cleaned announcement: what the banner shows (exported for tests). */
export function announcementView(msg: { title?: unknown; text?: unknown; style?: unknown; seconds?: unknown }): { title: string; text: string; style: AnnounceStyle; ms: number } {
  const style = styleOf(msg.style);
  const title = clipBroadcastText(msg.title, BROADCAST_TITLE_MAX) || STYLE_TITLE[style];
  return { title, text: clipBroadcastText(msg.text, BROADCAST_TEXT_MAX), style, ms: clampInt(msg.seconds, ANNOUNCE_SECONDS[0], ANNOUNCE_SECONDS[1], 8) * 1000 };
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ particles

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** seconds lived / to live */
  age: number;
  life: number;
  color: string;
  size: number;
  spin: number;
  rot: number;
  /** 0 confetti (a tumbling slip), 1 spark (a glowing dot), 2 rocket (rises, then bursts) */
  kind: 0 | 1 | 2;
  /** gravity, px/s^2 */
  g: number;
  drag: number;
  burstAt?: number;
}

interface Ring {
  tile: number;
  born: number;
}

/** The HUD's own colours (styles.css tokens), so the effects belong to the table. */
const CONFETTI = ['#c9a227', '#e3c04e', '#98a957', '#6b95b8', '#d4503a', '#e4dfd2'];
const SPARKS = ['#e3c04e', '#f4d77a', '#e4dfd2', '#6b95b8', '#d4503a', '#98a957'];

export class BroadcastLayer {
  readonly el: HTMLElement;
  private stack: HTMLElement;
  private bannerSlot: HTMLElement;
  private notes: HTMLElement;
  private countEl: HTMLElement;
  private countLabel: HTMLElement;
  private countNum: HTMLElement;
  private canvas: HTMLCanvasElement;
  private look: HTMLButtonElement;
  private lookText: HTMLElement;
  private banner: { el: HTMLElement; until: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private notices: { el: HTMLElement; timer: ReturnType<typeof setTimeout> }[] = [];
  private countdown: { until: number; label: string; doneUntil: number } | null = null;
  private particles: Particle[] = [];
  private ring: Ring | null = null;
  private lookTile = -1;
  private raf = 0;
  private last = 0;
  private view: (() => BroadcastView | null) | null = null;

  constructor(
    root: HTMLElement,
    /** the element that shakes (the app) */
    private shakeTarget: HTMLElement | null = null,
  ) {
    this.el = el('div', 'bc');
    this.canvas = el('canvas', 'bc-fx');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.stack = el('div', 'bc-stack');
    this.countEl = el('div', 'bc-count hidden');
    this.countEl.dataset.test = 'bc-countdown';
    this.countEl.setAttribute('role', 'timer');
    this.countLabel = el('span', 'bc-count-l');
    this.countNum = el('span', 'bc-count-n');
    this.countEl.append(this.countLabel, this.countNum);
    this.bannerSlot = el('div', 'bc-slot');
    this.bannerSlot.setAttribute('role', 'status');
    this.bannerSlot.setAttribute('aria-live', 'polite');
    this.notes = el('div', 'bc-notes');
    this.notes.setAttribute('role', 'status');
    this.notes.setAttribute('aria-live', 'polite');
    this.stack.append(this.countEl, this.bannerSlot, this.notes);
    this.look = el('button', 'bc-look hidden');
    this.look.type = 'button';
    this.look.dataset.test = 'bc-look';
    this.lookText = el('span', 'bc-look-t');
    this.look.append(el('i', 'bc-look-dot'), this.lookText);
    this.look.addEventListener('click', () => {
      const v = this.view?.();
      if (v && this.lookTile >= 0) v.focus(this.lookTile);
    });
    this.el.append(this.canvas, this.stack, this.look);
    root.append(this.el);
  }

  /** The map on screen now (main.ts sets it per game; null in the menu). */
  setView(view: (() => BroadcastView | null) | null): void {
    this.view = view;
  }

  /** Feed every server message here; the layer picks out its own. */
  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'announcement':
        this.announce(msg);
        break;
      case 'notice':
        this.notice(msg.text, msg.style, msg.seconds);
        break;
      case 'spectacle':
        this.spectacle(msg);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------- banner

  /** The big banner (one at a time: a new one replaces the one showing). Also the console's preview. */
  announce(msg: { title?: unknown; text?: unknown; style?: unknown; seconds?: unknown }): HTMLElement | null {
    const v = announcementView(msg);
    if (!v.text) return null;
    this.dropBanner();
    const card = el('div', `bc-ann s-${v.style}`);
    card.dataset.test = 'bc-announcement';
    if (v.style === 'warning') card.setAttribute('role', 'alert');
    const mark = el('span', 'bc-ann-mark');
    mark.setAttribute('aria-hidden', 'true');
    const body = el('div', 'bc-ann-body');
    body.append(el('div', 'bc-ann-title', v.title), el('p', 'bc-ann-text', v.text));
    const x = el('button', 'bc-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    const life = el('i', 'bc-life');
    life.style.animationDuration = `${v.ms}ms`;
    card.append(mark, body, x, life);
    this.bannerSlot.append(card);
    const timer = setTimeout(() => this.dropBanner(), v.ms);
    this.banner = { el: card, until: performance.now() + v.ms, timer };
    x.addEventListener('click', () => this.dropBanner());
    if (v.style === 'celebration') {
      // a small burst from the banner's corners: the celebration's own mark
      const r = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
      if (r && r.width > 0) {
        this.burst(r.left + 12, r.top + r.height / 2, 26, -Math.PI * 0.75);
        this.burst(r.right - 12, r.top + r.height / 2, 26, -Math.PI * 0.25);
      }
    }
    return card;
  }

  private dropBanner(): void {
    const b = this.banner;
    if (!b) return;
    this.banner = null;
    clearTimeout(b.timer);
    b.el.classList.add('out');
    setTimeout(() => b.el.remove(), 180);
  }

  /** A small card for this player alone (newest on top, at most MAX_NOTICES). */
  notice(text: unknown, style: unknown = 'info', seconds: unknown = NOTICE_SECONDS): HTMLElement | null {
    const t = clipBroadcastText(text, BROADCAST_TEXT_MAX);
    if (!t) return null;
    const st = styleOf(style);
    const ms = clampInt(seconds, ANNOUNCE_SECONDS[0], ANNOUNCE_SECONDS[1], NOTICE_SECONDS) * 1000;
    const card = el('div', `bc-note s-${st}`);
    card.dataset.test = 'bc-notice';
    const x = el('button', 'bc-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    const life = el('i', 'bc-life');
    life.style.animationDuration = `${ms}ms`;
    const body = el('div', 'bc-note-body');
    body.append(el('div', 'bc-note-title', NOTICE_TITLE), el('p', 'bc-note-text', t));
    card.append(body, x, life);
    const entry = { el: card, timer: setTimeout(() => drop(), ms) };
    const drop = (): void => {
      clearTimeout(entry.timer);
      const i = this.notices.indexOf(entry);
      if (i >= 0) this.notices.splice(i, 1);
      card.remove();
    };
    x.addEventListener('click', drop);
    this.notes.prepend(card);
    this.notices.unshift(entry);
    while (this.notices.length > MAX_NOTICES) {
      const old = this.notices.pop()!;
      clearTimeout(old.timer);
      old.el.remove();
    }
    return card;
  }

  // ---------------------------------------------------------------------------------------------- effects

  spectacle(msg: { kind?: unknown; code?: unknown; tile?: unknown; label?: unknown; seconds?: unknown }): void {
    if (!(SPECTACLE_KINDS as readonly unknown[]).includes(msg.kind)) return;
    const kind = msg.kind as SpectacleKind;
    const label = clipBroadcastText(msg.label, BROADCAST_LABEL_MAX);
    const v = this.view?.() ?? null;
    // a tile only means something on that room's map
    const tile = v && typeof msg.code === 'string' && msg.code === v.code && Number.isInteger(msg.tile) && (msg.tile as number) >= 0 && (msg.tile as number) < v.mapWidth * v.mapHeight ? (msg.tile as number) : -1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    switch (kind) {
      case 'ping':
        if (tile < 0) return;
        this.ring = { tile, born: performance.now() };
        this.lookTile = tile;
        setText(this.lookText, label || 'Look here');
        this.look.classList.remove('hidden');
        break;
      case 'countdown': {
        const s = clampInt(msg.seconds, COUNTDOWN_SECONDS[0], COUNTDOWN_SECONDS[1], 10);
        this.countdown = { until: performance.now() + s * 1000, label: label || 'Starting in', doneUntil: 0 };
        setText(this.countLabel, this.countdown.label);
        this.countEl.classList.remove('hidden', 'done');
        break;
      }
      case 'confetti': {
        const p = tile >= 0 && v ? this.tilePoint(v, tile) : null;
        if (p) this.burst(p.x, p.y, 90, -Math.PI / 2, 1.1);
        else this.rain(W, H);
        break;
      }
      case 'fireworks': {
        const p = tile >= 0 && v ? this.tilePoint(v, tile) : null;
        this.fireworks(W, H, p);
        break;
      }
      case 'shake':
        this.shake();
        return;
    }
    this.kick();
  }

  /** Short shake of the whole page (none with reduced motion). */
  shake(): void {
    const t = this.shakeTarget;
    if (!t || reducedMotion()) return;
    t.classList.remove('bc-shake');
    void t.offsetWidth;
    t.classList.add('bc-shake');
    setTimeout(() => t.classList.remove('bc-shake'), 700);
  }

  private tilePoint(v: BroadcastView, tile: number): { x: number; y: number } {
    const p = v.tileToScreen((tile % v.mapWidth) + 0.5, Math.floor(tile / v.mapWidth) + 0.5);
    const r = v.canvas.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  }

  private scale(n: number): number {
    return Math.max(1, Math.round(reducedMotion() ? n / 10 : n));
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(Math.random() * list.length)];
  }

  /** Confetti thrown from a point, in a cone around `dir` (radians, screen y down). */
  private burst(x: number, y: number, n: number, dir: number, power = 1): void {
    for (let i = 0, k = this.scale(n); i < k; i++) {
      const a = dir + (Math.random() - 0.5) * 1.6;
      const sp = (260 + Math.random() * 380) * power;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 2.2 + Math.random() * 1.4, color: this.pick(CONFETTI), size: 5 + Math.random() * 5, spin: (Math.random() - 0.5) * 14, rot: Math.random() * 6.3, kind: 0, g: 620, drag: 1.6 });
    }
  }

  /** Confetti falling over the whole screen. */
  private rain(W: number, H: number): void {
    for (let i = 0, k = this.scale(Math.min(220, 60 + W / 8)); i < k; i++) {
      this.particles.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 80, vy: 60 + Math.random() * 120, age: 0, life: 3.4 + Math.random() * 1.6, color: this.pick(CONFETTI), size: 6 + Math.random() * 6, spin: (Math.random() - 0.5) * 10, rot: Math.random() * 6.3, kind: 0, g: 120, drag: 0.4 });
    }
  }

  /** Rockets that rise and burst: over the tile when given, else across the screen. */
  private fireworks(W: number, H: number, at: { x: number; y: number } | null): void {
    const shots = reducedMotion() ? 1 : at ? 3 : 5;
    for (let i = 0; i < shots; i++) {
      const tx = at ? at.x + (Math.random() - 0.5) * 140 : W * (0.15 + 0.7 * Math.random());
      const ty = at ? at.y - 30 - Math.random() * 90 : H * (0.18 + 0.3 * Math.random());
      const fromY = at ? Math.min(H + 10, at.y + 220) : H + 10;
      const t = 0.7 + Math.random() * 0.25;
      this.particles.push({ x: tx + (Math.random() - 0.5) * 40, y: fromY, vx: 0, vy: (ty - fromY) / t, age: -i * 0.32, life: t, color: this.pick(SPARKS), size: 2.5, spin: 0, rot: 0, kind: 2, g: 0, drag: 0, burstAt: ty });
    }
  }

  private explode(x: number, y: number, color: string): void {
    for (let i = 0, k = this.scale(70); i < k; i++) {
      const a = (i / k) * Math.PI * 2 + Math.random() * 0.2;
      const sp = 120 + Math.random() * 230;
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: 1.1 + Math.random() * 0.8, color: Math.random() < 0.7 ? color : this.pick(SPARKS), size: 2 + Math.random() * 1.6, spin: 0, rot: 0, kind: 1, g: 140, drag: 1.4 });
    }
  }

  // ---------------------------------------------------------------------------------------------- frame loop

  /** Runs the frame loop while anything moves (it stops by itself). */
  private kick(): void {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    this.stepParticles(g, dt);
    this.drawRing(g, now);
    this.stepCountdown(now);
    if (this.particles.length || this.ring || this.countdown) this.raf = requestAnimationFrame((t) => this.frame(t));
    else g.clearRect(0, 0, W, H);
  }

  private stepParticles(g: CanvasRenderingContext2D, dt: number): void {
    const out: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age < 0) {
        out.push(p);
        continue;
      }
      if (p.kind === 2) {
        p.y += p.vy * dt;
        if (p.y <= (p.burstAt ?? 0) || p.age >= p.life) {
          this.explode(p.x, p.y, p.color);
          continue;
        }
        g.globalAlpha = 0.9;
        g.fillStyle = p.color;
        g.fillRect(p.x - 1, p.y, 2, 10);
        out.push(p);
        continue;
      }
      if (p.age >= p.life) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      const fade = Math.min(1, (p.life - p.age) / 0.6);
      g.globalAlpha = fade;
      g.fillStyle = p.color;
      if (p.kind === 0) {
        // a slip of paper turning over: its width follows the spin
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillRect(-p.size / 2, -p.size * 0.3 * Math.abs(Math.cos(p.rot * 1.7)), p.size, p.size * 0.6 * Math.abs(Math.cos(p.rot * 1.7)) + 0.6);
        g.restore();
      } else {
        g.beginPath();
        g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        g.fill();
      }
      out.push(p);
    }
    g.globalAlpha = 1;
    this.particles = out;
  }

  private drawRing(g: CanvasRenderingContext2D, now: number): void {
    const r = this.ring;
    if (!r) return;
    const age = now - r.born;
    const v = this.view?.() ?? null;
    if (age > PING_MS || !v) {
      this.ring = null;
      this.lookTile = -1;
      this.look.classList.add('hidden');
      return;
    }
    const p = this.tilePoint(v, r.tile);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const fade = Math.min(1, (PING_MS - age) / 800);
    // three rings, one every 600 ms, growing from the spot
    g.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const t = ((age / 1800 + k / 3) % 1 + 1) % 1;
      g.globalAlpha = (1 - t) * 0.9 * fade;
      g.strokeStyle = k === 0 ? '#e3c04e' : '#c9a227';
      g.beginPath();
      g.arc(p.x, p.y, 10 + t * 70, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = fade;
    g.fillStyle = '#e3c04e';
    g.beginPath();
    g.arc(p.x, p.y, 4, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    // the label sits above the spot; off screen it waits at the nearest edge as a button that goes there
    const m = 16;
    const on = p.x >= m && p.x <= W - m && p.y >= 60 && p.y <= H - m;
    // the chip is centred on x: keep all of it on screen (16 px gutter)
    const half = Math.min(W / 2 - m, (this.look.offsetWidth || 120) / 2);
    const lx = Math.max(m + half, Math.min(W - m - half, p.x));
    const ly = Math.max(104, Math.min(H - 40, p.y - 34)); // below the top bar
    this.look.classList.toggle('edge', !on);
    this.look.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px) translate(-50%, -100%)`;
    this.look.style.opacity = String(fade);
  }

  private stepCountdown(now: number): void {
    const c = this.countdown;
    if (!c) return;
    if (c.doneUntil) {
      if (now > c.doneUntil) {
        this.countdown = null;
        this.countEl.classList.add('hidden');
      }
      return;
    }
    const left = Math.ceil((c.until - now) / 1000);
    if (left <= 0) {
      c.doneUntil = now + 1600;
      setText(this.countNum, 'Now');
      this.countEl.classList.add('done');
      return;
    }
    setText(this.countNum, left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : String(left));
  }

  destroy(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}
