// The tutorial's content: eight short practice chapters (one game each, see src/sim/tutorialScenario.ts for the maps).
// Each step is one short instruction. `done` reads real game or UI state; a step without one shows Next.
// `target` names the HUD element to spotlight (data-test values, ' || ' = fallbacks); `tile` feeds "Show me".
// onEnter grants what a step needs, finishes a construction the player just ordered, or wakes an AI for a fight.
// Numbers in the text come from config, so the text follows the rules when they change.
import { MASTERY_CAP } from '../../sim/arsenal';
import {
  ATOM_RADIUS,
  BARRAGE_RANGE,
  BEACHHEAD_SUPPLY_SECONDS,
  DOCTRINE_UNLOCK_SECONDS,
  TANK_LAUNCH_REACH,
  TERRAIN,
} from '../../sim/config';
import { unitQueue } from '../../sim/navy';
import { tutorialPlayer, tutorialTile } from '../../sim/tutorialScenario';
import { isTribe, Terrain } from '../../sim/types';
import type { Building, BuildingType, GameState, Player, TechId, Unit, UnitType } from '../../sim/types';
import type { TutorialChapter, TutorialChapterId, TutorialStep, TutorialUi } from './engine';

// ------------------------------------------------------------------------------------------------ helpers

/** "Show me" on a named tile of the chapter. */
const at =
  (ch: TutorialChapterId, key: string) =>
  (s: GameState): number =>
    tutorialTile(s, ch, key);

/** Player id of a chapter role ('rival', 'tribe', ...). */
const role = (s: GameState, ch: TutorialChapterId, r: string): number => tutorialPlayer(s, ch, r);

/** An own building of a type (built = finished only). */
function own(s: GameState, me: Player, type: BuildingType, built = false): Building | undefined {
  for (const b of s.buildings.values()) if (b.owner === me.id && b.type === type && (!built || b.buildLeft <= 0)) return b;
  return undefined;
}
const ownAll = (s: GameState, me: Player): Building[] => [...s.buildings.values()].filter((b) => b.owner === me.id);

/** Own alive units of a type. */
const units = (s: GameState, me: Player, type: UnitType): Unit[] => s.units.filter((u) => u.owner === me.id && u.type === type && u.hp > 0);
/** An own unit of this type exists or is being built (port / factory queue). */
const ordered = (s: GameState, me: Player, type: 'warship' | 'tankDivision'): boolean =>
  units(s, me, type).length > 0 || unitQueue(s).some((q) => q.owner === me.id && q.type === type);

/** The tile under the first own unit of a type, else a fallback tile. */
function unitTile(s: GameState, me: Player | undefined, type: UnitType, fallback: number): number {
  const u = me ? units(s, me, type)[0] : undefined;
  return u ? Math.floor(u.y) * s.map.width + Math.floor(u.x) : fallback;
}
/** The tile of the first own building of a type, else a fallback tile. */
function buildingTile(s: GameState, me: Player | undefined, type: BuildingType, fallback: number): number {
  const b = me ? own(s, me, type) : undefined;
  return b ? b.tile : fallback;
}
const human = (s: GameState): Player | undefined => s.players[s.humanId];

/** An own attack on `target` (0 = wilderness) is running. */
const attacking = (s: GameState, me: Player, target: number): boolean => s.attacks.some((a) => a.attacker === me.id && a.target === target);

/** Has the tech or is researching it. */
const taking = (me: Player, ...techs: TechId[]): boolean => techs.some((t) => me.techs.includes(t) || me.researching === t);

/** Levels a building will reach once its upgrades and queued levels are done. */
const plannedLevel = (b: Building): number => b.level + (b.upgradeLeft > 0 ? 1 : 0) + (b.queuedLevels || 0);

/** Per-game step memory: numbers a step stores in onEnter or `done` (a fresh game starts empty). */
const memory = new WeakMap<GameState, Map<string, number>>();
function remember(s: GameState, key: string, v: number): void {
  let m = memory.get(s);
  if (!m) memory.set(s, (m = new Map()));
  m.set(key, v);
}
const recall = (s: GameState, key: string): number | undefined => memory.get(s)?.get(key);
/** True once `now` has been true in this game (for "it happened, now it is over" steps). */
function seen(s: GameState, key: string, now: boolean): boolean {
  if (now) remember(s, key, 1);
  return recall(s, key) === 1;
}
/** Troops in own attacks on `target` right now. */
const sentAt = (s: GameState, me: Player, target: number): number =>
  s.attacks.reduce((n, a) => (a.attacker === me.id && a.target === target ? n + a.troops.infantry + a.troops.armor + a.troops.artillery : n), 0);

