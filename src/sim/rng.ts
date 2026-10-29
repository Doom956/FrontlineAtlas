// Seeded RNG (mulberry32). The sim must only use state.rng().
//
// The whole generator state is the single 32-bit integer `state.s`, so a game can be snapshotted by saving
// `rngState.s` and resumed with makeRng(savedS): the next numbers are identical.
export function makeRng(seed: number): { rng: () => number; state: { s: number } } {
  const state = { s: seed >>> 0 };
  const rng = (): number => {
    state.s = (state.s + 0x6d2b79f5) >>> 0;
    let t = state.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rng, state };
}

/** Integer in [0, n). */
export function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher-Yates shuffle in place; returns the same array. */
export function shuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
