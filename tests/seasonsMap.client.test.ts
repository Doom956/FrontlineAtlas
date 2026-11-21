// Seasons and day and night on the game map (render/seasonView.ts, render/labelSink.ts, the map shader and the
// renderer's world layer): the Day and night setting, the light at the key moments of the day, the season colours
// blending at the season boundaries, the snow line and ice following the sim, and the labels, borders and HUD left
// out of the night's shade. Looks only: nothing here touches the sim.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEASON, TICKS_PER_SECOND } from '../src/sim/config';
import { SEASON_TICKS, iceRowsFor, snowRowsAt } from '../src/sim/seasons';
import { DAY_TIMES } from '../src/client/dayNight';
import { farDeltas, mapLook, overlayShade, rampDeltas, RAMP_IDS, seasonValue, setLookOverride, snowRowsSmooth, winterLook } from '../src/client/render/seasonView';
import { drawHeldLabels, holdLabel, holdLabels, holdingLabels } from '../src/client/render/labelSink';
import { groundFragmentShader, mapFragmentShader } from '../src/client/render/shaders';
import { lightKindOf, LIGHT_CAPS, NightLights } from '../src/client/render/nightLights';
import * as store from '../src/client/settings/store';

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const H = 560;
const game = (tick: number, playStartTick = 0) => ({ phase: 'playing' as const, tick, playStartTick, map: { height: H } as never });
const at = (sec: number) => game(Math.round(sec * TICKS_PER_SECOND));

beforeEach(() => {
  store.useSettingsStorage(new MemStore());
  setLookOverride(null);
});

describe('Day and night setting', () => {
  it('is on by default, saved under fa.settings.v1, and a broken value takes the default', () => {
    expect(store.DEFAULT_SETTINGS.dayNight).toBe(true);
    expect(store.DISPLAY_KEYS).toContain('dayNight');
    const mem = new MemStore();
    store.useSettingsStorage(mem);
    store.setSetting('dayNight', false);
    expect(JSON.parse(mem.getItem(store.FA_SETTINGS_KEY)!).dayNight).toBe(false);
    store.useSettingsStorage(mem);
    expect(store.getSettings().dayNight).toBe(false);
    expect(store.parseSettings({ dayNight: 'yes' }).dayNight).toBe(true);
  });

  it('off keeps it noon: no shade and no lights at night; the seasons still show', () => {
    store.setSetting('dayNight', false);
    const l = mapLook(game(Math.round(DAY_TIMES.night * TICKS_PER_SECOND), -2 * SEASON_TICKS));
    expect(l.dark).toBe(0);
    expect(l.warm).toBe(0);
    expect(l.lights).toBe(0);
    expect(l.light.k).toBe(1);
    expect(overlayShade(l).a).toBe(0);
    expect(l.s).toBeCloseTo(2, 5);
  });
  it('tutorials stay at noon: no dawn glow on the snow, no night', () => {
    for (const sec of [DAY_TIMES.dawn, DAY_TIMES.dusk, DAY_TIMES.night]) {
      const l = mapLook({ ...at(sec), tutorial: {} });
      expect(l.dark).toBe(0);
      expect(l.warm).toBe(0);
      expect(l.lights).toBe(0);
    }
    expect(mapLook(at(DAY_TIMES.dawn)).warm).toBeGreaterThan(0);
  });
});

