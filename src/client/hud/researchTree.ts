// Research drawer as a tree: tiers are columns (1 -> 4), each tech a node card (icon, short name, cost or state,
// one line on what it does), and lines from every prerequisite to the techs it unlocks, drawn in an SVG behind the
// cards. States: done (filled brass), researching (a ring filling up around the icon), available (bright edge),
// locked (dim, dashed). Hover or focus a tech: its whole prerequisite path and everything it leads to light up, the
// rest dims, and the footer explains it in full. Click (or Enter) researches it, the same action as before; a locked
// one says why. Arrow keys move between cards.
import { researchRule } from '../../sim/rules';
import { BUILDINGS, TECHS, TECH_ORDER } from '../../sim/config';
import { canResearch, hasTech } from '../../sim/tech';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, pct, setClass, setText, type DrawerId, type HudCtx } from './dom';
import { seg2, type DrawerPage } from './drawers';
import { iconSpan, lineIcon, worldGlyph } from './glyph';

/** One line per tech on what it gives (the config description has the numbers; it shows in the footer). */
export const TECH_LINE: Record<TechId, string> = {
  agriculture: 'Farms grow troops 50% faster',
  metallurgy: 'More iron; cheaper armor and artillery',
  logistics: 'Wider supply, faster attacks',
  fortification: 'Forts 2.5x stronger and wider',
  navigation: 'Unlocks warships; faster transports',
  banking: '+30% gold; better markets',
  medicine: 'Unlocks Hospitals; faster troop growth',
  mechanization: 'Armor +25% attack and defence',
  ballistics: 'Artillery +30%; longer barrages',
  flight: 'Unlocks Airfield, bombers and paratroopers',
  industrialization: 'Factories and arsenals twice as fast',
  combinedArms: '+20% attack with a mixed army',
  radar: 'Unlocks SAM sites; wider watchtowers',
  rocketry: 'Unlocks Missile Silo and rockets',
  nuclearFission: 'Unlocks the atom bomb',
};

const TECH_ICON: Record<TechId, () => string> = {
  agriculture: () => worldGlyph('farm', 20),
  metallurgy: () => worldGlyph('mine', 20),
  logistics: () => worldGlyph('supplyDepot', 20),
  fortification: () => worldGlyph('fort', 20),
  navigation: () => lineIcon('warship', 20),
  banking: () => worldGlyph('market', 20),
  medicine: () => worldGlyph('hospital', 20),
  mechanization: () => worldGlyph('factory', 20),
  ballistics: () => worldGlyph('arsenal', 20),
  flight: () => worldGlyph('airfield', 20),
  industrialization: () => lineIcon('build', 20),
  combinedArms: () => lineIcon('army', 20),
  radar: () => worldGlyph('sam', 20),
  rocketry: () => worldGlyph('silo', 20),
  nuclearFission: () => lineIcon('atom', 20),
};

/** Buildings each tech unlocks. */
const UNLOCKS: Partial<Record<TechId, BuildingType[]>> = {};
for (const b of Object.keys(BUILDINGS) as BuildingType[]) {
  const t = BUILDINGS[b].tech;
  if (t) (UNLOCKS[t] ??= []).push(b);
}
/** Techs each tech leads to directly. */
const CHILDREN: Partial<Record<TechId, TechId[]>> = {};
for (const t of TECH_ORDER) for (const r of TECHS[t].requires) (CHILDREN[r] ??= []).push(t);

function ancestors(t: TechId, out = new Set<TechId>()): Set<TechId> {
  for (const r of TECHS[t].requires) if (!out.has(r)) {
    out.add(r);
    ancestors(r, out);
  }
  return out;
}
function descendants(t: TechId, out = new Set<TechId>()): Set<TechId> {
  for (const c of CHILDREN[t] ?? []) if (!out.has(c)) {
    out.add(c);
    descendants(c, out);
  }
  return out;
}

/**
 * Column (tier - 1) and row of every tech: each column keeps TECH_ORDER for the first tier, later ones are sorted by
 * where their prerequisites sit and put as close to them as the rows allow, so most lines run straight.
 */
