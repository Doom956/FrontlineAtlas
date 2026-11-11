// What players see of the server's broadcasts (protocol: `announcement`, `notice`, `spectacle`): a banner across the
// top, a small card for one player, a countdown, a ring on a map tile with a "Look here" label, confetti, fireworks
// and a short screen shake. All of it is decoration on top of the page (menu or game): nothing here touches the game
// state, so it can't desync. One layer for the whole page, made once by main.ts.
//
// Safety: every text from the server is cleaned again (clipBroadcastText: control and bidi characters out, length
// capped) and only ever set with textContent. Nothing is a link. Styles and kinds outside the known lists are dropped.
// Motion: with prefers-reduced-motion there is no shake, a tenth of the particles and no banner slide (CSS).
//
// Screen pranks (PRANK_KINDS) are the same kind of decoration, each over within PRANK_SECONDS by its own timer:
//   flip        the map turns upside down (or mirrors) in half a second, stays, turns back. Clicks stay right: the
//               map input maps the pointer back through the turn (fx/prankView.ts); only while it turns (half a second
//               each way) does input on the map wait. HUD, minimap and chat are not turned.
//   earthquake  a gentle wobble of the map (a few px, under a degree), eased in and out; clicks mapped the same way
//   disco       nation colours run round the colour wheel (the renderer's palette; the 2D fallback turns the canvas)
//   ducks       every ship, plane and division is drawn as a rubber duck (missiles stay missiles)
//   fakeBomb    "Incoming!" counts down over a ring on the player's capital, then confetti and "Gotcha!"
//   fogPuff     a cloud comes over the screen and clears (clicks go through it)
//   chase       the camera glides to one of the player's units, follows it, then glides back; any pan or zoom by the
//               player ends it at once and leaves the camera where they put it
// With prefers-reduced-motion: no flip, no wobble, no chase (skipped: nothing shows), disco holds one turned palette
// instead of cycling, the cloud only fades, ducks and the countdown are as usual (with a tenth of the confetti).
import {
  ANNOUNCE_DEFAULT_SECONDS,
  ANNOUNCE_SECONDS,
  ANNOUNCE_STYLES,
  BROADCAST_LABEL_MAX,
  BROADCAST_TEXT_MAX,
  BROADCAST_TITLE_MAX,
  COUNTDOWN_SECONDS,
  FLIP_MODES,
  NOTICE_SECONDS,
  PRANK_DEFAULT_SECONDS,
  PRANK_KINDS,
  PRANK_SECONDS,
  SPECTACLE_KINDS,
  clipBroadcastText,
} from '../net/protocol';
import type { AnnounceStyle, FlipMode, PrankKind, ServerMessage, SpectacleKind } from '../net/protocol';
import { el, setText } from './dom';
import { mapPointOnPage, prankView, setMapWarp, warpCss } from './fx/prankView';
import type { MapWarp } from './fx/prankView';

/** The map the layer can point at (null in the menu). */
export interface BroadcastView {
  /** room code of the game on screen (tile effects for another room are ignored); '' = single player (no tiles) */
  code: string;
  mapWidth: number;
  mapHeight: number;
  /** tile coordinates (float) to CSS pixels relative to the map canvas */
  tileToScreen(tx: number, ty: number): { x: number; y: number };
  /** the map canvas (its page offset) */
  canvas: HTMLElement;
  /** glide the camera to a tile (the "Look here" chip when the spot is off screen) */
  focus(tile: number): void;
  /** the canvases a flip or a wobble turns (the map and its GL layer under it); none = no flip or wobble */
  mapLayers?: () => HTMLElement[];
  /** this player's capital, -1 = none (a spectator, no capital yet) */
  capitalTile?: () => number;
  /** one of this player's units (no id: any one, else that one), its tile position now; null = none or gone */
  ownUnit?: (id?: number) => { id: number; x: number; y: number } | null;
  /** the camera, for the chase */
  camera?: PrankCamera;
}

