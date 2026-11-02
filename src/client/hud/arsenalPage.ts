// One tab of the Research panel (hud/researchTree.ts hosts both): rows of tech cards on a shared column grid, with
// thin lines from each prerequisite to what it unlocks (an SVG per row, behind the cards). Layout: hud/techRows.ts.
//
// Every card has the same size and two lines: the name, then its state or price ("Owned", "600 · 2:30", "Needs
// Ballistics", "Arrives in 0:23", "Not chosen"). States differ by shape and words, not colour alone: owned cards are
// muted with a brass edge and a check, available ones have a brass outline, researching / on order a steel outline and
// a bar along the bottom, locked ones a dashed outline and a lock, not-chosen ones are faded. A fork (choose one) sits
// in one bracket box. The full description, prices and the Buy / Research button are in the host's detail pane.
// Lines are one plain style; hovering a card lights the path to it (brass) and from it (steel). Arrow keys move
// between cards (across rows too). On a phone the rows become a vertical list grouped by tier (CSS), one row at a time.
import './researchPanel.css';
import { TECHS } from '../../sim/config';
import { canResearch, hasTech } from '../../sim/tech';
import { missingPrereqs, rivalsOf, techStatus, techStatusReason } from '../../sim/techtree';
import type { GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, pct, setClass, setText } from './dom';
import { iconSpan, lineIcon } from './glyph';
import { roundedPath, type Box, type Pt } from './techFork';
import { arsenalCard, type ArsenalCard } from './procure';
import { formatEta, masteryCapLine, researchEta, type PanelLayout, type PanelRow, type RowCard, type RowEdge, type RowId } from './techRows';

export interface RowsHooks {
  /** icon markup and one-line effect of a tech */
  icon(t: TechId): string;
  line(t: TechId): string;
  focus(t: TechId | null): void;
  pick(t: TechId): void;
}

/** The card's state: what it looks like (owned, available, in progress, locked, not chosen). */
export type CardLook = 'done' | 'avail' | 'active' | 'locked' | 'off';

interface CardEl {
  c: RowCard;
  btn: HTMLButtonElement;
  meta: HTMLElement;
  mark: HTMLElement;
  flag: HTMLElement;
  bar: HTMLElement;
  /** last line 2 written (prices have icons: rebuilt only when they change) */
  metaKey?: string;
  markKey?: string;
  look: CardLook;
  rowEl: HTMLElement;
  rowIdx: number;
}
interface EdgeEl {
  e: RowEdge;
  path: SVGPathElement;
}
interface RowEl {
  r: PanelRow;
  el: HTMLElement;
  svg: SVGSVGElement;
  forks: { group: string; roots: TechId[]; el: HTMLElement }[];
  edges: EdgeEl[];
  count: HTMLElement;
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(k: K, cls?: string): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, k);
  if (cls) e.setAttribute('class', cls);
  return e;
};
const MARK = { done: lineIcon('accept', 14, 2.2) };
let uid = 0;

/**
 * A locked card's line: the first missing tech, and "+n" when more are missing ("Needs Banking +1"), so it fits the
 * card. The detail pane and the card's accessible name give the whole requirement.
 */
function needsShort(me: Player, t: TechId): string {
  const info = TECHS[t];
  const has = (r: TechId): boolean => me.techs.includes(r);
  const parts = info.requires.filter((r) => !has(r)).map((r) => TECHS[r].name);
  if (info.requiresAny?.length && !info.requiresAny.some(has)) parts.push(info.requiresAny.map((r) => TECHS[r].name).join(' or '));
  if (!parts.length) return 'Locked';
  return parts.length === 1 ? `Needs ${parts[0]}` : `Needs ${parts[0]} +${parts.length - 1}`;
}

/** Column label without the old "· choose one" (the fork bracket says it). */
export function colLabel(label: string): string {
  return label.replace(/\s*·\s*choose one$/i, '');
}

export class TechRowsView {
  readonly root: HTMLElement;
  readonly cards = new Map<TechId, CardEl>();
  private rows: RowEl[] = [];
  private size = '';
  private focusT: TechId | null = null;
  private selT: TechId | null = null;
  private last: { s: GameState; me: Player } | null = null;
  /** column header cells by column key (the host writes the mastery counter into the Mastery one) */
  readonly heads = new Map<string, HTMLElement>();

