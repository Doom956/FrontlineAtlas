// The tutorial fix round (a real play-through found these): the island is an island, the frozen diplomacy AIs answer
// and the war (and Peace) lasts as long as the player takes, the defense chapter's tanks meet the traps, a razed supply
// hub still cuts, the seasons jump far enough in, Air and Supply finish with any salvo size, and the attacker reads
// "You cut ..." for a supply cut.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { tick } from '../src/sim/sim';
import { buildingAt } from '../src/sim/buildings';
import { areAllied } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { seasonAt, snowMaxRows, snowRowsAt, playTicks } from '../src/sim/seasons';
import { hubDamaged, supplyNetworkOf } from '../src/sim/supplylines';
import { activeTreaties, canOfferPeace } from '../src/sim/treaty';
import {
  createTutorialGame,
  tutorialAccept,
  tutorialEnemyAttack,
  tutorialEnemyTanks,
  tutorialFinish,
  tutorialFreeze,
  tutorialGrant,
  tutorialHitHub,
  tutorialOfferPeace,
  tutorialPlace,
  tutorialPlayer,
  tutorialSetSeason,
  tutorialStart,
  tutorialTile,
  tutorialWake,
  tutorialWeaken,
} from '../src/sim/tutorialScenario';
import { isWater } from '../src/sim/types';
import type { Action, GameState } from '../src/sim/types';
import { AIR_CHAPTER, ARMOR_CHAPTER, DEFENSE_CHAPTER, DIPLOMACY_CHAPTER, PUSH_TILES, SUPPLY_CHAPTER } from '../src/client/tutorial/chapters';
import { QUICK_TUTORIAL } from '../src/client/tutorial/steps';
import { stepTarget, targetSelectors, TutorialRunner, type TutorialApi, type TutorialChapter, type TutorialUi } from '../src/client/tutorial/engine';

const UI: TutorialUi = { attackShare: 0.3, openPanel: null, researchTab: 'research', selectedUnits: 0, buildMode: null, mode: 'none', aiming: null, selectedBuildings: 0, selectedTile: -1, nationCard: 0, buildCount: 1, paused: false, speed: 1 };
function apiFor(s: GameState): TutorialApi {
  return {
    state: () => s,
    me: () => s.players[s.humanId],
    grant: (g) => tutorialGrant(s, s.humanId, g),
    wake: (ids, opts) => tutorialWake(s, ids, opts),
    freeze: (ids) => tutorialFreeze(s, ids),
    tile: (key) => tutorialTile(s, key),
    player: (r) => tutorialPlayer(s, r),
    weaken: (id, troops) => tutorialWeaken(s, id, troops),
    enemyAttack: (id) => tutorialEnemyAttack(s, id),
    enemyTanks: (id, tile) => tutorialEnemyTanks(s, id, tile),
    accept: (id) => tutorialAccept(s, id),
    offerPeace: (id) => tutorialOfferPeace(s, id),
    hitHub: (owner, tile) => tutorialHitHub(s, owner, tile, s.humanId),
    bombSalvoAtLeast: () => {},
    finish: () => tutorialFinish(s, s.humanId),
    startNow: () => tutorialStart(s),
    openPanel: () => {},
    centre: () => {},
  };
}
const ok = (s: GameState, a: Action): void => expect(applyAction(s, s.humanId, a)).toMatchObject({ ok: true });
/** Runs the runner over `seconds` of game time (checked 5 times a second, as the controller does). */
function run(s: GameState, r: TutorialRunner, seconds: number, ui = UI, each?: () => void): void {
  for (let t = 0; t < seconds * 10; t++) {
    tick(s);
    if (t % 2 === 0) r.update(s, s.players[s.humanId], ui);
    if (each && t % 20 === 0) each();
  }
}
const stepId = (r: TutorialRunner): string => (r.finished ? 'FINISHED' : r.step!.id);
/** Moves a runner to the step `id` with Next (the earlier steps skipped). */
function at(ch: TutorialChapter, s: GameState, id: string): TutorialRunner {
  const r = new TutorialRunner(ch, apiFor(s));
  r.update(s, s.players[s.humanId], UI);
  while (r.step && r.step.id !== id) {
    r.next();
    r.update(s, s.players[s.humanId], UI);
  }
  return r;
}

