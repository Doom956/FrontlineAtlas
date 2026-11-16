// Map colour themes (render/mapThemes.ts): the default is today's palette, a map that names a theme gets it, an
// unknown one falls back, and a theme is looks only (never in the game's hash). Client only.
import { afterEach, describe, expect, it } from 'vitest';
import { hashState } from '../src/sim/hash';
import { createGame } from '../src/sim/state';
import { TERRAIN } from '../src/sim/config';
import { getWorldMap, loadWorldMap } from '../src/sim/worldmaps';
import { GROUND, buildGround } from '../src/client/render/ground';
import { DEFAULT_THEME, THEME_DEFS, hx, mapTheme, ramp, themeForMap } from '../src/client/render/mapThemes';
import { groundFragmentShader, mapFragmentShader, MAP_FS } from '../src/client/render/shaders';
import { buildTerrain, TERRAIN_RGB, WATER_MID } from '../src/client/render/terrain';
import { testSettings } from './helpers';

const MAP = 'baltic';

afterEach(() => {
  delete THEME_DEFS['test-theme'];
  const m = getWorldMap(MAP);
  if (m) delete m.theme;
});

function withTestTheme(): void {
  THEME_DEFS['test-theme'] = { ground: { grass: ramp('#102030', '#203040', '#304050', '#405060') }, flat: [undefined, undefined, hx('#aabbcc')] };
  getWorldMap(MAP)!.theme = 'test-theme';
}

describe('map themes', () => {
  it('the default theme is today\'s palette', () => {
    expect(DEFAULT_THEME.ground).toBe(GROUND);
    expect(DEFAULT_THEME.flat).toBe(TERRAIN_RGB);
    expect(DEFAULT_THEME.waterMid).toBe(WATER_MID);
    expect(DEFAULT_THEME.thumb).toEqual(Object.values(TERRAIN).map((t) => t.color));
    expect(mapFragmentShader('today')).toBe(MAP_FS);
    expect(mapFragmentShader('ground', DEFAULT_THEME)).toBe(mapFragmentShader('ground'));
    expect(MAP_FS).not.toContain('@');
  });

  it('maps without a theme, generated maps and unknown themes use the default', () => {
    expect(themeForMap({ kind: 'world', id: 'europe' })).toBe(DEFAULT_THEME);
    expect(themeForMap({ kind: 'generated', type: 'continents', size: 'small' })).toBe(DEFAULT_THEME);
    expect(themeForMap('no-such-map')).toBe(DEFAULT_THEME);
    expect(mapTheme('no-such-theme')).toBe(DEFAULT_THEME);
    expect(mapTheme(undefined)).toBe(DEFAULT_THEME);
    getWorldMap(MAP)!.theme = 'no-such-theme';
    expect(themeForMap(MAP)).toBe(DEFAULT_THEME);
  });

  it('the Sundering Wall uses its bright theme', () => {
    expect(getWorldMap('fourseas')?.theme).toBe('brightseas');
    expect(themeForMap({ kind: 'world', id: 'fourseas' }).id).toBe('brightseas');
    expect(themeForMap('fourseas').flat[5]).not.toEqual(themeForMap('world').flat[5]);
  });

  it('the walled country maps use their theme', () => {
    for (const id of ['ringlands', 'sundered']) {
      expect(getWorldMap(id)?.theme).toBe('stonewall');
      expect(themeForMap({ kind: 'world', id }).id).toBe('stonewall');
    }
    expect(themeForMap('ringlands').ground.rock).not.toBe(GROUND.rock);
  });

  it('a map that names a theme is drawn in it; what the theme leaves out keeps the default', () => {
    withTestTheme();
    const t = themeForMap({ kind: 'world', id: MAP });
    expect(t.id).toBe('test-theme');
    expect(t.ground.grass[2]).toEqual(hx('#304050'));
    expect(t.ground.forest).toBe(GROUND.forest);
    expect(t.flat[2]).toEqual(hx('#aabbcc'));
    expect(t.flat[3]).toBe(TERRAIN_RGB[3]);
    expect(t.thumb[2]).toEqual(hx('#aabbcc'));
    const fs = groundFragmentShader('ground', t);
    expect(fs).toContain('vec3(0.1882, 0.2510, 0.3137)');
    expect(fs).not.toBe(groundFragmentShader('ground'));
  });

  it('a theme is looks only: the game hashes the same', async () => {
    const map = await loadWorldMap(MAP);
    const settings = testSettings({ map: { kind: 'world', id: MAP }, aiCount: 2 });
    const a = createGame(settings, map);
    const before = hashState(a);
    withTestTheme();
    const theme = themeForMap(settings.map);
    expect(theme.id).toBe('test-theme');
    const terr = buildTerrain(a.map, theme);
    buildGround(a.map, terr.depth, theme);
    expect(hashState(a)).toBe(before);
    const b = createGame(settings, await loadWorldMap(MAP));
    expect(hashState(b)).toBe(before);
  });
});