  constructor(readonly layout: PanelLayout, private hooks: RowsHooks) {
    this.root = el('div', `rp-grid rp-${layout.tab}`);
    this.root.style.setProperty('--cols', String(layout.cols.length));
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', layout.tab === 'research' ? 'Research techs' : 'Arsenal');
    // column labels
    const head = el('div', 'rp-colhead');
    head.append(el('span', 'rp-colhead-k'));
    let prev = '';
    for (const c of layout.cols) {
      // a tier that spans two columns is named once (the second "Tier 3" read like a mistake)
      const label = colLabel(c.label);
      const h = el('span', 'rp-colhead-c', label === prev ? '' : label);
      prev = label;
      this.heads.set(c.key, h);
      head.append(h);
    }
    this.root.append(head);
    layout.rows.forEach((r, ri) => this.buildRow(r, ri));
    this.root.addEventListener('pointerleave', () => this.setFocus(null));
    this.root.addEventListener('focusout', (e) => {
      if (!this.root.contains(e.relatedTarget as Node | null)) this.setFocus(null);
    });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
  }

  private buildRow(r: PanelRow, ri: number): void {
    const row = el('div', 'rp-row');
    row.dataset.row = r.id;
    row.dataset.test = `row-${r.id}`;
    row.style.setProperty('--lanes', String(r.lanes));
    if (r.lanes === 1) row.classList.add('one-lane');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', r.name);
    const lab = el('div', 'rp-rowlab');
    lab.style.gridRow = `1 / span ${r.lanes}`;
    const count = el('span', 'rp-rowlab-n');
    lab.append(el('span', 'rp-rowlab-t', r.name), count);
    const svg = svgEl('svg', 'rp-lines');
    svg.setAttribute('aria-hidden', 'true');
    row.append(svg, lab);
    const rowEl: RowEl = { r, el: row, svg, forks: [], edges: [], count };
    // one "Choose one" bracket per fork: around every card of both branches (the grid places it)
    const seen = new Set<string>();
    for (const f of r.forks) {
      if (seen.has(f.group)) continue;
      seen.add(f.group);
      const fc = r.cards.filter((c) => c.fork === f.group);
      const lanes = fc.map((c) => c.lane);
      const l0 = Math.min(...lanes);
      const l1 = Math.max(...fc.map((c) => c.lane + c.span));
      const box = el('div', 'rp-fork');
      box.dataset.test = `or-${f.group}`;
      box.style.gridColumn = `${f.col0 + 2} / ${f.col1 + 3}`;
      box.style.gridRow = `${l0 + 1} / ${l1 + 1}`;
      box.setAttribute('aria-hidden', 'true');
      box.append(el('span', 'rp-fork-l', 'Choose one'));
      row.append(box);
      rowEl.forks.push({ group: f.group, roots: f.roots, el: box });
    }
    for (const e of r.edges) {
      const path = svgEl('path');
      svg.append(path);
      rowEl.edges.push({ e, path });
    }
    // cards column by column, each column after its tier label (the label only shows in the phone list)
    const roots = new Set(r.forks.flatMap((f) => f.roots));
    const cols = [...new Set(r.cards.map((c) => c.col))].sort((a, b) => a - b);
    for (const col of cols) {
      const list = r.cards.filter((c) => c.col === col).sort((a, b) => a.lane - b.lane);
      const base = colLabel(this.layout.cols[col]?.label ?? '');
      const choose = list.some((c) => roots.has(c.tech));
      row.append(el('div', `rp-tier${choose ? ' choose' : ''}`, choose ? `${base}: choose one` : base));
      for (const c of list) row.append(this.card(c, row, ri));
    }
    this.rows.push(rowEl);
    this.root.append(row);
  }

