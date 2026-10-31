// Tech tree with exclusive choices (the research drawer, hud/researchTree.ts): layout and line routing, no DOM.
//
// A choice group (TechInfo.exclusiveGroup) is ONE slot of the tree: its techs sit side by side in a fork with an "OR"
// marker between them. Tiers are still columns, but a tier with both choices and ordinary techs gets two tracks:
// its choices first (right next to the techs they branch from), then its ordinary techs. That keeps every track at
// six rows or fewer, so the tree fits a 1280x720 screen. Lines that have to cross a track run through the gaps
// between rows and tracks, never behind a card.
import { TECH_ORDER, TECHS } from '../../sim/config';
import { groupName } from '../../sim/techtree';
import type { TechId } from '../../sim/types';
import { lineIcon, worldGlyph } from './glyph';

/** One line per branch tech (the core techs' lines live in researchTree.ts). */
export const BRANCH_TECH_LINE: Partial<Record<TechId, string>> = {
  propaganda: 'Attacks on you cost the attacker more',
  railways: 'Wider supply, faster fronts, cheaper tanks',
  stockExchange: 'Saved gold earns interest',
  freeTrade: 'Trade ships pay more; cheaper markets',
  blitzTactics: 'Armor fronts faster; deeper spearheads',
  trenchWarfare: 'Defence up; enemy fronts slower',
  carriers: 'Warships shoot down planes nearby',
  submarines: 'Warships hit ships harder, hidden',
  jetEngines: 'Faster planes, tougher bombers',
  strategicBombing: 'Wider bombs that burn their economy',
  diplomaticCorps: 'Allies trust you sooner and help more',
  conscription: 'Troop cap and growth up; cheaper mercenaries',
  industrialBoom: 'Gold, iron and oil +12%',
  massMobilization: 'Troop cap up and every attack stronger',
  automation: 'Buildings and upgrades faster and cheaper',
};

export const BRANCH_TECH_ICON: Partial<Record<TechId, () => string>> = {
  propaganda: () => lineIcon('signal', 20),
  railways: () => lineIcon('transport', 20),
  stockExchange: () => lineIcon('gold', 20),
  freeTrade: () => worldGlyph('port', 20),
  blitzTactics: () => lineIcon('attack', 20),
  trenchWarfare: () => lineIcon('shield', 20),
  carriers: () => lineIcon('plane', 20),
  submarines: () => lineIcon('target', 20),
  jetEngines: () => lineIcon('up', 20),
  strategicBombing: () => lineIcon('bomb', 20),
  diplomaticCorps: () => lineIcon('ally', 20),
  conscription: () => lineIcon('troops', 20),
  industrialBoom: () => lineIcon('upgrade', 20),
  massMobilization: () => lineIcon('army', 20),
  automation: () => lineIcon('settings', 20),
};

/** Every tech a tech needs: `requires` plus the either-or `requiresAny`. */
export function techParents(t: TechId): { all: TechId[]; any: TechId[] } {
  const info = TECHS[t];
  const any = info.requiresAny ?? [];
  return { all: [...info.requires], any: [...any] };
}

/** A slot of the tree: one ordinary tech or a whole choice group. */
export interface TreeSlot {
  /** tech id, or 'group:<id>' */
  key: string;
  techs: TechId[];
  group: string | null;
  col: number;
  row: number;
}
export interface TreeTrack {
  tier: number;
  choices: boolean;
  label: string;
  /** relative width (a fork is wider) */
  weight: number;
}
export interface TreeLayout {
  slots: TreeSlot[];
  tracks: TreeTrack[];
  rows: number;
  /** slot of every tech */
  slotOf: Map<TechId, TreeSlot>;
}

/** Lays the tree out: tracks per tier (choices, then ordinary techs), rows close to their parents. */
export function forkLayout(order: readonly TechId[] = TECH_ORDER): TreeLayout {
  const groups = new Map<string, TechId[]>();
  for (const t of order) {
    const g = TECHS[t].exclusiveGroup;
    if (g) groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const slots: TreeSlot[] = [];
  const seen = new Set<string>();
  for (const t of order) {
    const g = TECHS[t].exclusiveGroup;
    if (g) {
      if (seen.has(g)) continue;
      seen.add(g);
      slots.push({ key: `group:${g}`, techs: groups.get(g)!, group: g, col: -1, row: -1 });
    } else slots.push({ key: t, techs: [t], group: null, col: -1, row: -1 });
  }
  const tierOf = (s: TreeSlot) => Math.min(...s.techs.map((t) => TECHS[t].tier));
  const tiers = [...new Set(slots.map(tierOf))].sort((a, b) => a - b);
  const tracks: TreeTrack[] = [];
  const trackSlots: TreeSlot[][] = [];
  for (const tier of tiers) {
    const inTier = slots.filter((s) => tierOf(s) === tier);
    const forks = inTier.filter((s) => s.group);
    const plain = inTier.filter((s) => !s.group);
    if (forks.length) {
      const wide = Math.max(...forks.map((s) => s.techs.length));
      tracks.push({ tier, choices: true, label: plain.length ? `Tier ${tier} · choices` : `Tier ${tier} · choose one`, weight: Math.max(1, wide * 0.8) });
      trackSlots.push(forks);
    }
    if (plain.length) {
      tracks.push({ tier, choices: false, label: `Tier ${tier}`, weight: 1 });
      trackSlots.push(plain);
    }
  }
  const slotOf = new Map<TechId, TreeSlot>();
  for (const s of slots) for (const t of s.techs) slotOf.set(t, s);
  const rows = Math.max(...trackSlots.map((l) => l.length));
  trackSlots.forEach((list, col) => {
    const bary = (s: TreeSlot): number => {
      const ps: number[] = [];
      for (const t of s.techs) {
        const p = techParents(t);
        for (const r of [...p.all, ...p.any]) {
          const ps2 = slotOf.get(r);
          if (ps2 && ps2.row >= 0 && ps2.col < col) ps.push(ps2.row);
        }
      }
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : order.indexOf(s.techs[0]);
    };
    const sorted = col === 0 ? list : [...list].sort((a, b) => bary(a) - bary(b) || order.indexOf(a.techs[0]) - order.indexOf(b.techs[0]));
    const want = sorted.map((s, k) => (col === 0 ? k : Math.round(bary(s))));
    const at: number[] = [];
    for (let k = 0; k < sorted.length; k++) at.push(Math.max(k === 0 ? 0 : at[k - 1] + 1, want[k]));
    for (let k = sorted.length - 1; k >= 0; k--) at[k] = Math.min(at[k], k === sorted.length - 1 ? rows - 1 : at[k + 1] - 1);
    sorted.forEach((s, k) => {
      s.col = col;
      s.row = at[k];
    });
  });
  return { slots, tracks, rows, slotOf };
}

/** "Finance: choose one" style label of a group. */
export function forkTitle(group: string): string {
  return `${groupName(group)}: choose one`;
}

// ------------------------------------------------------------------------------------------------ line routing

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}

