// Deterministic math for the simulation.
//
// Lockstep multiplayer needs bit-identical results in every browser. The basic operations (+ - * /), Math.sqrt,
// Math.floor/round/abs/min/max are exactly specified (IEEE 754, correctly rounded), but Math.exp/log/pow/sin/...
// are not: their last bit may differ between JavaScript engines. The sim uses these replacements instead. They are
// built only from exactly specified operations, so every engine gets the same bits. Accuracy is a few ulp, which
// is plenty for game balance.

const LN2 = 0.6931471805599453;
// ln 2 split in two (Cody-Waite): k * LN2_HI is exact for |k| < 2^20, so the range reduction loses nothing.
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const SQRT2 = 1.4142135623730951;

/** 2^k for an integer k (exact: repeated doubling/halving of a power of two). */
function pow2i(k: number): number {
  let r = 1;
  if (k > 0) {
    let b = 2;
    let e = k;
    while (e > 0) {
      if (e & 1) r *= b;
      b *= b;
      e >>= 1;
    }
  } else if (k < 0) {
    let b = 0.5;
    let e = -k;
    while (e > 0) {
      if (e & 1) r *= b;
      b *= b;
      e >>= 1;
    }
  }
  return r;
}

/** Deterministic e^x. Range reduction x = k ln2 + r with |r| <= ln2/2, then a Taylor series for e^r. */
export function expDet(x: number): number {
  if (x !== x) return NaN;
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2_HI - k * LN2_LO;
  // Taylor series up to r^14 / 14!: |r| <= 0.347, so the error is far below 1 ulp.
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 14; n++) {
    term = (term * r) / n;
    sum += term;
  }
  // Split 2^k so that a big |k| doesn't overflow / underflow in the intermediate power.
  if (k > 1000 || k < -1000) {
    const h = (k / 2) | 0;
    return sum * pow2i(h) * pow2i(k - h);
  }
  return sum * pow2i(k);
}

/** Deterministic natural logarithm (x > 0; 0 -> -Infinity; negative -> NaN). */
export function logDet(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  // x = m * 2^e with m in [sqrt(1/2), sqrt(2)): exact, because scaling by 2 is exact.
  let m = x;
  let e = 0;
  while (m >= 2) {
    m *= 0.5;
    e++;
  }
  while (m < 1) {
    m *= 2;
    e--;
  }
  if (m > SQRT2) {
    m *= 0.5;
    e++;
  }
  // ln m = 2 atanh(s), s = (m - 1) / (m + 1), |s| <= 0.1716: the odd series converges fast.
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s;
  let sum = s;
  for (let n = 3; n <= 31; n += 2) {
    term *= s2;
    sum += term / n;
  }
  return 2 * sum + e * LN2;
}

/** Deterministic x^y for x >= 0 (x^0 = 1, 0^y = 0 for y > 0). */
export function powDet(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x === 1) return 1;
  if (x < 0) return NaN;
  return expDet(y * logDet(x));
}

/** b^n for a non-negative integer n by repeated multiplication (exactly specified). */
export function powInt(b: number, n: number): number {
  let r = 1;
  let base = b;
  let e = Math.max(0, Math.floor(n));
  while (e > 0) {
    if (e & 1) r *= base;
    base *= base;
    e = Math.floor(e / 2);
  }
  return r;
}
