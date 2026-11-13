// The map overlay accent (src/client/render/common.ts, docs/UI_DIRECTION.md "Map overlays"): the overlays drawn on
// the map canvas use the panels' cool steel and research cobalt, never the old brass, and each stays readable on the
// slate sea (the light line) and on light land (the dark casing under it).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCENT, ACCENT_CASING_RGB, ACCENT_RGB, ACCENT_TEXT, accentStroke, css } from '../src/client/render/common';
import { TERRAIN_RGB } from '../src/client/render/terrain';

const lum = (c: readonly number[]): number => {
  const ch = c.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h: string): number[] => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));

describe('map overlay accent', () => {
  it('is the research cobalt family and reads on water (the line) and on light land (the casing)', () => {
    expect(hex(ACCENT)).toEqual(ACCENT_RGB);
    expect(contrast(ACCENT_RGB, TERRAIN_RGB[0])).toBeGreaterThanOrEqual(7); // open sea
    expect(contrast(ACCENT_RGB, TERRAIN_RGB[1])).toBeGreaterThanOrEqual(4.3); // the shelf
    // plains, hills, desert, tundra and a blue nation's fill (plains under 58% of a blue)
    for (const land of [TERRAIN_RGB[2], TERRAIN_RGB[4], TERRAIN_RGB[6], TERRAIN_RGB[8], [98, 161, 198]]) expect(contrast(ACCENT_CASING_RGB, land)).toBeGreaterThanOrEqual(4.5);
    // labels on the dark map plate
    expect(contrast(hex(ACCENT_TEXT), [10, 13, 21])).toBeGreaterThanOrEqual(7);
    // cool: blue clearly above red and green, unlike brass
    expect(ACCENT_RGB[2]).toBeGreaterThan(ACCENT_RGB[0] + 60);
  });

  it('accentStroke draws the dark casing first, 2 px wider, then the accent line', () => {
    const strokes: { style: string; width: number }[] = [];
    const ctx = { lineWidth: 0, strokeStyle: '', lineCap: 'round', getLineDash: () => [], stroke() { strokes.push({ style: String(this.strokeStyle), width: this.lineWidth }); } };
    accentStroke(ctx as unknown as CanvasRenderingContext2D, 1.5, 0.8);
    expect(strokes).toEqual([
      { style: css(ACCENT_CASING_RGB, 0.55 * 0.8), width: 3.5 },
      { style: css(ACCENT_RGB, 0.8), width: 1.5 },
    ]);
  });

  it('no overlay on the map canvas keeps the old brass or gold accent', () => {
    const files = ['selectionOverlay', 'pillarOverlay', 'overlays', 'fronts', 'units', 'buildings', 'names', 'heartland'];
    // the brass and gold accents the overlays used before (rgb and hex spellings)
    const brass = /227,\s*192,\s*78|#e3c04e|214,\s*170,\s*60|#ffe98a|255,\s*240,\s*196|#f6e7b8|255,\s*236,\s*190|\bBRASS\b/i;
    for (const f of files) {
      const src = readFileSync(new URL(`../src/client/render/${f}.ts`, import.meta.url), 'utf8');
      expect(brass.exec(src)?.[0] ?? null, f).toBeNull();
    }
    // the selected tile is outlined in the accent, not yellow (the barrage shells keep their yellow: an effect)
    const ov = readFileSync(new URL('../src/client/render/overlays.ts', import.meta.url), 'utf8');
    expect(ov.match(/#ffd84a/g)?.length ?? 0).toBe(1);
  });
});