/** The bits of the camera a chase moves (camera.ts fits). */
export interface PrankCamera {
  get(): { x: number; y: number; zoom: number; flying: boolean };
  flyTo(x: number, y: number, zoom: number, ms: number): void;
  centerOn(x: number, y: number): void;
}

/** What a style is called when the sender gave no title. */
export const STYLE_TITLE: Record<AnnounceStyle, string> = { info: 'Announcement', warning: 'Announcement', celebration: 'Announcement' };
/** Notices (one player) show this small heading. */
export const NOTICE_TITLE = 'Message';
export const PING_MS = 6000;
const MAX_NOTICES = 3;
/** A flip turns in (and back out) over this long. */
export const FLIP_TURN_MS = 500;
/** The chase glides in and back over this long. */
const CHASE_GLIDE_MS = 900;
/** The fake bomb's "Gotcha!" stays this long (inside the prank's time). */
const GOTCHA_MS = 2000;
/** Countdown's "Now" stays this long after zero. */
const COUNT_DONE_MS = 1600;

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback);
const styleOf = (v: unknown): AnnounceStyle => ((ANNOUNCE_STYLES as readonly unknown[]).includes(v) ? (v as AnnounceStyle) : 'info');

/** A cleaned announcement: what the banner shows (exported for tests). */
export function announcementView(msg: { title?: unknown; text?: unknown; style?: unknown; seconds?: unknown }): { title: string; text: string; style: AnnounceStyle; ms: number } {
  const style = styleOf(msg.style);
  const title = clipBroadcastText(msg.title, BROADCAST_TITLE_MAX) || STYLE_TITLE[style];
  return { title, text: clipBroadcastText(msg.text, BROADCAST_TEXT_MAX), style, ms: clampInt(msg.seconds, ANNOUNCE_SECONDS[0], ANNOUNCE_SECONDS[1], ANNOUNCE_DEFAULT_SECONDS) * 1000 };
}

/** How long a prank runs (ms): the sender's seconds clamped to PRANK_SECONDS, else the kind's default. */
export function prankMs(kind: PrankKind, seconds: unknown): number {
  return clampInt(seconds, PRANK_SECONDS[0], PRANK_SECONDS[1], PRANK_DEFAULT_SECONDS[kind]) * 1000;
}

