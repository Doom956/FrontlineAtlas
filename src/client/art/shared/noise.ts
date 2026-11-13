// Repeatable pseudo-random values for the art (client only): the same seed always gives the same picture. Never used by
// the sim (which has its own seeded generator).

export function fract(v: number): number {
  return v - Math.floor(v);
}

/** A repeatable 0..1 value for (seed, i). */
export function rnd(seed: number, i: number): number {
  return fract(Math.sin(seed * 91.17 + i * 12.9898) * 43758.5453);
}

/** A 0..1 seed from a position and a time (a new effect's look). */
export function seedOf(x: number, y: number, t = 0): number {
  return fract(Math.sin(x * 12.9898 + y * 78.233 + t * 0.001) * 43758.5453);
}
