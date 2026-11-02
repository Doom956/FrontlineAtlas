// Research panel layout (hud/researchTree.ts hosts the panel, hud/arsenalPage.ts draws it): no DOM.
//
// Two tabs. RESEARCH holds the stat / effect techs (every tech where arsenal.isArsenalTech is false) in four rows:
// Economy, Land, Logistics, Influence. ARSENAL holds the vehicle side in the rows of arsenal.ARSENAL_ROWS (Navy,
// Armor, Air, Shared). Both tabs share one grid of columns, left to right by tier (a tier with choices gets its own
// "choose one" column before its plain techs; the Arsenal columns are Unlock, Path, Path upgrade, Special, Mastery),
// so tiers line up across rows. Inside a row each column stacks its cards in lanes; a fork's branches take one lane
// each (the OR sits between them) and everything after a branch root stays in that branch's lane. Lines are drawn
// only inside a row (prerequisites in another row or tab show on the card as "+ Name"), after a transitive reduction
// (Naval Mastery needs Navigation, but the line runs from the path's end).
import { ARSENAL_ROWS, MASTERY_CAP, PILLAR_NAMES, arsenalItem, isArsenalTech, type Pillar } from '../../sim/arsenal';
import { TECHS, TECH_ORDER } from '../../sim/config';
import { canProcure } from '../../sim/procurement';
import { canResearch } from '../../sim/tech';
import { techStatus } from '../../sim/techtree';
import type { GameState, Player, TechId } from '../../sim/types';
import { masteryCapped, masteryUsed, onOrder } from './procure';

export type PanelTab = 'research' | 'arsenal';
export type RowId = 'economy' | 'land' | 'logistics' | 'influence' | Pillar;
export type CardKind = 'tech' | 'unlock' | 'variant' | 'special' | 'mastery';

export interface RowCard {
  tech: TechId;
  row: RowId;
  /** column of the tab's grid */
  col: number;
  /** first lane in the row, and how many lanes the card is centred over */
  lane: number;
  span: number;
  kind: CardKind;
  /** exclusive group of the fork the card belongs to */
  fork?: string;
  /** root tech of its fork branch */
  branch?: TechId;
}
export interface RowEdge {
  from: TechId;
  to: TechId;
  /** an either-or prerequisite (requiresAny) */
  any: boolean;
}
/** A fork drawn as a split: an OR between lane `lane` and `lane + 1`, over columns col0..col1. */
export interface ForkMark {
  group: string;
  col0: number;
  col1: number;
  lane: number;
  /** branch roots, top lane first */
  roots: TechId[];
}
export interface PanelRow {
  id: RowId;
  name: string;
  lanes: number;
  cards: RowCard[];
  edges: RowEdge[];
  forks: ForkMark[];
  /** prerequisites of a card that sit in another row or tab */
  outside: Partial<Record<TechId, TechId[]>>;
}
export interface PanelColumn {
  key: string;
  label: string;
}
export interface PanelLayout {
  tab: PanelTab;
  cols: PanelColumn[];
  rows: PanelRow[];
}

/** The Research tab's rows (any other non-arsenal tech joins Land). */
export const RESEARCH_ROWS: { id: RowId; name: string; techs: TechId[] }[] = [
  { id: 'economy', name: 'Economy', techs: ['agriculture', 'banking', 'medicine', 'stockExchange', 'freeTrade', 'industrialization', 'industrialBoom', 'massMobilization', 'automation'] },
  { id: 'land', name: 'Land', techs: ['metallurgy', 'fortification', 'ballistics', 'blitzTactics', 'trenchWarfare', 'combinedArms', 'rocketry', 'nuclearFission'] },
  { id: 'logistics', name: 'Logistics', techs: ['logistics', 'railways', 'radar'] },
  { id: 'influence', name: 'Influence', techs: ['propaganda', 'diplomaticCorps', 'conscription'] },
];
export const ROW_NAMES: Record<RowId, string> = {
  economy: 'Economy',
  land: 'Land',
  logistics: 'Logistics',
  influence: 'Influence',
  ...PILLAR_NAMES,
};

