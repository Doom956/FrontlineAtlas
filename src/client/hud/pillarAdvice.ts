// Advisor hints that point at a pillar when the situation fits (hud/advisor.ts shows them like its other hints):
//   - the main foe's front runs along a coast and your warships sit on Auto / Hunt: Bombard there
//   - their coast but no warships yet (Navigation and a Port): build some
//   - open plains along the front and divisions only holding: Support front
//   - a stuck front (forts, hills) and airfields with bombers on Idle: Air support
//   - enemy planes over your land and fighters on Idle: Air superiority
// Each is phrased as one line with the click that does it (the Forces drawer, Y).
import { mainFoe, fortifiedShare, openness } from '../../sim/advisor';
import { airMissionOf } from '../../sim/airwings';
import { divisionMode } from '../../sim/armor2';
import { buildingsOf } from '../../sim/buildings';
import { warshipStance } from '../../sim/naval2';
import { unitAllowed } from '../../sim/rules';
import { hasTech } from '../../sim/tech';
import type { GameState, Player } from '../../sim/types';
import { isTribe } from '../compat';
import { isIncoming, unitBuildStatus } from '../forces';
import type { Suggestion } from '../simx';

/** The most fitting pillar hint now, or null. Cheap enough for every few seconds. */
export function pillarAdvice(s: GameState, me: Player): Suggestion | null {
  const { foe, frontTiles } = mainFoe(s, me.id);
  const fp = foe > 0 ? s.players[foe] : undefined;
  const fighting = !!fp && fp.alive && !isTribe(fp) && s.attacks.some((a) => (a.attacker === me.id && a.target === foe) || (a.attacker === foe && a.target === me.id));
  const mine = s.units.filter((u) => u.owner === me.id && u.hp > 0);

  // enemy planes over us and fighters on the ground
  if (unitAllowed(s, 'fighter') && s.units.some((u) => (u.type === 'bomber' || u.type === 'transportPlane') && isIncoming(s, me.id, u))) {
    const idle = buildingsOf(s, me.id, 'airfield').find((b) => b.buildLeft <= 0 && b.fighters > 0 && airMissionOf(s, b) === 'idle');
    if (idle) return { key: 'pillar-superiority', text: 'Enemy planes overhead: set an Airfield to Air superiority (Forces, Y) and its fighters hunt them', drawer: 'forces', tile: idle.tile };
  }
  if (!fighting || !fp || frontTiles.length < 4) return null;

  // a coastal front: warships make the land there cheaper and faster to take
  let coast = 0;
  for (const t of frontTiles) if (s.map.coastal[t]) coast++;
  if (coast >= 2 && unitAllowed(s, 'warship')) {
    const ships = mine.filter((u) => u.type === 'warship');
    if (ships.length && ships.every((u) => warshipStance(u) !== 'bombard' && warshipStance(u) !== 'blockade') && !ships.some((u) => u.state === 3)) {
      return { key: 'pillar-bombard', text: `${fp.name}'s front runs along the coast: select your warships (Shift+W) and pick Bombard, the land there falls faster`, drawer: 'forces' };
    }
    if (!ships.length && hasTech(me, 'navigation') && unitBuildStatus(s, me, 'warship').ok) {
      return { key: 'pillar-navy', text: `${fp.name}'s front runs along the coast: warships shelling it make your attacks there cheaper`, unit: 'warship' };
    }
  }

  // open ground: tank divisions on Support front break through by themselves
  const tanks = mine.filter((u) => u.type === 'tankDivision');
  if (tanks.length && openness(s, frontTiles) > 0.55 && tanks.every((u) => divisionMode(u) === 'hold' && u.state === 0)) {
    return { key: 'pillar-armor', text: `Open ground along ${fp.name}'s front: select your divisions (Shift+A), pick Support front and click the front`, drawer: 'forces' };
  }

  // a stuck front: forts or hills, and bombers waiting at home
  let hills = 0;
  for (const t of frontTiles) if (s.map.terrain[t] === 4 || s.map.terrain[t] === 5) hills++;
  const stuck = fortifiedShare(s, foe, frontTiles) > 0.2 || hills / frontTiles.length > 0.3;
  if (stuck && hasTech(me, 'flight') && unitAllowed(s, 'bomber')) {
    const idle = buildingsOf(s, me.id, 'airfield').find((b) => b.buildLeft <= 0 && b.bombers > 0 && airMissionOf(s, b) === 'idle');
    if (idle) return { key: 'pillar-air', text: `${fp.name}'s front is dug in: set an Airfield to Support front (Forces, Y) and its bombers hit ahead of your attack`, drawer: 'forces' };
  }
  return null;
}
