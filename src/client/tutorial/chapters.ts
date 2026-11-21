// The optional tutorial chapters: each one a tiny scripted practice game of 2 to 3 minutes on the tutorial map
// (src/sim/tutorialScenario.ts ChapterSpec sets up the nations, buildings, resources and techs it needs), with 3 to 5
// steps and a win goal, run by the same step runner as the basics. A chapter's last step is its goal; finishing it
// marks the chapter done. Steps grant what they cost (topUp), finish constructions at once (api.finish) and put back a
// target the player destroyed too early (keep), so none can stall.
import { BUILDINGS } from '../../sim/config';
import { areAllied } from '../../sim/diplomacy';
import { arsenalPrice } from '../../sim/procurement';
import { seasonAt } from '../../sim/seasons';
import { hubDamaged, supplyNetworkOf } from '../../sim/supplylines';
import { activeTreaties } from '../../sim/treaty';
import { tutorialPlace, tutorialPlayer, tutorialSetSeason, tutorialTile } from '../../sim/tutorialScenario';
import type { TechId } from '../../sim/types';
import type { GameState, Player } from '../../sim/types';
import type { TutorialApi, TutorialChapter } from './engine';
import { at, attacking, topUp } from './steps';

const owns = (s: GameState, me: Player, type: string): boolean => [...s.buildings.values()].some((b) => b.owner === me.id && b.type === type);
const ownBuildings = (s: GameState, me: Player, type: string) => [...s.buildings.values()].filter((b) => b.owner === me.id && b.type === type);
const unitsOf = (s: GameState, me: Player, type: string): number => s.units.filter((u) => u.owner === me.id && u.hp > 0 && u.type === type).length;
const queued = (s: GameState, me: Player, type: string): boolean => !!s.unitQueue?.some((q) => q.owner === me.id && q.type === type);
const bombers = (s: GameState, me: Player): number => ownBuildings(s, me, 'airfield').reduce((n, b) => n + b.bombers, 0);
const gone = (s: GameState, tile: number): boolean => tile < 0 || !s.map.building[tile];

/** The Arsenal price of an item, topped up (gold, iron and oil). */
function topUpArsenal(api: TutorialApi, tech: TechId): void {
  const p = arsenalPrice(api.state(), api.me().id, tech);
  topUp(api, { gold: p.gold + 200, iron: p.iron + 100, oil: p.oil + 100 });
}
const ordered = (me: Player, tech: TechId): boolean => me.techs.includes(tech) || !!me.procuring?.some((x) => x.tech === tech);

/** Own tiles on the island east of the strait (x >= 144). */
const ISLAND_X = 144;
function islandTiles(s: GameState, me: Player): number {
  const { width: w, owner } = s.map;
  let n = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === me.id && i % w >= ISLAND_X) n++;
  return n;
}
const ISLAND_GOAL = 250;

/** Own land this many columns past the front (x of the push goal tile). */
function reachedX(s: GameState, me: Player): number {
  const { width: w, owner } = s.map;
  let m = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === me.id) m = Math.max(m, i % w);
  return m;
}

/** When a timed step began (game tick), per game. */
const began = new WeakMap<GameState, number>();
const HOLD_SECONDS = 90;

const PLAY = { endTitle: 'Chapter done.', endText: 'Play a game now, or pick another tutorial.' };

export const NAVY_CHAPTER: TutorialChapter = {
  id: 'navy',
  title: 'Navy',
  icon: 'warship',
  blurb: 'Ports, warships and landing on an island',
  minutes: 3,
  ...PLAY,
  steps: [
    {
      id: 'port',
      label: 'Build a Port',
      text: 'Click Port in the bottom bar, then your coast. Ports build ships.',
      target: 'build-port || build-menu-btn',
      tile: at('coast'),
      onEnter: (api) => {
        api.centre(api.tile('home'));
        topUp(api, { gold: BUILDINGS.port.cost + 100 });
      },
      done: (s, me) => owns(s, me, 'port'),
    },
    {
      id: 'ship',
      label: 'Build a warship',
      text: 'Click Forces, then Warship at your Port. Warships guard your coast.',
      target: 'open-forces',
      onEnter: (api) => {
        api.finish(); // the Port stands at once
        topUp(api, { gold: 900, iron: 120, oil: 120 });
      },
      done: (s, me) => unitsOf(s, me, 'warship') > 0 || queued(s, me, 'warship'),
    },
    {
      id: 'land',
      label: 'Land on the island',
      text: 'Click the island across the water. Your troops cross in a transport boat.',
      tile: at('island'),
      onEnter: (api) => {
        api.finish();
        topUp(api, { troops: 12000 });
        api.centre(api.tile('island'));
      },
      done: (s, me) => unitsOf(s, me, 'transport') > 0 || islandTiles(s, me) > 0,
    },
    {
      id: 'island',
      label: 'Take the island',
      text: `Take the island: own ${ISLAND_GOAL} tiles of it. Keep clicking its land.`,
      tile: at('island'),
      done: (s, me) => islandTiles(s, me) >= ISLAND_GOAL,
    },
  ],
};

