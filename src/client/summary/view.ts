// The end-of-game summary on the game-over card: land over time (your line highlighted, the top nations in colour,
// the rest faded) with the key moments on its timeline, and a small stats table (you, the winner, the top nations).
// Built once when the card opens; the chart redraws only when its box changes size.
import type { GameState } from '../../sim/types';
import { el, fmtTime } from '../hud/dom';
import { swatchCss } from '../hud/swatch';
import { formatCount } from '../render/common';
import type { GameHistory } from './history';
import { buildSummary, type Series, type StatColumn, type SummaryData } from './data';
import './summary.css';

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (text !== undefined) e.textContent = text;
  return e;
}
const pctText = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plot margins: y labels left, nation labels right, the moments row and time labels below. */
const M = { l: 38, r: 112, t: 10, b: 46 };
const X_STEPS = [30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200];

/** The y axis: its top and gridline step, the top a whole number of steps a little above the highest line. */
function yScale(data: SummaryData): { top: number; step: number } {
  let max = 0;
  for (const s of data.series) for (const [, v] of s.points) if (v > max) max = v;
  if (data.victoryShare > max && data.victoryShare - max < 0.12) max = data.victoryShare; // the win line when it is close
  max = Math.min(1, Math.max(0.1, max + 0.02));
  const step = max <= 0.3 ? 0.05 : max <= 0.6 ? 0.1 : 0.2;
  return { top: Math.min(1, Math.ceil(max / step - 1e-6) * step), step };
}

class Chart {
  readonly el: HTMLElement;
  private svgEl: SVGSVGElement;
  private tip: HTMLElement;
  private drawnW = 0;
  private markers: SVGGElement[] = [];
  private guide: SVGLineElement | null = null;
  private ro: ResizeObserver | null = null;
  /** moment index -> list row, for the two-way highlight */
  rows: HTMLElement[] = [];

