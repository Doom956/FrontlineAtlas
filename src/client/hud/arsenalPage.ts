// One tab of the Research panel (hud/researchTree.ts hosts both): rows of tech cards on a shared column grid, with
// thin lines from each prerequisite to what it unlocks (an SVG per row, behind the cards). Layout: hud/techRows.ts.
//
// A card: icon (a ring fills while researching), name, "+ Name" for a prerequisite in another row or tab, the price
// and time ("1,000 gold · 3:40") or its state, a tag (Special, Mastery, "locks Submarines" on a fork before you pick),
// and a one-line effect. Click (or Enter) buys it. A fork is a split: the branches in two lanes with an OR between
// them and a dashed rule along the gap; after a pick the other branch is dimmed, struck through and its lines cut.
// The next affordable card glows with a NEXT flag. Arsenal cards (hud/procure.ts) are bought, not researched: the price
// in gold / iron / oil and the delivery time, a Buy pill, "Build a Port first" while the building it needs is missing,
// and a countdown bar while on order. Lines route through the gaps between columns and lanes, or along a
// rail above the cards, never behind one. Arrow keys move between cards (across rows too).
import './researchPanel.css';
import { TECHS } from '../../sim/config';
import { canResearch, hasTech } from '../../sim/tech';
import { choiceLockedBy, rivalsOf, techStatus, techStatusReason } from '../../sim/techtree';
import type { GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, pct, setClass, setText } from './dom';
import { iconSpan, lineIcon } from './glyph';
import { cutMark, roundedPath, type Box, type Pt } from './techFork';
import { arsenalCard, type ArsenalCard } from './procure';
import { formatEta, masteryCapLine, researchEta, type PanelLayout, type PanelRow, type RowCard, type RowEdge, type RowId } from './techRows';

export interface RowsHooks {
  /** icon markup and one-line effect of a tech */
  icon(t: TechId): string;
  line(t: TechId): string;
  focus(t: TechId | null): void;
  pick(t: TechId): void;
}

interface CardEl {
  c: RowCard;
  btn: HTMLButtonElement;
  ring: HTMLElement;
  name: HTMLElement;
  need: HTMLElement;
  meta: HTMLElement;
  tag: HTMLElement;
  line: HTMLElement;
  flag: HTMLElement;
  /** Arsenal cards: the Buy pill and the delivery bar */
  buy?: HTMLElement;
  bar?: HTMLElement;
  /** last price markup written (the price has icons: rebuilt only when it changes) */
  metaKey?: string;
  rowEl: HTMLElement;
  rowIdx: number;
}
interface EdgeEl {
  e: RowEdge;
  path: SVGPathElement;
  cut: SVGPathElement;
  at: Pt | null;
  atFrom?: Pt;
}
interface RowEl {
  r: PanelRow;
  el: HTMLElement;
  svg: SVGSVGElement;
  divs: SVGPathElement[];
  ors: HTMLElement[];
  edges: EdgeEl[];
  count: HTMLElement;
}

/** Shorter names for the "locks X" tag (it shares a line with the price). */
const SHORT: Partial<Record<TechId, string>> = { groundAttack: 'Ground-attack', heavyBombers: 'Heavy Bombers', diplomaticCorps: 'Diplomats', massMobilization: 'Mobilization', stockExchange: 'Stock Exch.' };

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(k: K, cls?: string): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG, k);
  if (cls) e.setAttribute('class', cls);
  return e;
};