const minutes = (sec: number): number => Math.round(sec / 60);
const panel = (ui: TutorialUi, ...names: string[]): boolean => ui.openPanel !== null && names.includes(ui.openPanel);

// ------------------------------------------------------------------------------------------------ 1 Basics

const basics: TutorialChapter = {
  id: 'basics',
  title: 'Basics',
  blurb: 'Place your capital, expand, attack a tribe and build a city.',
  minutes: 3,
  steps: [
    {
      id: 'spawn',
      label: 'Place your capital',
      text: 'Click a land tile to place your capital.',
      tile: at('basics', 'spawn'),
      done: (_s, me) => me.spawned,
    },
    {
      id: 'start',
      label: 'Start the game',
      text: 'Press Start now to begin.',
      target: 'start-now',
      done: (s) => s.phase === 'playing',
    },
    {
      id: 'share',
      label: 'Set attack size',
      text: 'Drag ATTACK to 50%. Each click sends that share of your troops.',
      target: 'attack-share',
      done: (_s, _me, ui) => ui.attackShare >= 0.5,
    },
    {
      id: 'expand',
      label: 'Expand',
      text: 'Click empty land next to yours to expand.',
      tile: at('basics', 'wild'),
      done: (s, me) => attacking(s, me, 0),
    },
    {
      id: 'tribe',
      label: 'Attack a tribe',
      text: 'Expand until you touch the grey tribe to the east, then click it.',
      tile: at('basics', 'tribe'),
      done: (s, me) =>
        s.attacks.some((a) => a.attacker === me.id && a.target > 0 && isTribe(s.players[a.target])) ||
        ['tribe', 'tribeNorth', 'tribeSouth'].some((r) => s.players[role(s, 'basics', r)]?.alive === false),
    },
    {
      id: 'troops',
      label: 'Troops',
      text: 'Troops regrow fastest near the brass mark on this bar. Keep spending them.',
      target: 'troops',
    },
    {
      id: 'gold',
      label: 'Gold',
      text: 'Gold comes in every second. Buildings cost gold.',
      target: 'resources',
    },
    {
      id: 'city',
      label: 'Build a City',
      text: 'Press 1, then click your land to build a City: more troops and gold.',
      target: 'build-city || build-menu-btn',
      tile: at('basics', 'citySite'),
      done: (s, me) => !!own(s, me, 'city'),
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 2 War

const war: TutorialChapter = {
  id: 'war',
  title: 'War',
  blurb: 'Take a tribe, read the terrain, hold a fort, shell it back and attack.',
  minutes: 4,
  steps: [
    {
      id: 'tribe',
      label: 'Take the tribe',
      text: 'Click the grey tribe to the south. Tribes fall at the first hit.',
      tile: at('war', 'tribe'),
      done: (s, me) => {
        const t = role(s, 'war', 'tribe');
        return attacking(s, me, t) || !s.players[t]?.alive;
      },
    },
    {
      id: 'terrain',
      label: 'Terrain',
      text: `Point at land to see its terrain. Forest defends x${TERRAIN[Terrain.Forest].defense}, hills x${TERRAIN[Terrain.Hills].defense}.`,
      tile: at('war', 'forest'),
    },
    {
      id: 'fort',
      label: 'Build a Fort',
      text: 'Press 9 and click near your border: attackers lose x2 near a Fort.',
      target: 'build-fort || build-menu-btn',
      tile: at('war', 'fortSite'),
      done: (s, me) => !!own(s, me, 'fort'),
    },
    {
      id: 'defend',
      label: 'Stop their attack',
      text: 'The rival attacks! Click its border: your attack cancels theirs.',
      tile: at('war', 'front'),
      onEnter: (api) => {
        api.finish();
        const rival = api.player('rival');
        if (rival <= 0) return;
        api.wake([rival], { hostile: true });
        // no attack possible: let the step pass once nothing attacks
        if (!api.enemyAttack(rival)) seen(api.state(), 'war.defend', true);
      },
      done: (s, me) => {
        const rival = role(s, 'war', 'rival');
        const theirs = s.attacks.some((a) => a.attacker === rival && a.target === me.id);
        return seen(s, 'war.defend', theirs) && !theirs;
      },
    },
    {
      id: 'barrage',
      label: 'Shell their fort',
      text: `Press Z, then click the rival's fort. Guns reach ${BARRAGE_RANGE} tiles past your border.`,
      target: 'strike-barrage',
      tile: at('war', 'fort'),
      done: (s, me) => me.barrageReadyTick > s.tick || s.barrages.some((b) => b.owner === me.id),
    },
    {
      id: 'attack',
      label: 'Attack the rival',
      text: "Set ATTACK to 40% or more, then click the rival's border.",
      target: 'attack-share',
      tile: at('war', 'front'),
      done: (s, me, ui) => {
        // a click on a nation you already attack adds troops to that attack: watch the troops sent grow
        const now = sentAt(s, me, role(s, 'war', 'rival'));
        const low = Math.min(recall(s, 'war.attack') ?? now, now);
        remember(s, 'war.attack', low);
        return ui.attackShare >= 0.4 && now > low + 500;
      },
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 3 Economy and research

const economy: TutorialChapter = {
  id: 'economy',
  title: 'Economy and research',
  blurb: 'Mines, wells, farms and markets, then research and a doctrine.',
  minutes: 4,
  steps: [
    {
      id: 'mine',
      label: 'Build a Mine',
      text: 'Press 4 and click next to the iron deposit. Iron pays for armor and forts.',
      target: 'build-mine || build-menu-btn',
      tile: at('economy', 'mineSite'),
      done: (s, me) => !!own(s, me, 'mine'),
    },
    {
      id: 'well',
      label: 'Build an Oil Well',
      text: 'Press 5 and click next to the oil. Tanks and planes burn oil.',
      target: 'build-oilWell || build-menu-btn',
      tile: at('economy', 'wellSite'),
      done: (s, me) => !!own(s, me, 'oilWell'),
    },
    {
      id: 'farm',
      label: 'Build a Farm',
      text: 'Press 2 and click the fertile land. A Farm there counts double.',
      target: 'build-farm || build-menu-btn',
      tile: at('economy', 'farmSite'),
      done: (s, me) => !!own(s, me, 'farm'),
    },
    {
      id: 'market',
      label: 'Build a Market',
      text: 'Press 3 and click your land. Each Market level adds 12% gold.',
      target: 'build-market || build-menu-btn',
      tile: at('economy', 'marketSite'),
      done: (s, me) => !!own(s, me, 'market'),
    },
    {
      id: 'x3',
      label: 'Build x3',
      text: 'Pick x3 at the end of the build bar. Each click then builds 3 levels.',
      target: 'count-3',
      done: (_s, _me, ui) => ui.buildCount >= 3,
    },
    {
      id: 'city3',
      label: 'City x3',
      text: 'Press 1 and click your land. The City goes up 3 levels at once.',
      target: 'build-city || bm-city',
      tile: at('economy', 'citySite'),
      done: (s, me) => ownAll(s, me).some((b) => b.type === 'city' && plannedLevel(b) >= 3),
    },
    {
      id: 'research',
      label: 'Open Research',
      text: 'Open Research (T). Science builds up by itself.',
      target: 'open-research',
      done: (_s, _me, ui) => panel(ui, 'research', 'arsenal'),
    },
    {
      id: 'tech',
      label: 'Pick a tech',
      text: 'Click Agriculture: farms grow 50% faster. It costs science and gold.',
      target: 'tech-agriculture || tab-research',
      done: (_s, me) => taking(me, 'agriculture'),
    },
    {
      id: 'doctrine',
      label: 'Pick a doctrine',
      text: `Open Doctrine (Shift+D) and pick one. Normal games open it at ${minutes(DOCTRINE_UNLOCK_SECONDS)}:00.`,
      target: 'doctrine-go || open-doctrine',
      done: (_s, me) => me.doctrine.id !== null,
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 4 Navy

const navy: TutorialChapter = {
  id: 'navy',
  title: 'Navy',
  blurb: 'Build a port and a warship, land on the island, bombard and blockade.',
  minutes: 4,
  steps: [
    {
      id: 'port',
      label: 'Build a Port',
      text: 'Press E and click your east coast to build a Port.',
      target: 'build-port || build-menu-btn',
      tile: at('navy', 'portSite'),
      done: (s, me) => !!own(s, me, 'port'),
    },
    {
      id: 'warship',
      label: 'Order a warship',
      text: 'Click your Port, then Warship. Click the sea to place it.',
      target: 'order-warship || order-destroyer || order-submarine',
      tile: (s) => buildingTile(s, human(s), 'port', tutorialTile(s, 'navy', 'portSite')),
      onEnter: (api) => api.finish(),
      done: (s, me) => ordered(s, me, 'warship'),
    },
    {
      id: 'invade',
      label: 'Land on the island',
      text: "Click the island's coast. A transport carries your troops over.",
      tile: at('navy', 'enemyCoast'),
      onEnter: (api) => api.finish(),
      done: (s, me) => units(s, me, 'transport').length > 0 || s.attacks.some((a) => a.attacker === me.id && a.amphibious),
    },
    {
      id: 'beach',
      label: 'Beachhead',
      text: `A landing is supplied for ${BEACHHEAD_SUPPLY_SECONDS} s. Warships nearby help it hold.`,
      tile: at('navy', 'enemyCoast'),
    },
    {
      id: 'select',
      label: 'Select the warship',
      text: 'Click your warship to select it.',
      tile: (s) => unitTile(s, human(s), 'warship', tutorialTile(s, 'navy', 'sea')),
      done: (_s, _me, ui) => ui.selectedUnits > 0,
    },
    {
      id: 'bombard',
      label: 'Bombard the coast',
      text: 'Pick Bombard, then click the enemy coast. It shells the defenders.',
      target: 'stance-bombard',
      tile: at('navy', 'enemyCoast'),
      done: (s, me) => units(s, me, 'warship').some((u) => u.stance === 'bombard'),
    },
    {
      id: 'blockade',
      label: 'Blockade the port',
      text: 'Now pick Blockade, then click the enemy port. It loses trade and supply.',
      target: 'stance-blockade',
      tile: at('navy', 'enemyPort'),
      done: (s, me) => units(s, me, 'warship').some((u) => u.stance === 'blockade'),
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 5 Armor

const armor: TutorialChapter = {
  id: 'armor',
  title: 'Armor',
  blurb: 'Build a factory and a tank division, launch a spearhead, support a front.',
  minutes: 4,
  steps: [
    {
      id: 'factory',
      label: 'Build a Factory',
      text: 'Press 7 and click your land. A Factory turns troops into armor.',
      target: 'build-factory || build-menu-btn',
      tile: at('armor', 'factorySite'),
      done: (s, me) => !!own(s, me, 'factory'),
    },
    {
      id: 'division',
      label: 'Order a division',
      text: 'Click your Factory, then Tank division.',
      target: 'order-tank-division',
      tile: (s) => buildingTile(s, human(s), 'factory', tutorialTile(s, 'armor', 'factorySite')),
      onEnter: (api) => api.finish(),
      done: (s, me) => ordered(s, me, 'tankDivision'),
    },
    {
      id: 'select',
      label: 'Select it',
      text: 'Click your tank division to select it.',
      tile: (s) => unitTile(s, human(s), 'tankDivision', tutorialTile(s, 'armor', 'factorySite')),
      onEnter: (api) => api.finish(),
      done: (_s, _me, ui) => ui.selectedUnits > 0,
    },
    {
      id: 'move',
      label: 'Move to the front',
      text: 'Click your land near the front to drive it there.',
      tile: at('armor', 'rally'),
      done: (s, me) => units(s, me, 'tankDivision').some((u) => u.state !== 0 || u.path.length > 0),
    },
    {
      id: 'spearhead',
      label: 'Launch a spearhead',
      text: `Click enemy land up to ${TANK_LAUNCH_REACH} tiles past your border, then click again.`,
      tile: at('armor', 'front'),
      done: (s, me) => units(s, me, 'tankDivision').some((u) => u.state === 2 || u.state === 3),
    },
    {
      id: 'support',
      label: 'Support a front',
      text: 'Select the division, pick Support front, then click the front.',
      target: 'mode-support',
      tile: at('armor', 'front'),
      done: (s, me) => units(s, me, 'tankDivision').some((u) => u.mode === 'support'),
    },
    {
      id: 'refit',
      label: 'Hold and Refit',
      text: 'Hold stays and defends. Refit drives back to a Factory to refill.',
      target: 'mode-refit',
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 6 Air

const air: TutorialChapter = {
  id: 'air',
  title: 'Air',
  blurb: 'Build an airfield, bomb a city, fly a raid, guard with a SAM, drop troops.',
  minutes: 4,
  steps: [
    {
      id: 'airfield',
      label: 'Build an Airfield',
      text: 'Press F and click your land behind the border.',
      target: 'build-airfield || build-menu-btn',
      tile: at('air', 'airfieldSite'),
      done: (s, me) => !!own(s, me, 'airfield'),
    },
    {
      id: 'bomber',
      label: 'Buy a bomber',
      text: 'Click your Airfield, then Bomber.',
      target: 'order-bomber',
      tile: (s) => buildingTile(s, human(s), 'airfield', tutorialTile(s, 'air', 'airfieldSite')),
      onEnter: (api) => api.finish(),
      done: (s, me) => ownAll(s, me).some((b) => b.type === 'airfield' && b.bombers > 0) || units(s, me, 'bomber').length > 0,
    },
    {
      id: 'bomb',
      label: 'Bomb the city',
      text: "Press X, then click the rival's city to bomb it.",
      target: 'strike-bomb',
      tile: at('air', 'enemyCity'),
      done: (s, me) => units(s, me, 'bomber').some((u) => u.mission === undefined),
    },
    {
      id: 'mission',
      label: 'Fly a raid',
      text: 'Click your Airfield, pick Strategic, then click the rival. Raids cut its income.',
      target: 'air-strategic',
      tile: at('air', 'enemy'),
      done: (s) => (s.air?.wings ?? []).some((w) => w.owner === s.humanId && w.mission === 'strategic'),
    },
    {
      id: 'sam',
      label: 'Build a SAM Site',
      text: 'Press G and click your land. A SAM shoots down planes and missiles.',
      target: 'build-sam || build-menu-btn',
      tile: at('air', 'samSite'),
      done: (s, me) => !!own(s, me, 'sam'),
    },
    {
      id: 'paradrop',
      label: 'Drop paratroopers',
      text: "Press K, then click the rival's land. Paratroopers attack where they land.",
      target: 'strike-paradrop',
      tile: at('air', 'dropZone'),
      onEnter: (api) => api.finish(),
      done: (s, me) =>
        units(s, me, 'transportPlane').some((u) => u.mission === undefined) || ownAll(s, me).some((b) => b.type === 'airfield' && b.dropCooldown > 0),
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 7 Arsenal

const ARMOR_PATH: TechId[] = ['lightTanks', 'heavyTanks'];
const ARMOR_NEXT: TechId[] = ['deepRaids', 'siegeTanks'];
const SPECIALS: TechId[] = ['amphibiousTanks', 'earlyWarning', 'navalMines', 'dropTanks', 'nightBombing'];

const arsenal: TutorialChapter = {
  id: 'arsenal',
  title: 'Arsenal',
  blurb: 'Pick a path, take a special and a mastery, upgrade many buildings at once.',
  minutes: 4,
  steps: [
    {
      id: 'open',
      label: 'Open the Arsenal',
      text: 'Open Research (T), then the Arsenal tab.',
      target: 'tab-arsenal || open-research',
      done: (_s, _me, ui) => panel(ui, 'arsenal'),
    },
    {
      id: 'fork',
      label: 'Paths fork',
      text: 'OR marks a fork. Your navy took Destroyers, so Submarines are locked.',
      target: 'or-navalDoctrine || row-navy',
    },
    {
      id: 'path',
      label: 'Pick a tank path',
      text: 'Pick Light Tanks or Heavy Tanks. The other one locks for this game.',
      target: 'row-armor',
      done: (_s, me) => taking(me, ...ARMOR_PATH),
    },
    {
      id: 'next',
      label: 'Follow the path',
      text: 'Take the next card on your path: Deep Raids or Siege Tanks.',
      target: 'tech-deepRaids || tech-siegeTanks || row-armor',
      done: (_s, me) => taking(me, ...ARMOR_NEXT),
    },
    {
      id: 'mastery',
      label: 'Take a mastery',
      text: `Take Armor Mastery. You get ${MASTERY_CAP} masteries per game: see the count.`,
      target: 'tech-armorMastery || mastery-count',
      done: (_s, me) => taking(me, 'armorMastery'),
    },
    {
      id: 'special',
      label: 'Take a special',
      text: 'Specials add a new trick to any path. Take Drop Tanks.',
      target: 'tech-dropTanks || row-air',
      done: (_s, me) => taking(me, ...SPECIALS),
    },
    {
      id: 'select',
      label: 'Select buildings',
      text: 'Close the panel. Hold Shift and drag a box over your buildings.',
      tile: at('arsenal', 'upgradeArea'),
      done: (_s, _me, ui) => ui.selectedBuildings >= 2,
    },
    {
      id: 'upgrade',
      label: 'Upgrade them all',
      text: 'Click Upgrade x3: each one gets 3 more levels, cheapest first.',
      target: 'upgrade-x3 || building-selection',
      done: (s, me) => ownAll(s, me).filter((b) => b.upgradeLeft > 0 || (b.queuedLevels || 0) > 0 || b.level >= 2).length >= 2,
    },
  ],
};

// ------------------------------------------------------------------------------------------------ 8 Diplomacy and strikes

const allied = (s: GameState, a: number, b: number): boolean => s.alliances.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
const friends = (s: GameState): number[] => [role(s, 'diplomacy', 'friendA'), role(s, 'diplomacy', 'friendB')].filter((id) => id > 0);

const diplomacy: TutorialChapter = {
  id: 'diplomacy',
  title: 'Diplomacy and strikes',
  blurb: 'Make an ally, face a runaway leader, fire a rocket and an atom bomb.',
  minutes: 4,
  steps: [
    {
      id: 'card',
      label: 'Open a nation card',
      text: "Click a neighbour's name in the standings to open its card.",
      target: (s) => [...friends(s).map((id) => `lb-row-${id}`), 'leaderboard'].join(' || '),
      tile: at('diplomacy', 'friendA'),
      done: (s, _me, ui) => friends(s).includes(ui.nationCard),
    },
    {
      id: 'ally',
      label: 'Make an ally',
      text: "Press Ally, or Accept if they asked first. Allies can't attack each other.",
      target: 'nc-ally || nc-accept || leaderboard',
      done: (s, me) => friends(s).some((f) => allied(s, me.id, f)),
    },
    {
      id: 'coalition',
      label: 'The leader',
      text: 'One nation is far ahead. The others team up on it: a coalition.',
      tile: at('diplomacy', 'leader'),
    },
    {
      id: 'ask',
      label: 'Ask for help',
      text: "Right-click the leader's land and pick Ask allies. Your ally attacks it.",
      target: 'rad-ask-allies',
      tile: at('diplomacy', 'leaderMainland'),
      done: (s, me) => s.allyRequests.some((r) => r.from === me.id && r.kind === 'attack') || s.allyPledges.some((p) => p.friend === me.id),
    },
    {
      id: 'rocket',
      label: 'Fire a rocket',
      text: "Press I, then click the leader's land. A rocket wrecks buildings.",
      target: 'strike-rocket',
      tile: at('diplomacy', 'leaderMainland'),
      done: (s, me) => units(s, me, 'rocket').length > 0,
    },
    {
      id: 'warning',
      label: 'About atom bombs',
      text: `An atom bomb wipes out ${ATOM_RADIUS} tiles, yours too. Every nation turns on you.`,
      target: 'strike-atomBomb',
    },
    {
      id: 'atom',
      label: 'Drop an atom bomb',
      text: "Press O, then click the leader's island.",
      target: 'strike-atomBomb',
      tile: at('diplomacy', 'leader'),
      onEnter: (api) => api.finish(), // the silo reloads at once
      done: (s, me) => units(s, me, 'atomBomb').length > 0,
    },
  ],
};

export const CHAPTERS: TutorialChapter[] = [basics, war, economy, navy, armor, air, arsenal, diplomacy];