const ARSENAL_COL_LABEL: Record<string, string> = { '1': 'Unlock', '2': 'Path · choose one', '3': 'Path upgrade', '3s': 'Special', '4': 'Mastery' };

interface Seed {
  tech: TechId;
  kind: CardKind;
  fork?: string;
  branch?: TechId;
  colKey: string;
}

function parents(t: TechId): { all: TechId[]; any: TechId[] } {
  const i = TECHS[t];
  return { all: [...i.requires], any: [...(i.requiresAny ?? [])] };
}
function ancestorsOf(t: TechId, out = new Set<TechId>()): Set<TechId> {
  const p = parents(t);
  for (const r of [...p.all, ...p.any]) if (!out.has(r)) {
    out.add(r);
    ancestorsOf(r, out);
  }
  return out;
}

/** Column key sort: tier, then "choose one" before plain, then specials. */
function colOrder(k: string): number {
  const tier = parseInt(k, 10);
  return tier * 10 + (k.endsWith('c') ? 0 : k.endsWith('s') ? 2 : 1);
}

function researchSeeds(): { id: RowId; name: string; seeds: Seed[] }[] {
  const rows = RESEARCH_ROWS.map((r) => ({ id: r.id, name: r.name, seeds: [] as Seed[] }));
  const listed = new Set<TechId>();
  const push = (row: (typeof rows)[number], t: TechId): void => {
    const i = TECHS[t];
    if (!i || isArsenalTech(t) || listed.has(t)) return;
    listed.add(t);
    const g = i.exclusiveGroup;
    row.seeds.push({ tech: t, kind: 'tech', fork: g, branch: g ? t : undefined, colKey: `${i.tier}${g ? 'c' : ''}` });
  };
  RESEARCH_ROWS.forEach((r, k) => r.techs.forEach((t) => push(rows[k], t)));
  // a new tech nobody placed yet still shows up (in Land)
  for (const t of TECH_ORDER) if (!listed.has(t) && !isArsenalTech(t)) push(rows[1], t);
  return rows;
}

function arsenalSeeds(): { id: RowId; name: string; seeds: Seed[] }[] {
  return ARSENAL_ROWS.map((r) => ({
    id: r.pillar,
    name: r.name,
    seeds: r.items.filter((it) => TECHS[it.tech]).map((it) => ({ tech: it.tech, kind: it.kind, fork: it.fork, branch: it.branch, colKey: `${it.tier}${it.kind === 'special' ? 's' : ''}` })),
  }));
}

/** Lays out one tab: shared columns, lanes per row, in-row edges, forks and outside prerequisites. */
export function panelLayout(tab: PanelTab): PanelLayout {
  const src = tab === 'research' ? researchSeeds() : arsenalSeeds();
  const keys = [...new Set(src.flatMap((r) => r.seeds.map((s) => s.colKey)))].sort((a, b) => colOrder(a) - colOrder(b));
  const cols: PanelColumn[] = keys.map((k) => {
    const tier = parseInt(k, 10);
    const label = tab === 'arsenal' ? ARSENAL_COL_LABEL[k] ?? `Tier ${tier}` : k.endsWith('c') ? `Tier ${tier} · choose one` : `Tier ${tier}`;
    return { key: k, label };
  });
  const colOf = (k: string): number => keys.indexOf(k);
  // Arsenal rows without a fork (Shared) spread a crowded column into the empty one after it: one lane, not two
  const rows: PanelRow[] = src.map((r) => layRow(r.id, r.name, r.seeds, colOf, tab === 'arsenal' ? keys.length : 0));
  return { tab, cols, rows };
}

