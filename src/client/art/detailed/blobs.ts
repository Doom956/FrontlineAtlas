// The detailed style's puffs (client only): smoke, soot, dust, spray and fire as small baked pixel blobs. A blob is a
// lumpy round mass (its edge wobbles with the angle, never a clean circle) shaded like a ball lit from the top left
// with a billowing noise inside, in one 4-tone ramp (smoke, soot, dust, spray) or, for fire, by temperature from a
// white-hot core to a red edge. Every explosion, crater wisp, wake foam patch, contrail puff and gun smoke of the style
// is built from these, so the effects share one look and one palette, and drawing one is a single drawImage from an
// atlas (cheap with many on screen). Pure bitmaps (testable without a canvas) plus the atlas lookup.
import { canBake, SpriteAtlas, type AtlasEntry, type RGBABitmap } from '../shared/atlas';
import { hex, type RGB } from '../shared/colour';
import type { Grid } from './grid';
import { CLOUD, CLOUD_SHADE, CLOUD_TOP, DUST, FIRE, SCORCH, SHADE, SMOKE, SOOT, SPRAY, VAPOUR } from './palette';

/**
 * Puffs: smoke, soot, dust, spray, vapour and shade (balls lit from the top left), fire by heat, the flash core, the
 * lights ('glow' on the ground, 'halo' in the air), the 'haze' dust sheet, and the big cloud's soft billows: 'cloudTop'
 * (lit tops), 'cloud' (warm grey sides), 'cloudUnder' (the shaded underside) and 'roll' (a low flattened billow of dust
 * rolling along the ground). The soft ones have a gentle tone range and no darker rim, so many of them overlapping read
 * as one billowing mass, not a heap of separate stones. Then the burning and the sea: 'flame' (a flickering tongue of
 * fire standing on its base, four flicker frames, leaning with the wind), 'foam' (a flat lacy patch of foam on the
 * water that breaks up as it ages), 'heat' (ground glowing red hot and cooling, like 'glow' in deep reds), 'scorch'
 * (a flat blackened, burnt patch on a deck), 'press' (the pale patch of water a gun's blast presses flat) and
 * 'lamp' (a broad pool of warm light a gun's flash throws on its deck) and 'whiteHot' (ground glowing white hot, a
 * broad pool white nearly to its pale yellow edge), and 'oil' (a flat slick of oil on the sea where a ship went down or
 * a plane crashed: near black, a dull sheen in streaks, thinning and breaking up as it ages).
 */
export type BlobKind = 'smoke' | 'soot' | 'dust' | 'spray' | 'fire' | 'vapour' | 'flash' | 'glow' | 'halo' | 'shade' | 'haze' | 'cloudTop' | 'cloud' | 'cloudUnder' | 'roll' | 'flame' | 'foam' | 'heat' | 'scorch' | 'press' | 'lamp' | 'whiteHot' | 'oil';
const KINDS: BlobKind[] = ['smoke', 'soot', 'dust', 'spray', 'fire', 'vapour', 'flash', 'glow', 'halo', 'shade', 'haze', 'cloudTop', 'cloud', 'cloudUnder', 'roll', 'flame', 'foam', 'heat', 'scorch', 'press', 'lamp', 'whiteHot', 'oil'];