export class TechRowsView {
  readonly root: HTMLElement;
  readonly cards = new Map<TechId, CardEl>();
  private rows: RowEl[] = [];
  private size = '';
  private focusT: TechId | null = null;
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
    for (const c of layout.cols) {
      const h = el('span', 'rp-colhead-c', c.label);
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
    const rowEl: RowEl = { r, el: row, svg, divs: [], ors: [], edges: [], count };
    for (const f of r.forks) {
      const d = svgEl('path', 'rp-fork-rule');
      svg.append(d);
      rowEl.divs.push(d);
      const or = el('span', 'rp-or', 'OR');
      or.dataset.test = `or-${f.group}`;
      row.append(or);
      rowEl.ors.push(or);
    }
    for (const e of r.edges) {
      const path = svgEl('path');
      const cut = svgEl('path', 'cut-mark');
      svg.append(path, cut);
      rowEl.edges.push({ e, path, cut, at: null });
    }
    for (const c of r.cards) row.append(this.card(c, row, ri));
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
    const ic = el('span', 'rp-ic');
    const ring = el('span', 'rp-ring');
    ic.append(ring, iconSpan(this.hooks.icon(c.tech), 'rp-glyph'));
    const top = el('span', 'rp-top');
    const name = el('span', 'rp-n', info.name);
    const need = el('span', 'rp-need');
    top.append(name, need);
    const mid = el('span', 'rp-mid');
    const meta = el('span', 'rp-meta');
    const tag = el('span', 'rp-tag');
    mid.append(meta, tag);
    let buy: HTMLElement | undefined;
    let bar: HTMLElement | undefined;
    if (this.layout.tab === 'arsenal') {
      buy = el('span', 'rp-buy', 'Buy');
      buy.setAttribute('aria-hidden', 'true');
      mid.append(buy);
      bar = el('span', 'rp-bar');
      bar.append(el('span'));
    }
    const line = el('span', 'rp-l', this.hooks.line(c.tech));
    const txt = el('span', 'rp-txt');
    txt.append(top, mid, line);
    const flag = el('span', 'rp-flag', 'Next');
    b.append(ic, txt, flag);
    if (bar) b.append(bar);
    b.addEventListener('pointerenter', () => this.setFocus(c.tech));
    b.addEventListener('focus', () => this.setFocus(c.tech));
    b.addEventListener('click', () => this.hooks.pick(c.tech));
    this.cards.set(c.tech, { c, btn: b, ring, name, need, meta, tag, line, flag, buy, bar, rowEl, rowIdx });
    return b;
  }

  /** Shows only the rows in `only` (empty = all). */
  filter(only: ReadonlySet<RowId>): void {
    for (const r of this.rows) setClass(r.el, 'hidden', only.size > 0 && !only.has(r.r.id));
    this.size = '';
  }

  /** Card states, tags, flags; then lines (re-laid out when the size changed). */
  update(s: GameState, me: Player, next: TechId | null): void {
    this.last = { s, me };
    for (const n of this.cards.values()) this.updateCard(s, me, n, next);
    for (const r of this.rows) {
      const done = r.r.cards.filter((c) => hasTech(me, c.tech)).length;
      setText(r.count, `${done}/${r.r.cards.length}`);
    }
    this.draw();
    this.updateEdges(s, me);
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
    let cls = 'avail';
    let meta = `${formatCount(info.gold)} gold · ${formatEta(researchEta(me, t))}`;
    let tip = '';
    const capLine = st === 'locked-choice' ? masteryCapLine(me, t) : null;
    const chose = st === 'locked-choice' && !capLine ? choiceLockedBy(me, t) : null;
    if (st === 'done') {
      cls = 'done';
      meta = 'Researched';
    } else if (st === 'researching') {
      cls = 'active';
      const f = Math.min(1, me.researchProgress / info.science);
      const left = me.income.science > 0 ? (info.science - me.researchProgress) / me.income.science : null;
      meta = `${pct(f)} · ${formatEta(left)} left`;
    } else if (st === 'locked-choice') {
      cls = 'locked';
      meta = capLine ?? (chose ? `You chose ${TECHS[chose].name}` : 'Locked');
      tip = techStatusReason(s, me.id, t) ?? '';
    } else if (st === 'disabled') {
      cls = 'locked';
      meta = techStatusReason(s, me.id, t) ?? 'Not available';
    } else if (st === 'locked-prereq') {
      cls = 'locked';
    } else if (!res.ok) {
      cls = 'avail poor';
      tip = res.reason ?? '';
    }
    for (const k of ['avail', 'done', 'active', 'locked']) setClass(n.btn, k, cls.split(' ').includes(k));
    setClass(n.btn, 'poor', cls.includes('poor'));
    setClass(n.btn, 'chose-other', !!chose);
    setClass(n.btn, 'capped', !!capLine);
    setClass(n.btn, 'next', next === t);
    setText(n.meta, meta);
    n.ring.style.setProperty('--p', st === 'researching' ? Math.min(1, me.researchProgress / info.science).toFixed(3) : '0');
    // prerequisites in another row or tab, while missing
    const row = this.rows[n.rowIdx].r;
    const out = (row.outside[t] ?? []).filter((r) => !hasTech(me, r));
    const anyOut = (TECHS[t].requiresAny ?? []).filter((r) => out.includes(r));
    const needTxt = out.length ? `+ ${out.filter((r) => !anyOut.includes(r)).map((r) => TECHS[r].name).concat(anyOut.length ? [anyOut.map((r) => TECHS[r].name).join(' or ')] : []).join(', ')}` : '';
    setText(n.need, st === 'done' || st === 'researching' ? '' : needTxt);
    // tag: a fork before the pick says what it locks; specials and masteries say so
    const rivals = rivalsOf(t);
    let tag = '';
    let tagCls = '';
    if (rivals.length && (st === 'available' || st === 'locked-prereq')) {
      tag = `locks ${rivals.map((r) => SHORT[r] ?? TECHS[r].name).join(', ')}`;
      tagCls = 'warn';
    } else if (n.c.kind === 'special') {
      tag = 'Special';
      tagCls = 'special';
    } else if (n.c.kind === 'mastery') {
      tag = capLine ? 'Locked' : 'Mastery';
      tagCls = 'mastery';
    }
    setText(n.tag, tag);
    n.tag.className = `rp-tag ${tagCls}`;
    const why = st === 'done' ? 'Researched' : st === 'researching' ? `Researching, ${meta}` : cls === 'locked' ? `Locked${tip ? `: ${tip}` : ''}` : res.ok ? `Available, ${meta}` : res.reason ?? 'Not possible now';
    n.btn.setAttribute('aria-label', `${info.name}: ${this.hooks.line(t)}. ${why}${tag && tagCls === 'warn' ? `. Choosing this ${tag}` : ''}`);
    n.btn.setAttribute('aria-disabled', String(!res.ok));
    // no tooltip: the footer says it all, and a tooltip would cover the neighbouring cards
    void tip;
  }