  constructor(
    private data: SummaryData,
    private color: (id: number) => string,
    private me: number,
  ) {
    this.el = el('div', 'sum-chart');
    this.svgEl = svg('svg', { role: 'img' });
    this.svgEl.setAttribute('aria-label', this.describe());
    this.tip = el('div', 'sum-tip hidden');
    this.el.append(this.svgEl, this.tip);
    this.draw(640, 240);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        if (!this.el.isConnected) {
          this.ro?.disconnect();
          return;
        }
        const w = Math.round(this.el.clientWidth);
        const h = Math.round(this.el.clientHeight);
        if (w > 0 && h > 0 && Math.abs(w - this.drawnW) > 1) this.draw(w, h);
      });
      this.ro.observe(this.el);
    }
  }

  private describe(): string {
    const peak = (s: Series | undefined) => (s ? Math.max(...s.points.map((p) => p[1])) : 0);
    const mine = this.data.series.find((s) => s.role === 'me');
    const lead = this.data.series.filter((s) => s.role === 'top').map((s) => `${s.name} ${pctText(peak(s))}`);
    return `Share of the land over ${fmtTime(this.data.duration)} of play.${mine ? ` Your peak: ${pctText(peak(mine))}.` : ''} Top nations' peaks: ${lead.join(', ')}.`;
  }

  draw(W: number, H: number): void {
    this.drawnW = W;
    const d = this.data;
    const s = this.svgEl;
    s.replaceChildren();
    s.setAttribute('viewBox', `0 0 ${W} ${H}`);
    s.setAttribute('width', String(W));
    s.setAttribute('height', String(H));
    const pw = Math.max(40, W - M.l - M.r);
    const ph = Math.max(40, H - M.t - M.b);
    const { top, step } = yScale(d);
    const dur = Math.max(1, d.duration);
    const x = (t: number) => M.l + (t / dur) * pw;
    const y = (v: number) => M.t + ph - (v / top) * ph;

    // grid: share of the land (y), game time (x)
    const grid = svg('g', { class: 'sum-grid' });
    for (let k = 0; k * step <= top + 1e-6; k++) {
      const v = k * step;
      grid.append(svg('line', { x1: M.l, x2: M.l + pw, y1: y(v), y2: y(v), class: v === 0 ? 'base' : '' }));
      grid.append(svg('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, pctText(v)));
    }
    const xs = X_STEPS.find((st) => dur / st <= 6) ?? 7200;
    for (let t = 0; t <= dur + 1e-6; t += xs) grid.append(svg('text', { x: x(t), y: M.t + ph + 40, 'text-anchor': 'middle' }, fmtTime(t)));
    s.append(grid);
    if (d.victoryShare <= top) {
      const g = svg('g', { class: 'sum-win' });
      g.append(svg('line', { x1: M.l, x2: M.l + pw, y1: y(d.victoryShare), y2: y(d.victoryShare) }));
      g.append(svg('text', { x: M.l + 4, y: y(d.victoryShare) - 4 }, `Victory at ${pctText(d.victoryShare)}`));
      s.append(g);
    }

    // lines: faded first, then the top nations, yours last (on top, with a dark halo)
    const lines = svg('g', { class: 'sum-lines' });
    for (const se of d.series) {
      const pts = se.points.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      if (se.role === 'me') lines.append(svg('polyline', { points: pts, class: 'halo' }));
      const pl = svg('polyline', { points: pts, class: se.id === d.winner ? `${se.role} win` : se.role });
      if (se.role !== 'faded') pl.setAttribute('stroke', this.color(se.id));
      lines.append(pl);
    }
    s.append(lines);

    // names at the right end of the lines still there at the end (nudged apart)
    const labels = d.series
      .filter((se) => se.role !== 'faded' && se.points.length && se.points[se.points.length - 1][0] >= dur - 1 && se.points[se.points.length - 1][1] > 0)
      .map((se) => ({ se, v: se.points[se.points.length - 1][1], ly: y(se.points[se.points.length - 1][1]) }))
      .sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < labels.length; i++) labels[i].ly = Math.max(labels[i].ly, labels[i - 1].ly + 13);
    const over = labels.length ? labels[labels.length - 1].ly - (M.t + ph) : 0;
    if (over > 0) for (const l of labels) l.ly -= over;
    const lg = svg('g', { class: 'sum-ends' });
    for (const l of labels) {
      const t = svg('text', { x: M.l + pw + 8, y: l.ly + 4, class: l.se.role }, `${l.v < 0.01 ? '<1%' : pctText(l.v)} ${short(l.se.id === this.me ? 'You' : l.se.name, 11)}`);
      lg.append(svg('rect', { x: M.l + pw + 2, y: l.ly - 1, width: 4, height: 2, fill: this.color(l.se.id) }), t);
    }
    s.append(lg);

    // key moments: numbered markers under the time axis, a guide line through the chart on hover
    this.guide = svg('line', { x1: 0, x2: 0, y1: M.t, y2: M.t + ph, class: 'sum-guide hidden' });
    s.append(this.guide);
    this.markers = [];
    const mg = svg('g', { class: 'sum-marks', 'aria-hidden': 'true' });
    d.moments.forEach((m, i) => {
      const g = svg('g', { class: m.players.includes(this.me) ? 'mark mine' : 'mark', transform: `translate(${x(m.t).toFixed(1)},${M.t + ph + 15})` });
      g.append(svg('line', { x1: 0, x2: 0, y1: -15, y2: -8 }), svg('circle', { r: 8 }), svg('text', { y: 4, 'text-anchor': 'middle' }, String(i + 1)));
      g.addEventListener('pointerenter', () => this.focus(i, true));
      g.addEventListener('pointerleave', () => this.focus(i, false));
      mg.append(g);
      this.markers.push(g);
    });
    s.append(mg);
  }

  /** Highlights moment i on the chart and in the list; `tip` shows its text by the marker. */
  focus(i: number, on: boolean, tip = true): void {
    const m = this.data.moments[i];
    const g = this.markers[i];
    if (!m || !g) return;
    g.classList.toggle('on', on);
    this.rows[i]?.classList.toggle('on', on);
    const dur = Math.max(1, this.data.duration);
    const pw = Math.max(40, this.drawnW - M.l - M.r);
    const gx = M.l + (m.t / dur) * pw;
    if (this.guide) {
      this.guide.setAttribute('x1', gx.toFixed(1));
      this.guide.setAttribute('x2', gx.toFixed(1));
      this.guide.classList.toggle('hidden', !on);
    }
    this.tip.classList.toggle('hidden', !on || !tip);
    if (on && tip) {
      this.tip.textContent = `${fmtTime(m.t)}  ${m.text}`;
      const w = Math.min(380, this.drawnW - 8);
      this.tip.style.maxWidth = `${w}px`;
      const left = Math.max(4, Math.min(this.drawnW - this.tip.offsetWidth - 4, gx - this.tip.offsetWidth / 2));
      this.tip.style.transform = `translate(${Math.round(left)}px, 0)`;
    }
  }
}

