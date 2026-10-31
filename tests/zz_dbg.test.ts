import { it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { spawnWarshipAt } from '../src/sim/units';
import { warSet } from '../src/sim/naval2';
import { claimRect, makeFlatGame } from './helpers';
it('dbg', () => {
  const s = makeFlatGame(80, 40, 3, { human: true, seed: 4 });
  const at = (x: number, y: number) => y * 80 + x;
  for (let y = 20; y < 40; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(x, y)] = 0;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 39, 19);
  claimRect(s, 2, 40, 0, 79, 19);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  for (const p of s.players) { if (p.id) { p.techs.push('navigation'); p.troops = { infantry: 60000, armor: 0, artillery: 0 }; } }
  const b = spawnWarshipAt(s, 1, at(20, 19), at(30, 30));
  b.stance = 'bombard';
  const a = spawnWarshipAt(s, 1, at(20, 19), at(55, 30));
  console.log(applyAction(s, 1, { type: 'attack', tile: at(40, 5), troops: { infantry: 20000, armor: 0, artillery: 0 } }));
  for (let k = 0; k < 100; k++) { tick(s); if (k % 10 === 0) console.log(k, b.state, b.station, a.state, a.station, a.x.toFixed(1), a.y.toFixed(1), a.cargo, [...warSet(s)].join()); }
});