describe('the light through the day', () => {
  it('noon: full light, no tint', () => {
    const l = mapLook(at(DAY_TIMES.noon));
    expect(l.dark).toBe(0);
    expect(l.warm).toBe(0);
    expect(l.light.k).toBe(1);
    expect(l.lights).toBe(0);
    expect(overlayShade(l).a).toBe(0);
  });

  it('night: 25 to 30% darker with a cool blue tint, lights on, fires brighter', () => {
    const l = mapLook(at(DAY_TIMES.night));
    expect(l.dark).toBe(1);
    expect(1 - l.light.k).toBeGreaterThanOrEqual(0.25);
    expect(1 - l.light.k).toBeLessThanOrEqual(0.3);
    expect(l.light.tint[2]).toBeGreaterThan(l.light.tint[0]);
    expect(l.lights).toBe(1);
    expect(l.fire).toBeGreaterThan(mapLook(at(DAY_TIMES.noon)).fire);
    const o = overlayShade(l);
    expect(o.a).toBeGreaterThan(0.25);
    expect(o.a).toBeLessThanOrEqual(0.32);
    expect(o.c[2]).toBeGreaterThan(o.c[0]);
  });

  it('dawn and dusk: the sun low, a soft warm glow (red over blue), the first lights coming on', () => {
    for (const t of [DAY_TIMES.dawn, DAY_TIMES.dusk]) {
      const l = mapLook(at(t));
      expect(l.dark).toBeGreaterThan(0.05);
      expect(l.dark).toBeLessThan(0.35);
      expect(l.warm).toBeGreaterThan(0.9);
      expect(l.light.tint[0]).toBeGreaterThan(l.light.tint[2]);
      expect(l.lights).toBeGreaterThan(0);
      expect(l.lights).toBeLessThan(1);
    }
  });

  it('changes smoothly: no step bigger than a few percent between ticks over a whole day', () => {
    let prev = mapLook(game(0));
    for (let t = 1; t <= 120 * TICKS_PER_SECOND; t++) {
      const l = mapLook(game(t));
      expect(Math.abs(l.light.k - prev.light.k)).toBeLessThan(0.03);
      expect(Math.abs(l.warm - prev.warm)).toBeLessThan(0.05);
      prev = l;
    }
  });

  it('the test override sets the season and the time of day for the look only', () => {
    setLookOverride({ playTicks: 2 * SEASON_TICKS, tick: DAY_TIMES.night * TICKS_PER_SECOND });
    const l = mapLook(game(0));
    expect(l.s).toBeCloseTo(2, 5);
    expect(l.dark).toBe(1);
  });
});

describe('season colours', () => {
  it('each season holds its look, then blends into the next with no jump at the boundary', () => {
    for (let i = 0; i < 4; i++) {
      expect(seasonValue(i * SEASON_TICKS + SEASON_TICKS * 0.3)).toBeCloseTo(i, 5);
      const before = seasonValue((i + 1) * SEASON_TICKS - 1);
      const after = seasonValue((i + 1) * SEASON_TICKS);
      const d = Math.min(Math.abs(after - before), 4 - Math.abs(after - before));
      expect(d).toBeLessThan(0.01);
    }
  });

  it('the ramp changes blend smoothly at a boundary and match the art lab colours at a season height', () => {
    const near = rampDeltas(0.99);
    const at1 = rampDeltas(1);
    let most = 0;
    for (let i = 0; i < at1.length; i++) most = Math.max(most, Math.abs(near[i] - at1[i]));
    expect(most).toBeLessThan(0.02);
    // autumn: the forest turns orange (more red than green), its red crowns redder still
    const forest = RAMP_IDS.findIndex((r) => r.glsl === 'FOREST');
    const red = RAMP_IDS.findIndex((r) => r.glsl === 'FOREST_RED');
    const aut = rampDeltas(2);
    expect(aut[forest * 12 + 2 * 3]).toBeGreaterThan(aut[forest * 12 + 2 * 3 + 1]);
    expect(aut[red * 12 + 2 * 3]).toBeGreaterThan(0);
    // summer grass is straw: redder than spring's
    const grass = RAMP_IDS.findIndex((r) => r.glsl === 'GRASS');
    expect(rampDeltas(1)[grass * 12 + 6]).toBeGreaterThan(rampDeltas(0)[grass * 12 + 6]);
    expect(farDeltas(2)).toHaveLength(27);
  });

  it('snow follows the sim: the smooth line floors to sim rows, and the ice and tundra snow fade in over winter start', () => {
    for (let t = 0; t < 8 * SEASON_TICKS; t += 37) {
      expect(Math.abs(snowRowsSmooth(t, H) - snowRowsAt(t, H))).toBeLessThan(1);
    }
    expect(winterLook(3 * SEASON_TICKS)).toBe(0);
    expect(winterLook(3 * SEASON_TICKS + 10 * TICKS_PER_SECOND)).toBe(1);
    expect(winterLook(2 * SEASON_TICKS)).toBe(0);
    const w = mapLook(game(3.5 * SEASON_TICKS));
    expect(w.iceRows).toBe(iceRowsFor(H));
    expect(w.snowRows).toBeGreaterThan(0);
    expect(SEASON.startIndex).toBe(0);
  });
});

