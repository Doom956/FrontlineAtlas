// The tutorial's content: one quick practice game (about 5 minutes) on the map of src/sim/tutorialScenario.ts.
// Each step is one short instruction. `done` reads real game or UI state; a step without one shows Next.
// `target` names the HUD element to spotlight (data-test values, ' || ' = fallbacks); `tile` feeds "Show me".
// onEnter starts the game, grants what a step needs or finishes a construction, so no step can stall.
// Everything past the basics (navy, tanks, air, strikes, the Arsenal, doctrines) is left to the in-game guide.
import { BUILDINGS, TECHS } from '../../sim/config';
import { TUTORIAL_ID, tutorialPlayer, tutorialTile } from '../../sim/tutorialScenario';
import { isTribe } from '../../sim/types';
import type { GameState, Player } from '../../sim/types';
import type { TutorialApi, TutorialChapter } from './engine';

/** "Show me" on a named tile. */
const at =
  (key: string) =>
  (s: GameState): number =>
    tutorialTile(s, key);

/** An own attack on `target` (0 = wilderness) is running. */
const attacking = (s: GameState, me: Player, target: number): boolean => s.attacks.some((a) => a.attacker === me.id && a.target === target);
const homeTroops = (me: Player): number => me.troops.infantry + me.troops.armor + me.troops.artillery;

/** Tops gold (and science) up to what the step costs, so a slow start never blocks it. */
function topUp(api: TutorialApi, need: { gold?: number; science?: number; troops?: number }): void {
  const me = api.me();
  api.grant({
    gold: Math.max(0, (need.gold ?? 0) - me.gold),
    science: Math.max(0, (need.science ?? 0) - me.science),
    troops: Math.max(0, (need.troops ?? 0) - homeTroops(me)),
  });
}

const CITY = BUILDINGS.city;
/** the tribe's army when its step starts */
const TRIBE_TROOPS = 3000;
/** the neighbour's army when its step starts, as a share of the player's */
const NEIGHBOUR_SHARE = 0.12;
const AGRI = TECHS.agriculture;

export const QUICK_TUTORIAL: TutorialChapter = {
  id: TUTORIAL_ID,
  title: 'Tutorial',
  minutes: 5,
  steps: [
    {
      id: 'spawn',
      label: 'Place your capital',
      text: 'Click land in the middle of the screen to place your capital.',
      tile: at('spawn'),
      onEnter: (api) => api.centre(api.tile('spawn')),
      done: (_s, me) => me.spawned,
    },
    {
      id: 'share',
      label: 'Set attack size',
      text: 'Drag ATTACK to 50%. Each click on the map sends that share of your troops.',
      target: 'attack-share',
      onEnter: (api) => api.startNow(), // the game starts as soon as the capital stands
      done: (_s, _me, ui) => ui.attackShare >= 0.5,
    },
    {
      id: 'expand',
      label: 'Expand',
      text: 'Click the empty land next to yours to expand into it.',
      tile: at('wild'),
      done: (s, me) => attacking(s, me, 0),
    },
    {
      id: 'troops',
      label: 'Troops',
      text: 'Troops are your army. They regrow fastest when this bar is near its brass mark.',
      target: 'troops',
    },
    {
      id: 'gold',
      label: 'Gold',
      text: 'Gold comes in every second. You spend it on buildings and research.',
      target: 'resources',
    },
    {
      id: 'city',
      label: 'Build a City',
      text: 'Press 1, then click your land to build a City: more troops and more gold.',
      target: 'build-city || build-menu-btn',
      tile: at('citySite'),
      onEnter: (api) => topUp(api, { gold: CITY.cost + 50 }),
      done: (s, me) => [...s.buildings.values()].some((b) => b.owner === me.id && b.type === 'city'),
    },
    {
      id: 'tribe',
      label: 'Take a tribe',
      text: 'Click the grey tribe to the north-east. Not touching it yet? Expand first.',
      tile: at('tribe'),
      onEnter: (api) => {
        api.finish(); // the City stands at once
        topUp(api, { troops: 9000 });
        api.weaken(api.player('tribe'), TRIBE_TROOPS);
      },
      done: (s, me) => {
        const t = tutorialPlayer(s, 'tribe');
        return s.attacks.some((a) => a.attacker === me.id && a.target > 0 && isTribe(s.players[a.target])) || s.players[t]?.alive === false;
      },
    },
    {
      id: 'neighbour',
      label: 'Attack a neighbour',
      text: 'Now attack the weak nation to the south-east: click its land next to yours.',
      tile: at('front'),
      onEnter: (api) => {
        topUp(api, { troops: 9000 });
        // frozen AIs still grow: keep the neighbour clearly weaker than the player
        api.weaken(api.player('rival'), Math.round(homeTroops(api.me()) * NEIGHBOUR_SHARE));
      },
      done: (s, me) => {
        const r = tutorialPlayer(s, 'rival');
        return attacking(s, me, r) || s.players[r]?.alive === false;
      },
    },
    {
      id: 'research',
      label: 'Open Research',
      text: 'Press T to open Research.',
      target: 'open-research',
      onEnter: (api) => topUp(api, { gold: AGRI.gold + 50, science: AGRI.science + 10 }),
      done: (_s, _me, ui) => ui.openPanel === 'research' || ui.openPanel === 'arsenal',
    },
    {
      id: 'tech',
      label: 'Pick a tech',
      text: `Click ${AGRI.name} (farms grow faster). Techs cost science and gold.`,
      target: 'tech-agriculture || tab-research',
      // any tech counts
      done: (_s, me) => me.researching !== null || me.techs.length > 0,
    },
  ],
};
