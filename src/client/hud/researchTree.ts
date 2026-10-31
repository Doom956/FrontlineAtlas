// Research drawer as a tree: tiers are columns, each tech a node card (icon, short name, cost or state, one line on
// what it does), and lines from every prerequisite to the techs it unlocks, drawn in an SVG behind the cards.
// Exclusive choices (TechInfo.exclusiveGroup) are drawn as a FORK: the group's cards side by side with an "OR" marker
// between them; choosing one shows the others as "locked by your choice" (crossed line, dim, struck name), and before
// choosing, the card's tooltip warns "Choosing this locks <other>". Layout and line routing: hud/techFork.ts.
// States: done (filled brass), researching (a ring filling up around the icon), available (bright edge), locked (dim,
// dashed). Hover or focus a tech: its whole prerequisite path and everything it leads to light up, the rest dims, and
// the footer explains it in full. Click (or Enter) researches it; a locked one says why. Arrow keys move between cards.
import { researchRule } from '../../sim/rules';
import { BUILDINGS, TECHS, TECH_ORDER } from '../../sim/config';
import { canResearch, hasTech } from '../../sim/tech';
import { choiceWarning, groupName, techStatus, techStatusReason } from '../../sim/techtree';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, pct, setClass, setText, setTip, type DrawerId, type HudCtx } from './dom';
import { seg2, type DrawerPage } from './drawers';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { BRANCH_TECH_ICON, BRANCH_TECH_LINE, cutMark, forkLayout, roundedPath, routeEdge, techParents, type Box, type RouteEnd, type TreeLayout } from './techFork';

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
  ...BRANCH_TECH_LINE,
} as Record<TechId, string>;

const TECH_ICON = {
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
  ...BRANCH_TECH_ICON,
} as Record<TechId, () => string>;
const iconOf = (t: TechId): string => (TECH_ICON[t] ?? (() => lineIcon('science', 20)))();
const lineOf = (t: TechId): string => TECH_LINE[t] ?? TECHS[t].description;

