// Alert cards (left column, under the standings), the map ping and the Alerts drawer page (bell button).
//
// A card: icon, one short line, "x3" when it happened again, a thin bar running down until it fades. Click (or tap)
// anywhere on it: the camera glides there and a ring pings the spot. At most MAX_CARDS at once (newest on top); the
// pointer over the stack holds them. Every alert also goes to the drawer's list (last 20), with the same jump.
import { gameSecondsAt } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import type { AlertEntry, AlertFeed } from '../alerts';
import type { Camera } from '../camera';
import { el, fmtTime, setClass, setText, type DrawerId } from './dom';
import type { DrawerPage } from './drawers';
import { iconSpan, lineIcon } from './glyph';
import { mapShown } from '../fx/prankView';

const MAX_CARDS = 3;
/** ms on screen: a red (bad) alert a little longer */
const LIFE_MS = { bad: 9000, warn: 7000, info: 7000 } as const;

interface Card {
  entry: AlertEntry;
  el: HTMLElement;
  text: HTMLElement;
  count: HTMLElement;
  life: HTMLElement;
  until: number;
  left: number;
}

export class AlertStack {
  readonly el: HTMLElement;
  private cards: Card[] = [];
  private held = false;

  constructor(private jump: (e: AlertEntry) => void) {
    this.el = el('div', 'alerts');
    this.el.dataset.test = 'alerts';
    this.el.setAttribute('role', 'log');
    this.el.setAttribute('aria-live', 'assertive');
    this.el.setAttribute('aria-label', 'Alerts');
    // the pointer over the stack holds the cards (and their bars) until it leaves
    this.el.addEventListener('pointerenter', () => this.hold(true));
    this.el.addEventListener('pointerleave', () => this.hold(false));
  }

  /** Shows a new alert, or refreshes the card of one it joined (count, text, timer). */
  show(entry: AlertEntry, now = performance.now()): void {
    const life = LIFE_MS[entry.tone];
    const old = this.cards.find((c) => c.entry === entry);
    if (old) {
      this.fill(old);
      old.until = now + life;
      old.left = life;
      this.restartBar(old, life);
      // to the top, with a short nudge so the change is seen
      if (this.el.firstChild !== old.el) this.el.prepend(old.el);
      this.cards.splice(this.cards.indexOf(old), 1);
      this.cards.unshift(old);
      old.el.classList.remove('bump');
      void old.el.offsetWidth;
      old.el.classList.add('bump');
      return;
    }
    const card = el('div', `alert t-${entry.tone}`);
    card.dataset.test = 'alert';
    const go = el('button', 'al-go');
    go.type = 'button';
    const text = el('span', 'al-t');
    const hint = el('span', 'al-h', entry.tile >= 0 ? 'Show on the map' : '');
    const body = el('span', 'al-body');
    body.append(text, hint);
    const count = el('span', 'al-n');
    go.append(iconSpan(lineIcon(entry.icon, 18), 'al-ic'), body, count);
    if (entry.tile >= 0) go.addEventListener('click', () => this.jump(entry));
    else go.disabled = true;
    const x = el('button', 'al-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss alert');
    x.append(iconSpan(lineIcon('close', 12, 2)));
    const bar = el('i', 'al-life');
    card.append(go, x, bar);
    const c: Card = { entry, el: card, text, count, life: bar, until: now + LIFE_MS[entry.tone], left: LIFE_MS[entry.tone] };
    x.addEventListener('click', () => this.drop(c));
    this.fill(c);
    this.restartBar(c, c.left);
    this.el.prepend(card);
    this.cards.unshift(c);
    while (this.cards.length > MAX_CARDS) this.drop(this.cards[this.cards.length - 1]);
  }

  /** ~5 Hz: fades out cards whose time is up (not while held). */
  update(now = performance.now()): void {
    if (this.held) return;
    for (const c of [...this.cards]) if (now > c.until) this.drop(c);
  }

  get count(): number {
    return this.cards.length;
  }

  clear(): void {
    for (const c of [...this.cards]) this.drop(c);
  }

  private fill(c: Card): void {
    setText(c.text, c.entry.text);
    setText(c.count, c.entry.count > 1 ? `x${c.entry.count}` : '');
    setClass(c.count, 'hidden', c.entry.count < 2);
    c.el.querySelector('.al-go')?.setAttribute('aria-label', `${c.entry.text}${c.entry.count > 1 ? ` (${c.entry.count} times)` : ''}${c.entry.tile >= 0 ? '. Show on the map' : ''}`);
  }