export const AIR_CHAPTER: TutorialChapter = {
  id: 'air',
  title: 'Air',
  icon: 'plane',
  blurb: 'Airfield, bombers and a SAM site',
  minutes: 3,
  ...PLAY,
  steps: [
    {
      id: 'airfield',
      label: 'Build an Airfield',
      text: 'Click Airfield in the bottom bar, then your land. Bombers fly from it.',
      target: 'build-airfield || build-menu-btn',
      tile: at('home'),
      onEnter: (api) => topUp(api, { gold: BUILDINGS.airfield.cost + 100, iron: BUILDINGS.airfield.iron + 20 }),
      done: (s, me) => owns(s, me, 'airfield'),
    },
    {
      id: 'wing',
      label: 'Buy 3 bombers',
      text: 'Click Forces, then Bomber at your Airfield, 3 times. A wing flies together.',
      target: 'open-forces',
      onEnter: (api) => {
        api.finish();
        topUp(api, { gold: 2500, oil: 300 });
      },
      done: (s, me) => bombers(s, me) >= 3 || unitsOf(s, me, 'bomber') > 0,
    },
    {
      id: 'sam',
      label: 'The SAM site',
      text: 'The enemy SAM site shoots bombers down. That is why you send several.',
      tile: at('sam'),
    },
    {
      id: 'bomb',
      label: 'Send the wing',
      text: 'Click Bomb in the bottom bar, then the enemy Fort.',
      target: 'strike-bomb || open-forces',
      tile: at('fort'),
      onEnter: (api) => api.centre(api.tile('fort')),
      done: (s, me) => unitsOf(s, me, 'bomber') > 0 || gone(s, tutorialTile(s, 'fort')),
    },
    {
      id: 'fort',
      label: 'Knock out the fort',
      text: 'Knock out the Fort. Bombs wreck buildings; a few bombers may fall.',
      tile: at('fort'),
      keep: (api, s, me) => {
        // out of bombers before the Fort fell: a fresh wing
        if (!gone(s, tutorialTile(s, 'fort')) && bombers(s, me) === 0 && unitsOf(s, me, 'bomber') === 0) {
          const af = ownBuildings(s, me, 'airfield')[0];
          if (af) api.grant({ gold: 1500, oil: 200 });
          if (af) af.bombers += 3;
        }
      },
      done: (s) => gone(s, tutorialTile(s, 'fort')),
    },
  ],
};