function layRow(id: RowId, name: string, seeds: Seed[], colOf0: (k: string) => number, spillCols: number): PanelRow {
  const inRow = new Set(seeds.map((s) => s.tech));
  const moved = new Map<TechId, number>();
  const colOf = (k: string, t?: TechId): number => (t && moved.has(t) ? moved.get(t)! : colOf0(k));
  if (spillCols && !seeds.some((s) => s.fork)) {
    for (let c = 0; c + 1 < spillCols; c++) {
      const here = seeds.filter((s) => colOf(s.colKey, s.tech) === c);
      const nextFree = !seeds.some((s) => colOf(s.colKey, s.tech) === c + 1);
      if (here.length < 2 || !nextFree) continue;
      const last = here[here.length - 1];
      // only when no in-row neighbour of it sits in the next column or to the left of it (order of the lines)
      const p = parents(last.tech);
      const kids = seeds.filter((s) => [...parents(s.tech).all, ...parents(s.tech).any].includes(last.tech));
      if ([...p.all, ...p.any].some((r) => inRow.has(r) && colOf(seeds.find((x) => x.tech === r)!.colKey, r) >= c + 1)) continue;
      if (kids.some((k) => colOf(k.colKey, k.tech) <= c + 1)) continue;
      moved.set(last.tech, c + 1);
    }
  }
  // branch lanes: each fork's roots in order (a later fork in the row reuses lanes 0..n-1)
  const branchLane = new Map<TechId, number>();
  const forkRoots = new Map<string, TechId[]>();
  for (const s of seeds) {
    if (!s.fork || !s.branch) continue;
    const roots = forkRoots.get(s.fork) ?? [];
    if (!roots.includes(s.branch)) roots.push(s.branch);
    forkRoots.set(s.fork, roots);
  }
  for (const roots of forkRoots.values()) roots.forEach((t, k) => branchLane.set(t, k));
  // cards by column
  const byCol = new Map<number, Seed[]>();
  for (const s of seeds) {
    const c = colOf(s.colKey, s.tech);
    byCol.set(c, [...(byCol.get(c) ?? []), s]);
  }
  let lanes = 1;
  for (const list of byCol.values()) lanes = Math.max(lanes, list.length);
  for (const roots of forkRoots.values()) lanes = Math.max(lanes, roots.length);
  const cards: RowCard[] = [];
  const laneOf = new Map<TechId, number>();
  for (const c of [...byCol.keys()].sort((a, b) => a - b)) {
    const list = byCol.get(c)!;
    const forked = list.filter((s) => s.branch && branchLane.has(s.branch));
    const plain = list.filter((s) => !(s.branch && branchLane.has(s.branch)));
    const used = new Set<number>();
    for (const s of forked) {
      const l = branchLane.get(s.branch!)!;
      used.add(l);
      laneOf.set(s.tech, l);
      cards.push({ tech: s.tech, row: id, col: c, lane: l, span: 1, kind: s.kind, fork: s.fork, branch: s.branch });
    }
    if (plain.length === 1 && forked.length === 0 && plain[0].kind !== 'special') {
      const s = plain[0];
      laneOf.set(s.tech, (lanes - 1) / 2);
      cards.push({ tech: s.tech, row: id, col: c, lane: 0, span: lanes, kind: s.kind, fork: s.fork, branch: s.branch });
      continue;
    }
    // specials stay in the top lanes (lines to the mastery run through the gap under them); several plain cards:
    // ordered by where their in-row parents sit (fewer crossings), into the free lanes
    const want = (s: Seed): number => {
      const p = parents(s.tech);
      const ls = [...p.all, ...p.any].filter((r) => laneOf.has(r)).map((r) => laneOf.get(r)!);
      return ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : lanes;
    };
    const sorted = plain.map((s, k) => ({ s, k, w: want(s) })).sort((a, b) => a.w - b.w || a.k - b.k);
    const free = Array.from({ length: lanes }, (_, l) => l).filter((l) => !used.has(l));
    sorted.forEach(({ s }, k) => {
      const l = free[k] ?? lanes + k;
      laneOf.set(s.tech, l);
      cards.push({ tech: s.tech, row: id, col: c, lane: l, span: 1, kind: s.kind, fork: s.fork, branch: s.branch });
    });
  }
  lanes = Math.max(lanes, ...cards.map((c) => c.lane + c.span));
  // edges inside the row, minus the ones another in-row parent already implies
  const edges: RowEdge[] = [];
  const outside: Partial<Record<TechId, TechId[]>> = {};
  for (const s of seeds) {
    const p = parents(s.tech);
    const all = [...p.all.map((r) => ({ r, any: false })), ...p.any.map((r) => ({ r, any: true }))];
    const here = all.filter((x) => inRow.has(x.r));
    const implied = new Set<TechId>();
    for (const x of here) for (const a of ancestorsOf(x.r)) implied.add(a);
    for (const x of here) if (!implied.has(x.r)) edges.push({ from: x.r, to: s.tech, any: x.any });
    const out = all.filter((x) => !inRow.has(x.r) && !here.some((h) => ancestorsOf(h.r).has(x.r))).map((x) => x.r);
    if (out.length) outside[s.tech] = out;
  }
  // forks: an OR between each pair of neighbouring branch lanes, over the columns the branches use
  const forks: ForkMark[] = [];
  for (const [group, roots] of forkRoots) {
    const fc = cards.filter((c) => c.fork === group);
    const c0 = Math.min(...fc.map((c) => c.col));
    const c1 = Math.max(...fc.map((c) => c.col));
    for (let k = 0; k + 1 < roots.length; k++) forks.push({ group, col0: c0, col1: c1, lane: k, roots: [...roots] });
  }
  return { id, name, lanes, cards, edges, forks, outside };
}