/** A polyline with rounded corners as an SVG path ("M .. L .. Q .."). */
export function roundedPath(pts: readonly Pt[], radius = 6): string {
  if (pts.length < 2) return '';
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const c = pts[k + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) {
      d += `L${f(b.x)} ${f(b.y)}`;
      continue;
    }
    const p1 = { x: b.x + ((a.x - b.x) * r) / l1, y: b.y + ((a.y - b.y) * r) / l1 };
    const p2 = { x: b.x + ((c.x - b.x) * r) / l2, y: b.y + ((c.y - b.y) * r) / l2 };
    d += `L${f(p1.x)} ${f(p1.y)}Q${f(b.x)} ${f(b.y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  const z = pts[pts.length - 1];
  return d + `L${f(z.x)} ${f(z.y)}`;
}

export interface RouteEnd {
  box: Box;
  /** leave by the right edge (normal) or the bottom (a fork member with a sibling to its right) */
  exit?: 'right' | 'bottom';
  /** enter by the left edge (normal) or the top (a fork member with a sibling to its left) */
  enter?: 'left' | 'top';
  /** the box of the whole fork the end belongs to (for bottom exits and top entries) */
  fork?: Box;
}

/**
 * Points of a line from `a` to `b`. Straight neighbours get a plain curve (null: the caller draws its bezier); lines
 * that cross another track, leave a fork from below or enter a fork from above run through the gaps: half a column
 * gap right of the source track, along the row gap just above the target (or below the source fork), then in.
 */
export function routeEdge(a: RouteEnd, b: RouteEnd, colGap: number, rowGap: number, adjacent: boolean): Pt[] | null {
  const exit = a.exit ?? 'right';
  const enter = b.enter ?? 'left';
  if (adjacent && exit === 'right' && enter === 'left') return null;
  const pts: Pt[] = [];
  const srcRight = (exit === 'bottom' && a.fork ? a.fork.x + a.fork.w : a.box.x + a.box.w) + colGap / 2;
  if (exit === 'right') {
    const y1 = a.box.y + a.box.h / 2;
    pts.push({ x: a.box.x + a.box.w, y: y1 }, { x: srcRight, y: y1 });
  } else {
    const cx = a.box.x + a.box.w / 2;
    const below = (a.fork ? a.fork.y + a.fork.h : a.box.y + a.box.h) + rowGap / 2;
    pts.push({ x: cx, y: a.box.y + a.box.h }, { x: cx, y: below }, { x: srcRight, y: below });
  }
  if (enter === 'left') {
    const y2 = b.box.y + b.box.h / 2;
    const inX = b.box.x - colGap / 2;
    if (Math.abs(inX - srcRight) < 1) {
      pts.push({ x: srcRight, y: y2 });
    } else {
      // along the row gap just above the target's row
      const ch = b.box.y - rowGap / 2;
      pts.push({ x: srcRight, y: ch }, { x: inX, y: ch }, { x: inX, y: y2 });
    }
    pts.push({ x: b.box.x - 5, y: y2 });
  } else {
    const top = (b.fork ? b.fork.y : b.box.y) - rowGap / 2;
    const cx = b.box.x + b.box.w / 2;
    pts.push({ x: srcRight, y: top }, { x: cx, y: top }, { x: cx, y: b.box.y - 4 });
  }
  // drop repeated points
  return pts.filter((p, k) => k === 0 || Math.abs(p.x - pts[k - 1].x) > 0.01 || Math.abs(p.y - pts[k - 1].y) > 0.01);
}

/** A small "x" across a cut line, centred on p. */
export function cutMark(p: Pt, s = 4): string {
  return `M${p.x - s} ${p.y - s}L${p.x + s} ${p.y + s}M${p.x + s} ${p.y - s}L${p.x - s} ${p.y + s}`;
}
