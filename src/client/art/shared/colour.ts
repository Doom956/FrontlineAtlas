// Colour maths shared by the art styles (client only, pure).
export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const lerpRGB = (a: readonly number[], b: readonly number[], t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/** Perceived brightness 0..255 (Rec. 601 weights). */
export function luma(c: readonly number[]): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/**
 * The owner's colour as a 4-tone ramp (deep, dark, base, light): evened toward a mid lightness first (a very dark or
 * very pale nation colour still shows as a band), then darkened and lightened along its own hue.
 */
export function ownerRamp(c: readonly number[]): RGB[] {
  const l = luma(c);
  let base: RGB = [c[0], c[1], c[2]];
  if (l < 70) base = lerpRGB(c, [150, 150, 150], (70 - l) / 140);
  else if (l > 205) base = lerpRGB(c, [120, 120, 120], (l - 205) / 160);
  return [lerpRGB(base, [8, 10, 14], 0.62), lerpRGB(base, [8, 10, 14], 0.36), base, lerpRGB(base, [255, 255, 255], 0.42)];
}

/** CSS colour of an RGB triple. */
export function rgbCss(c: readonly number[], a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