const STAT_ROWS: { key: keyof StatColumn; label: string; tip: string; fmt: (c: StatColumn) => string }[] = [
  { key: 'landPeak', label: 'Most land', tip: 'The largest share of the land the nation held', fmt: (c) => pctText(c.landPeak, 1) },
  { key: 'battlesWon', label: 'Battles won', tip: 'Attacks on another nation that took land', fmt: (c) => formatCount(c.battlesWon) },
  { key: 'cities', label: 'Most cities', tip: 'The most cities held at one time', fmt: (c) => formatCount(c.cities) },
  { key: 'unitsBuilt', label: 'Units built', tip: 'Ships, planes, transports and tank divisions', fmt: (c) => formatCount(c.unitsBuilt) },
  { key: 'goldEarned', label: 'Gold earned', tip: 'All gold earned during the game', fmt: (c) => formatCount(c.goldEarned) },
  { key: 'alive', label: 'Time alive', tip: 'Game time until the end, or until the nation was eliminated', fmt: (c) => fmtTime(c.alive) },
];

function statsTable(cols: StatColumn[], color: (id: number) => string, me: number): HTMLElement {
  const t = el('table', 'sum-tbl');
  const head = el('tr');
  head.append(el('th'));
  for (const c of cols) {
    const th = el('th', c.id === me ? 'me' : '');
    th.scope = 'col';
    const n = el('span', 'sum-nat');
    const dot = el('i', 'sw');
    dot.style.background = color(c.id);
    n.append(dot, el('span', 'nm', short(c.name)));
    n.title = c.name;
    th.append(n, el('span', 'sum-tag', c.eliminated ? `${c.tag} · out` : c.tag));
    head.append(th);
  }
  t.append(el('thead'));
  t.tHead!.append(head);
  const body = el('tbody');
  for (const r of STAT_ROWS) {
    const tr = el('tr');
    const th = el('th', '', r.label);
    th.scope = 'row';
    th.dataset.tip = r.tip;
    tr.append(th);
    const vals = cols.map((c) => Number(c[r.key]));
    const best = Math.max(...vals);
    const tie = vals.every((v) => v === best); // nothing stands out when everyone has the same
    for (const c of cols) {
      const v = Number(c[r.key]);
      const cls = [c.id === me ? 'me' : '', best > 0 && v === best && !tie ? 'best' : ''].filter(Boolean).join(' ');
      tr.append(el('td', cls, r.fmt(c)));
    }
    body.append(tr);
  }
  t.append(body);
  return t;
}

/** The summary block of the game-over card. */
export function summaryView(state: GameState, history: GameHistory): HTMLElement {
  const data = buildSummary(state, history);
  const me = state.humanId;
  const color = (id: number) => {
    const p = state.players[id];
    return p ? swatchCss(p, me) : 'var(--faint)';
  };
  const root = el('div', 'sum');
  root.dataset.test = 'summary';

  // left: the chart, its legend and the moments
  const left = el('section', 'sum-panel sum-left');
  const head = el('div', 'sum-head');
  head.append(el('h2', 'wr-sec', 'Land over time'));
  const legend = el('div', 'sum-legend');
  // you first, then the top nations by place
  for (const se of [...data.series].reverse()) {
    if (se.role === 'faded') continue;
    const k = el('span', se.role === 'me' ? 'lg me' : 'lg');
    const dot = el('i', 'sw');
    dot.style.background = color(se.id);
    k.append(dot, short(se.role === 'me' ? 'You' : se.name, 12));
    legend.append(k);
  }
  if (data.series.some((s) => s.role === 'faded')) legend.append(el('span', 'lg faded', 'Others'));
  head.append(legend);
  const chart = new Chart(data, color, me);
  const list = el('ol', 'sum-moments');
  list.setAttribute('aria-label', 'Key moments');
  data.moments.forEach((m, i) => {
    const li = el('li', m.players.includes(me) ? 'mine' : '');
    li.tabIndex = 0;
    li.append(el('span', 'n', String(i + 1)), el('span', 't', fmtTime(m.t)), el('span', 'x', m.text));
    li.addEventListener('pointerenter', () => chart.focus(i, true, false));
    li.addEventListener('pointerleave', () => chart.focus(i, false));
    li.addEventListener('focus', () => chart.focus(i, true, false));
    li.addEventListener('blur', () => chart.focus(i, false));
    chart.rows[i] = li;
    list.append(li);
  });
  left.append(head, chart.el);
  if (data.moments.length) left.append(list);
  else left.append(el('p', 'sum-empty', 'No key moments were recorded in this game.'));

  // right: a few numbers per nation
  const right = el('section', 'sum-panel sum-right');
  right.append(el('h2', 'wr-sec', 'Nations compared'), statsTable(data.columns, color, me));
  root.append(left, right);
  return root;
}