/** Buildings each tech unlocks. */
const UNLOCKS: Partial<Record<TechId, BuildingType[]>> = {};
for (const b of Object.keys(BUILDINGS) as BuildingType[]) {
  const t = BUILDINGS[b].tech;
  if (t) (UNLOCKS[t] ??= []).push(b);
}
/** Techs each tech leads to directly (requires and either-or requiresAny). */
const CHILDREN: Partial<Record<TechId, TechId[]>> = {};
for (const t of TECH_ORDER) {
  const p = techParents(t);
  for (const r of [...p.all, ...p.any]) (CHILDREN[r] ??= []).push(t);
}
function parentsOf(t: TechId): TechId[] {
  const p = techParents(t);
  return [...p.all, ...p.any];
}
function ancestors(t: TechId, out = new Set<TechId>()): Set<TechId> {
  for (const r of parentsOf(t)) if (!out.has(r)) {
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
 * Column (track) and row of every tech, for tests and older callers: a fork's techs share their slot's cell.
 * `cols` counts tracks (a tier with choices and ordinary techs has two).
 */
export function treeLayout(): { pos: Map<TechId, { col: number; row: number }>; rows: number; cols: number; layout: TreeLayout } {
  const layout = forkLayout();
  const pos = new Map<TechId, { col: number; row: number }>();
  for (const s of layout.slots) for (const t of s.techs) pos.set(t, { col: s.col, row: s.row });
  return { pos, rows: layout.rows, cols: layout.tracks.length, layout };
}

interface TechNode {
  t: TechId;
  btn: HTMLButtonElement;
  ring: HTMLElement;
  state: HTMLElement;
  col: number;
  row: number;
  /** position in its fork (0 = leftmost), -1 when not in a fork */
  fork: number;
  /** the fork's container, when in one */
  forkEl: HTMLElement | null;
  forkSize: number;
}
interface Edge {
  from: TechId;
  to: TechId;
  path: SVGPathElement;
  /** the target's "OR" sibling of a choice made (crossed line) */
  cut: SVGPathElement;
  any: boolean;
}

export class ResearchPage implements DrawerPage {
  id: DrawerId = 'research';
  title = 'Research';
  root = el('div', 'page rtree-page');
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private tree: HTMLElement;
  private svg: SVGSVGElement;
  private nodes = new Map<TechId, TechNode>();
  private edges: Edge[] = [];
  private focus: TechId | null = null;
  private size = '';
  private foot: HTMLElement;
  private footT: HTMLElement;
  private footD: HTMLElement;
  private footN: HTMLElement;
  private last: { s: GameState; me: Player } | null = null;
  private cutKey = '';

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

    // the tree: track labels, the SVG with the lines, the cards (forks hold their cards side by side)
    const lay = treeLayout().layout;
    this.tree = el('div', 'rtree forked');
    this.tree.style.setProperty('--cols', String(lay.tracks.length));
    this.tree.style.setProperty('--rows', String(lay.rows));
    this.tree.style.gridTemplateColumns = lay.tracks.map((t) => `minmax(0, ${t.weight}fr)`).join(' ');
    this.tree.setAttribute('role', 'group');
    this.tree.setAttribute('aria-label', 'Technology tree');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('rt-lines');
    this.svg.setAttribute('aria-hidden', 'true');
    this.tree.append(this.svg);
    lay.tracks.forEach((tr, c) => {
      const lab = el('div', 'rt-tier', tr.label);
      lab.style.gridColumn = String(c + 1);
      this.tree.append(lab);
    });
    for (const slot of lay.slots) {
      if (!slot.group) {
        const b = this.node(slot.techs[0], slot.col, slot.row, -1, null, 1);
        b.style.gridColumn = String(slot.col + 1);
        b.style.gridRow = String(slot.row + 2);
        this.tree.append(b);
        continue;
      }
      const fork = el('div', 'rt-fork');
      fork.dataset.test = `fork-${slot.group}`;
      fork.style.gridColumn = String(slot.col + 1);
      fork.style.gridRow = String(slot.row + 2);
      fork.setAttribute('role', 'group');
      fork.setAttribute('aria-label', `${groupName(slot.group)}: choose one of ${slot.techs.map((t) => TECHS[t].name).join(' or ')}`);
      slot.techs.forEach((t, k) => {
        fork.append(this.node(t, slot.col, slot.row, k, fork, slot.techs.length));
        if (k > 0) {
          const or = el('span', 'rt-or', 'OR');
          or.style.left = `${(k / slot.techs.length) * 100}%`;
          fork.append(or);
        }
      });
      this.tree.append(fork);
    }
    for (const t of TECH_ORDER) {
      const p = techParents(t);
      for (const [r, any] of [...p.all.map((x) => [x, false] as const), ...p.any.map((x) => [x, true] as const)]) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const cut = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cut.setAttribute('class', 'cut-mark');
        this.svg.append(path, cut);
        this.edges.push({ from: r, to: t, path, cut, any });
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

  private node(t: TechId, col: number, row: number, fork: number, forkEl: HTMLElement | null, forkSize: number): HTMLButtonElement {
    const info = TECHS[t];
    const b = el('button', 'rt-node locked');
    b.type = 'button';
    b.dataset.test = `tech-${t}`;
    const ic = el('span', 'rt-ic');
    const ring = el('span', 'rt-ring');
    ic.append(ring, iconSpan(iconOf(t), 'rt-glyph'));
    const name = el('span', 'rt-n', info.name);
    const state = el('span', 'rt-s');
    const line = el('span', 'rt-l', lineOf(t));
    if (fork >= 0) {
      // fork cards: icon and state on top, the name (two lines) under them; the one-liner is in the footer
      const top = el('span', 'rt-head2');
      top.append(ic, state);
      b.append(top, name);
    } else {
      const top = el('span', 'rt-top');
      top.append(name, state);
      const txt = el('span', 'rt-txt');
      txt.append(top, line);
      b.append(ic, txt);
    }
    b.addEventListener('pointerenter', () => this.setFocus(t));
    b.addEventListener('focus', () => this.setFocus(t));
    b.addEventListener('click', () => this.pick(t));
    this.nodes.set(t, { t, btn: b, ring, state, col, row, fork, forkEl, forkSize });
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
      const col = all.filter((n) => n.col === cur.col && n.fork <= 0).sort((a, b) => a.row - b.row);
      const at = col.findIndex((n) => n.row === cur.row);
      const i = at + (k === 'ArrowUp' ? -1 : 1);
      next = col[Math.max(0, Math.min(col.length - 1, i))];
    } else if (cur.fork >= 0 && ((k === 'ArrowRight' && cur.fork < cur.forkSize - 1) || (k === 'ArrowLeft' && cur.fork > 0))) {
      // inside a fork: to the other choice
      next = all.find((n) => n.col === cur.col && n.row === cur.row && n.fork === cur.fork + (k === 'ArrowRight' ? 1 : -1));
    } else {
      const c = cur.col + (k === 'ArrowLeft' ? -1 : 1);
      const col = all.filter((n) => n.col === c && (n.fork < 0 || n.fork === (k === 'ArrowLeft' ? n.forkSize - 1 : 0)));
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

  /** Position of an element inside the tree (offsets, so the HUD's scale does not matter). */
  private boxOf(e: HTMLElement): Box {
    let x = 0;
    let y = 0;
    let n: HTMLElement | null = e;
    while (n && n !== this.tree) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent as HTMLElement | null;
    }
    return { x, y, w: e.offsetWidth, h: e.offsetHeight };
  }

  /** Lines from each prerequisite to what it unlocks (re-laid out on size changes). */
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
    const cs = getComputedStyle(this.tree);
    const colGap = parseFloat(cs.columnGap) || 24;
    const rowGap = parseFloat(cs.rowGap) || 8;
    const end = (n: TechNode, as: 'from' | 'to'): RouteEnd => {
      const box = this.boxOf(n.btn);
      const fork = n.forkEl ? this.boxOf(n.forkEl) : undefined;
      if (as === 'from') return { box, fork, exit: n.fork >= 0 && n.fork < n.forkSize - 1 ? 'bottom' : 'right' };
      return { box, fork, enter: n.fork > 0 ? 'top' : 'left' };
    };
    for (const e of this.edges) {
      const a = this.nodes.get(e.from)!;
      const b = this.nodes.get(e.to)!;
      const ra = end(a, 'from');
      const rb = end(b, 'to');
      const pts = routeEdge(ra, rb, colGap, rowGap, b.col === a.col + 1);
      if (!pts) {
        const x1 = ra.box.x + ra.box.w;
        const y1 = ra.box.y + ra.box.h / 2;
        const x2 = rb.box.x;
        const y2 = rb.box.y + rb.box.h / 2;
        const mx = (x1 + x2) / 2;
        e.path.setAttribute('d', `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2 - 5} ${y2}`);
        e.cut.dataset.at = `${x2 - 13},${y2}`;
      } else {
        e.path.setAttribute('d', roundedPath(pts, 7));
        const p = pts[pts.length - 2];
        const z = pts[pts.length - 1];
        e.cut.dataset.at = `${(p.x + z.x) / 2},${(p.y + z.y) / 2}`;
      }
    }
    this.cutKey = '';
    if (this.last) this.updateEdges(this.last.me);
  }

  private updateNodes(s: GameState, me: Player): void {
    this.last = { s, me };
    for (const n of this.nodes.values()) {
      const info = TECHS[n.t];
      const st = techStatus(s, me.id, n.t);
      let cls = 'avail';
      let text = `${formatCount(info.gold)} gold`;
      if (st === 'done') {
        cls = 'done';
        text = 'Done';
      } else if (st === 'researching') {
        cls = 'active';
        text = pct(me.researchProgress / info.science);
      } else if (st === 'locked-choice') {
        cls = 'locked';
        text = 'Locked';
      } else if (st !== 'available') cls = 'locked';
      for (const c of ['avail', 'done', 'active', 'locked']) setClass(n.btn, c, c === cls);
      setClass(n.btn, 'chose-other', st === 'locked-choice');
      setText(n.state, text);
      n.ring.style.setProperty('--p', st === 'researching' ? Math.min(1, me.researchProgress / info.science).toFixed(3) : '0');
      const ok = st === 'available' && canResearch(s, me.id, n.t).ok;
      n.btn.setAttribute('aria-disabled', String(!ok));
      const why = st === 'locked-choice' ? 'Locked by your choice' : st === 'done' ? 'Researched' : st === 'researching' ? `Researching, ${text}` : cls === 'locked' ? 'Locked' : 'Available';
      n.btn.setAttribute('aria-label', `${info.name}: ${lineOf(n.t)}. ${why}`);
      // the fork warning before choosing; the lock reason after
      const warn = st === 'available' || st === 'locked-prereq' ? choiceWarning(n.t) : null;
      setTip(n.btn, st === 'locked-choice' ? techStatusReason(s, me.id, n.t) ?? '' : warn ?? '');
    }
    this.updateEdges(me);
    this.drawLines();
    this.updateFoot(s, me);
  }

  private updateEdges(me: Player): void {
    const s = this.last?.s;
    for (const e of this.edges) {
      const from = hasTech(me, e.from);
      const to = hasTech(me, e.to);
      const cut = !!s && techStatus(s, me.id, e.to) === 'locked-choice';
      const cls = `${to ? 'done' : cut ? 'fork-cut' : from ? 'open' : 'locked'}${e.any ? ' either' : ''}`;
      e.path.setAttribute('class', `${cls}${e.path.classList.contains('hl-pre') ? ' hl-pre' : ''}${e.path.classList.contains('hl-next') ? ' hl-next' : ''}`);
      const at = e.cut.dataset.at;
      if (cut && at) {
        const [x, y] = at.split(',').map(Number);
        e.cut.setAttribute('d', cutMark({ x, y }, 4));
      } else e.cut.setAttribute('d', '');
    }
  }

  private updateFoot(s: GameState, me: Player): void {
    const t = this.focus;
    if (!t) {
      setText(this.footT, researchRule(s) ? '' : 'Hover or focus a tech');
      setText(this.footD, 'Lines run from each tech to what it unlocks. OR marks a choice: picking one locks the other for the rest of the game. A tech costs gold to start and science to finish; picking one switches Auto off.');
      setText(this.footN, '');
      return;
    }
    const info = TECHS[t];
    const g = info.exclusiveGroup;
    setText(this.footT, `${info.name} · tier ${info.tier}${g ? ` · ${groupName(g)} choice` : ''} · ${formatCount(info.gold)} gold, ${formatCount(info.science)} science`);
    const unl = UNLOCKS[t]?.map((b) => BUILDINGS[b].name) ?? [];
    setText(this.footD, info.description + (unl.length ? ` Unlocks: ${unl.join(', ')}.` : ''));
    let note = '';
    const st = techStatus(s, me.id, t);
    if (st === 'done') note = 'Researched.';
    else if (st === 'researching') note = `Researching: ${pct(me.researchProgress / info.science)}.`;
    else if (st === 'locked-choice' || st === 'locked-prereq' || st === 'disabled') note = `${techStatusReason(s, me.id, t) ?? 'Not possible now'}.`;
    else {
      const r = canResearch(s, me.id, t);
      if (!r.ok) note = `${r.reason ?? 'Not possible now'}.`;
      else note = me.researching ? `Click to start it instead of ${TECHS[me.researching].name} (its progress is lost).` : 'Click to research it.';
      const warn = choiceWarning(t);
      if (warn) note += ` ${warn} for the rest of the game.`;
    }
    const next = (CHILDREN[t] ?? []).map((c) => TECHS[c].name);
    setText(this.footN, note + (next.length ? ` Leads to ${next.join(', ')}.` : ''));
  }

  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }
}