const RAMP: Record<Exclude<BlobKind, 'fire' | 'flash' | 'glow' | 'halo' | 'haze' | 'flame' | 'foam' | 'heat' | 'scorch' | 'press' | 'lamp' | 'whiteHot' | 'oil'>, RGB[]> = {
  smoke: SMOKE.map(hex),
  soot: SOOT.map(hex),
  dust: DUST.map(hex),
  spray: SPRAY.map(hex),
  vapour: VAPOUR.map(hex),
  shade: SHADE.map(hex),
  cloudTop: CLOUD_TOP.map(hex),
  cloud: CLOUD.map(hex),
  cloudUnder: CLOUD_SHADE.map(hex),
  roll: DUST.map(hex),
};
/** How much of its ramp a ball uses (1 = full contrast) and whether its lower right rim goes a tone deeper. */
const SOFT: Partial<Record<BlobKind, number>> = { dust: 0.55, spray: 0.8, vapour: 0.8, cloudTop: 0.55, cloud: 0.6, cloudUnder: 0.6, roll: 0.42 };
const NO_RIM = new Set<BlobKind>(['dust', 'cloudTop', 'cloud', 'cloudUnder', 'roll']);
/** A 'roll' lies low: this much flatter than wide. */
const ROLL_FLAT = 0.7;
const FIRE_RGB: RGB[] = FIRE.map(hex);

const BAYER = [-0.375, 0.125, 0.375, -0.125];