export const ARMOR_CHAPTER: TutorialChapter = {
  id: 'armor',
  title: 'Armor',
  icon: 'tank',
  blurb: 'Tanks, a division and a broken front',
  minutes: 3,
  ...PLAY,
  steps: [
    {
      id: 'factory',
      label: 'Build a Factory',
      text: 'Click Factory in the bottom bar, then your land. Factories make tank divisions.',
      target: 'build-factory || build-menu-btn',
      tile: at('home'),
      onEnter: (api) => topUp(api, { gold: BUILDINGS.factory.cost + 100, iron: BUILDINGS.factory.iron + 20 }),
      done: (s, me) => owns(s, me, 'factory'),
    },
    {
      id: 'mech',
      label: 'Order Mechanization',
      text: 'Click Research, open the Arsenal tab, and order Mechanization. It unlocks tanks.',
      target: 'open-research',
      onEnter: (api) => {
        api.finish();
        topUpArsenal(api, 'mechanization');
      },
      done: (_s, me) => ordered(me, 'mechanization'),
    },
    {
      id: 'division',
      label: 'Form a division',
      text: 'Click Forces, then Tank division, then your Factory.',
      target: 'open-forces',
      onEnter: (api) => {
        api.finish(); // the order is delivered
        topUp(api, { gold: 1500, iron: 300, oil: 200, armor: 5000 });
      },
      done: (s, me) => unitsOf(s, me, 'tankDivision') > 0 || queued(s, me, 'tankDivision'),
    },
    {
      id: 'push',
      label: 'Break the front',
      text: 'Click your division, then the enemy land at your border. Push 30 tiles in.',
      tile: at('front'),
      onEnter: (api) => {
        api.finish();
        api.weaken(api.player('foe'), 1500); // a weak front: tanks break it
      },
      done: (s, me) => reachedX(s, me) >= (tutorialTile(s, 'push') % s.map.width),
    },
  ],
};

export const DEFENSE_CHAPTER: TutorialChapter = {
  id: 'defense',
  title: 'Defense',
  icon: 'shield',
  blurb: 'A Fort, Tank Traps and a held line',
  minutes: 3,
  ...PLAY,
  steps: [
    {
      id: 'fort',
      label: 'Build a Fort',
      text: 'Click Fort in the bottom bar, then your border. Forts make attackers lose twice as much.',
      target: 'build-fort || build-menu-btn',
      tile: at('fort'),
      onEnter: (api) => {
        api.centre(api.tile('fort'));
        topUp(api, { gold: BUILDINGS.fort.cost + 100, iron: BUILDINGS.fort.iron + 20 });
      },
      done: (s, me) => owns(s, me, 'fort'),
    },
    {
      id: 'traps',
      label: 'Order Tank Traps',
      text: 'Click Research, Arsenal, Defense: order Tank Traps. (Flak, the other pick, shoots bombers.)',
      target: 'open-research',
      onEnter: (api) => {
        api.finish(); // the Fort stands at once
        topUpArsenal(api, 'tankTraps');
      },
      done: (_s, me) => ordered(me, 'tankTraps'),
    },
    {
      id: 'hold',
      label: `Hold ${HOLD_SECONDS} seconds`,
      text: `An attack is coming. Hold your land for ${HOLD_SECONDS} seconds.`,
      tile: at('front'),
      onEnter: (api) => {
        api.finish(); // the traps are delivered
        const foe = api.player('foe');
        api.wake([foe], { hostile: true });
        api.weaken(foe, 30000);
        api.enemyAttack(foe);
        began.set(api.state(), api.state().tick);
      },
      keep: (api, s) => {
        const foe = api.player('foe');
        // a repelled attack is followed by another, so the line is tested for the whole time
        if (!s.attacks.some((a) => a.attacker === foe && a.target === s.humanId)) api.enemyAttack(foe);
      },
      done: (s) => s.tick - (began.get(s) ?? s.tick) >= HOLD_SECONDS * 10,
    },
  ],
};

export const DIPLOMACY_CHAPTER: TutorialChapter = {
  id: 'diplomacy',
  title: 'Diplomacy',
  icon: 'diplomacy',
  blurb: 'An alliance, a peace and a pact',
  minutes: 3,
  ...PLAY,
  steps: [
    {
      id: 'open',
      label: 'Open Diplomacy',
      text: 'Click Diplomacy in the top bar. Three nations are next to you.',
      target: 'open-diplomacy',
      done: (_s, _me, ui) => ui.openPanel === 'diplomacy',
    },
    {
      id: 'ally',
      label: 'Make an alliance',
      text: 'The nation to the north likes you. Click it, then Ally. Allies share wars.',
      tile: at('friend'),
      done: (s, me) => areAllied(s, me.id, tutorialPlayer(s, 'friend')),
    },
    {
      id: 'peace',
      label: 'Make peace',
      text: 'The nation to the east is at war with you. Answer its peace offer, or offer peace.',
      tile: at('enemy'),
      done: (s, me) => activeTreaties(s, me.id).some((t) => t.kind === 'peace' && t.other === tutorialPlayer(s, 'enemy')),
    },
    {
      id: 'pact',
      label: 'Sign a pact',
      text: 'The quiet nation to the south: offer a Pact. Neither side attacks for 3 minutes.',
      tile: at('quiet'),
      done: (s, me) => activeTreaties(s, me.id).some((t) => t.kind === 'pact' && t.other === tutorialPlayer(s, 'quiet')),
    },
  ],
};