describe('tutorial map and scenario fixes', () => {
  it('the navy island lies in open water, with its City on the far shore', () => {
    const s = createTutorialGame(undefined, 'navy');
    const w = s.map.width;
    for (let x = 132; x < 150; x++) expect(isWater(s.map.terrain[64 * w + x]), `x ${x}`).toBe(true);
    // water round the island on every side
    for (const [x, y] of [[166, 30], [166, 100], [190, 64], [199, 0]]) expect(isWater(s.map.terrain[y * w + x]), `${x},${y}`).toBe(true);
    const city = buildingAt(s, tutorialTile(s, 'islandCity'));
    expect(city?.type).toBe('city');
    expect(city?.owner).toBe(tutorialPlayer(s, 'islanders'));
    expect(tutorialTile(s, 'islandCity') % w).toBeGreaterThan(170);
  });

  it('the basics tribe lies straight north of the suggested start', () => {
    const s = createTutorialGame();
    const w = s.map.width;
    const [hx, hy] = [tutorialTile(s, 'spawn') % w, (tutorialTile(s, 'spawn') / w) | 0];
    const [tx, ty] = [tutorialTile(s, 'tribe') % w, (tutorialTile(s, 'tribe') / w) | 0];
    expect(hy - ty).toBeGreaterThan(4 * Math.abs(tx - hx));
    expect(QUICK_TUTORIAL.steps.find((x) => x.id === 'tribe')!.text).toMatch(/north\b/);
    expect(QUICK_TUTORIAL.steps.find((x) => x.id === 'tribe')!.text).not.toMatch(/north-east/);
  });

  it('season jumps land inside the season; winter far enough in that the snow is down', () => {
    const s = createTutorialGame(undefined, 'seasons');
    tutorialSetSeason(s, 3, 0.62);
    expect(seasonAt(s).season).toBe('winter');
    expect(snowRowsAt(playTicks(s), s.map.height)).toBe(snowMaxRows(s.map.height));
    tutorialSetSeason(s, 1, 0.2);
    expect(seasonAt(s).season).toBe('summer');
    tutorialSetSeason(s, 0);
    expect(seasonAt(s).season).toBe('spring');
  });

  it('the helpers are deterministic (same calls, same hash)', () => {
    const go = (): number => {
      const s = createTutorialGame(undefined, 'defense');
      ok(s, { type: 'build', building: 'fort', tile: tutorialTile(s, 'fort') });
      tutorialFinish(s, s.humanId);
      tutorialWake(s, [], { hostile: true });
      tutorialEnemyTanks(s, tutorialPlayer(s, 'foe'), tutorialTile(s, 'tanks'));
      for (let k = 0; k < 100; k++) tick(s);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});

describe('Diplomacy chapter: no stall at a slow pace', () => {
  it('the frozen AIs answer the player; the war and the peace offer outlast a slow player', () => {
    const s = createTutorialGame(undefined, 'diplomacy');
    const me = s.players[s.humanId];
    const friend = tutorialPlayer(s, 'friend');
    const enemy = tutorialPlayer(s, 'enemy');
    const quiet = tutorialPlayer(s, 'quiet');
    expect(s.tutorial!.frozen).toEqual(expect.arrayContaining([friend, enemy, quiet]));
    const r = at(DIPLOMACY_CHAPTER, s, 'ally');
    // 45 s on the alliance step before doing anything
    run(s, r, 45);
    expect(stepId(r)).toBe('ally');
    const t = stepTarget(r.step, s);
    expect(targetSelectors(t)).toContain(`[data-test="lb-row-${friend}"]`);
    ok(s, { type: 'requestAlliance', to: friend });
    run(s, r, 3);
    expect(areAllied(s, me.id, friend)).toBe(true);
    expect(stepId(r)).toBe('peace');
    // 45 s on the peace step: the enemy still fights and an offer is waiting the whole time (a new one after expiry)
    for (let k = 0; k < 45; k++) {
      run(s, r, 1);
      expect(canOfferPeace(s, me.id, enemy).ok || (s.treatyOffers ?? []).some((o) => o.from === enemy && o.to === me.id), `second ${k}`).toBe(true);
    }
    expect((s.treatyOffers ?? []).some((o) => o.from === enemy && o.to === me.id)).toBe(true);
    // a refusal brings a fresh offer, which the player then accepts
    ok(s, { type: 'answerTreaty', from: enemy, accept: false });
    run(s, r, 2);
    expect((s.treatyOffers ?? []).some((o) => o.from === enemy && o.to === me.id)).toBe(true);
    ok(s, { type: 'answerTreaty', from: enemy, accept: true });
    run(s, r, 1);
    expect(stepId(r)).toBe('pact');
    ok(s, { type: 'offerPact', to: quiet, seconds: 180 });
    run(s, r, 3);
    expect(r.finished).toBe(true);
    expect(activeTreaties(s, me.id).map((x) => x.kind).sort()).toEqual(['pact', 'peace']);
  });

  it('the player may offer peace instead: the enemy accepts it', () => {
    const s = createTutorialGame(undefined, 'diplomacy');
    const enemy = tutorialPlayer(s, 'enemy');
    const r = at(DIPLOMACY_CHAPTER, s, 'peace');
    s.treatyOffers = []; // the player acts before the enemy's offer: its own offer goes out
    ok(s, { type: 'offerPeace', to: enemy, theyGive: 'none', youGive: 'none' });
    run(s, r, 3);
    expect(stepId(r)).toBe('pact');
  });
});

describe('Air and Supply finish with any salvo size', () => {
  for (const count of [1, 0]) {
    it(`Air: salvo ${count === 0 ? 'All' : 'x1'}, again whenever the wing is home`, () => {
      const s = createTutorialGame(undefined, 'air');
      const r = at(AIR_CHAPTER, s, 'bomb');
      // the wing step was skipped: the bomb step refills the wing to 3
      const af = (): number => [...s.buildings.values()].filter((b) => b.owner === s.humanId && b.type === 'airfield').reduce((n, b) => n + b.bombers, 0);
      if (af() === 0) {
        ok(s, { type: 'build', building: 'airfield', tile: tutorialTile(s, 'home') - 2 });
        tutorialFinish(s, s.humanId);
        tick(s);
        r.update(s, s.players[s.humanId], UI);
        const k = AIR_CHAPTER.steps.findIndex((x) => x.id === 'bomb');
        AIR_CHAPTER.steps[k].onEnter!(apiFor(s));
      }
      expect(af()).toBeGreaterThanOrEqual(3);
      const send = (): void => {
        if (s.units.some((u) => u.owner === s.humanId && u.type === 'bomber') || af() === 0 || !buildingAt(s, tutorialTile(s, 'fort'))) return;
        applyAction(s, s.humanId, { type: 'bomb', airfield: -1, tile: tutorialTile(s, 'fort'), count });
      };
      send();
      run(s, r, 120, UI, send);
      expect(r.finished).toBe(true);
    });
    it(`Supply: salvo ${count === 0 ? 'All' : 'x1'} cuts the Fort off`, () => {
      const s = createTutorialGame(undefined, 'supply');
      const r = at(SUPPLY_CHAPTER, s, 'bomb');
      const foe = tutorialPlayer(s, 'foe');
      const city = tutorialTile(s, 'city');
      const send = (): void => {
        if (s.units.some((u) => u.owner === s.humanId && u.type === 'bomber') || !buildingAt(s, city)) return;
        applyAction(s, s.humanId, { type: 'bomb', airfield: -1, tile: city, count });
      };
      send();
      run(s, r, 90, UI, send);
      expect(stepId(r)).toBe('FINISHED');
      // the enemy heard its supply was cut at the City
      expect(s.events.some((e) => e.kind === 'supplyHubDamaged' && e.players[0] === foe && e.supply?.hub === city && e.supply.sources.length > 0)).toBe(true);
      expect(supplyNetworkOf).toBeTypeOf('function');
    });
  }

  it('Supply: a razed City is put back damaged, so the cut stands', () => {
    const s = createTutorialGame(undefined, 'supply');
    const foe = tutorialPlayer(s, 'foe');
    const city = tutorialTile(s, 'city');
    for (let k = 0; k < 30; k++) tick(s);
    const r = at(SUPPLY_CHAPTER, s, 'cut');
    applyAction(s, s.humanId, { type: 'admin', op: 'deleteBuilding', tile: city } as Action);
    if (buildingAt(s, city)) s.buildings.delete(s.map.building[city] - 1), (s.map.building[city] = 0);
    run(s, r, 3);
    expect(buildingAt(s, city)?.type).toBe('city');
    expect(hubDamaged(s, foe, city)).toBe(true);
    run(s, r, 2);
    expect(r.finished).toBe(true);
    expect(tutorialPlace).toBeTypeOf('function');
  });
});

describe('Armor and Defense goals are reachable and need the player', () => {
  it('Armor: the push goal is one or two spearheads away', () => {
    expect(PUSH_TILES).toBeLessThanOrEqual(12);
    expect(ARMOR_CHAPTER.steps.find((x) => x.id === 'spearhead')!.text).toMatch(/again to launch/);
  });

  it('Defense: the enemy tanks hit the traps; the step waits for the player to strike back', () => {
    const s = createTutorialGame(undefined, 'defense');
    ok(s, { type: 'build', building: 'fort', tile: tutorialTile(s, 'fort') });
    tutorialFinish(s, s.humanId);
    tutorialGrant(s, s.humanId, { techs: ['tankTraps'] });
    const r = at(DEFENSE_CHAPTER, s, 'tanks');
    const foe = tutorialPlayer(s, 'foe');
    const tiles0 = s.players[s.humanId].tiles;
    let trapped = false;
    run(s, r, 20, UI, () => {
      if (s.units.some((u) => u.owner === foe && u.type === 'tankDivision' && (u.trapLoss ?? 0) > 0)) trapped = true;
    });
    expect(s.players[s.humanId].tiles).toBeLessThan(tiles0); // the tanks took land
    expect(s.events.some((e) => e.kind === 'spearheadEnded' && e.players.includes(foe))).toBe(true);
    expect(trapped || s.events.some((e) => e.kind === 'spearheadEnded' && /troops lost/.test(e.message))).toBe(true);
    expect(stepId(r)).toBe('tanks'); // no input yet: the step waits
    // the player wins land back
    const w = s.map.width;
    let lost = -1;
    for (let i = 0; i < s.map.owner.length && lost < 0; i++) if (s.map.owner[i] === foe && i % w <= 60) lost = i;
    ok(s, { type: 'attack', tile: lost, troops: { infantry: 4000, armor: 0, artillery: 0 } });
    run(s, r, 3);
    expect(r.finished).toBe(true);
  });
});

describe('supply cut news, as each side reads it', () => {
  it('the nation that cut the supply reads "You cut", the victim "Your supply is cut"', () => {
    const s = createTutorialGame(undefined, 'supply');
    const foe = tutorialPlayer(s, 'foe');
    for (let k = 0; k < 30; k++) tick(s);
    expect(tutorialHitHub(s, foe, tutorialTile(s, 'city'), s.humanId)).toBe(true);
    for (let k = 0; k < 20; k++) tick(s);
    const mine = s.events.filter((e) => e.players.length === 1 && e.players[0] === s.humanId && /supply/i.test(e.message));
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) expect(e.message, e.message).not.toMatch(/^Your /);
    expect(mine.some((e) => e.message.startsWith(`You cut ${s.players[foe].name}'s supply`))).toBe(true);
    expect(s.events.some((e) => e.players.length === 1 && e.players[0] === foe && /^Your .*supply is cut/.test(e.message))).toBe(true);
  });
});
