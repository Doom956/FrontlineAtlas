// Research panel helpers (hud/researchTree.ts, hud/arsenalPage.ts): one-liners and icons of the branch techs, and
// line geometry (rounded polylines, routing through gaps, the cut mark of a fork not taken). No DOM. The panel's row
// layout is hud/techRows.ts.
import { TECHS } from '../../sim/config';
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
