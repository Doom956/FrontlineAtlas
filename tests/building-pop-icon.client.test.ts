// The flat icon that floats above a hovered or selected building at art zoom (render/buildings.ts popIconTiles).
import { describe, expect, it } from 'vitest';
import { ART_ZOOM } from '../src/client/render/buildingArt';
import { POP_FADE_MS, popFade, popIconTiles } from '../src/client/render/buildings';

describe('building pop-up icon', () => {
  it('shows for the hovered and the selected building from ART_ZOOM on', () => {
    expect(popIconTiles([40, 77], ART_ZOOM)).toEqual([40, 77]);
    expect(popIconTiles([40], 20)).toEqual([40]);
  });
  it('shows once when the hovered building is also the selected one', () => {
    expect(popIconTiles([40, 40], ART_ZOOM)).toEqual([40]);
  });
  it('is off below ART_ZOOM (the flat marker is already there) and with nothing focused', () => {
    expect(popIconTiles([40, 77], ART_ZOOM - 0.1)).toEqual([]);
    expect(popIconTiles([], 12)).toEqual([]);
  });
  it('fades in from 0 to 1', () => {
    expect(popFade(1000, 1000)).toBe(0);
    expect(popFade(1000, 1000 + POP_FADE_MS)).toBe(1);
    expect(popFade(1000, 5000)).toBe(1);
    const mid = popFade(1000, 1000 + POP_FADE_MS / 2);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
  });
});
