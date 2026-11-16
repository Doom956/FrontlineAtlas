// Defense row on the map (src/client/fx/defenseFx.ts, src/client/defenseView.ts): flak puffs around enemy planes in
// flak zones, hedgehogs on trap tiles, the card lines and the ring labels. Client only; the state is never written.
import { describe, expect, it } from 'vitest';
import { DefenseFx, PUFF_CAP } from '../src/client/fx/defenseFx';
import { defenseLines, routeFlak, routeFlakText } from '../src/client/defenseView';
import type { Camera } from '../src/client/camera';
import { markBuildingsChanged } from '../src/sim/buildings';
import { hashState } from '../src/sim/hash';
import { newId } from '../src/sim/state';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function add(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function game(): GameState {
  const s = makeFlatGame(80, 40, 2, { human: true, seed: 5 });
  claimRect(s, 1, 0, 0, 39, 39);
  claimRect(s, 2, 40, 0, 79, 39);
  s.players[1].techs.push('fortification', 'flakGuns');
  return s;
}
function cam(zoom: number): Camera {
  const c = { zoom, x: 30, y: 20, viewW: 1200, viewH: 800, mapW: 80, mapH: 40 };
  return {
    ...c,
    visibleTiles: () => ({ x0: 0, y0: 0, x1: 80, y1: 40 }),
    tileToScreen: (x: number, y: number) => ({ x: c.viewW / 2 + (x - c.x) * zoom, y: c.viewH / 2 + (y - c.y) * zoom }),
  } as unknown as Camera;
}
function ctx(): CanvasRenderingContext2D {
  const noop = (): void => {};
  return new Proxy({} as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop),
    set: (t, k, v) => ((t[k as string] = v), true),
  }) as unknown as CanvasRenderingContext2D;
}
const poses = { screenOf: () => null, headingOf: () => null };
function bomber(s: GameState, owner: number, x: number, y: number, target: number): Unit {
  const u = { id: newId(s), type: 'bomber', owner, x, y, target, home: at(s, 70, 20), path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 1 } as Unit;
  s.units.push(u);
  return u;
}

describe('flak puffs', () => {
  it('appear around enemy planes inside a flak zone, capped; none far out or outside a zone; the state stays', () => {
    const s = game();
    const fort = add(s, 'fort', 1, at(s, 30, 20));
    bomber(s, 2, 33, 20, fort.tile);
    const h = hashState(s);
    const fx = new DefenseFx(() => 0.5);
    let drawn = 0;
    for (let t = 0; t < 2000; t += 50) {
      fx.update(s, cam(6), t);
      fx.drawAir(ctx(), s, cam(6), t, poses, 2);
      drawn = Math.max(drawn, fx.drawnPuffs);
    }
    expect(drawn).toBeGreaterThan(3);
    expect(drawn).toBeLessThanOrEqual(PUFF_CAP);
    expect(hashState(s)).toBe(h);
    // far out: nothing
    const far = new DefenseFx(() => 0.5);
    for (let t = 0; t < 1000; t += 50) {
      far.update(s, cam(1), t);
      far.drawAir(ctx(), s, cam(1), t, poses, 2);
    }
    expect(far.drawnPuffs).toBe(0);
    // own planes and planes outside the zone: nothing
    const o = game();
    add(o, 'fort', 1, at(o, 30, 20));
    bomber(o, 2, 60, 20, at(o, 30, 20));
    const none = new DefenseFx(() => 0.5);
    for (let t = 0; t < 1000; t += 50) {
      none.update(o, cam(6), t);
      none.drawAir(ctx(), o, cam(6), t, poses, 2);
    }
    expect(none.drawnPuffs).toBe(0);
  });
});

describe('tank trap marks and texts', () => {
  it('hedgehogs on dug land near a Tank Traps fort from zoom 4; card lines; route flak text', () => {
    const s = game();
    s.players[2].techs.push('fortification', 'tankTraps');
    const f2 = add(s, 'fort', 2, at(s, 46, 20));
    for (let y = 10; y < 30; y++) for (let x = 40; x < 43; x++) s.trench!.dig[at(s, x, y)] = 50;
    const fx = new DefenseFx(() => 0.5);
    fx.drawGround(ctx(), s, cam(3), 0, 1, 2);
    expect(fx.drawnTraps).toBe(0);
    fx.drawGround(ctx(), s, cam(5), 0, 1, 2);
    expect(fx.drawnTraps).toBeGreaterThan(5);
    // a spearhead hits the traps: a dirt burst there for a moment
    s.effects.push({ kind: 'trapHit', x: 41.5, y: 20.5, radius: 1, tick: s.tick });
    fx.update(s, cam(6), 1000);
    fx.drawAir(ctx(), s, cam(6), 1200, poses, 2);
    expect(fx.drawnDirt).toBe(1);
    fx.drawAir(ctx(), s, cam(6), 2000, poses, 2);
    expect(fx.drawnDirt).toBe(0);
    const fort1 = add(s, 'fort', 1, at(s, 20, 20));
    expect(defenseLines(s, fort1)).toEqual(['Flak: 14 tiles, enemy bombs here -35%']);
    expect(defenseLines(s, f2)[0]).toMatch(/^Tank traps: dug-in land within \d+ tiles slows enemy tanks to 40%$/);
    expect(routeFlakText(routeFlak(s, 2, at(s, 70, 20), fort1.tile, 1))).toBe('Enemy flak on the way: bombs about -35%');
    expect(routeFlakText(0.9)).toMatch(/turn back/);
  });
});