describe('the night leaves labels, borders and the HUD alone', () => {
  it('labels drawn on the world layer are held and drawn after on the overlay, with their own transform', () => {
    const calls: string[] = [];
    const ctx = (name: string) =>
      ({
        globalAlpha: 0.5,
        font: '10px x',
        textAlign: 'center',
        textBaseline: 'top',
        getTransform: () => ({ a: 2 }),
        setTransform: () => calls.push(`${name}:transform`),
        save: () => calls.push(`${name}:save`),
        restore: () => calls.push(`${name}:restore`),
      }) as unknown as CanvasRenderingContext2D;
    const world = ctx('world');
    const main = ctx('main');
    expect(holdLabel(world, () => calls.push('drawn'))).toBe(false);
    holdLabels(world);
    expect(holdingLabels(world)).toBe(true);
    expect(holdLabel(main, () => calls.push('main now'))).toBe(false);
    expect(holdLabel(world, (c) => calls.push(c === main ? 'held on main' : 'held on world'))).toBe(true);
    expect(calls).not.toContain('held on main');
    expect(drawHeldLabels(main)).toBe(1);
    expect(calls).toContain('held on main');
    expect(holdingLabels(world)).toBe(false);
  });

  it('every label the world art draws asks the sink first (halo text, level chips, troop pills, fleet counts, supply labels)', () => {
    const src = (p: string) => readFileSync(new URL(`../src/client/${p}`, import.meta.url), 'utf8');
    expect(src('render/common.ts')).toMatch(/export function haloText[^]*?holdLabel\(ctx/);
    expect(src('art/detailed/buildings.ts')).toMatch(/export function levelPill[^]*?holdLabel\(ctx/);
    expect(src('render/troopIcons.ts')).toMatch(/export function troopPill\([^]*?holdLabel\(ctx/);
    expect(src('render/unitIcons.ts')).toMatch(/export function drawFleetCount[^]*?holdLabel\(ctx/);
    expect(src('art/detailed/supplyArt.ts')).toMatch(/export function supplyLabel[^]*?holdLabel\(ctx/);
  });

  it('the renderer shades only the world layer, then draws names, labels, fronts and the HUD layers on the overlay', () => {
    const r = readFileSync(new URL('../src/client/renderer.ts', import.meta.url), 'utf8');
    const shade = r.indexOf("globalCompositeOperation = 'source-atop'");
    expect(shade).toBeGreaterThan(0);
    // world art on the world layer
    for (const call of ['this.buildings.draw(wctx', 'this.units.draw(wctx', 'this.supply.drawGround(wctx']) expect(r).toContain(call);
    // labels and the rest after the shade, on the overlay
    for (const call of ['drawHeldLabels(ctx)', 'this.names.draw(ctx', 'this.fronts.draw(ctx', 'this.lights.draw(ctx', 'this.overlays.capitals(ctx']) {
      expect(r.lastIndexOf(call)).toBeGreaterThan(shade);
    }
    for (const call of ['this.fronts.drawLines(ctx', 'this.overlays.rings(ctx']) expect(r).toContain(call);
  });

  it('the map shader shades the ground before the nations, so the border line and band keep their day colours', () => {
    const fs = mapFragmentShader('ground');
    const shade = fs.indexOf('col = shadeDay(col);');
    expect(shade).toBeGreaterThan(0);
    expect(fs.indexOf('// ---- nations')).toBeGreaterThan(shade);
    expect(fs.indexOf('// ---- borders')).toBeGreaterThan(shade);
    expect(fs).toContain('tameSnow(dayCol)');
    for (const st of ['today', 'pixel', 'muted'] as const) expect(mapFragmentShader(st)).toContain('col = shadeDay(col);');
    const g = groundFragmentShader('ground');
    expect(g).toContain('uniform vec3 uRampD[');
    expect(g).toContain('return snowOver(c, gter, tq, ap);');
    expect(g).toContain('iceCov(q) > dth');
  });
});

describe('night lights', () => {
  it('only cities, ports, factories and forts are lit; counts are capped', () => {
    expect(lightKindOf('city', false)).toBe('city');
    expect(lightKindOf('city', true)).toBe('capital');
    for (const t of ['port', 'factory', 'fort']) expect(lightKindOf(t, false)).toBe(t);
    for (const t of ['farm', 'mine', 'airfield']) expect(lightKindOf(t, false)).toBeNull();
    const n = new NightLights();
    n.begin(true);
    for (let i = 0; i < LIGHT_CAPS.markers + 50; i++) n.addMarker({ kind: 'city', level: 1, seed: i, tile: i, x: 0, y: 0, size: 4 });
    expect(n.markers).toHaveLength(LIGHT_CAPS.markers);
    n.begin(false);
    n.addShip({ x: 0, y: 0, angle: 0, len: 10 });
    expect(n.ships).toHaveLength(0);
  });
});
