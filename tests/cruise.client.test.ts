// Cruise missiles on the client: the ship card's button and its reasons, the target check, the alert to the target
// nation, and the detailed style's launch timeline and models (art/detailed/cruise.ts).
import { describe, expect, it } from 'vitest';
import { CRUISE, UNITS } from '../src/sim/config';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { spawnWarshipAt } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { GameState, Unit } from '../src/sim/types';
import { cruiseButton, cruiseClick, cruiseTarget } from '../src/client/cruise';
import { alertFromEvent } from '../src/client/alerts';
import { CRUISE_STAGES, CRUISE_TIMES, cruiseModel, cruisePhase } from '../src/client/art/detailed/cruise';
import { rasterize, solidCount } from '../src/client/art/detailed/bake';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

function game(): { s: GameState; ship: Unit } {
  const s = makeFlatGame(120, 60, 2, { human: true, seed: 3 });
  for (let y = 30; y < 60; y++) for (let x = 0; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 59, 29);
  claimRect(s, 2, 60, 0, 119, 29);
  s.humanId = 1;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.oil = 1e5;
    p.techs.push('navigation');
  }
  const ship = spawnWarshipAt(s, 1, at(s, 30, 29), at(s, 70, 32));
  return { s, ship };
}

describe('the Cruise missile button', () => {
  it('stays hidden far from Naval Mastery, then says plainly why it is off', () => {
    const { s, ship } = game();
    const me = s.players[1];
    expect(cruiseButton(s, me, [ship.id]).show).toBe(false);
    me.techs.push('battleships');
    const b = cruiseButton(s, me, [ship.id]);
    expect(b).toMatchObject({ show: true, ok: false, why: 'Needs Naval Mastery' });
    me.techs.push('navalMastery');
    expect(cruiseButton(s, me, [ship.id]).ok).toBe(true);
    ship.cruiseReady = s.tick + 12 * 10;
    expect(cruiseButton(s, me, [ship.id]).why).toBe('Reloading 12 s');
    ship.cruiseReady = undefined;
    me.gold = 10;
    expect(cruiseButton(s, me, [ship.id]).why).toBe('Not enough gold');
    expect(cruiseButton(s, me, [ship.id]).line).toContain(`${UNITS.cruiseMissile.gold} gold, ${UNITS.cruiseMissile.oil} oil`);
  });

  it('a click fires from the nearest loaded ship in reach, else says why', () => {
    const { s, ship } = game();
    const me = s.players[1];
    me.techs.push('navalMastery');
    const far = spawnWarshipAt(s, 1, at(s, 30, 29), at(s, 10, 50));
    const a = cruiseClick(s, me, [far.id, ship.id], at(s, 70, 20));
    expect(a).toEqual({ type: 'cruiseMissile', ship: ship.id, tile: at(s, 70, 20) });
    const t = cruiseTarget(s, me, [ship.id], at(s, 70, 20));
    expect(t.ok).toBe(true);
    expect(t.radius).toBe(CRUISE.radius);
    expect(cruiseClick(s, me, [ship.id], at(s, 115, 1))).toMatch(/^Too far/);
    expect(cruiseClick(s, me, [ship.id], at(s, 55, 20))).toBe('That is your own land');
  });
});

describe('cruise missile alert', () => {
  it('tells the target nation a cruise missile is incoming', () => {
    const { s } = game();
    const me = s.players[2];
    const e = { kind: 'missile' as const, message: `${s.players[1].name} launched a cruise missile at ${me.name}`, players: [1, 2], tile: 5, tick: 0 };
    const a = alertFromEvent(s, me, e as never);
    expect(a?.kind).toBe('incoming');
    expect(a?.text).toBe(`Cruise missile incoming from ${s.players[1].name}'s warship`);
  });
});

describe('the launch animation (detailed style)', () => {
  it('pops up, pitches over, unfolds, drops the booster, cruises and dives, in order, landing with the sim', () => {
    const flight = 2500;
    const names: string[] = [];
    let stage = -1;
    for (let e = 0; e <= flight; e += 20) {
      const p = cruisePhase(e, flight - e);
      if (names[names.length - 1] !== p.name) names.push(p.name);
      if (p.name !== 'dive') expect(p.stage).toBeGreaterThanOrEqual(stage);
      stage = p.stage;
    }
    expect(names).toEqual(['pop-up', 'pitch', 'unfold', 'cruise', 'dive']);
    expect(cruisePhase(0, flight).lag).toBe(0); // the climb starts over the ship
    expect(cruisePhase(flight, 0)).toMatchObject({ alt: 0, lag: 1 }); // and it hits where the sim's missile hits
    expect(cruisePhase(CRUISE_TIMES.pop + CRUISE_TIMES.pitch + CRUISE_TIMES.unfold + 10, 1000).dropMs).toBeGreaterThan(0);
    // a short shot squeezes the whole launch into its flight
    expect(cruisePhase(560, 40).name).toBe('dive');
    expect(cruisePhase(100, 500).name).toBe('pop-up');
    expect(cruisePhase(450, 150).name).toBe('cruise');
  });

  it('every stage bakes to a visible model, the vertical one standing taller than wide', () => {
    for (const st of CRUISE_STAGES) {
      const b = rasterize(cruiseModel(st.pitch, st.wings, st.booster), 2, 0, { facings: 32, owner: [64, 160, 255] });
      expect(solidCount(b)).toBeGreaterThan(20);
    }
    const up = rasterize(cruiseModel(90, 0, true), 2, 0, { facings: 32, owner: [64, 160, 255] });
    expect(up.h).toBeGreaterThan(up.w);
  });
});