export const SUPPLY_CHAPTER: TutorialChapter = {
  id: 'supply',
  title: 'Supply',
  icon: 'train',
  blurb: 'Trains, rails and cutting a hub',
  minutes: 3,
  ...PLAY,
  steps: [
    {
      id: 'layer',
      label: 'Show supply',
      text: 'Click Map key, then switch on Supply. Trains carry supplies along the rails.',
      target: 'open-legend || overlay-supply',
      onEnter: (api) => api.centre(api.tile('city')),
      done: (_s, _me, ui) => !!ui.showSupply,
    },
    {
      id: 'rails',
      label: 'The weak link',
      text: 'The enemy Fort at its front gets supplies through one City. No detour, so a weak link.',
      tile: at('city'),
    },
    {
      id: 'bomb',
      label: 'Bomb the City',
      text: 'Click Bomb in the bottom bar, then the enemy City on the rail.',
      target: 'strike-bomb || open-forces',
      tile: at('city'),
      done: (s, me) => unitsOf(s, me, 'bomber') > 0 || gone(s, tutorialTile(s, 'city')) || hubDamaged(s, tutorialPlayer(s, 'foe'), tutorialTile(s, 'city')),
    },
    {
      id: 'cut',
      label: 'Cut the supply',
      text: 'Cut the Fort off: the City must be hit but not razed. The enemy front then slows.',
      tile: at('city'),
      keep: (api, s, me) => {
        const foe = api.player('foe');
        const city = api.tile('city');
        // a razed City is rebuilt by the enemy; an empty wing is refilled
        if (gone(s, city)) tutorialPlace(s, foe, 'city', city);
        const af = ownBuildings(s, me, 'airfield')[0];
        if (af && af.bombers === 0 && unitsOf(s, me, 'bomber') === 0) af.bombers += 3;
      },
      done: (s) => (supplyNetworkOf(s, tutorialPlayer(s, 'foe')).cut?.length ?? 0) > 0,
    },
  ],
};

export const SEASONS_CHAPTER: TutorialChapter = {
  id: 'seasons',
  title: 'Seasons',
  icon: 'sun',
  blurb: 'Mud, snow, ice and the best time to attack',
  minutes: 2,
  ...PLAY,
  steps: [
    {
      id: 'spring',
      label: 'Spring mud',
      text: 'Spring: mud makes tanks 25% slower on plains. This chip shows the season.',
      target: 'season-chip',
      onEnter: (api) => tutorialSetSeason(api.state(), 0),
    },
    {
      id: 'autumn',
      label: 'Autumn harvest',
      text: 'Skipping ahead. Autumn: farms bring in extra gold, up to 10%.',
      target: 'season-chip',
      onEnter: (api) => tutorialSetSeason(api.state(), 2),
    },
    {
      id: 'winter',
      label: 'Winter snow and ice',
      text: 'Winter: snow slows attacks by 25% (tanks 40%). Sea ice stops ships at the map edge.',
      target: 'season-chip',
      onEnter: (api) => tutorialSetSeason(api.state(), 3),
    },
    {
      id: 'summer',
      label: 'Attack in summer',
      text: 'Summer: nothing slows you. Attack the neighbour now: click its land.',
      tile: at('front'),
      onEnter: (api) => {
        tutorialSetSeason(api.state(), 1);
        topUp(api, { troops: 9000 });
        api.weaken(api.player('foe'), 1500);
      },
      done: (s, me) => seasonAt(s).season === 'summer' && attacking(s, me, tutorialPlayer(s, 'foe')),
    },
  ],
};

export const CHAPTERS: TutorialChapter[] = [NAVY_CHAPTER, AIR_CHAPTER, ARMOR_CHAPTER, DEFENSE_CHAPTER, DIPLOMACY_CHAPTER, SUPPLY_CHAPTER, SEASONS_CHAPTER];