  private card(c: RowCard, rowEl: HTMLElement, rowIdx: number): HTMLButtonElement {
    const info = TECHS[c.tech];
    const b = el('button', `rp-card k-${c.kind} locked`);
    b.type = 'button';
    b.dataset.test = `tech-${c.tech}`;
    b.style.gridColumn = String(c.col + 2);
    b.style.gridRow = `${c.lane + 1} / span ${c.span}`;
    if (c.fork) b.dataset.fork = c.fork;
    const txt = el('span', 'rp-txt');
    const meta = el('span', 'rp-meta');
    txt.append(el('span', 'rp-n', info.name), meta);
    // the effect stays with the card for screen readers; the detail pane shows it in full
    const line = el('span', 'rp-l', this.hooks.line(c.tech));
    line.id = `rp-l-${++uid}`;
    b.setAttribute('aria-describedby', line.id);
    const mark = el('span', 'rp-mark');
    mark.setAttribute('aria-hidden', 'true');
    const flag = el('span', 'rp-flag', 'Next');
    flag.setAttribute('aria-hidden', 'true');
    const bar = el('span', 'rp-bar');
    bar.append(el('span'));
    b.append(iconSpan(this.hooks.icon(c.tech), 'rp-ic'), txt, mark, line, flag, bar);
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') this.setFocus(c.tech);
    });
    b.addEventListener('focus', () => this.setFocus(c.tech));
    b.addEventListener('click', () => this.hooks.pick(c.tech));
    this.cards.set(c.tech, { c, btn: b, meta, mark, flag, bar, look: 'locked', rowEl, rowIdx });
    return b;
  }

  /** Shows only the rows in `only` (empty = all). */
  filter(only: ReadonlySet<RowId>): void {
    for (const r of this.rows) setClass(r.el, 'hidden', only.size > 0 && !only.has(r.r.id));
    this.size = '';
  }

  /** Marks the card the detail pane is pinned to. */
  select(t: TechId | null): void {
    this.selT = t;
    for (const n of this.cards.values()) setClass(n.btn, 'sel', n.c.tech === t);
  }

  /** Card states and flags; then lines (re-laid out when the size changed). */
  update(s: GameState, me: Player, next: TechId | null): void {
    this.last = { s, me };
    for (const n of this.cards.values()) this.updateCard(s, me, n, next);
    for (const r of this.rows) {
      const done = r.r.cards.filter((c) => hasTech(me, c.tech)).length;
      setText(r.count, `${done}/${r.r.cards.length}`);
      for (const f of r.forks) {
        const chosen = f.roots.find((t) => hasTech(me, t) || me.researching === t || (me.procuring ?? []).some((o) => o.tech === t));
        setClass(f.el, 'decided', !!chosen);
      }
    }
    this.draw();
    this.updateEdges(me);
  }

  private setLook(n: CardEl, look: CardLook, extra: Record<string, boolean>): void {
    n.look = look;
    for (const k of ['avail', 'done', 'active', 'locked', 'off'] as const) setClass(n.btn, k, k === look);
    for (const [k, v] of Object.entries(extra)) setClass(n.btn, k, v);
    // locked cards need no padlock: the dashed outline and "Needs X" say it (and leave the requirement room)
    const mk = look === 'done' ? 'done' : '';
    if (n.markKey !== mk) {
      n.markKey = mk;
      n.mark.innerHTML = mk ? MARK[mk] : '';
    }
  }
  private setMeta(n: CardEl, key: string, html: () => string, plain: boolean): void {
    if (n.metaKey === key) return;
    n.metaKey = key;
    setClass(n.meta, 'price', !plain);
    if (plain) setText(n.meta, key);
    else n.meta.innerHTML = html();
  }
  private setBar(n: CardEl, f: number | null): void {
    setClass(n.bar, 'on', f !== null);
    (n.bar.firstElementChild as HTMLElement).style.width = `${((f ?? 0) * 100).toFixed(1)}%`;
  }

  private updateCard(s: GameState, me: Player, n: CardEl, next: TechId | null): void {
    if (this.layout.tab === 'arsenal') {
      this.updateArsenalCard(s, me, n, next);
      return;
    }
    const t = n.c.tech;
    const info = TECHS[t];
    const st = techStatus(s, me.id, t);
    const res = canResearch(s, me.id, t);
    let look: CardLook = 'avail';
    let text: string | null = null;
    let full: string | null = null; // the whole requirement, for screen readers (the card shows a short one)
    let bar: number | null = null;
    const capLine = st === 'locked-choice' ? masteryCapLine(me, t) : null;
    if (st === 'done') {
      look = 'done';
      text = 'Owned';
    } else if (st === 'researching') {
      look = 'active';
      bar = Math.min(1, me.researchProgress / info.science);
      const left = me.income.science > 0 ? (info.science - me.researchProgress) / me.income.science : null;
      text = `${pct(bar)} · ${formatEta(left)} left`;
    } else if (st === 'locked-choice') {
      look = 'off';
      text = capLine ?? 'Not chosen';
    } else if (st === 'disabled') {
      look = 'off';
      text = techStatusReason(s, me.id, t) ?? 'Not available';
    } else if (st === 'locked-prereq') {
      look = 'locked';
      const miss = missingPrereqs(me, t);
      text = miss ? needsShort(me, t) : 'Locked';
      if (miss) full = `Needs ${miss}`;
    }
    const poor = look === 'avail' && !res.ok;
    this.setLook(n, look, { poor, next: next === t, 'chose-other': st === 'locked-choice' && !capLine, capped: !!capLine });
    const short = me.gold < info.gold;
    const eta = formatEta(researchEta(me, t));
    this.setMeta(n, text ?? `${info.gold}|${eta}|${short ? 1 : 0}`, () => researchPriceHtml(info.gold, eta, short), text !== null);
    this.setBar(n, bar);
    const why = full ?? text ?? (res.ok ? `Available: ${formatCount(info.gold)} gold, ${eta}` : res.reason ?? 'Not possible now');
    const fork = rivalsOf(t).length && (look === 'avail' || look === 'locked') ? ', choose one' : '';
    n.btn.setAttribute('aria-label', `${info.name}: ${why}${fork}`);
  }

  /** An Arsenal card: bought with gold plus iron / oil, delivered after a timer (hud/procure.ts). */
  private updateArsenalCard(s: GameState, me: Player, n: CardEl, next: TechId | null): void {
    const t = n.c.tech;
    const info = TECHS[t];
    const a = arsenalCard(s, me, t);
    const st = a.state;
    const look: CardLook = st === 'done' ? 'done' : st === 'ordered' ? 'active' : st === 'buy' || st === 'poor' ? 'avail' : st === 'building' || st === 'prereq' ? 'locked' : 'off';
    this.setLook(n, look, { poor: st === 'poor', next: next === t, 'chose-other': st === 'chose-other', capped: st === 'capped', 'needs-building': st === 'building' });
    let text: string | null = null;
    let full: string | null = null;
    if (st === 'done') text = 'In service';
    else if (st === 'ordered') text = `Arrives in ${formatEta(a.order!.left)}`;
    else if (st === 'chose-other') text = 'Not chosen';
    else if (st === 'building') text = a.reason;
    else if (st === 'prereq') {
      const miss = missingPrereqs(me, t);
      text = miss ? needsShort(me, t) : a.reason;
      if (miss) full = `Needs ${miss}`;
    } else if (st === 'capped' || st === 'disabled') text = a.reason;
    this.setMeta(n, text ?? priceKey(a), () => priceHtml(a), text !== null);
    this.setBar(n, st === 'ordered' ? a.order!.frac : null);
    const p = a.price;
    const cost = [`${formatCount(p.gold)} gold`, p.iron ? `${formatCount(p.iron)} iron` : '', p.oil ? `${formatCount(p.oil)} oil` : ''].filter(Boolean).join(', ');
    const why = st === 'buy' ? `Buy for ${cost}, arrives ${formatEta(p.seconds)} later` : st === 'poor' ? `${a.reason}. Costs ${cost}` : full ?? text ?? a.reason;
    const fork = rivalsOf(t).length && (look === 'avail' || look === 'locked') ? ', choose one' : '';
    n.btn.setAttribute('aria-label', `${info.name}: ${why}${fork}`);
  }

  private updateEdges(me: Player): void {
    for (const r of this.rows) {
      for (const x of r.edges) {
        const off = this.cards.get(x.e.from)?.look === 'off' || this.cards.get(x.e.to)?.look === 'off';
        const base = hasTech(me, x.e.to) && hasTech(me, x.e.from) ? 'done' : off ? 'off' : 'open';
        const keep = ['hl-pre', 'hl-next'].filter((c) => x.path.classList.contains(c)).join(' ');
        const cls = `${base}${keep ? ` ${keep}` : ''}`;
        if (x.path.getAttribute('class') !== cls) x.path.setAttribute('class', cls);
      }
    }
  }

  /** Forces a re-layout of the lines on the next update (the panel opened or the window changed). */
  invalidate(): void {
    this.size = '';
  }

  /** Lays out the lines of every visible row (only when a size changed). */
  draw(): void {
    const key = this.rows.map((r) => `${r.el.offsetWidth}x${r.el.offsetHeight}`).join(',');
    if (!this.root.offsetWidth || key === this.size) return;
    this.size = key;
    for (const r of this.rows) if (!r.el.classList.contains('hidden')) this.drawRow(r);
    if (this.last) this.updateEdges(this.last.me);
  }

  private boxOf(e: HTMLElement, row: HTMLElement): Box {
    let x = 0;
    let y = 0;
    let n: HTMLElement | null = e;
    while (n && n !== row) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    return { x, y, w: e.offsetWidth, h: e.offsetHeight };
  }

  private drawRow(r: RowEl): void {
    const W = r.el.offsetWidth;
    // the padding box, a pixel short: rows have fractional heights and an svg reaching past the row would give the
    // scrolling rows box (.rp-body) a needless scrollbar; the paths may still draw past it (overflow visible)
    const H = Math.max(0, r.el.clientHeight - 1);
    r.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    r.svg.setAttribute('width', String(W));
    r.svg.setAttribute('height', String(H));
    // the phone list has no lines
    if (getComputedStyle(r.svg).display === 'none') return;
    const cs = getComputedStyle(r.el);
    const colGap = parseFloat(cs.columnGap) || 24;
    const padTop = parseFloat(cs.paddingTop) || 8;
    const boxes = new Map<TechId, Box>();
    for (const c of r.r.cards) boxes.set(c.tech, this.boxOf(this.cards.get(c.tech)!.btn, r.el));
    // lane geometry: the y between lane k and k+1 (from the single-lane cards)
    const laneTop: number[] = [];
    const laneBot: number[] = [];
    for (const c of r.r.cards) {
      if (c.span !== 1) continue;
      const b = boxes.get(c.tech)!;
      laneTop[c.lane] = Math.min(laneTop[c.lane] ?? Infinity, b.y);
      laneBot[c.lane] = Math.max(laneBot[c.lane] ?? -Infinity, b.y + b.h);
    }
    const gapY = (k: number): number | null => (laneBot[k] !== undefined && laneTop[k + 1] !== undefined ? (laneBot[k] + laneTop[k + 1]) / 2 : null);
    const rail = Math.max(2, padTop / 2);
    for (const x of r.edges) {
      const a = boxes.get(x.e.from)!;
      const b = boxes.get(x.e.to)!;
      const ya = a.y + a.h / 2;
      const yb = b.y + b.h / 2;
      const xs = a.x + a.w + colGap / 2;
      const xt = b.x - colGap / 2;
      const blocked = (y: number): boolean => {
        if (xt - xs < 1) return false;
        for (const [t, bx] of boxes) {
          if (t === x.e.from || t === x.e.to) continue;
          if (bx.x < xt && bx.x + bx.w > xs && y > bx.y - 3 && y < bx.y + bx.h + 3) return true;
        }
        return false;
      };
      const tries = [yb, ya];
      for (let k = 0; k < r.r.lanes - 1; k++) {
        const g = gapY(k);
        if (g !== null) tries.push(g);
      }
      tries.sort((p, q) => (p === yb ? -1 : q === yb ? 1 : p === ya ? -1 : q === ya ? 1 : Math.abs(p - yb) - Math.abs(q - yb)));
      const y = tries.find((v) => !blocked(v)) ?? rail;
      const pts: Pt[] = [{ x: a.x + a.w, y: ya }, { x: xs, y: ya }, { x: xs, y }, { x: xt, y }, { x: xt, y: yb }, { x: b.x, y: yb }];
      const clean = pts.filter((p, k) => k === 0 || Math.abs(p.x - pts[k - 1].x) > 0.5 || Math.abs(p.y - pts[k - 1].y) > 0.5);
      x.path.setAttribute('d', roundedPath(clean, 6));
    }
  }

  private setFocus(t: TechId | null): void {
    if (this.focusT === t) return;
    this.focusT = t;
    const anc = new Set<TechId>();
    const desc = new Set<TechId>();
    if (t) {
      const up = (x: TechId): void => {
        const i = TECHS[x];
        for (const r of [...i.requires, ...(i.requiresAny ?? [])]) if (!anc.has(r)) {
          anc.add(r);
          up(r);
        }
      };
      up(t);
      const down = (x: TechId): void => {
        for (const n of this.cards.values()) {
          const i = TECHS[n.c.tech];
          if ((i.requires.includes(x) || (i.requiresAny ?? []).includes(x)) && !desc.has(n.c.tech)) {
            desc.add(n.c.tech);
            down(n.c.tech);
          }
        }
      };
      down(t);
    }
    setClass(this.root, 'hovering', !!t);
    for (const n of this.cards.values()) {
      setClass(n.btn, 'hl', n.c.tech === t);
      setClass(n.btn, 'hl-pre', anc.has(n.c.tech));
      setClass(n.btn, 'hl-next', desc.has(n.c.tech));
    }
    for (const r of this.rows) {
      for (const x of r.edges) {
        const pre = t !== null && (x.e.to === t || anc.has(x.e.to)) && (anc.has(x.e.from) || x.e.from === t);
        const nx = t !== null && (x.e.from === t || desc.has(x.e.from)) && desc.has(x.e.to);
        x.path.classList.toggle('hl-pre', pre);
        x.path.classList.toggle('hl-next', nx);
      }
    }
    this.hooks.focus(t);
  }

  /** Focuses the first card (or the NEXT one) of the tab. */
  focusFirst(): void {
    const vis = [...this.cards.values()].filter((n) => !n.rowEl.classList.contains('hidden'));
    (vis.find((n) => n.c.tech === this.selT) ?? vis.find((n) => n.btn.classList.contains('next')) ?? vis[0])?.btn.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    const cur = [...this.cards.values()].find((n) => n.btn === document.activeElement);
    if (!cur) return;
    e.preventDefault();
    e.stopPropagation();
    const vis = [...this.cards.values()].filter((n) => !n.rowEl.classList.contains('hidden'));
    // a card's position on one global lane axis: rows stacked, lanes inside
    const rowBase = new Map<number, number>();
    let acc = 0;
    this.rows.forEach((r, i) => {
      rowBase.set(i, acc);
      if (!r.el.classList.contains('hidden')) acc += r.r.lanes;
    });
    const ymid = (n: CardEl): number => rowBase.get(n.rowIdx)! + n.c.lane + n.c.span / 2;
    const cy = ymid(cur);
    let pick: CardEl | undefined;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      const same = vis.filter((n) => n.rowIdx === cur.rowIdx && Math.sign(n.c.col - cur.c.col) === dir);
      pick = same.sort((a, b) => Math.abs(a.c.col - cur.c.col) - Math.abs(b.c.col - cur.c.col) || Math.abs(ymid(a) - cy) - Math.abs(ymid(b) - cy))[0];
    } else {
      const dir = k === 'ArrowUp' ? -1 : 1;
      const cand = vis.filter((n) => n !== cur && Math.sign(ymid(n) - cy) === dir);
      pick = cand.sort((a, b) => Math.abs(ymid(a) - cy) + Math.abs(a.c.col - cur.c.col) * 2 - (Math.abs(ymid(b) - cy) + Math.abs(b.c.col - cur.c.col) * 2))[0];
    }
    pick?.btn.focus();
  }
}