export function treeLayout(): { pos: Map<TechId, { col: number; row: number }>; rows: number; cols: number } {
  const tiers = [...new Set(TECH_ORDER.map((t) => TECHS[t].tier))].sort((a, b) => a - b);
  const pos = new Map<TechId, { col: number; row: number }>();
  const rows = Math.max(...tiers.map((tr) => TECH_ORDER.filter((t) => TECHS[t].tier === tr).length));
  tiers.forEach((tier, col) => {
    const list = TECH_ORDER.filter((t) => TECHS[t].tier === tier);
    const bary = (t: TechId): number => {
      const ps = TECHS[t].requires.map((r) => pos.get(r)?.row).filter((v): v is number => v !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : TECH_ORDER.indexOf(t);
    };
    const sorted = col === 0 ? list : [...list].sort((a, b) => bary(a) - bary(b) || TECH_ORDER.indexOf(a) - TECH_ORDER.indexOf(b));
    const want = sorted.map((t) => (col === 0 ? sorted.indexOf(t) : Math.round(bary(t))));
    const at: number[] = [];
    for (let k = 0; k < sorted.length; k++) at.push(Math.max(k === 0 ? 0 : at[k - 1] + 1, want[k]));
    // pushed past the last row: slide back up
    for (let k = sorted.length - 1; k >= 0; k--) at[k] = Math.min(at[k], k === sorted.length - 1 ? rows - 1 : at[k + 1] - 1);
    sorted.forEach((t, k) => pos.set(t, { col, row: at[k] }));
  });
  return { pos, rows, cols: tiers.length };
}

interface TechNode {
  t: TechId;
  btn: HTMLButtonElement;
  ring: HTMLElement;
  state: HTMLElement;
  col: number;
  row: number;
}

export class ResearchPage implements DrawerPage {
  id: DrawerId = 'research';
  title = 'Research';
  root = el('div', 'page rtree-page');
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private tree: HTMLElement;
  private svg: SVGSVGElement;
  private nodes = new Map<TechId, TechNode>();
  private edges: { from: TechId; to: TechId; path: SVGPathElement }[] = [];
  private focus: TechId | null = null;
  private size = '';
  private foot: HTMLElement;
  private footT: HTMLElement;
  private footD: HTMLElement;
  private footN: HTMLElement;
  private last: { s: GameState; me: Player } | null = null;

  constructor(private ctx: HudCtx) {
    // header: what is being researched (or science stored) and Auto / Manual
    const head = el('div', 'rt-head');
    const cur = el('div', 'rt-cur');
    const cv = el('span', 'rt-cur-v');
    const cl = el('span', 'rt-cur-l');
    const bar = el('div', 'pbar thin');
    const fill = el('span');
    bar.append(fill);
    cur.append(cv, cl, bar);
    const autoSeg = seg2(
      'Auto',
      'Manual',
      () => ctx.act({ type: 'setAuto', research: true }),
      () => ctx.act({ type: 'setAuto', research: false }),
    );
    autoSeg.el.dataset.test = 'auto-research';
    autoSeg.el.classList.add('rt-auto');
    head.append(cur, autoSeg.el);
    this.root.append(head);
    this.upd.push((s, me) => {
      const rule = researchRule(s);
      setClass(autoSeg.el, 'hidden', !!rule);
      setClass(bar, 'hidden', !!rule || !me.researching);
      const c = me.researching ? TECHS[me.researching] : null;
      if (rule) {
        setText(cv, rule);
        setText(cl, '');
      } else if (c) {
        setText(cv, c.name);
        setText(cl, `${pct(me.researchProgress / c.science)} · +${me.income.science.toFixed(1)} science/s`);
        fill.style.width = pct(Math.min(1, me.researchProgress / c.science));
      } else {
        setText(cv, `${formatCount(me.science)} science`);
        setText(cl, `+${me.income.science.toFixed(1)}/s · ${me.auto.research ? 'auto picks the next tech' : 'pick a tech'}`);
      }
      autoSeg.set(!!me.auto.research);
    });

    // the tree: tier labels, the SVG with the lines, the cards
    const lay = treeLayout();
    this.tree = el('div', 'rtree');
    this.tree.style.setProperty('--cols', String(lay.cols));
    this.tree.style.setProperty('--rows', String(lay.rows));
    this.tree.setAttribute('role', 'group');
    this.tree.setAttribute('aria-label', 'Technology tree');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('rt-lines');
    this.svg.setAttribute('aria-hidden', 'true');
    this.tree.append(this.svg);
    for (let c = 0; c < lay.cols; c++) {
      const lab = el('div', 'rt-tier', `Tier ${c + 1}`);
      lab.style.gridColumn = String(c + 1);
      this.tree.append(lab);
    }
    for (const t of TECH_ORDER) {
      const p = lay.pos.get(t)!;
      this.tree.append(this.node(t, p.col, p.row));
    }
    for (const t of TECH_ORDER) {
      for (const r of TECHS[t].requires) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.svg.append(path);
        this.edges.push({ from: r, to: t, path });
      }
    }
    this.tree.addEventListener('pointerleave', () => this.setFocus(null));
    this.tree.addEventListener('focusout', (e) => {
      if (!this.tree.contains(e.relatedTarget as Node | null)) this.setFocus(null);
    });
    this.tree.addEventListener('keydown', (e) => this.onKey(e));
    this.root.append(this.tree);

    // footer: the hovered / focused tech in full, else a hint
    this.foot = el('div', 'rt-foot');
    this.footT = el('div', 'rt-foot-t');
    this.footD = el('div', 'rt-foot-d');
    this.footN = el('div', 'rt-foot-n');
    this.foot.append(this.footT, this.footD, this.footN);
    this.root.append(this.foot);
    this.upd.push((s, me) => this.updateNodes(s, me));
  }

  onOpen(): void {
    this.size = '';
    requestAnimationFrame(() => this.drawLines());
  }

  private node(t: TechId, col: number, row: number): HTMLButtonElement {
    const info = TECHS[t];
    const b = el('button', 'rt-node locked');
    b.type = 'button';
    b.dataset.test = `tech-${t}`;
    b.style.gridColumn = String(col + 1);
    b.style.gridRow = String(row + 2);
    const ic = el('span', 'rt-ic');
    const ring = el('span', 'rt-ring');
    ic.append(ring, iconSpan(TECH_ICON[t](), 'rt-glyph'));
    const name = el('span', 'rt-n', info.name);
    const state = el('span', 'rt-s');
    const line = el('span', 'rt-l', TECH_LINE[t]);
    const top = el('span', 'rt-top');
    top.append(name, state);
    const txt = el('span', 'rt-txt');
    txt.append(top, line);
    b.append(ic, txt);
    b.addEventListener('pointerenter', () => this.setFocus(t));
    b.addEventListener('focus', () => this.setFocus(t));
    b.addEventListener('click', () => this.pick(t));
    this.nodes.set(t, { t, btn: b, ring, state, col, row });
    return b;
  }

  private pick(t: TechId): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    if (hasTech(me, t) || me.researching === t) return;
    const r = canResearch(s, me.id, t);
    if (!r.ok) {
      this.ctx.toast(`${TECHS[t].name}: ${r.reason ?? 'not possible now'}`, 'info');
      this.ctx.sound('uiError');
      return;
    }
    this.ctx.act({ type: 'research', tech: t });
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    const cur = [...this.nodes.values()].find((n) => n.btn === document.activeElement);
    if (!cur) return;
    e.preventDefault();
    e.stopPropagation();
    const all = [...this.nodes.values()];
    let next: TechNode | undefined;
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const col = all.filter((n) => n.col === cur.col).sort((a, b) => a.row - b.row);
      const i = col.indexOf(cur) + (k === 'ArrowUp' ? -1 : 1);
      next = col[Math.max(0, Math.min(col.length - 1, i))];
    } else {
      const c = cur.col + (k === 'ArrowLeft' ? -1 : 1);
      const col = all.filter((n) => n.col === c);
      next = col.sort((a, b) => Math.abs(a.row - cur.row) - Math.abs(b.row - cur.row))[0];
    }
    next?.btn.focus();
  }

  private setFocus(t: TechId | null): void {
    if (this.focus === t) return;
    this.focus = t;
    const anc = t ? ancestors(t) : new Set<TechId>();
    const desc = t ? descendants(t) : new Set<TechId>();
    setClass(this.tree, 'hovering', !!t);
    for (const n of this.nodes.values()) {
      setClass(n.btn, 'hl', n.t === t);
      setClass(n.btn, 'hl-pre', anc.has(n.t));
      setClass(n.btn, 'hl-next', desc.has(n.t));
    }
    for (const e of this.edges) {
      const pre = t !== null && (e.to === t || anc.has(e.to)) && (anc.has(e.from) || e.from === t);
      const next = t !== null && (e.from === t || desc.has(e.from)) && desc.has(e.to);
      e.path.classList.toggle('hl-pre', pre);
      e.path.classList.toggle('hl-next', next);
    }
    if (this.last) this.updateFoot(this.last.s, this.last.me);
  }

  /** Lines from each prerequisite's right edge to the unlocked tech's left edge (re-laid out on size changes). */
  private drawLines(): void {
    const tw = this.tree.clientWidth;
    const th = this.tree.clientHeight;
    if (!tw || !th) return;
    const size = `${tw}x${th}`;
    if (size === this.size) return;
    this.size = size;
    this.svg.setAttribute('viewBox', `0 0 ${tw} ${th}`);
    this.svg.setAttribute('width', String(tw));
    this.svg.setAttribute('height', String(th));
    for (const e of this.edges) {
      const a = this.nodes.get(e.from)!.btn;
      const b = this.nodes.get(e.to)!.btn;
      const x1 = a.offsetLeft + a.offsetWidth;
      const y1 = a.offsetTop + a.offsetHeight / 2;
      const x2 = b.offsetLeft;
      const y2 = b.offsetTop + b.offsetHeight / 2;
      const mx = (x1 + x2) / 2;
      e.path.setAttribute('d', `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2 - 5} ${y2}`);
    }
  }

  private updateNodes(s: GameState, me: Player): void {
    this.last = { s, me };
    const rule = researchRule(s);
    for (const n of this.nodes.values()) {
      const info = TECHS[n.t];
      const done = hasTech(me, n.t);
      const active = me.researching === n.t;
      const missing = info.requires.filter((r) => !hasTech(me, r));
      let cls = 'avail';
      let text = `${formatCount(info.gold)} gold`;
      if (done) {
        cls = 'done';
        text = 'Done';
      } else if (active) {
        cls = 'active';
        text = pct(me.researchProgress / info.science);
      } else if (rule || missing.length) {
        cls = 'locked';
      }
      for (const c of ['avail', 'done', 'active', 'locked']) setClass(n.btn, c, c === cls);
      setText(n.state, text);
      n.ring.style.setProperty('--p', active ? Math.min(1, me.researchProgress / info.science).toFixed(3) : '0');
      const ok = !done && !active && canResearch(s, me.id, n.t).ok;
      n.btn.setAttribute('aria-disabled', String(!ok));
      n.btn.setAttribute('aria-label', `${info.name}: ${TECH_LINE[n.t]}. ${done ? 'Researched' : active ? `Researching, ${text}` : cls === 'locked' ? 'Locked' : 'Available'}`);
    }
    for (const e of this.edges) {
      const from = hasTech(me, e.from);
      const to = hasTech(me, e.to);
      e.path.setAttribute('class', `${to ? 'done' : from ? 'open' : 'locked'}${e.path.classList.contains('hl-pre') ? ' hl-pre' : ''}${e.path.classList.contains('hl-next') ? ' hl-next' : ''}`);
    }
    this.drawLines();
    this.updateFoot(s, me);
  }

  private updateFoot(s: GameState, me: Player): void {
    const t = this.focus;
    if (!t) {
      setText(this.footT, researchRule(s) ? '' : 'Hover or focus a tech');
      setText(this.footD, 'Lines run from each tech to what it unlocks. A tech costs gold to start and science to finish; picking one switches Auto off.');
      setText(this.footN, '');
      return;
    }
    const info = TECHS[t];
    setText(this.footT, `${info.name} · tier ${info.tier} · ${formatCount(info.gold)} gold, ${formatCount(info.science)} science`);
    const unl = UNLOCKS[t]?.map((b) => BUILDINGS[b].name) ?? [];
    setText(this.footD, info.description + (unl.length ? ` Unlocks: ${unl.join(', ')}.` : ''));
    let note = '';
    if (hasTech(me, t)) note = 'Researched.';
    else if (me.researching === t) note = `Researching: ${pct(me.researchProgress / info.science)}.`;
    else {
      const r = canResearch(s, me.id, t);
      const missing = info.requires.filter((q) => !hasTech(me, q));
      if (missing.length) note = `Needs ${missing.map((q) => TECHS[q].name).join(' + ')} first.`;
      else if (!r.ok) note = `${r.reason ?? 'Not possible now'}.`;
      else note = me.researching ? `Click to start it instead of ${TECHS[me.researching].name} (its progress is lost).` : 'Click to research it.';
    }
    const next = (CHILDREN[t] ?? []).map((c) => TECHS[c].name);
    setText(this.footN, note + (next.length ? ` Leads to ${next.join(', ')}.` : ''));
  }

  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }
}
