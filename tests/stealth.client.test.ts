// The stealth strike on the client: the airfield card's button and its reasons, the target check, the alert and the
// toasts, the incoming list (only once the target may see it), and the detailed style's flying wing.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { STEALTH, TICKS_PER_SECOND } from '../src/sim/config';
import { newId } from '../src/sim/state';
import { updateUnits } from '../src/sim/units';
import { applyAction } from '../src/sim/actions';
import type { Building, BuildingType, GameEvent, GameState } from '../src/sim/types';
import { stealthButton, stealthClick, stealthPriceText, stealthTarget } from '../src/client/stealth';
import { alertFromEvent } from '../src/client/alerts';
import { strikeToastText } from '../src/client/strikes';
import { isIncoming } from '../src/client/forces';
import { unitModel } from '../src/client/art/detailed/models';
import { rasterize, solidCount } from '../src/client/art/detailed/bake';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function game(): { s: GameState; af: Building } {
  const s = makeFlatGame(300, 40, 2, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 149, 39);
  claimRect(s, 2, 150, 0, 299, 39);
  s.humanId = 1;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.oil = 1e5;
    p.techs.push('flight');
  }
  const af = addBuilding(s, 'airfield', 1, at(s, 100, 20));
  return { s, af };
}

describe('the Stealth strike button', () => {
  it('stays hidden far from Air Mastery, then says plainly why it is off, with the price', () => {
    const { s, af } = game();
    const me = s.players[1];
    expect(stealthButton(s, me, af.tile).show).toBe(false);
    me.techs.push('jetEngines');
    expect(stealthButton(s, me, af.tile)).toMatchObject({ show: true, ok: false, why: 'Needs Air Mastery' });
    expect(stealthButton(s, me, af.tile).line).toContain(stealthPriceText(s, 1));
    expect(stealthPriceText(s, 1)).toMatch(/ gold, 100 oil$/);
    me.techs.push('airMastery');
    expect(stealthButton(s, me, af.tile).ok).toBe(true);
    me.stealthReady = s.tick + 45 * TICKS_PER_SECOND;
    expect(stealthButton(s, me, af.tile).why).toBe('Recharging 45 s');
    me.stealthReady = undefined;
    me.gold = 10;
    expect(stealthButton(s, me, af.tile).why).toBe('Not enough gold');
    me.gold = 1e6;
    expect(applyAction(s, 1, { type: 'stealthStrike', airfield: af.tile, tile: at(s, 200, 20) }).ok).toBe(true);
    expect(stealthButton(s, me, af.tile).why).toBe('Stealth bomber in the air');
  });

  it('the target check names what it would wreck and the SAM sites it slips past', () => {
    const { s, af } = game();
    const me = s.players[1];
    me.techs.push('airMastery');
    addBuilding(s, 'factory', 2, at(s, 220, 20));
    addBuilding(s, 'sam', 2, at(s, 200, 25));
    const t = stealthTarget(s, me, af.tile, at(s, 220, 20));
    expect(t).toMatchObject({ ok: true, enemyBuildings: 1, victim: 2, samSites: 1 });
    expect(stealthClick(s, me, af.tile, at(s, 220, 20))).toEqual({ type: 'stealthStrike', airfield: af.tile, tile: at(s, 220, 20) });
    expect(stealthClick(s, me, af.tile, at(s, 120, 20))).toBe('That is your own land');
  });
});

describe('what the players are told', () => {
  it('the target gets an alert and a toast only at the warning; the owner gets its own toasts', () => {
    const { s, af } = game();
    s.players[1].techs.push('airMastery');
    addBuilding(s, 'factory', 2, at(s, 250, 20));
    expect(applyAction(s, 1, { type: 'stealthStrike', airfield: af.tile, tile: at(s, 250, 20) }).ok).toBe(true);
    const u = s.units.find((q) => q.type === 'stealthBomber')!;
    expect(isIncoming(s, 2, u)).toBe(false); // not seen yet
    const warned = (): GameEvent | undefined => s.events.find((e) => e.message.startsWith('A stealth bomber of'));
    for (let k = 0; k < 200 && !warned(); k++) {
      updateUnits(s);
      s.tick++;
    }
    expect(isIncoming(s, 2, u)).toBe(true);
    const e = warned()!;
    const me = s.players[1];
    const them = s.players[2];
    expect(alertFromEvent(s, them, e)).toMatchObject({ kind: 'incoming', text: `Stealth bomber of ${me.name} over your land: bombs in ${STEALTH.revealSeconds} s` });
    expect(alertFromEvent(s, me, e)).toBeNull();
    expect(strikeToastText(e, them)?.kind).toBe('bad');
    expect(strikeToastText(e, me)).toMatchObject({ kind: 'info', text: `Your stealth bomber is over ${them.name}: bombs in ${STEALTH.revealSeconds} s` });
    for (let k = 0; k < 200 && !s.events.some((q) => q.message.startsWith('Stealth strike by')); k++) {
      updateUnits(s);
      s.tick++;
    }
    const hit = s.events.find((q) => q.message.startsWith('Stealth strike by'))!;
    expect(strikeToastText(hit, me)?.text).toMatch(new RegExp(`^Stealth strike on ${them.name}: 1 building destroyed`));
    expect(strikeToastText(hit, them)?.text).toMatch(new RegExp(`^Stealth strike by ${me.name}: 1 building destroyed`));
  });
});

describe('the flying wing (detailed style)', () => {
  it('draws something solid, with no propellers and no glowing nozzles', () => {
    const um = unitModel('stealthBomber', 0);
    const r = rasterize(um.model, 2, 0, { facings: 32, owner: [64, 160, 255] });
    expect(solidCount(r)).toBeGreaterThan(200);
    // a flying wing: no fins, no propellers, no glowing nozzles
    expect(um.props.length).toBe(0);
    expect(um.nozzles.length).toBe(0);
  });
});
