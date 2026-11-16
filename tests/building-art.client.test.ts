// The detailed building art on the map: game state to art (level look, add-ons), the zoom looks, the sprite cache key and
// the cache itself (one bake per key, never per frame).
import { describe, expect, it } from 'vitest';
import { addonOf, ART_BAKES_PER_FRAME, ART_ZOOM, artScale, BuildingSprites, CLOSE_ZOOM, hasArt, lookFor, quantTint, seaFacing, specOf, spriteKey, type AddonState } from '../src/client/render/buildingArt';
import { spriteScale } from '../src/client/render/units';

const NONE: AddonState = { fortification: false, radar: false, navalMastery: false, samCover: false };

describe('building art mapping', () => {
  it('has art for fort, city, SAM site and port only', () => {
    for (const t of ['fort', 'city', 'sam', 'port'] as const) expect(hasArt(t)).toBe(true);
    for (const t of ['farm', 'mine', 'market', 'barracks', 'factory', 'arsenal', 'watchtower', 'airfield', 'silo', 'lab', 'hospital', 'oilWell'] as const) expect(hasArt(t)).toBe(false);
    expect(specOf('farm', 1, NONE)).toBeNull();
  });

  it('maps the building level to the level look, capped at what the models tell apart', () => {
    expect(specOf('fort', 3, NONE)?.level).toBe(3);
    expect(specOf('city', 6, NONE)?.level).toBe(5);
    expect(specOf('sam', 3, NONE)?.level).toBe(3);
    expect(specOf('port', 5, NONE)?.level).toBe(5);
    expect(specOf('fort', 0, NONE)?.level).toBe(1);
  });

  it('shows an add-on only where the game has that state', () => {
    expect(addonOf('fort', NONE)).toBeNull();
    expect(addonOf('fort', { ...NONE, fortification: true })).toBe('traps');
    expect(addonOf('fort', { ...NONE, samCover: true })).toBe('flak');
    expect(addonOf('city', { ...NONE, samCover: true })).toBe('flak');
    expect(addonOf('city', { ...NONE, fortification: true, radar: true, navalMastery: true })).toBeNull();
    expect(addonOf('sam', { ...NONE, radar: true })).toBe('radar');
    expect(addonOf('port', { ...NONE, navalMastery: true })).toBe('guns');
    expect(addonOf('port', { ...NONE, samCover: true })).toBeNull();
  });

  it('picks the look by zoom: flat markers when far, far look A at normal zoom, the close look up close', () => {
    expect(lookFor(ART_ZOOM - 0.1)).toBeNull();
    expect(lookFor(ART_ZOOM)).toBe('far');
    expect(lookFor(CLOSE_ZOOM - 0.1)).toBe('far');
    expect(lookFor(CLOSE_ZOOM)).toBe('close');
  });

  it('uses the units own pixel scale', () => {
    for (const z of [4, 10.9, 11, 21, 22, 31, 32, 60]) expect(artScale(z)).toBe(spriteScale(z));
  });
});

describe('building art sprite cache', () => {
  const fort = specOf('fort', 2, NONE)!;
  const key = (over: Partial<{ lv: number; owner: number[]; look: 'close' | 'far'; scale: number; tint: number[]; facing: number }> = {}): string =>
    spriteKey({ ...fort, level: over.lv ?? fort.level }, over.owner ?? [64, 160, 255], over.look ?? 'far', over.scale ?? 1.5, 1, over.tint ?? [96, 120, 72], over.facing ?? 0);

  it('keys differ by type, level, add-on, owner colour, look, scale and ground colour', () => {
    const base = key();
    expect(key()).toBe(base);
    expect(key({ lv: 3 })).not.toBe(base);
    expect(key({ owner: [226, 74, 60] })).not.toBe(base);
    expect(key({ look: 'close' })).not.toBe(base);
    expect(key({ scale: 2 })).not.toBe(base);
    expect(key({ tint: [96, 128, 72] })).not.toBe(base);
    expect(spriteKey({ ...fort, addon: 'traps' }, [1, 2, 3], 'far', 1.5, 1, [0, 0, 0])).not.toBe(spriteKey(fort, [1, 2, 3], 'far', 1.5, 1, [0, 0, 0]));
    expect(spriteKey({ ...fort, type: 'city' }, [1, 2, 3], 'far', 1.5, 1, [0, 0, 0])).not.toBe(spriteKey(fort, [1, 2, 3], 'far', 1.5, 1, [0, 0, 0]));
  });

  it('snaps near ground colours to one key', () => {
    expect(quantTint([97, 121, 73])).toEqual(quantTint([95, 119, 71]));
  });

  it('bakes once per key and limits bakes per frame', () => {
    const c = new BuildingSprites();
    let n = 0;
    const mk = () => {
      n++;
      return { baked: { canvas: null as never, w: 1, h: 1, top: 0, cx: 0 }, scale: 1.5 };
    };
    c.newFrame();
    expect(c.get('a', mk)).not.toBeNull();
    expect(c.get('a', mk)).not.toBeNull();
    expect(n).toBe(1);
    for (let i = 0; i < ART_BAKES_PER_FRAME + 2; i++) c.get('k' + i, mk);
    expect(n).toBe(ART_BAKES_PER_FRAME);
    expect(c.get('zzz', mk)).toBeNull();
    c.newFrame();
    expect(c.get('zzz', mk)).not.toBeNull();
  });
});

describe('port facing', () => {
  it('faces the side with the sea', () => {
    expect(seaFacing((dx) => dx >= 1)).toBe(0);
    expect(seaFacing((_dx, dy) => dy >= 1)).toBe(1);
    expect(seaFacing((dx) => dx <= -1)).toBe(2);
    expect(seaFacing((_dx, dy) => dy <= -1)).toBe(3);
  });
});
