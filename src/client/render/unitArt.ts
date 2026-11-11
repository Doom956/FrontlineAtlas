// Modern Flat unit art (client only): bold top-down vector silhouettes filled in the owner's colour with a crisp dark
// edge, nose at +x, half-length 1, lateral axis y. Two levels of detail:
//   far  (half-length under DETAIL_S px): the silhouette only, a small solid shape that reads as ship / plane / tank
//   near (DETAIL_S px and up): plus light decks and canopies, dark turrets, tracks, engines and barrels
// Every shape is original and drawn here in code. Trails (wakes, contrails) stay in unitGlyphs.ts.
import type { UnitType } from '../../sim/types';
import { prankView } from '../fx/prankView';
import { GLYPHS, strokeDucks, type Inst } from './unitGlyphs';

/** body: silhouette (owner colour), deck: light panel, dark: turret / track / engine, line: dark detail stroke */
interface Part {
  k: 'body' | 'deck' | 'dark' | 'line' | 'ring';
  p: number[];
}
export interface Art {
  /** length on screen relative to the zoom's base size */
  len: number;
  parts: Part[];
}

/** Half-length in px from which the near details are drawn. */
export const DETAIL_S = 6.5;

const box = (k: 'deck' | 'dark', cx: number, cy: number, hw: number, hh: number): Part => ({ k, p: [cx - hw, cy - hh, cx - hw, cy + hh, cx + hw, cy + hh, cx + hw, cy - hh] });
/** A closed outline from its upper half (y >= 0, nose to tail); the lower half is mirrored. */
const sym = (half: number[]): number[] => {
  const out = [...half];
  for (let i = half.length - 2; i >= 0; i -= 2) if (half[i + 1] !== 0) out.push(half[i], -half[i + 1]);
  return out;
};
const body = (half: number[]): Part => ({ k: 'body', p: sym(half) });

export const ART: Record<UnitType, Art> = {
  warship: {
    len: 1.3,
    parts: [
      body([1, 0, 0.55, 0.27, -0.85, 0.27, -1, 0.16]),
      box('deck', -0.12, 0, 0.24, 0.14),
      box('dark', 0.4, 0, 0.11, 0.11),
      box('dark', -0.58, 0, 0.11, 0.11),
      { k: 'line', p: [0.4, 0, 0.78, 0] },
      { k: 'line', p: [-0.58, 0, -0.9, 0] },
    ],
  },
  tradeShip: {
    len: 1.05,
    parts: [body([1, 0, 0.62, 0.34, -1, 0.34]), box('deck', -0.5, 0, 0.15, 0.22), box('deck', -0.1, 0, 0.15, 0.22), box('deck', 0.3, 0, 0.15, 0.22), box('dark', -0.84, 0, 0.08, 0.24)],
  },
  transport: {
    len: 1.0,
    parts: [body([1, 0.36, 0.86, 0.48, -0.85, 0.48, -1, 0.3]), { k: 'line', p: [0.72, -0.44, 0.72, 0.44] }, box('deck', -0.2, 0, 0.36, 0.26), box('dark', -0.82, 0, 0.08, 0.22)],
  },
  tankDivision: {
    len: 1.2,
    parts: [
      body([1.05, 0.06, 0.62, 0.06, 0.62, 0.64, -0.92, 0.64, -0.92, 0.5]),
      box('dark', -0.15, 0.56, 0.77, 0.1),
      box('dark', -0.15, -0.56, 0.77, 0.1),
      box('deck', -0.18, 0, 0.3, 0.27),
      { k: 'line', p: [0.12, 0, 1.0, 0] },
    ],
  },
  fighter: {
    len: 1.05,
    parts: [body([1, 0, 0.35, 0.12, -0.18, 0.92, -0.42, 0.92, -0.36, 0.14, -0.78, 0.12, -1, 0.44, -1.06, 0.44, -0.98, 0]), box('deck', 0.42, 0, 0.16, 0.06)],
  },
  bomber: {
    len: 1.3,
    parts: [
      body([1, 0, 0.84, 0.13, 0.26, 0.13, 0.12, 1.06, -0.18, 1.06, -0.2, 0.13, -0.78, 0.1, -0.94, 0.44, -1.04, 0.44, -1, 0]),
      box('dark', 0.16, 0.42, 0.11, 0.07),
      box('dark', 0.1, -0.42, 0.11, 0.07),
      box('dark', 0.11, 0.76, 0.1, 0.06),
      box('dark', 0.05, -0.76, 0.1, 0.06),
      box('deck', 0.78, 0, 0.1, 0.06),
    ],
  },
  transportPlane: {
    len: 1.15,
    parts: [
      body([1, 0, 0.86, 0.24, 0.42, 0.24, 0.36, 1.0, 0.02, 1.0, -0.04, 0.24, -0.62, 0.22, -0.84, 0.6, -1, 0.6, -1, 0]),
      box('dark', 0.24, 0.55, 0.1, 0.07),
      box('dark', 0.24, -0.55, 0.1, 0.07),
      box('deck', 0.78, 0, 0.1, 0.1),
    ],
  },
  reconPlane: {
    len: 1.0,
    parts: [body([1, 0, 0.8, 0.1, 0.24, 0.1, 0.22, 1.08, 0.06, 1.08, 0.04, 0.1, -0.78, 0.07, -0.9, 0.38, -1, 0.38, -1, 0]), { k: 'ring', p: [0.66, 0, 0.12] }],
  },
  rocket: {
    len: 0.95,
    parts: [body([1, 0, 0.62, 0.13, -0.58, 0.13, -1, 0.42, -1, 0]), { k: 'line', p: [0.3, -0.13, 0.3, 0.13] }],
  },
  atomBomb: {
    len: 1.1,
    parts: [body([1, 0, 0.55, 0.25, -0.5, 0.25, -1, 0.52, -1, 0]), { k: 'ring', p: [-0.02, 0, 0.17] }],
  },
};