const RES_ICON = { gold: lineIcon('gold', 12, 2), iron: lineIcon('iron', 12, 2), oil: lineIcon('oil', 12, 2), time: lineIcon('clock', 12, 2) };
function priceKey(a: ArsenalCard): string {
  const p = a.price;
  return `${p.gold}|${p.iron}|${p.oil}|${p.seconds}|${a.short.gold ? 1 : 0}${a.short.iron ? 1 : 0}${a.short.oil ? 1 : 0}`;
}
const cell = (k: 'gold' | 'iron' | 'oil', v: number, short: boolean): string => `<span class="rp-p p-${k}${short ? ' short' : ''}">${RES_ICON[k]}${formatCount(v)}</span>`;
/**
 * "[gold] 1.5k  [iron] 80  [oil] 40  [clock] 30 s": each resource the price has (short ones marked), in fixed slots so
 * the figures line up from card to card; the time sits at the end.
 */
export function priceHtml(a: ArsenalCard): string {
  const p = a.price;
  const parts = [cell('gold', p.gold, a.short.gold)];
  if (p.iron > 0) parts.push(cell('iron', p.iron, a.short.iron));
  if (p.oil > 0) parts.push(cell('oil', p.oil, a.short.oil));
  return `${parts.join('')}<span class="rp-p p-time">${Math.round(p.seconds)} s</span>`;
}
/** A research card's price: gold to start and the time to finish at the current science rate. */
function researchPriceHtml(gold: number, eta: string, short: boolean): string {
  return `${cell('gold', gold, short)}<span class="rp-p p-time">${RES_ICON.time}${eta}</span>`;
}