  /** An Arsenal card: bought with gold plus iron / oil, delivered after a timer (hud/procure.ts). */
  private updateArsenalCard(s: GameState, me: Player, n: CardEl, next: TechId | null): void {
    const t = n.c.tech;
    const info = TECHS[t];
    const a = arsenalCard(s, me, t);
    const st = a.state;
    const cls = st === 'done' ? 'done' : st === 'ordered' ? 'active' : st === 'buy' ? 'avail' : st === 'poor' ? 'avail poor' : 'locked';
    for (const k of ['avail', 'done', 'active', 'locked']) setClass(n.btn, k, cls.split(' ').includes(k));
    setClass(n.btn, 'poor', st === 'poor');
    setClass(n.btn, 'chose-other', st === 'chose-other');
    setClass(n.btn, 'capped', st === 'capped');
    setClass(n.btn, 'needs-building', st === 'building');
    setClass(n.btn, 'next', next === t);
    // the price line: icons and numbers, or the state
    let text: string | null = null;
    if (st === 'done') text = 'In service';
    else if (st === 'ordered') text = `Arrives in ${formatEta(a.order!.left)}`;
    else if (st === 'chose-other') text = `You chose ${TECHS[a.chose!].name}`;
    else if (st === 'capped' || st === 'disabled') text = a.reason;
    const key = text ?? priceKey(a);
    if (n.metaKey !== key) {
      n.metaKey = key;
      if (text !== null) setText(n.meta, text);
      else n.meta.innerHTML = priceHtml(a);
    }
    const f = a.order ? a.order.frac : 0;
    n.ring.style.setProperty('--p', f.toFixed(3));
    if (n.bar) {
      setClass(n.bar, 'on', st === 'ordered');
      (n.bar.firstElementChild as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`;
    }
    if (n.buy) setClass(n.buy, 'hidden', st !== 'buy' && st !== 'poor');
    // the effect line, or what is missing: "Build a Port first"
    setText(n.line, st === 'building' ? a.reason : this.hooks.line(t));
    setClass(n.line, 'warn', st === 'building');
    const row = this.rows[n.rowIdx].r;
    const out = (row.outside[t] ?? []).filter((r) => !hasTech(me, r));
    const anyOut = (info.requiresAny ?? []).filter((r) => out.includes(r));
    const needTxt = out.length ? `+ ${out.filter((r) => !anyOut.includes(r)).map((r) => TECHS[r].name).concat(anyOut.length ? [anyOut.map((r) => TECHS[r].name).join(' or ')] : []).join(', ')}` : '';
    setText(n.need, st === 'done' || st === 'ordered' ? '' : needTxt);
    // tag: a fork before the pick says what it locks (a flag on the top edge); Special / Mastery when there is room
    const rivals = rivalsOf(t);
    const open = st === 'buy' || st === 'poor' || st === 'building' || st === 'prereq';
    let tag = '';
    let tagCls = '';
    if (rivals.length && open) {
      tag = `locks ${rivals.map((r) => SHORT[r] ?? TECHS[r].name).join(', ')}`;
      tagCls = 'warn';
    } else if (text !== null) {
      // only when the line shows a state, not the price (the column headers say Special / Mastery too)
      if (n.c.kind === 'special') {
        tag = 'Special';
        tagCls = 'special';
      } else if (n.c.kind === 'mastery') {
        tag = st === 'capped' ? 'Locked' : 'Mastery';
        tagCls = 'mastery';
      }
    }
    setText(n.tag, tag);
    n.tag.className = `rp-tag ${tagCls}`;
    const p = a.price;
    const cost = [`${formatCount(p.gold)} gold`, p.iron ? `${formatCount(p.iron)} iron` : '', p.oil ? `${formatCount(p.oil)} oil` : ''].filter(Boolean).join(', ');
    const why =
      st === 'done' ? 'In service'
      : st === 'ordered' ? `On order, arrives in ${formatEta(a.order!.left)}`
      : st === 'buy' ? `Buy for ${cost}, delivered in ${formatEta(p.seconds)}`
      : st === 'poor' ? `${a.reason}. Costs ${cost}`
      : `Locked: ${a.reason}`;
    n.btn.setAttribute('aria-label', `${info.name}: ${this.hooks.line(t)}. ${why}${tagCls === 'warn' ? `. Choosing this ${tag}` : ''}`);
    n.btn.setAttribute('aria-disabled', String(st !== 'buy'));
  }

  private updateEdges(s: GameState, me: Player): void {
    for (const r of this.rows) {
      for (const x of r.edges) {
        const from = hasTech(me, x.e.from);
        const to = hasTech(me, x.e.to);
        const cutFrom = this.choiceLocked(s, me, x.e.from);
        const cut = cutFrom || this.choiceLocked(s, me, x.e.to);
        const base = to && from ? 'done' : cut ? 'fork-cut' : from ? 'open' : 'locked';
        const keep = ['hl-pre', 'hl-next'].filter((c) => x.path.classList.contains(c)).join(' ');
        const cls = `${base}${x.e.any ? ' either' : ''}${keep ? ` ${keep}` : ''}`;
        if (x.path.getAttribute('class') !== cls) x.path.setAttribute('class', cls);
        const at = cutFrom ? x.atFrom : x.at;
        const d = cut && at ? cutMark(at, 3.5) : '';
        if (x.cut.getAttribute('d') !== d) x.cut.setAttribute('d', d);
      }
      // a decided fork: the rule between the branches turns solid on the chosen side
      r.r.forks.forEach((f, k) => {
        const chosen = f.roots.find((t) => hasTech(me, t) || me.researching === t || (me.procuring ?? []).some((o) => o.tech === t));
        setClass(r.ors[k], 'decided', !!chosen);
      });
    }
  }

  /** Locked by a fork pick or the mastery cap (Arsenal: an order counts as a pick). */
  private choiceLocked(s: GameState, me: Player, t: TechId): boolean {
    if (this.layout.tab !== 'arsenal') return techStatus(s, me.id, t) === 'locked-choice';
    const st = arsenalCard(s, me, t).state;
    return st === 'chose-other' || st === 'capped';
  }

  /** Forces a re-layout of the lines on the next update (the panel opened or the window changed). */
  invalidate(): void {
    this.size = '';
  }

  /** Lays out the lines and the OR markers of every visible row (only when a size changed). */
  draw(): void {
    const key = this.rows.map((r) => `${r.el.offsetWidth}x${r.el.offsetHeight}`).join(',');
    if (!this.root.offsetWidth || key === this.size) return;
    this.size = key;
    for (const r of this.rows) if (!r.el.classList.contains('hidden')) this.drawRow(r);
    if (this.last) this.updateEdges(this.last.s, this.last.me);
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
    const cs = getComputedStyle(r.el);
    const colGap = parseFloat(cs.columnGap) || 24;
    const rowGap = parseFloat(cs.rowGap) || 10;
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
    // column x edges, from the cards
    const colL: number[] = [];
    const colR: number[] = [];
    for (const c of r.r.cards) {
      const b = boxes.get(c.tech)!;
      colL[c.col] = Math.min(colL[c.col] ?? Infinity, b.x);
      colR[c.col] = Math.max(colR[c.col] ?? -Infinity, b.x + b.w);
    }
    // forks: OR in the gap left of the branch roots, a dashed rule along the gap between the branches
    const obstacles: Box[] = [];
    r.r.forks.forEach((f, k) => {
      const y = gapY(f.lane) ?? H / 2;
      const x0 = colL[f.col0] ?? 0;
      const x1 = colR[f.col1] ?? W;
      const ox = x0 - colGap / 2;
      const or = r.ors[k];
      or.style.left = `${ox}px`;
      or.style.top = `${y}px`;
      const a = r.r.cards.find((c) => c.tech === f.roots[f.lane]);
      const b = r.r.cards.find((c) => c.tech === f.roots[f.lane + 1]);
      const ya = a ? boxes.get(a.tech)!.y + boxes.get(a.tech)!.h / 2 : y - 20;
      const yb = b ? boxes.get(b.tech)!.y + boxes.get(b.tech)!.h / 2 : y + 20;
      // bracket: ticks into both roots, joined through the OR; then the rule along the branch gap
      r.divs[k].setAttribute('d', `M${x0} ${ya}H${ox}V${yb}H${x0}M${x0 + 10} ${y}H${x1 - 10}`);
      obstacles.push({ x: x0, y: y - 2, w: x1 - x0, h: 4 });
    });
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
        for (const o of obstacles) if (o.x < xt && o.x + o.w > xs && y > o.y - 3 && y < o.y + o.h + 3) return true;
        return false;
      };
      const tries = [yb, ya];
      for (let k = 0; k < r.r.lanes - 1; k++) {
        const g = gapY(k);
        if (g !== null) tries.push(g);
      }
      tries.sort((p, q) => (p === yb ? -1 : q === yb ? 1 : p === ya ? -1 : q === ya ? 1 : Math.abs(p - yb) - Math.abs(q - yb)));
      const y = tries.find((v) => !blocked(v)) ?? rail;
      const pts: Pt[] = [{ x: a.x + a.w, y: ya }, { x: xs, y: ya }, { x: xs, y }, { x: xt, y }, { x: xt, y: yb }, { x: b.x - 4, y: yb }];
      const clean = pts.filter((p, k) => k === 0 || Math.abs(p.x - pts[k - 1].x) > 0.5 || Math.abs(p.y - pts[k - 1].y) > 0.5);
      x.path.setAttribute('d', roundedPath(clean, 6));
      // the cut mark sits next to the locked end (two path ends can share the last stretch into a mastery)
      x.at = { x: (xt + b.x) / 2, y: yb };
      x.atFrom = { x: (a.x + a.w + xs) / 2, y: ya };
    }
    void rowGap;
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
    // hovering a fork before the pick: the rival branches show what this choice would lock
    const wouldLock = new Set<TechId>();
    if (t && this.last) {
      const st = techStatus(this.last.s, this.last.me.id, t);
      if (st === 'available' || st === 'locked-prereq') {
        for (const r of rivalsOf(t)) {
          wouldLock.add(r);
          for (const n of this.cards.values()) if (n.c.branch === r && n.c.fork === TECHS[t].exclusiveGroup) wouldLock.add(n.c.tech);
        }
      }
    }
    setClass(this.root, 'hovering', !!t);
    for (const n of this.cards.values()) {
      setClass(n.btn, 'would-lock', wouldLock.has(n.c.tech));
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
    (vis.find((n) => n.btn.classList.contains('next')) ?? vis[0])?.btn.focus();
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

const RES_ICON = { gold: lineIcon('gold', 11, 2), iron: lineIcon('iron', 11, 2), oil: lineIcon('oil', 11, 2), time: lineIcon('clock', 11, 2) };
function priceKey(a: ArsenalCard): string {
  const p = a.price;
  return `${p.gold}|${p.iron}|${p.oil}|${p.seconds}|${a.short.gold ? 1 : 0}${a.short.iron ? 1 : 0}${a.short.oil ? 1 : 0}`;
}
/** "[gold] 1.5k  [iron] 80  [oil] 40  [clock] 30 s": each resource the price has, short ones marked. */
export function priceHtml(a: ArsenalCard): string {
  const p = a.price;
  const part = (k: 'gold' | 'iron' | 'oil', v: number): string => (v > 0 ? `<span class="rp-p p-${k}${a.short[k] ? ' short' : ''}">${RES_ICON[k]}${formatCount(v)}</span>` : '');
  return `${part('gold', p.gold)}${part('iron', p.iron)}${part('oil', p.oil)}<span class="rp-p p-time">${RES_ICON.time}${Math.round(p.seconds)} s</span>`;
}