function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
function vnoise(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, s);
  const b = hash2(x0 + 1, y0, s);
  const c = hash2(x0, y0 + 1, s);
  const d = hash2(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * The light of a blast on the ground or in the air: a soft lumpy pool, densest in the middle, its alpha falling off in
 * seven dithered steps (no smooth gradient and no ring), white hot in the middle through yellow to an orange edge.
 * 'glow' lies on the ground (squashed by the 3/4 view), 'halo' hangs in the air (round). Radius `r` cells (1..48).
 */
export function glowBitmap(kind: 'glow' | 'halo' | 'heat' | 'press' | 'lamp' | 'whiteHot', r: number, variant: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = kind === 'halo' ? 1 : 0.6;
  const half = Math.ceil(R * 1.15) + 1;
  const hy = Math.ceil(R * sq * 1.15) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.731 + 0.4;
  const s = variant * 13 + R + 5;
  // seven alpha steps a little apart: the dither between two of them stays quiet even when a big light is drawn
  // with coarse cells
  const ALPHA = [0, 30, 60, 92, 124, 158, 192, 226];
  // 'heat': ground glowing red hot, a broad pool from a dark red at its edge to orange in the middle (never white)
  // 'press': water pressed flat by a gun's blast, pale spray tones
  const SP = SPRAY.map(hex);
  const COL =
    kind === 'press'
      ? [SP[1], SP[1], SP[1], SP[2], SP[2], SP[2], SP[3], SP[3]]
      : kind === 'whiteHot'
      ? [FIRE_RGB[1], FIRE_RGB[1], FIRE_RGB[1], FIRE_RGB[0], FIRE_RGB[0], FIRE_RGB[0], FIRE_RGB[0], FIRE_RGB[0]]
      : kind === 'lamp'
      ? [FIRE_RGB[3], FIRE_RGB[3], FIRE_RGB[3], FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[1]]
      : kind === 'heat'
      ? [FIRE_RGB[5], FIRE_RGB[5], FIRE_RGB[4], FIRE_RGB[4], FIRE_RGB[4], FIRE_RGB[3], FIRE_RGB[3], FIRE_RGB[2]]
      : [FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[1], FIRE_RGB[1], FIRE_RGB[1], FIRE_RGB[0], FIRE_RGB[0]];
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      const e = R * (0.92 + 0.1 * Math.sin(3 * a + ph) + 0.06 * Math.sin(5 * a + ph * 2.3));
      const d = Math.hypot(dx, dy) / e;
      if (d >= 1) continue;
      const grain = vnoise(x * 0.5 + variant * 3.1, y * 0.5, s) - 0.5;
      // 'lamp' (a gun's light thrown on a deck): a broad pool, strong out to near its edge
      const i = (1 - d) ** (kind === 'lamp' || kind === 'whiteHot' ? 0.45 : kind === 'heat' ? 0.8 : 1.6) + grain * 0.15;
      const lv = Math.max(0, Math.min(7, Math.floor(i * 8 + 0.4 + BAYER[(x & 1) + ((y & 1) << 1)] * 0.95)));
      if (!lv) continue;
      const o = (y * W + x) * 4;
      const c = COL[lv];
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = ALPHA[lv];
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/**
 * A sheet of dust lying low on the ground (the atom bomb's base surge): flat (squashed by the 3/4 view), its edge in
 * big uneven lobes, dense inside and thinning toward the edge in dithered steps, lit a shade lighter toward the top
 * left. Radius `r` cells (1..48).
 */
export function hazeBitmap(r: number, variant: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = 0.5;
  const half = Math.ceil(R * 1.3) + 1;
  const hy = Math.ceil(R * sq * 1.3) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.731 + 0.9;
  const s = variant * 17 + R + 9;
  const ALPHA = [0, 44, 88, 128, 168, 206];
  const ramp = RAMP.dust;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      const e = R * (0.86 + 0.16 * Math.sin(3 * a + ph) + 0.11 * Math.sin(5 * a + ph * 2.3) + 0.06 * Math.sin(9 * a + ph * 1.7));
      const d = Math.hypot(dx, dy) / e;
      if (d >= 1) continue;
      const grain = vnoise(x * 0.35 + variant * 3.1, y * 0.6, s) - 0.5;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const i = (1 - d) ** 0.7 + grain * 0.35;
      const lv = Math.max(0, Math.min(5, Math.floor(i * 5.5 + dith * 0.95)));
      if (!lv) continue;
      const t = Math.max(1, Math.min(3, Math.floor(2 + (-dx - dy * 1.4) / (e * 1.6) + grain * 1.2 + dith * 0.6)));
      const c = ramp[t];
      const o = (y * W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = ALPHA[lv];
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/**
 * A blob's pixels: radius `r` cells (1..48), shape `variant` (0..3), and for fire the heat (0 white hot .. 4 cooling
 * to red and brown). 'flash' is the white-hot core of a blast's first frames: white through pale yellow to a yellow
 * rim, never red. The origin (ox, oy) is the blob's centre.
 */
export function blobBitmap(kind: BlobKind, r: number, variant: number, heat = 0): RGBABitmap {
  if (kind === 'glow' || kind === 'halo' || kind === 'heat' || kind === 'press' || kind === 'lamp' || kind === 'whiteHot') return glowBitmap(kind, r, variant);
  if (kind === 'scorch') return scorchBitmap(r, variant);
  if (kind === 'haze') return hazeBitmap(r, variant);
  if (kind === 'flame') return flameBitmap(r, variant, heat & 3, (heat >> 2) - 2);
  if (kind === 'foam') return foamBitmap(r, variant, heat);
  if (kind === 'oil') return oilBitmap(r, variant, heat);
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const half = Math.ceil(R * 1.22) + 1;
  const W = half * 2 + 1;
  const sq = kind === 'roll' ? ROLL_FLAT : 1;
  const hy = sq === 1 ? half : Math.ceil(R * 1.22 * sq) + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.731 + 0.4;
  const s = variant * 13 + R;
  const ramp = kind === 'fire' || kind === 'flash' ? null : RAMP[kind];
  const soft = SOFT[kind] ?? 1;
  const rim = !NO_RIM.has(kind);
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      // a lumpy edge: billows of a few sizes round the rim, bigger toward the top (a puff rises)
      let e = R * (0.9 + 0.11 * Math.sin(3 * a + ph) + 0.07 * Math.sin(5 * a + ph * 2.3) + 0.04 * Math.sin(8 * a + ph * 3.1));
      if (R >= 3) e *= 1 + 0.06 * Math.max(0, -Math.sin(a));
      if (R <= 1) e = 1.15;
      else if (R === 2) e = 2.05 + 0.18 * Math.sin(2 * a + ph);
      const d = Math.hypot(dx, dy);
      if (d > e) continue;
      const o = (y * W + x) * 4;
      const nx = dx / e;
      const ny = dy / e;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const grain = vnoise(x * 0.42 + variant * 3.1, y * 0.42, s) - 0.5;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      let c: RGB;
      if (ramp) {
        // a ball lit from the top left, billowing inside
        const lum = -0.55 * nx - 0.62 * ny + 0.55 * nz + grain * 0.5;
        // dust and the big cloud's billows are soft (a narrow range of tones), smoke and soot billow with more contrast
        const tf = 1.6 + ((lum + 0.25) * 2.6 - 1.6) * soft;
        let t = Math.max(0, Math.min(3, Math.floor(tf + 0.5 + dith * 0.45)));
        // the lower right rim a tone deeper
        if (rim && d > e - 1.05 && dx + dy > 0) t = Math.min(t, 1);
        c = ramp[t];
      } else if (kind === 'flash') {
        // the flash: white hot, a pale yellow skin, a thin yellow rim (a little up and left the hottest)
        const q = d / e + grain * 0.35 + (dx + dy) / (e * 8);
        const idx = q + dith * 0.25 < 0.58 ? 0 : q + dith * 0.25 < 0.86 ? 1 : 2;
        c = FIRE_RGB[idx === 2 && R < 3 ? 1 : idx];
      } else {
        // fire by temperature: hot core (a little up and left), cooling outward, flickering grain
        const q = d / e;
        let temp = 1 - q * 0.95 + grain * 0.55 - (dx + dy) / (e * 6);
        temp -= heat * 0.17;
        const idx = Math.max(0, Math.min(6, Math.floor((1 - temp) * 5.2 + dith * 0.9)));
        c = FIRE_RGB[idx];
      }
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/** A flame's `heat` code for drawBlob: flicker frame 0..3 and a lean -2..2 (screen px of the tip per cell of base, halves). */
export function flameCode(frame: number, lean: number): number {
  return (frame & 3) + 4 * (Math.max(-2, Math.min(2, Math.round(lean))) + 2);
}

/**
 * A tongue of fire standing on its base: `r` cells half-wide at the base (1..16), about 2.8 times as tall, tapering to
 * a ragged tip that sways a little each flicker `frame` (0..3) and leans `lean` (-2..2) to the side the wind blows;
 * white hot low in its middle, yellow and orange up its body, red at the tips, with a lick of flame torn off above it
 * on some frames. The origin is the middle of its base.
 */
export function flameBitmap(r: number, variant: number, frame: number, lean: number): RGBABitmap {
  const R = Math.max(1, Math.min(16, Math.round(r)));
  const H = Math.round(R * 2.8 + 1);
  const tip = lean * R * 0.45;
  const half = R + Math.ceil(Math.abs(tip)) + 2;
  const W = half * 2 + 1;
  const below = Math.max(1, Math.ceil(R * 0.55));
  const top = Math.ceil(H * 1.3) + 1;
  const Hh = top + below + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const s = variant * 31 + R * 7 + 11;
  const ph = variant * 1.9 + frame * 1.7;
  const put = (x: number, y: number, c: RGB): void => {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  };
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const up = top - y;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      if (up < 0) {
        // the rounded foot of the fire, glowing
        if ((dx * dx) / (R * R) + (up * up) / (below * below) > 1) continue;
        put(x, y, FIRE_RGB[Math.abs(dx) < R * 0.45 ? 1 : 2]);
        continue;
      }
      const n = vnoise(x * 0.55 + variant * 3.1, (y + frame * 2.7) * 0.42, s);
      // the main tongue: it sways and leans more toward its tip, narrowing with a flickering bulge or two along it
      const k = up / H;
      let temp = -9;
      if (k <= 1.05) {
        const cx = tip * k ** 1.5 + Math.sin(k * 3.4 + ph) * R * 0.28 * k;
        const hw = R * (1 - Math.min(1, k)) ** 0.75 * (1 + 0.2 * Math.sin(k * 7 + ph * 1.3)) + 0.35;
        const edge = hw * (0.72 + 0.62 * n);
        const ad = Math.abs(dx - cx);
        if (ad <= edge) temp = 1 - (ad / Math.max(0.5, edge)) * 0.5 - k * 1.05 + (n - 0.5) * 0.4;
      }
      // a second, shorter lick of flame off to one side (each shape its side), so a fire is never one tidy drop
      if (R >= 2) {
        const k2 = up / (H * (0.5 + 0.12 * ((frame + variant) & 1)));
        if (k2 <= 1) {
          const side = variant & 1 ? 1 : -1;
          const cx2 = side * R * 0.62 + tip * 0.8 * k2 ** 1.6 + Math.sin(k2 * 3 + ph * 1.7) * R * 0.2 * k2;
          const hw2 = R * 0.55 * (1 - k2) ** 0.8 + 0.3;
          const ad2 = Math.abs(dx - cx2);
          if (ad2 <= hw2 * (0.7 + 0.6 * n)) temp = Math.max(temp, 0.9 - (ad2 / Math.max(0.5, hw2)) * 0.5 - k2 * 1.1 + (n - 0.5) * 0.4);
        }
      }
      if (temp === -9) continue;
      const idx = Math.max(0, Math.min(5, Math.floor((1 - temp) * 4.6 + dith * 0.8)));
      put(x, y, FIRE_RGB[idx]);
    }
  }
  // a lick of flame torn off above the tip on two of the four frames
  if ((frame + variant) & 1) {
    const lx = half + Math.round(tip * 1.1 + Math.sin(ph) * R * 0.3);
    const ly = top - Math.round(H * (1.1 + 0.12 * ((frame >> 1) & 1)));
    put(lx, ly, FIRE_RGB[3]);
    if (R >= 2) put(lx, ly - 1, FIRE_RGB[4]);
    if (R >= 3) put(lx + 1, ly, FIRE_RGB[4]);
  }
  return { w: W, h: Hh, ox: half, oy: top, data };
}

/**
 * A patch of foam on the water: flat (the sea seen at the 3/4 angle), white lace, not a mat: clumps of near-white froth
 * threaded with streaky holes, thin low veils of blue-grey spray between them, densest in its middle and breaking into
 * lobes and loose bubbles at its edge (never a ring or a straight edge); `age` 0..3 opens more and bigger holes in it
 * as it breaks up. Radius `r` cells (1..48).
 */
export function foamBitmap(r: number, variant: number, age: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = 0.55;
  const half = Math.ceil(R * 1.45) + 1;
  const hy = Math.ceil(R * sq * 1.45) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.37 + 0.2;
  const s = variant * 23 + R + 3;
  const A = Math.max(0, Math.min(3, age | 0));
  const fs = Math.max(0.33, Math.min(0.8, 5 / R));
  const top = RAMP.spray[3];
  const veil = RAMP.spray[1];
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      // big lobes round the edge (three and five round), so the patch never has a straight top or bottom
      const e = R * (0.9 + 0.13 * Math.sin(3 * a + ph) + 0.09 * Math.sin(5 * a + ph * 2.1) + 0.05 * Math.sin(9 * a + ph * 1.3));
      const d = Math.hypot(dx, dy) / e;
      const o = (y * W + x) * 4;
      const grain = hash2(x, y, s + 5);
      if (d >= 1) {
        // loose bubbles out past the edge
        if (d < 1.35 && grain < 0.05 * (1.35 - d) / 0.35 * (1 - A * 0.2)) {
          data[o] = top[0];
          data[o + 1] = top[1];
          data[o + 2] = top[2];
          data[o + 3] = 210;
        }
        continue;
      }
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      // lace: a network of froth round open holes (ridges of noise), stretched across the screen, its strands thick
      // and white in the middle of the patch and thin toward its edge
      const rid = 1 - Math.abs(2 * vnoise(x * fs + variant * 2.3, y * fs * 1.7, s) - 1);
      const clump = vnoise(x * fs * 0.35 + 4.1, y * fs * 0.6, s + 1);
      const dens = 1 - d * d;
      const score = rid + 0.6 * dens + 0.3 * (clump - 0.5) - A * 0.1 + dith * 0.08;
      if (score < 0.92) continue;
      if (score > 1.08) {
        data[o] = top[0];
        data[o + 1] = top[1];
        data[o + 2] = top[2];
        data[o + 3] = 235;
      } else {
        // a thin veil of spray at the edge of a strand
        data[o] = veil[0];
        data[o + 1] = veil[1];
        data[o + 2] = veil[2];
        data[o + 3] = 90;
      }
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/**
 * A burnt patch on a deck: flat (the 3/4 view), blackened plating in soot and scorched-earth tones, darkest in the
 * middle, its edge broken by dither into the paint round it. Radius `r` cells (1..48).
 */
export function scorchBitmap(r: number, variant: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = 0.6;
  const half = Math.ceil(R * 1.2) + 1;
  const hy = Math.ceil(R * sq * 1.2) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.9 + 0.3;
  const s = variant * 19 + R + 7;
  const T = [hex(SOOT[0]), hex(SCORCH[1]), hex(SOOT[1]), hex(SCORCH[3])];
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      const e = R * (0.9 + 0.16 * Math.sin(3 * a + ph) + 0.1 * Math.sin(5 * a + ph * 1.7));
      const d = Math.hypot(dx, dy) / e;
      if (d >= 1.05) continue;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const n = vnoise(x * 0.6 + variant * 3.7, y * 0.9, s);
      if (d + (n - 0.5) * 0.5 + dith * 0.35 > 0.85) continue;
      const t = Math.max(0, Math.min(3, Math.floor(d * 2.6 + (n - 0.5) * 1.6 + dith * 0.8)));
      const c = T[t];
      const o = (y * W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = t === 3 ? 170 : 235;
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/**
 * Oil on the sea, darkest first: near black with a little brown in it, laid on see-through so it reads as the sea a
 * shade darker, never a grey patch; and its sheen (a few faint flecks a step lighter, a muted olive and a dull violet).
 */
const OIL: RGB[] = ['#0a0908', '#0d0b0a', '#110e0c', '#15110e'].map(hex);
const SHEEN: RGB[] = ['#262620', '#27242b'].map(hex);

/**
 * A slick of oil on the sea: flat (the 3/4 view), its edge in big uneven lobes, ragged where it thins out (loose
 * pixels, never a checkerboard), near black and slightly brown with darker and lighter swirls inside and a few faint
 * flecks of sheen; `age` 0..3 thins it, opening holes of open water in it. Radius `r` cells (1..48).
 */
export function oilBitmap(r: number, variant: number, age: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = 0.52;
  const half = Math.ceil(R * 1.3) + 1;
  const hy = Math.ceil(R * sq * 1.3) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.53 + 0.7;
  const s = variant * 29 + R + 11;
  const A = Math.max(0, Math.min(3, age | 0));
  const fs = Math.max(0.18, Math.min(0.6, 3.5 / R));
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      const e = R * (0.86 + 0.15 * Math.sin(3 * a + ph) + 0.1 * Math.sin(5 * a + ph * 1.9) + 0.06 * Math.sin(8 * a + ph * 2.7));
      const d = Math.hypot(dx, dy) / e;
      if (d >= 1) continue;
      const n = vnoise(x * fs + variant * 2.1, y * fs * 1.6, s);
      // holes of open water as it thins
      if (n < A * 0.12 - 0.05 + d * 0.15 * A) continue;
      // the edge: ragged, loose pixels thinning out (by noise, not a regular dither)
      const edge = (d - 0.72 - 0.12 * n) / 0.28;
      if (edge > 0 && hash2(x, y, s + 2) < 0.25 + 0.75 * edge) continue;
      const swirl = vnoise(x * fs * 0.6 + 7.3, y * fs, s + 3);
      const t = Math.max(0, Math.min(3, Math.floor(swirl * 3.4 + (hash2(x, y, s + 4) - 0.5) * 0.6 + d * 0.6)));
      // the sheen: a few faint flecks where a ridge of the swirl noise runs
      const ridge = 1 - Math.abs(2 * vnoise(x * fs * 0.9 + 1.7, y * fs * 2.2, s + 7) - 1);
      const c = ridge > 0.975 && d < 0.75 && hash2(x, y, s) < 0.35 ? SHEEN[(x + variant) & 1] : OIL[t];
      const o = (y * W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = d > 0.8 ? 120 : 175 - A * 22;
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

// ------------------------------------------------------------------------------------------------- drawing

const atlas = new SpriteAtlas(1024, 6);

/** A blob's radius in whole cells; big ones in steps of two and four cells, so a growing cloud bakes far fewer sizes. */
export function cellsOf(r: number): number {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  return R > 32 ? Math.round(R / 4) * 4 : R > 16 ? Math.round(R / 2) * 2 : R;
}

function entry(kind: BlobKind, r: number, variant: number, heat: number): AtlasEntry | null {
  const R = kind === 'flame' ? Math.max(1, Math.min(16, Math.round(r))) : cellsOf(r);
  const v = variant & 3;
  const h = kind === 'fire' ? Math.max(0, Math.min(4, Math.round(heat))) : kind === 'flame' ? Math.max(0, Math.min(19, heat | 0)) : kind === 'foam' || kind === 'oil' ? Math.max(0, Math.min(3, heat | 0)) : 0;
  const key = ((KINDS.indexOf(kind) * 64 + R) * 4 + v) * 32 + h;
  return atlas.get(key, () => blobBitmap(kind, R, v, h));
}

/**
 * Draws a blob centred at (x, y) CSS px, `r` cells of grid `g` (bigger than 48 cells: drawn with coarser cells),
 * at `alpha`. Fire heat 0..4; a flame's `heat` is its frame (0..3) plus four times its lean plus two (flameCode), and
 * its origin is the middle of its base; a foam patch's or an oil slick's `heat` is its age (0 fresh .. 3 breaking
 * up). Returns false when it could not be drawn (no canvas).
 */
export function drawBlob(ctx: CanvasRenderingContext2D, kind: BlobKind, r: number, variant: number, x: number, y: number, g: Grid, alpha = 1, heat = 0): boolean {
  if (alpha <= 0.01 || r < 0.5) return true;
  let f = 1;
  while (r / f > (kind === 'flame' ? 16 : 40)) f *= 2;
  const e = entry(kind, r / f, variant, heat);
  if (!e) return false;
  const k = g.k * f;
  const cx = (Math.round((x * g.dpr) / (g.p * f)) * g.p * f) / g.dpr;
  const cy = (Math.round((y * g.dpr) / (g.p * f)) * g.p * f) / g.dpr;
  const prev = ctx.globalAlpha;
  const sm = ctx.imageSmoothingEnabled;
  // a soft light or dust sheet drawn with coarse cells (a big one) is smoothed, so its dither never shows as a
  // checkerboard of big squares; every other blob keeps crisp pixels
  ctx.imageSmoothingEnabled = f >= 4 && (kind === 'glow' || kind === 'halo' || kind === 'haze' || kind === 'heat' || kind === 'press' || kind === 'lamp' || kind === 'whiteHot');
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, cx - e.ox * k, cy - e.oy * k, e.w * k, e.h * k);
  ctx.globalAlpha = prev;
  ctx.imageSmoothingEnabled = sm;
  return true;
}

/** True where blobs can be drawn (a DOM canvas). */
export function blobsReady(): boolean {
  return canBake();
}
