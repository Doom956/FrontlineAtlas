// The detailed building art on the map: game state to art (level look, add-ons), the zoom looks, the sprite cache key and
// the cache itself (one bake per key, never per frame).
import { describe, expect, it } from 'vitest';
import { addonOf, allSpecs, ART_BAKES_PER_FRAME, ART_TYPES, ART_ZOOM, artScale, BuildingSprites, CLOSE_ZOOM, fitScale, hasArt, lookFor, quantTint, drawnExtent, seaFacing, specOf, spriteKey, type AddonState } from '../src/client/render/buildingArt';
import { type BuildingSpec } from '../src/client/art/detailed/buildings';
import { BUILDING_MIN_SPACING_BY_SIZE, BUILDINGS } from '../src/sim/config';
import type { BuildingType } from '../src/sim/types';
import { spriteScale } from '../src/client/render/units';

const NONE: AddonState = { fortification: false, radar: false, navalMastery: false, samCover: false };

describe('building art mapping', () => {
  it('has art for every building type in the game', () => {
    for (const t of Object.keys(BUILDINGS) as BuildingType[]) {
      expect(hasArt(t), t).toBe(true);
      expect(specOf(t, 1, NONE), t).not.toBeNull();
    }
    expect(ART_TYPES.length).toBe(Object.keys(BUILDINGS).length);
    expect(ART_TYPES.length).toBe(16);
  });

  it('maps every type and level to its own spec, capped at the building max level (and at 5)', () => {
    for (const t of ART_TYPES) {
      const max = BUILDINGS[t].maxLevel;
      const top = Math.min(max, 5);
      for (let lv = 1; lv <= max; lv++) expect(specOf(t, lv, NONE), `${t} ${lv}`).toEqual({ type: t, level: Math.min(lv, top), addon: null });
      expect(specOf(t, max + 3, NONE)?.level, t).toBe(top);
      expect(specOf(t, 0, NONE)?.level, t).toBe(1);
    }
    expect(specOf('farm', 5, NONE)?.level).toBe(5);
    expect(specOf('hospital', 2, NONE)?.level).toBe(2);
    expect(specOf('silo', 3, NONE)?.level).toBe(3);
  });

  it('gives the new types no add-on whatever the owner has', () => {
    const ALL: AddonState = { fortification: true, radar: true, navalMastery: true, samCover: true };
    for (const t of ART_TYPES) if (!['fort', 'city', 'sam', 'port'].includes(t)) expect(addonOf(t, ALL), t).toBeNull();
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

  it('keys differ per type and level for the new types too', () => {
    const keys = new Set<string>();
    for (const sp of allSpecs()) keys.add(spriteKey(sp, [1, 2, 3], 'far', 1.5, 1, [0, 0, 0]));
    expect(keys.size).toBe(allSpecs().length);
    expect(spriteKey(specOf('farm', 1, NONE)!, [1, 2, 3], 'close', 2, 2, [8, 16, 24])).not.toBe(spriteKey(specOf('mine', 1, NONE)!, [1, 2, 3], 'close', 2, 2, [8, 16, 24]));
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

describe('building art never overlaps at minimum spacing', () => {
  // all 16 types, every level and add-on
  const specs: BuildingSpec[] = allSpecs();
  const boxOf = (s: BuildingSpec, look: 'close' | 'far', facing: number, zoom: number, spacing: number) => {
    const fit = fitScale(s, look, facing, zoom, spacing);
    if (!fit) return null;
    const e = drawnExtent(s, look, facing);
    return { l: e.l * fit.scale, r: e.r * fit.scale, u: e.u * fit.scale, d: e.d * fit.scale, fit };
  };

  it('for every map size and zoom step from the cutoff up, two neighbours at the minimum spacing have separate boxes', () => {
    for (const spacing of Object.values(BUILDING_MIN_SPACING_BY_SIZE)) {
      for (let zoom = ART_ZOOM; zoom <= 48; zoom += 0.5) {
        const look = lookFor(zoom)!;
        const boxes: NonNullable<ReturnType<typeof boxOf>>[] = [];
        for (const s of specs) for (const f of s.type === 'port' ? [0, 1, 2, 3] : [0]) {
          const b = boxOf(s, look, f, zoom, spacing);
          // from the cutoff up every picture fits at the smallest scale on every map size
          expect(b, `${s.type} ${s.level} ${s.addon} at zoom ${zoom}`).not.toBeNull();
          boxes.push(b!);
        }
        const D = spacing * zoom;
        // the widest and the tallest pictures stand for every pair (a box only grows with its reaches)
        const big = { l: Math.max(...boxes.map((b) => b.l)), r: Math.max(...boxes.map((b) => b.r)), u: Math.max(...boxes.map((b) => b.u)), d: Math.max(...boxes.map((b) => b.d)) };
        for (let a = 0; a < 8; a++) {
          const dx = Math.cos((a * Math.PI) / 4) * D;
          const dy = Math.sin((a * Math.PI) / 4) * D;
          // B sits at (dx, dy) from A; boxes are separate when they miss on either axis
          const sepX = dx > 0 ? big.r + big.l <= dx + 1e-6 : dx < 0 ? big.l + big.r <= -dx + 1e-6 : false;
          const sepY = dy > 0 ? big.d + big.u <= dy + 1e-6 : dy < 0 ? big.u + big.d <= -dy + 1e-6 : false;
          expect(sepX || sepY, `zoom ${zoom} spacing ${spacing} angle ${a * 45}`).toBe(true);
        }
      }
    }
  });

  it('keeps the flat markers below the cutoff and a chip or label only where there is room', () => {
    expect(lookFor(ART_ZOOM - 0.01)).toBeNull();
    const city5 = { type: 'city', level: 5, addon: 'flak' } as const;
    expect(fitScale(city5, 'far', 0, ART_ZOOM / 2, 10)).toBeNull();
    const f = fitScale(city5, 'close', 0, 11, 10)!;
    expect(f.scale % 0.25).toBe(0);
    expect(f.scale).toBeLessThanOrEqual(artScale(11));
    // plenty of room on a huge map at high zoom: the units' own scale and both labels
    const g = fitScale(city5, 'close', 0, 40, 15)!;
    expect(g.scale).toBe(artScale(40));
    expect(g.chip && g.name).toBe(true);
  });
});