  private restartBar(c: Card, ms: number): void {
    c.life.style.animation = 'none';
    void c.life.offsetWidth;
    c.life.style.animation = `al-life ${ms}ms linear forwards`;
  }

  private hold(on: boolean): void {
    if (on === this.held) return;
    this.held = on;
    const now = performance.now();
    for (const c of this.cards) {
      if (on) c.left = Math.max(0, c.until - now);
      // after a hold, at least 2 s more so a card read under the pointer doesn't vanish the moment it leaves
      else c.until = now + Math.max(2000, c.left);
    }
    setClass(this.el, 'held', on);
  }

  private drop(c: Card): void {
    const i = this.cards.indexOf(c);
    if (i < 0) return;
    this.cards.splice(i, 1);
    c.el.classList.add('out');
    setTimeout(() => c.el.remove(), 200);
  }
}

/** Rings that grow and fade on a map tile for PING_MS (positioned every frame: the camera moves meanwhile). */
export const PING_MS = 1800;
export class MapPing {
  readonly el: HTMLElement;
  private x = 0;
  private y = 0;
  private born = -Infinity;

  constructor(private camera: Camera) {
    this.el = el('div', 'map-ping hidden');
    this.el.setAttribute('aria-hidden', 'true');
    this.el.append(el('i'), el('i'), el('b'));
  }

  ping(tile: number, mapWidth: number, tone: string, now = performance.now()): void {
    this.x = (tile % mapWidth) + 0.5;
    this.y = ((tile / mapWidth) | 0) + 0.5;
    this.born = now;
    this.el.className = `map-ping p-${tone}`;
    // restart the CSS rings
    void this.el.offsetWidth;
    this.el.classList.add('go');
    this.frame(now);
  }

  /** Every frame. */
  frame(now = performance.now()): void {
    if (this.el.classList.contains('hidden')) return;
    if (now - this.born > PING_MS) {
      this.el.classList.add('hidden');
      return;
    }
    const t = this.camera.tileToScreen(this.x, this.y);
    const p = mapShown(t.x, t.y); // a screen prank may show the map turned (fx/prankView.ts)
    this.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  }
}

/** The Alerts drawer: the last alerts, newest first, each a button that jumps to its spot. */
export class AlertsPage implements DrawerPage {
  id: DrawerId = 'alerts';
  title = 'Alerts';
  root = el('div', 'page');
  private list = el('div', 'al-list');
  private shown = -1;
  /** entries that had news when the log was opened (or came in while it is open): marked */
  private news = new Set<number>();

  constructor(private feed: AlertFeed, private jump: (e: AlertEntry) => void) {
    this.root.append(el('p', 'note', 'Big events: attacks on you, lost ships and tanks, bombs on their way. Click one to see where.'), this.list);
    this.list.dataset.test = 'alert-log';
  }

  onOpen(): void {
    this.news.clear();
    this.shown = -1;
  }

  update(s: GameState, _me: Player): void {
    for (const e of this.feed.log) if (this.feed.isUnread(e.id)) this.news.add(e.id);
    this.feed.markRead();
    if (this.shown === this.feed.version) return;
    this.shown = this.feed.version;
    const rows: HTMLElement[] = [];
    for (const e of this.feed.log) {
      const r = el('button', `al-row t-${e.tone}${this.news.has(e.id) ? ' new' : ''}`);
      r.type = 'button';
      r.dataset.test = 'alert-row';
      r.append(el('span', 'al-tm', fmtTime(gameSecondsAt(s, e.tick))), iconSpan(lineIcon(e.icon, 16), 'al-ic'), el('span', 'al-t', e.text));
      if (e.count > 1) r.append(el('span', 'al-n', `x${e.count}`));
      if (e.tile >= 0) {
        r.dataset.tip = 'Show on the map';
        r.addEventListener('click', () => this.jump(e));
      } else r.disabled = true;
      rows.push(r);
    }
    if (!rows.length) rows.push(el('p', 'note al-empty', 'No alerts yet. When something big happens to you, it shows up here.'));
    this.list.replaceChildren(...rows);
  }
}