type Pass = 'body' | 'deck' | 'dark' | 'line';

function addArt(ctx: CanvasRenderingContext2D, a: Art, x: number, y: number, cos: number, sin: number, s: number, pass: Pass): void {
  for (const sh of a.parts) {
    const k = sh.k === 'ring' ? 'line' : sh.k;
    if (k !== pass) continue;
    const p = sh.p;
    if (sh.k === 'ring') {
      const px = x + (p[0] * cos - p[1] * sin) * s;
      const py = y + (p[0] * sin + p[1] * cos) * s;
      ctx.moveTo(px + p[2] * s, py);
      ctx.arc(px, py, p[2] * s, 0, Math.PI * 2);
      continue;
    }
    for (let i = 0; i < p.length; i += 2) {
      const px = x + (p[i] * cos - p[i + 1] * sin) * s;
      const py = y + (p[i] * sin + p[i + 1] * cos) * s;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (sh.k !== 'line') ctx.closePath();
  }
}

/** One owner's units: a dark edge, the owner-colour silhouette, then (near only) decks, dark parts and detail lines. */
export function drawUnitArt(ctx: CanvasRenderingContext2D, list: readonly Inst[], color: string, under: string, lw: number): void {
  if (prankView.ducks) {
    const ducks = list.filter((e) => GLYPHS[e.type].trail !== 'missile');
    if (ducks.length) strokeDucks(ctx, ducks, color, under, lw);
    if (ducks.length === list.length) return;
    list = list.filter((e) => GLYPHS[e.type].trail === 'missile');
  }
  const path = (pass: Pass, nearOnly: boolean): boolean => {
    ctx.beginPath();
    let any = false;
    for (const e of list) {
      if (nearOnly && e.S < DETAIL_S) continue;
      addArt(ctx, ART[e.type], e.x, e.y, Math.cos(e.angle), Math.sin(e.angle), e.S, pass);
      any = true;
    }
    return any;
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!path('body', false)) return;
  ctx.lineWidth = lw + 1.6;
  ctx.strokeStyle = under;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  if (path('deck', true)) {
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fill();
  }
  if (path('dark', true)) {
    ctx.fillStyle = 'rgba(12,15,20,0.82)';
    ctx.fill();
  }
  if (path('line', true)) {
    ctx.lineWidth = Math.max(1, lw * 0.9);
    ctx.strokeStyle = 'rgba(12,15,20,0.85)';
    ctx.stroke();
  }
}
