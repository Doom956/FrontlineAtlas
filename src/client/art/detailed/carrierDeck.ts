// The detailed carrier's flight deck (client only, pure): where the angled landing deck, the bow catapults, the
// elevators and the deck markings lie, in model units (nose at +u, starboard at +v), and the deck's surface pattern
// read by the rasterizer (bake.ts 'flightDeck'). Kept in one place so the model (models.ts) parks its planes clear
// of the landing area the pattern paints.
//
// The deck is steel plates in a dark weathered grey, a few plates a shade darker or lighter, the landing area
// darkened by tyre marks along its axis. Markings are short, broken and sparse, never one long dashed line: the
// worn edge line of the angled deck, three short touchdown dashes, a few threshold stripes at its stern end, the
// arresting wires, the catapult tracks at the bow, the elevators as dark seams and the hull number at the bow.

/** Half the carrier's length (its bow at +CL, its stern at -CL). */
export const CL = 27;

/** The angled landing deck: from its stern end (AU, AV) for ALEN units at ANG radians to port, AHALF units each side. */
export const ANG = 0.16;
export const AU = -25.2;
export const AV = -0.2;
export const ALEN = 31;
export const AHALF = 2.6;
const DU = Math.cos(ANG);
const DV = -Math.sin(ANG);
const NU = Math.sin(ANG);
const NV = Math.cos(ANG);

/** A point on the angled deck: `s` units along it from its stern end, `w` across (+ toward starboard). */
export function onAngled(s: number, w: number): [number, number] {
  return [AU + DU * s + NU * w, AV + DV * s + NV * w];
}

/** Elevators on the starboard edge (u0, v0, u1, v1; v1 is the deck edge). */
export const ELEVATORS: readonly (readonly [number, number, number, number])[] = [
  [3.6, 3.5, 7.2, 5.4],
  [-12.4, 3.5, -8.8, 5.4],
];

/** The bow catapults: from the bow end (u0, v0) aft to (u1, v1). */
const CATS: readonly (readonly [number, number, number, number])[] = [
  [CL - 1.6, -1.15, 13.2, -1.85],
  [CL - 1.6, 1.15, 13.2, 1.85],
];

/** The hull number painted at the bow, read from the stern: two 3 x 5 digits. */
const DIGITS = ['010110010010111', '111101111101111'];
const NUM_U = 9.6;
const NUM_CELL = 0.52;

function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
function vnoise1(x: number, s: number): number {
  const x0 = Math.floor(x);
  const f = x - x0;
  const a = hash2(x0, 0, s);
  const b = hash2(x0 + 1, 0, s);
  return a + (b - a) * f * f * (3 - 2 * f);
}
const BAYER = [-0.375, 0.125, 0.375, -0.125];

/** What the deck shows at a point: the tone change on the deck grey, or paint. */
export const DECK_PAINT = 16;

/**
 * The flight deck's tone at model point (u, v) from its flat tone `t` (0..3), at `res` art px per unit, screen pixel
 * (x, y) for the dither. Returns a tone 0..3, or DECK_PAINT + a paint tone for the markings.
 */
export function flightDeckTone(t: number, u: number, v: number, res: number, x: number, y: number): number {
  const px = 1 / res;
  const fine = res >= 1.6;
  const dith = BAYER[(x & 1) + ((y & 1) << 1)];
  // where the point lies on the angled deck: along it and across it
  const du = u - AU;
  const dv = v - AV;
  const s = du * DU + dv * DV;
  const w = du * NU + dv * NV;
  const inLanding = s > -0.5 && s < ALEN && Math.abs(w) < AHALF;
  const line = Math.max(0.3, px * 0.95);
  // markings in worn white paint: a few pixels of every mark lost to wear
  const worn = hash2(x, y, 5) < 0.22;
  if (inLanding) {
    // the starboard edge line of the landing area, broken where the paint has worn away
    if (Math.abs(w - (AHALF - 0.2)) < line / 2 && s > 0.6 && vnoise1(s * 0.55, 3) > 0.34) return worn ? Math.max(0, t - 1) : DECK_PAINT + 1;
    if (fine) {
      // three short touchdown dashes on the axis
      if (Math.abs(w) < Math.max(0.2, px * 0.6) && ((s > 8.6 && s < 9.8) || (s > 11.2 && s < 12.4) || (s > 13.8 && s < 15))) return worn ? t : DECK_PAINT + 2;
      // threshold stripes across the stern end
      if (s > 0.4 && s < 1.5) {
        const k = (w + AHALF) / (AHALF * 2);
        const q = k * 5 - Math.floor(k * 5);
        if (q > 0.3 && q < 0.75) return worn ? t : DECK_PAINT + 2;
      }
      // the arresting wires: thin dark cables across
      for (const ws of [4.2, 5.5, 6.8]) if (Math.abs(s - ws) < px * 0.5 && Math.abs(w) < AHALF - 0.4) return 0;
    }
    // tyre marks: dark streaks along the axis, heaviest where the planes touch down
    const zone = s < 3 ? (s - 1) / 2 : s < 13 ? 1 : 1 - (s - 13) / 11;
    if (zone > 0) {
      const streak = vnoise1(w * 2.3 + 11, 7) * (0.75 + 0.5 * vnoise1(s * 0.4, 9));
      const wear = zone * (1 - Math.abs(w) / AHALF) * streak;
      if (wear > 0.42 + dith * 0.5) return Math.max(0, t - 1);
    }
  }
  if (fine) {
    // the bow catapults: dark slots
    for (const c of CATS) {
      if (u > c[0] || u < c[2]) continue;
      const k = (u - c[0]) / (c[2] - c[0]);
      if (Math.abs(v - (c[1] + (c[3] - c[1]) * k)) < px * 0.5) return Math.max(0, t - 1);
    }
    // the elevators: dark seams round three sides (the fourth is the deck edge)
    for (const e of ELEVATORS) {
      if (u < e[0] - px * 0.5 || u > e[2] + px * 0.5 || v < e[1] - px * 0.5 || v > e[3]) continue;
      if (u < e[0] + px * 0.5 || u > e[2] - px * 0.5 || v < e[1] + px * 0.5) return Math.max(0, t - 1);
    }
    // the hull number at the bow, read from the stern
    if (res >= 2.5) {
      const r = Math.floor((NUM_U + 5 * NUM_CELL - u) / NUM_CELL);
      const c = Math.floor((v + 3.5 * NUM_CELL) / NUM_CELL);
      if (r >= 0 && r < 5 && c >= 0 && c < 7 && c !== 3) {
        const d = c < 3 ? 0 : 1;
        if (DIGITS[d][r * 3 + (c - d * 4)] === '1') return worn ? t : DECK_PAINT + 1;
      }
    }
    // steel plates: a faint seam every few units, staggered rows
    const row = Math.floor(v / 2.3);
    const pu = (u + row * 1.7) / 3.4;
    const col = Math.floor(pu);
    const fu = (pu - col) * 3.4;
    const fv = (v / 2.3 - row) * 2.3;
    if ((fu < px * 0.9 || fv < px * 0.9) && (x + y) % 2 === 0) return Math.max(0, t - 1);
    // weathering: a few plates a shade darker or lighter (a checker of the next tone)
    const h = hash2(col, row, 13);
    if (h < 0.16 && (x + y) % 2 === 0) return Math.max(0, t - 1);
    if (h > 0.96 && (x + y) % 2 === 1) return Math.min(3, t + 1);
  }
  return t;
}
