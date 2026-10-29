// Seeded RNG (mulberry32). The sim must only use state.rng().
export function makeRng(seed: number): { rng: () => number; state: { s: number } } {
  // TODO(WP-A)
  const state = { s: seed >>> 0 };
  return { rng: () => 0.5, state };
}