/** Eased 0..1..0 of a turn that goes in over `turn` ms from `start` and back out before `end`. */
export function turnAmount(now: number, start: number, end: number, turn = FLIP_TURN_MS): number {
  const t = Math.max(0, Math.min(1, (now - start) / turn, (end - now) / turn));
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

export function reducedMotion(): boolean {
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
  /** how long it shows */
  ms: number;
}

/** A running prank: when it started and ends (performance.now ms), its own end timer, and what it needs. */
interface Prank {
  start: number;
  end: number;
  timer: ReturnType<typeof setTimeout>;
  mode?: FlipMode;
  /** chase: the unit, where the camera was, the phase, and where the camera was put last frame */
  chase?: { unit: number; from: { x: number; y: number; zoom: number }; phase: 'in' | 'follow' | 'out'; zoom: number; last: { x: number; y: number; zoom: number } | null };
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
  private countdown: { until: number; label: string; doneUntil: number; doneText: string; doneLabel: string; onDone?: () => void } | null = null;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private pranks = new Map<PrankKind, Prank>();
  private fogEl: HTMLElement;
  private jumpEl: HTMLElement;
  /** the layers the last warp was written to (cleared when it ends) */
  private warped: HTMLElement[] = [];
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
    this.fogEl = el('div', 'bc-fog hidden');
    this.fogEl.setAttribute('aria-hidden', 'true');
    this.fogEl.dataset.test = 'bc-fog';
    this.jumpEl = this.buildJump();
    this.el.append(this.canvas, this.fogEl, this.jumpEl, this.stack, this.look);
    root.append(this.el);
  }

  /** The jumpscare overlay: a full-screen flash with a scary face, drawn with plain elements (no bundled assets). */
  private buildJump(): HTMLElement {
    const wrap = el('div', 'bc-jump hidden');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.dataset.test = 'bc-jump';
    const face = el('div', 'bc-jump-face');
    const eyes = el('div', 'bc-jump-eyes');
    eyes.append(el('div', 'bc-jump-eye'), el('div', 'bc-jump-eye'));
    face.append(eyes, el('div', 'bc-jump-mouth'));
    wrap.append(face);
    return wrap;
  }

  /** The map on screen now (main.ts sets it per game; null in the menu). */
  setView(view: (() => BroadcastView | null) | null): void {
    // a new game or the menu: no prank carries over (nothing turned, no ducks, no camera move)
    this.endPranks();
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

  spectacle(msg: { kind?: unknown; code?: unknown; tile?: unknown; label?: unknown; seconds?: unknown; mode?: unknown }): void {
    // a kind this client doesn't know (a newer server) is dropped: effects are decoration only
    if (!(SPECTACLE_KINDS as readonly unknown[]).includes(msg.kind)) return;
    const kind = msg.kind as SpectacleKind;
    if ((PRANK_KINDS as readonly string[]).includes(kind)) {
      this.prank(kind as PrankKind, msg);
      return;
    }
    const label = clipBroadcastText(msg.label, BROADCAST_LABEL_MAX);
    const v = this.view?.() ?? null;
    // a tile only means something on that room's map
    const tile = v && v.code !== '' && typeof msg.code === 'string' && msg.code === v.code && Number.isInteger(msg.tile) && (msg.tile as number) >= 0 && (msg.tile as number) < v.mapWidth * v.mapHeight ? (msg.tile as number) : -1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    switch (kind) {
      case 'ping':
        if (tile < 0) return;
        this.ring = { tile, born: performance.now(), ms: PING_MS };
        this.lookTile = tile;
        setText(this.lookText, label || 'Look here');
        this.look.classList.remove('hidden');
        break;
      case 'countdown': {
        const s = clampInt(msg.seconds, COUNTDOWN_SECONDS[0], COUNTDOWN_SECONDS[1], 10);
        this.startCountdown(s * 1000, label || 'Starting in', 'Now', '');
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

  /** A tile's centre on the page (through a flip or wobble, so rings and confetti sit where the tile shows). */
  private tilePoint(v: BroadcastView, tile: number): { x: number; y: number } {
    const p = v.tileToScreen((tile % v.mapWidth) + 0.5, Math.floor(tile / v.mapWidth) + 0.5);
    return mapPointOnPage(v.canvas, p.x, p.y);
  }

  /**
   * One countdown plate (a new one replaces the old). It ends by itself: a timer, so it goes even when no frame runs
   * (a hidden tab); the frames only draw the seconds.
   */
  private startCountdown(ms: number, label: string, doneText: string, doneLabel: string, doneMs = COUNT_DONE_MS, onDone?: () => void): void {
    const now = performance.now();
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countdown = { until: now + ms, label, doneUntil: 0, doneText, doneLabel, onDone };
    setText(this.countLabel, label);
    setText(this.countNum, String(Math.ceil(ms / 1000)));
    this.countEl.classList.remove('hidden', 'done', 'bomb');
    this.countTimer = setTimeout(() => {
      this.countDone(performance.now());
      this.countTimer = setTimeout(() => this.clearCountdown(), doneMs);
    }, ms);
  }

  private countDone(now: number): void {
    const c = this.countdown;
    if (!c || c.doneUntil) return;
    c.doneUntil = now + COUNT_DONE_MS;
    setText(this.countNum, c.doneText);
    if (c.doneLabel) setText(this.countLabel, c.doneLabel);
    this.countEl.classList.add('done');
    const fn = c.onDone;
    c.onDone = undefined;
    fn?.();
  }

  private clearCountdown(): void {
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countTimer = null;
    this.countdown = null;
    this.countEl.classList.add('hidden');
    this.countEl.classList.remove('done', 'bomb');
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
    this.stepPranks(now);
    this.stepParticles(g, dt);
    this.drawRing(g, now);
    this.stepCountdown(now);
    if (this.particles.length || this.ring || this.countdown || this.pranks.size) this.raf = requestAnimationFrame((t) => this.frame(t));
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
    if (age > r.ms || !v) {
      this.ring = null;
      this.lookTile = -1;
      this.look.classList.add('hidden');
      return;
    }
    const p = this.tilePoint(v, r.tile);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const fade = Math.min(1, (r.ms - age) / 800);
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
    if (!c || c.doneUntil) return; // (its timers end it)
    const left = Math.ceil((c.until - now) / 1000);
    if (left > 0) setText(this.countNum, String(left));
  }

  destroy(): void {
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.endPranks();
    this.clearCountdown();
    this.el.remove();
  }

  // ---------------------------------------------------------------------------------------------- pranks

  /** Which pranks run now (tests, the console's preview). */
  activePranks(): PrankKind[] {
    return [...this.pranks.keys()];
  }

  /** Starts (or restarts) a prank; it ends by its own timer within PRANK_SECONDS. */
  prank(kind: PrankKind, msg: { seconds?: unknown; mode?: unknown } = {}): boolean {
    const v = this.view?.() ?? null;
    const ms = prankMs(kind, msg.seconds);
    const now = performance.now();
    const calm = reducedMotion();
    // the map pranks need a map; the cloud and the jumpscare also cover the menu
    if (kind !== 'fogPuff' && kind !== 'jumpscare' && !v) return false;
    if (calm && (kind === 'flip' || kind === 'earthquake' || kind === 'chase')) return false;
    const old = this.pranks.get(kind);
    if (old) clearTimeout(old.timer);
    const p: Prank = { start: now, end: now + ms, timer: setTimeout(() => this.endPrank(kind), ms) };
    switch (kind) {
      case 'flip': {
        p.mode = (FLIP_MODES as readonly unknown[]).includes(msg.mode) ? (msg.mode as FlipMode) : 'upside';
        if (!v?.mapLayers) return this.dropNew(kind, p);
        // already turned the same way: it stays turned for the new time (no turning back and forth)
        if (old && old.mode === p.mode && now - old.start > FLIP_TURN_MS) p.start = now - FLIP_TURN_MS;
        break;
      }
      case 'earthquake':
        if (!v?.mapLayers) return this.dropNew(kind, p);
        if (old) p.start = Math.min(now, old.start);
        break;
      case 'disco':
        prankView.hue = calm ? 150 : 6;
        break;
      case 'ducks':
        prankView.ducks = true;
        break;
      case 'fakeBomb': {
        const cap = v?.capitalTile?.() ?? -1;
        const tile = v && cap >= 0 && cap < v.mapWidth * v.mapHeight ? cap : -1;
        const count = Math.max(1000, ms - GOTCHA_MS);
        if (tile >= 0) {
          this.ring = { tile, born: now, ms: count };
          this.lookTile = tile;
          setText(this.lookText, 'Your capital');
          this.look.classList.remove('hidden');
        }
        this.startCountdown(count, 'Incoming!', 'Gotcha!', 'Just confetti', Math.min(GOTCHA_MS, ms - count), () => {
          const vv = this.view?.() ?? null;
          const at = tile >= 0 && vv ? this.tilePoint(vv, tile) : null;
          if (this.ring && this.ring.tile === tile) this.ring.ms = 0;
          if (at) this.burst(at.x, at.y, 110, -Math.PI / 2, 1.15);
          else this.rain(window.innerWidth, window.innerHeight);
          this.kick();
        });
        this.countEl.classList.add('bomb');
        break;
      }
      case 'fogPuff': {
        const f = this.fogEl;
        f.classList.remove('on');
        void f.offsetWidth; // restart the animation
        f.style.animationDuration = `${ms}ms`;
        f.classList.remove('hidden');
        f.classList.add('on');
        break;
      }
      case 'jumpscare': {
        // a sudden full-screen scare: a scary face and a flash, with a sound sting. Reduced motion gets a mild,
        // silent variant (a brief dim with a small still face, no harsh flash or sound).
        const j = this.jumpEl;
        j.classList.remove('on', 'calm');
        void j.offsetWidth; // restart the animation
        j.style.animationDuration = `${ms}ms`;
        j.classList.remove('hidden');
        j.classList.add(calm ? 'calm' : 'on');
        if (!calm) this.playSting(ms);
        break;
      }
      case 'chase': {
        const cam = v?.camera;
        const u = v?.ownUnit?.() ?? null;
        if (!cam || !u) return this.dropNew(kind, p);
        const c = cam.get();
        const zoom = Math.min(24, Math.max(c.zoom * 1.6, 9));
        cam.flyTo(u.x + 0.5, u.y + 0.5, zoom, Math.min(CHASE_GLIDE_MS, ms / 3));
        p.chase = { unit: u.id, from: old?.chase?.from ?? { x: c.x, y: c.y, zoom: c.zoom }, phase: 'in', zoom, last: null };
        break;
      }
    }
    this.pranks.set(kind, p);
    this.kick();
    return true;
  }

  private dropNew(kind: PrankKind, p: Prank): boolean {
    clearTimeout(p.timer);
    this.endPrank(kind);
    return false;
  }

  /** Ends a prank and puts back what it changed (its timer calls this; so do a new game and the menu). */
  endPrank(kind: PrankKind): void {
    const p = this.pranks.get(kind);
    if (p) clearTimeout(p.timer);
    this.pranks.delete(kind);
    switch (kind) {
      case 'flip':
      case 'earthquake':
        this.applyWarp(performance.now());
        break;
      case 'disco':
        prankView.hue = 0;
        break;
      case 'ducks':
        prankView.ducks = false;
        break;
      case 'fakeBomb':
        if (this.countEl.classList.contains('bomb')) this.clearCountdown();
        break;
      case 'fogPuff':
        this.fogEl.classList.remove('on');
        this.fogEl.classList.add('hidden');
        break;
      case 'jumpscare':
        this.jumpEl.classList.remove('on', 'calm');
        this.jumpEl.classList.add('hidden');
        break;
      case 'chase': {
        // still gliding or following (its time ran out before the glide back): go back now
        const c = p?.chase;
        const cam = this.view?.()?.camera;
        if (c && cam && c.phase !== 'out') cam.flyTo(c.from.x, c.from.y, c.from.zoom, 600);
        break;
      }
    }
  }

  /** Every prank off at once. */
  endPranks(): void {
    for (const k of [...this.pranks.keys()]) this.endPrank(k);
    prankView.hue = 0;
    prankView.ducks = false;
    this.writeWarp(null);
  }

  private stepPranks(now: number): void {
    if (!this.pranks.size) return;
    const disco = this.pranks.get('disco');
    if (disco && !reducedMotion()) prankView.hue = 6 + (((now - disco.start) * 0.12) % 354); // once round in 3 s
    this.applyWarp(now);
    const chase = this.pranks.get('chase');
    if (chase) this.stepChase(chase, now);
  }

  /** The map's warp from the flip and the wobble now (null = none) and onto the map layers. */
  private applyWarp(now: number): void {
    const flip = this.pranks.get('flip');
    const quake = this.pranks.get('earthquake');
    if (!flip && !quake) {
      this.writeWarp(null);
      return;
    }
    const w: MapWarp = { rot: 0, sx: 1, sy: 1, dx: 0, dy: 0, moving: false };
    if (flip) {
      const k = turnAmount(now, flip.start, flip.end);
      if (flip.mode === 'mirror') w.sx = 1 - 2 * k;
      else w.rot = Math.PI * k;
      w.moving = k > 0.001 && k < 0.999;
    }
    if (quake) {
      // a smooth wobble (two sines each way, not random jitter), eased in over 0.4 s and out over 0.6 s
      const e = Math.max(0, Math.min(1, (now - quake.start) / 400, (quake.end - now) / 600));
      const t = now - quake.start;
      w.dx += e * 5 * (Math.sin(t * 0.021) + 0.5 * Math.sin(t * 0.047));
      w.dy += e * 3.5 * (Math.sin(t * 0.026 + 1.3) + 0.5 * Math.sin(t * 0.053));
      w.rot += e * 0.011 * Math.sin(t * 0.017);
    }
    this.writeWarp(w);
  }

  private writeWarp(w: MapWarp | null): void {
    setMapWarp(w);
    const layers = w ? this.view?.()?.mapLayers?.() ?? [] : [];
    const css = warpCss(w);
    for (const l of this.warped) if (!layers.includes(l)) l.style.transform = '';
    for (const l of layers) {
      l.style.transform = css;
      l.style.transformOrigin = '50% 50%';
    }
    this.warped = layers;
  }

  /** Glide in, follow, glide back; a pan or zoom by the player ends it where they put the camera. */
  private stepChase(p: Prank, now: number): void {
    const c = p.chase!;
    const cam = this.view?.()?.camera;
    const v = this.view?.() ?? null;
    if (!cam || !v) return this.endPrank('chase');
    const at = cam.get();
    const glide = Math.min(CHASE_GLIDE_MS, (p.end - p.start) / 3);
    const u = v.ownUnit?.(c.unit) ?? null;
    if (c.phase !== 'out' && (now >= p.end - glide || !u)) {
      c.phase = 'out';
      cam.flyTo(c.from.x, c.from.y, c.from.zoom, glide);
      return;
    }
    if (c.phase === 'out') {
      if (!at.flying) this.letGo(p); // back where it was (or the player took over on the way)
      return;
    }
    if (c.phase === 'in') {
      if (at.flying) return;
      if (now - p.start < glide - 50) return this.letGo(p); // the player took the camera
      c.phase = 'follow';
      c.zoom = at.zoom;
    } else if (c.last && (Math.abs(at.x - c.last.x) > 1e-3 || Math.abs(at.y - c.last.y) > 1e-3 || Math.abs(at.zoom - c.last.zoom) > 1e-3)) {
      return this.letGo(p);
    }
    if (!u) return;
    cam.centerOn(at.x + (u.x + 0.5 - at.x) * 0.18, at.y + (u.y + 0.5 - at.y) * 0.18);
    const after = cam.get();
    c.last = { x: after.x, y: after.y, zoom: after.zoom };
  }

  /** The player moved the camera during a chase: it ends there (no glide back). */
  private letGo(p: Prank): void {
    clearTimeout(p.timer);
    this.pranks.delete('chase');
  }

  // ---------------------------------------------------------------------------------------------- jumpscare sound

  private jumpAudio: AudioContext | null = null;
  /**
   * A short dissonant sting for the jumpscare, made in the browser (no bundled audio). Best-effort: a context that
   * cannot start (no WebAudio, or a page with no gesture yet) just stays quiet, and the scare still shows.
   */
  private playSting(ms: number): void {
    try {
      const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.jumpAudio ??= new AC();
      const ctx = this.jumpAudio;
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const dur = Math.min(0.9, Math.max(0.3, ms / 1000));
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.55, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      gain.connect(ctx.destination);
      // a few detuned saws falling an octave: a screech
      for (const f of [180, 186, 372]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f * 2, now);
        o.frequency.exponentialRampToValueAtTime(f, now + dur);
        o.connect(gain);
        o.start(now);
        o.stop(now + dur);
      }
      // a short noise burst for the hit
      const len = Math.max(1, Math.floor(ctx.sampleRate * 0.15));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.4, now);
      noise.connect(ng);
      ng.connect(ctx.destination);
      noise.start(now);
    } catch {
      /* no audio: the scare is visual only */
    }
  }
}