/** Which tab a tech lives in. */
export function tabOf(t: TechId): PanelTab {
  return isArsenalTech(t) ? 'arsenal' : 'research';
}

/** Seconds to finish t at the current science rate (science saved up is spent first), or null at 0 science/s. */
export function researchEta(me: Player, t: TechId): number | null {
  const need = Math.max(0, TECHS[t].science - (me.researching ? 0 : me.science));
  if (need <= 0) return 0;
  const rate = me.income.science;
  return rate > 0 ? need / rate : null;
}
/** "3:40", "45 s", "1 h 05"; "—" when it would never finish. */
export function formatEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const s = Math.ceil(sec);
  if (s < 60) return `${s} s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    return `${h} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The next thing worth buying in a tab: the lowest-tier tech that can be researched (Research tab) or bought (Arsenal,
 * sim/procurement.ts) right now (prerequisites met, gold enough, not locked, not on order), in the panel's reading order (columns left to right, rows top to bottom). Rows outside
 * `only` (a filter) are skipped. null when nothing is affordable.
 */
export function nextAffordable(s: GameState, me: Player, lay: PanelLayout, only?: ReadonlySet<RowId>): TechId | null {
  let best: { t: TechId; tier: number; col: number; row: number; lane: number } | null = null;
  lay.rows.forEach((r, ri) => {
    if (only && only.size && !only.has(r.id)) return;
    for (const c of r.cards) {
      if (me.researching === c.tech || onOrder(me, c.tech) || techStatus(s, me.id, c.tech) !== 'available') continue;
      if (!(lay.tab === 'arsenal' ? canProcure(s, me.id, c.tech) : canResearch(s, me.id, c.tech)).ok) continue;
      const tier = TECHS[c.tech].tier;
      const k = { t: c.tech, tier, col: c.col, row: ri, lane: c.lane };
      if (!best || tier < best.tier || (tier === best.tier && (c.col < best.col || (c.col === best.col && (ri < best.row || (ri === best.row && c.lane < best.lane)))))) best = k;
    }
  });
  return (best as { t: TechId } | null)?.t ?? null;
}

/** "Mastery 1 of 2" counter (with the pillars; a mastery on order counts) and whether the cap is used up. */
export function masteryCounter(me: Player): { text: string; full: boolean; pillars: Pillar[] } {
  const ps = masteryUsed(me);
  const names = ps.map((p) => PILLAR_NAMES[p]).join(', ');
  return { text: `Mastery ${ps.length} of ${MASTERY_CAP}${names ? ` · ${names}` : ''}`, full: ps.length >= MASTERY_CAP, pillars: ps };
}

/** Short reason a mastery card is capped ("Cap used: Navy, Air"), or null. */
export function masteryCapLine(me: Player, t: TechId): string | null {
  return masteryCapped(me, t);
}

/** What kind of card a tech is (for tags and styles). */
export function cardKind(t: TechId): CardKind {
  return arsenalItem(t)?.kind ?? 'tech';
}
