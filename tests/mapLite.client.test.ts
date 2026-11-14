// The light map for software rendering (render/glmap.ts lite) and the ground built between frames (render/ground.ts
// groundLater): no GPU must not freeze the page. Client only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapData } from '../src/sim/types';
import { softwareRenderer } from '../src/client/render/glmap';
import { buildGround, groundFor, groundLater } from '../src/client/render/ground';
import { mapFragmentShader } from '../src/client/render/shaders';
import { buildTerrain } from '../src/client/render/terrain';

function testMap(w = 90, h = 70): MapData {
  const n = w * h;
  const terrain = new Uint8Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      terrain[i] = x < 8 ? 0 : (x * 7 + y * 3) % 23 < 4 ? 3 : (x + y) % 31 < 3 ? 5 : 2;
    }
  return { width: w, height: h, terrain, resource: new Uint8Array(n), owner: new Uint16Array(n), building: new Int32Array(n), coastal: new Uint8Array(n), fallout: new Float32Array(n), landTileCount: n } as unknown as MapData;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('software rendering', () => {
  it('knows the software renderers (no GPU) from real ones', () => {
    expect(softwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true);
    expect(softwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(softwareRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)')).toBe(true);
    expect(softwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(softwareRenderer('Apple M2')).toBe(false);
    expect(softwareRenderer('')).toBe(false);
  });

  it('can turn the pixel ground off in the map pass (the light map, and while the ground is built)', () => {
    const src = mapFragmentShader('ground');
    expect(src).toContain('uniform float uNearOn;');
    expect(src).toMatch(/float nearG = smoothstep\(2\.0, 3\.2, zc\) \* uNearOn;/);
  });
});

describe('ground built between frames', () => {
  it('builds in slices and gives exactly what a build at once gives, telling each listener once', () => {
    vi.useFakeTimers();
    const map = testMap();
    const depth = buildTerrain(map).depth;
    const ready = vi.fn();
    expect(groundLater(map, depth, ready)).toBeNull();
    expect(groundLater(map, depth, ready)).toBeNull(); // asked again on the next frame: the same job
    vi.runAllTimers();
    expect(ready).toHaveBeenCalledTimes(1);
    const g = groundLater(map, depth, ready);
    expect(g).not.toBeNull();
    const once = buildGround(map, depth);
    expect(g!.far).toEqual(once.far);
    expect(g!.data).toEqual(once.data);
    expect(g!.mixA).toEqual(once.mixA);
    expect(g!.mixB).toEqual(once.mixB);
    expect(g!.mixC).toEqual(once.mixC);
    expect(groundFor(map, depth)).toBe(g);
  });

  it('is finished at once when something needs it right now (groundFor), and the listener still hears of it', () => {
    vi.useFakeTimers();
    const map = testMap(60, 50);
    const depth = buildTerrain(map).depth;
    const ready = vi.fn();
    expect(groundLater(map, depth, ready)).toBeNull();
    const g = groundFor(map, depth);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(groundLater(map, depth, ready)).toBe(g);
    vi.runAllTimers(); // the pending slice finds the job gone and stops
    expect(ready).toHaveBeenCalledTimes(1);
  });
});
