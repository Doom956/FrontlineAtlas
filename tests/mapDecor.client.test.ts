// Map decor (render/decor.ts): towns, districts, farms and roads a world map lists in its manifest entry, painted by
// the client only. The list parses, the painting stays off walls and water, and the game hashes the same with or
// without it. Client only.
import { describe, expect, it } from 'vitest';
import { hashState } from '../src/sim/hash';
import { createGame } from '../src/sim/state';
import { getWorldMap, loadWorldMap, type WorldMapDecor } from '../src/sim/worldmaps';
import { buildDecor, DECOR_BLOCK, DECOR_SCALE, decorForMap, withDecor } from '../src/client/render/decor';
import { testSettings } from './helpers';

const KINDS = ['palace', 'town', 'district', 'village', 'farms', 'road'];

describe('map decor', () => {
  it('the walled country lists its towns, districts, farms and roads; other maps have none', () => {
    const info = getWorldMap('ringlands')!;
    const decor = info.decor ?? [];
    const n = info.width * info.height;
    expect(decor.length).toBeGreaterThan(20);
    for (const d of decor) {
      expect(KINDS).toContain(d.kind);
      expect(d.tile).toBeGreaterThanOrEqual(0);
      expect(d.tile).toBeLessThan(n);
      expect(d.size).toBeGreaterThan(0);
      if (d.kind === 'district') expect(typeof d.dir).toBe('number');
      if (d.kind === 'road') expect(d.path!.length).toBeGreaterThan(1);
    }
    // the core palace, twelve gate districts (four per wall)
    expect(decor.filter((d) => d.kind === 'palace')).toHaveLength(1);
    expect(decor.filter((d) => d.kind === 'district')).toHaveLength(12);
    expect(decorForMap({ kind: 'world', id: 'ringlands' })).toBe(decor);
    expect(decorForMap({ kind: 'world', id: 'europe' })).toEqual([]);
    expect(decorForMap({ kind: 'generated', type: 'continents', size: 'small' })).toEqual([]);
  });

  it('paints sparse blocks, never on walls or water, and lays its average into the far colours', async () => {
    const map = await loadWorldMap('ringlands');
    const layer = buildDecor(map, decorForMap({ kind: 'world', id: 'ringlands' }))!;
    expect(layer).not.toBeNull();
    const blocks = Math.ceil(map.width / DECOR_BLOCK) * Math.ceil(map.height / DECOR_BLOCK);
    let used = 0;
    let bad = 0;
    const BP = DECOR_BLOCK * DECOR_SCALE;
    for (let by = 0; by < layer.idxH; by++)
      for (let bx = 0; bx < layer.idxW; bx++) {
        const io = (by * layer.texW + bx) * 4;
        const slot = layer.data[io] + layer.data[io + 1] * 256 - 1;
        if (slot < 0) continue;
        used++;
        const sx = (slot % layer.perRow) * BP;
        const sy = layer.idxH + Math.floor(slot / layer.perRow) * BP;
        for (let y = 0; y < BP; y++)
          for (let x = 0; x < BP; x++) {
            if (layer.data[((sy + y) * layer.texW + sx + x) * 4 + 3] === 0) continue;
            const tx = bx * DECOR_BLOCK + Math.floor(x / DECOR_SCALE);
            const ty = by * DECOR_BLOCK + Math.floor(y / DECOR_SCALE);
            const t = map.terrain[ty * map.width + tx];
            if (t <= 1 || t === 5) bad++; // nothing on water or walls (mountains)
          }
      }
    expect(bad).toBe(0);
    expect(used).toBeGreaterThan(20);
    expect(used).toBeLessThan(blocks / 2); // sparse: only blocks that hold decor
    const flat = new Uint8Array(map.width * map.height * 4).fill(100);
    const out = withDecor(flat, layer);
    expect(out).not.toBe(flat);
    expect(flat[0]).toBe(100);
    const [tile] = layer.far.keys();
    expect(out.slice(tile * 4, tile * 4 + 3)).not.toEqual(flat.slice(tile * 4, tile * 4 + 3));
  });

  it('is looks only: the game hashes the same with or without it', async () => {
    const info = getWorldMap('ringlands')!;
    const saved = info.decor;
    const settings = testSettings({ map: { kind: 'world', id: 'ringlands' }, aiCount: 2 });
    try {
      const a = createGame(settings, await loadWorldMap('ringlands'));
      const before = hashState(a);
      buildDecor(a.map, decorForMap(settings.map));
      expect(hashState(a)).toBe(before);
      info.decor = [] as WorldMapDecor[];
      const b = createGame(settings, await loadWorldMap('ringlands'));
      expect(hashState(b)).toBe(before);
    } finally {
      info.decor = saved;
    }
  });
});
