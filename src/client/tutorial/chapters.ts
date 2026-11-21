// The optional tutorial chapters: each one a tiny scripted practice game of 2 to 3 minutes on the tutorial map
// (src/sim/tutorialScenario.ts ChapterSpec sets up the nations, buildings, resources and techs it needs), with 3 to 5
// steps and a win goal, run by the same step runner as the basics. A chapter's last step is its goal; finishing it
// marks the chapter done. Steps grant what they cost (topUp), finish constructions at once (api.finish) and put back a
// target the player destroyed too early (keep), so none can stall.
import { ALLIANCE_REQUEST_TIMEOUT, BUILDINGS, TREATY_OFFER_TIMEOUT } from '../../sim/config';
import { areAllied } from '../../sim/diplomacy';
import { arsenalPrice } from '../../sim/procurement';
import { seasonAt } from '../../sim/seasons';
import { hubDamaged, supplyNetworkOf } from '../../sim/supplylines';
import { activeTreaties } from '../../sim/treaty';
import { ISLANDERS, tutorialPlace, tutorialPlayer, tutorialSetSeason, tutorialTile } from '../../sim/tutorialScenario';
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

/** The island's City is the player's (or its owners are gone). */
function islandTaken(s: GameState, me: Player): boolean {
  const b = s.buildings.get(s.map.building[tutorialTile(s, 'islandCity')] - 1);
  return (!!b && b.owner === me.id) || s.players[tutorialPlayer(s, 'islanders')]?.alive === false;
}

/** Own land this many columns past the front (x of the push goal tile). */
function reachedX(s: GameState, me: Player): number {
  const { width: w, owner } = s.map;
  let m = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === me.id) m = Math.max(m, i % w);
  return m;
}
/** How far the armor goal lies past the front (tiles): one spearhead goes about 12, so one or two reach it. */
export const PUSH_TILES = 10;
/** An own tank division is on a spearhead (state 3) or driving to start one (2). */
const onSpearhead = (s: GameState, me: Player): boolean => s.units.some((u) => u.owner === me.id && u.type === 'tankDivision' && u.hp > 0 && u.state === 3);

/** Per game: when a step's clock started, what a step saw at its start, flags a step raised. */
const began = new WeakMap<GameState, number>();
const seen = new WeakMap<GameState, number>();
const lowest = new WeakMap<GameState, number>();
const refills = new WeakMap<GameState, number>();
const flags = new WeakMap<GameState, Set<string>>();
const flag = (s: GameState, k: string): boolean => flags.get(s)?.has(k) ?? false;
const raise = (s: GameState, k: string): void => {
  let f = flags.get(s);
  if (!f) flags.set(s, (f = new Set()));
  f.add(k);
};

/** The defense chapter: seconds the enemy tanks keep coming before the step closes by itself (never stalls). */
const DEFENSE_MAX_SECONDS = 120;
/** ...and the gap between two tank attacks (s). */
const TANK_GAP_SECONDS = 20;

/** Refills an empty or spent wing to `n` bombers once every bomber is home (the lesson goes on). */
function refillWing(api: TutorialApi, s: GameState, me: Player, n: number): boolean {
  if (unitsOf(s, me, 'bomber') > 0) return false;
  const af = ownBuildings(s, me, 'airfield')[0];
  if (!af || af.bombers >= n) return false;
  af.bombers = n;
  return true;
}
/** Air: how long the SAM site rests after the player lost two wings' worth of lone bombers (s). */
const SAM_REST_SECONDS = 40;

/** A frozen AI answers the player's alliance request or offer about a second after it was sent (an answer, not a reflex). */
function answerSoon(api: TutorialApi, s: GameState, me: Player, ai: number): void {
  const old = (expiresTick: number, timeout: number): boolean => expiresTick - s.tick <= (timeout - 1) * 10;
  const req = s.allianceRequests.some((r) => r.from === me.id && r.to === ai && old(r.expiresTick, ALLIANCE_REQUEST_TIMEOUT));
  const offer = (s.treatyOffers ?? []).some((o) => o.from === me.id && o.to === ai && old(o.expiresTick, TREATY_OFFER_TIMEOUT));
  if (req || offer) api.accept(ai);
}

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
      text: 'Click Port in the bottom bar (or Build, then Port), then your coast. Ports build ships.',
      target: 'build-port || bm-port || build-menu-btn',
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
      text: 'Click Forces, then + Warship, then the water next to your Port. Warships guard your coast.',
      target: 'fa-warship || open-forces',
      tile: at('coast'),
      onEnter: (api) => {
        api.finish(); // the Port stands at once
        topUp(api, { gold: 900, iron: 120, oil: 120 });
      },
      done: (s, me) => unitsOf(s, me, 'warship') > 0 || queued(s, me, 'warship'),
    },
    {
      id: 'land',
      label: 'Land on the island',
      text: 'Click the island out in the sea. Your troops cross the water in a transport boat.',
      tile: at('island'),
      onEnter: (api) => {
        api.finish();
        topUp(api, { troops: 12000 });
        api.weaken(api.player('islanders'), ISLANDERS);
        api.centre(api.tile('island'));
      },
      done: (s, me) => unitsOf(s, me, 'transport') > 0 || islandTaken(s, me) || [...s.attacks].some((a) => a.attacker === me.id && a.target === tutorialPlayer(s, 'islanders')),
    },
    {
      id: 'island',
      label: "Take the island's City",
      text: "Take the island's City: keep clicking the island's land until the City is yours.",
      tile: at('islandCity'),
      onEnter: (api) => api.weaken(api.player('islanders'), ISLANDERS),
      // a frozen nation still grows troops: the island's army stays at ISLANDERS, so each landing gains ground
      keep: (api) => api.weaken(api.player('islanders'), ISLANDERS),
      done: (s, me) => islandTaken(s, me),
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
      text: 'Click Build in the bottom bar, then Airfield, then your land. Bombers fly from it.',
      target: 'build-airfield || bm-airfield || build-menu-btn',
      tile: at('home'),
      onEnter: (api) => topUp(api, { gold: BUILDINGS.airfield.cost + 100, iron: BUILDINGS.airfield.iron + 20 }),
      done: (s, me) => owns(s, me, 'airfield'),
    },
    {
      id: 'wing',
      label: 'Buy 3 bombers',
      text: 'Click Forces, then + Bomber at your Airfield, 3 times. A wing flies together.',
      target: 'fa-bomber || open-forces',
      onEnter: (api) => {
        api.finish();
        topUp(api, { gold: 2500, oil: 300 });
      },
      done: (s, me) => bombers(s, me) >= 3 || unitsOf(s, me, 'bomber') > 0,
    },
    {
      id: 'sam',
      label: 'The SAM site',
      text: 'The enemy SAM site shoots down one bomber every 4 s. That is why you send several at once.',
      tile: at('sam'),
    },
    {
      id: 'bomb',
      label: 'Send the wing',
      text: 'Click Bomb in the bottom bar (set to x3: 3 bombers per click), then click the enemy Fort.',
      target: 'strike-bomb || open-forces',
      tile: at('fort'),
      onEnter: (api) => {
        api.centre(api.tile('fort'));
        api.bombSalvoAtLeast(3); // a lone bomber falls to the SAM: x3 gets two through
        const s = api.state();
        refillWing(api, s, api.me(), 3);
        seen.set(s, bombers(s, api.me()));
      },
      // bombers in the air, fewer at home than at the start (one shot down at once), or the Fort is gone
      done: (s, me) => unitsOf(s, me, 'bomber') > 0 || bombers(s, me) < (seen.get(s) ?? 0) || gone(s, tutorialTile(s, 'fort')),
    },
    {
      id: 'fort',
      label: 'Knock out the Fort',
      text: 'Knock out the Fort. Send x3 or All: the SAM downs one bomber, the rest get through.',
      target: 'strike-bomb',
      tile: at('fort'),
      // a spent wing is refilled once it is home; after two refills the SAM runs dry for a while, so the Fort always falls
      keep: (api, s, me) => {
        if (gone(s, tutorialTile(s, 'fort')) || !refillWing(api, s, me, 3)) return;
        const n = (refills.get(s) ?? 0) + 1;
        refills.set(s, n);
        const sam = s.buildings.get(s.map.building[tutorialTile(s, 'sam')] - 1);
        if (n >= 2 && sam && sam.type === 'sam') sam.disabledUntil = Math.max(sam.disabledUntil, s.tick + SAM_REST_SECONDS * 10);
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
      text: 'Click Build in the bottom bar, then Factory, then your land. Factories make tank divisions.',
      target: 'build-factory || bm-factory || build-menu-btn',
      tile: at('home'),
      onEnter: (api) => topUp(api, { gold: BUILDINGS.factory.cost + 100, iron: BUILDINGS.factory.iron + 20 }),
      done: (s, me) => owns(s, me, 'factory'),
    },
    {
      id: 'mech',
      label: 'Order Mechanization',
      text: 'Click Research, open the Arsenal tab, and order Mechanization. It unlocks tanks.',
      target: 'tech-mechanization || tab-arsenal || open-research',
      next: 'mechanization',
      onEnter: (api) => {
        api.finish();
        topUpArsenal(api, 'mechanization');
      },
      done: (_s, me) => ordered(me, 'mechanization'),
    },
    {
      id: 'division',
      label: 'Form a division',
      text: 'Click Forces, then + Tank division, then your Factory.',
      target: 'fa-tank-division || open-forces',
      onEnter: (api) => {
        api.finish(); // the order is delivered
        topUp(api, { gold: 1500, iron: 300, oil: 200, armor: 5000 });
      },
      done: (s, me) => unitsOf(s, me, 'tankDivision') > 0 || queued(s, me, 'tankDivision'),
    },
    {
      id: 'spearhead',
      label: 'Launch a spearhead',
      text: 'Click your division, then the enemy land at your border, then click there again to launch.',
      tile: at('front'),
      onEnter: (api) => {
        api.finish();
        api.weaken(api.player('foe'), 1500); // a weak front: tanks break it
      },
      done: (s, me) => onSpearhead(s, me) || reachedX(s, me) >= tutorialTile(s, 'front') % s.map.width + 2,
    },
    {
      id: 'push',
      label: `Push ${PUSH_TILES} tiles in`,
      text: `Push ${PUSH_TILES} tiles into their land. Spearhead stopped? Click the division and send it again.`,
      tile: at('push'),
      onEnter: (api) => api.weaken(api.player('foe'), 1500),
      done: (s, me) => reachedX(s, me) >= (tutorialTile(s, 'front') % s.map.width) + PUSH_TILES,
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
      text: 'Click Fort in the bottom bar (or Build, then Fort), then your border. Attackers lose twice as much.',
      target: 'build-fort || bm-fort || build-menu-btn',
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
      text: 'Click Research, then Arsenal, and order Tank Traps. They slow and bleed enemy tanks near your Forts.',
      target: 'tech-tankTraps || tab-arsenal || open-research',
      next: 'tankTraps',
      onEnter: (api) => {
        api.finish(); // the Fort stands at once
        topUpArsenal(api, 'tankTraps');
      },
      done: (_s, me) => ordered(me, 'tankTraps'),
    },
    {
      id: 'tanks',
      label: 'Stop the tanks',
      text: 'Enemy tanks drive into your traps and stall. Then win the lost land back: click it.',
      tile: at('tanks'),
      onEnter: (api) => {
        api.finish(); // the traps are delivered
        const s = api.state();
        api.wake([], { hostile: true }); // the enemy may now attack the player (it stays frozen: only its tanks come)
        api.centre(api.tile('tanks'));
        api.enemyTanks(api.player('foe'), api.tile('tanks'));
        began.set(s, s.tick);
        seen.set(s, s.tick);
      },
      keep: (api, s, me) => {
        const foe = api.player('foe');
        const tanks = s.units.filter((u) => u.owner === foe && u.type === 'tankDivision' && u.hp > 0);
        if (tanks.some((u) => (u.trapLoss ?? 0) > 0)) raise(s, 'trapped');
        // struck back: an attack on the enemy, or land won back since the lowest point (a pocket falls in a moment)
        const low = Math.min(lowest.get(s) ?? me.tiles, me.tiles);
        lowest.set(s, low);
        if (attacking(s, me, foe) || (flag(s, 'trapped') && me.tiles >= low + 3)) raise(s, 'struck');
        // the next tank attack once the last one has ended
        const busy = tanks.some((u) => u.state === 2 || u.state === 3);
        if (flag(s, 'trapped') && !busy) raise(s, 'stalled');
        if (!busy && s.tick - (seen.get(s) ?? s.tick) >= TANK_GAP_SECONDS * 10) {
          seen.set(s, s.tick);
          api.enemyTanks(foe, api.tile('tanks'));
        }
      },
      // the traps stopped a spearhead and the player struck back (or the time ran out: never stalls)
      done: (s) => (flag(s, 'stalled') && flag(s, 'struck')) || s.tick - (began.get(s) ?? s.tick) >= DEFENSE_MAX_SECONDS * 10,
    },
  ],
};

/** A nation's row in the standings (its card opens from there; the rows keep still under the mouse). */
const row = (role: string) => (s: GameState): string => `lb-row-${tutorialPlayer(s, role)}`;

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
      text: 'The nation to the north likes you. Click its name in Standings (top left), then Ally.',
      target: (s) => `nc-ally || ${row('friend')(s)}`,
      tile: at('friend'),
      keep: (api, s, me) => answerSoon(api, s, me, api.player('friend')),
      done: (s, me) => areAllied(s, me.id, tutorialPlayer(s, 'friend')),
    },
    {
      id: 'peace',
      label: 'Make peace',
      text: 'The nation to the east is at war with you and offers peace. Click Accept in Diplomacy.',
      target: (s) => `treaty-accept || treaty-send || nc-peace || open-diplomacy || ${row('enemy')(s)}`,
      tile: at('enemy'),
      keep: (api, s, me) => {
        const foe = api.player('enemy');
        // the war goes on (so Peace stays on the table) until a peace is signed
        if (!s.attacks.some((a) => a.attacker === foe && a.target === me.id)) api.enemyAttack(foe);
        // the player's own peace offer is accepted
        answerSoon(api, s, me, foe);
        // its offer stands: a fresh one whenever none is waiting (also after a refusal or when one ran out)
        const waiting = (s.treatyOffers ?? []).some((o) => (o.from === foe && o.to === me.id) || (o.from === me.id && o.to === foe));
        if (!waiting && !activeTreaties(s, me.id).some((t) => t.other === foe)) api.offerPeace(foe);
      },
      done: (s, me) => activeTreaties(s, me.id).some((t) => t.kind === 'peace' && t.other === tutorialPlayer(s, 'enemy')),
    },
    {
      id: 'pact',
      label: 'Sign a pact',
      text: 'The quiet nation to the south: click its name in Standings, then Pact, then Send offer.',
      target: (s) => `treaty-send || nc-pact || ${row('quiet')(s)}`,
      tile: at('quiet'),
      keep: (api, s, me) => answerSoon(api, s, me, api.player('quiet')),
      done: (s, me) => activeTreaties(s, me.id).some((t) => t.kind === 'pact' && t.other === tutorialPlayer(s, 'quiet')),
    },
  ],
};

/** The enemy's Fort is cut off from its supply, or the City (its only link) is damaged. */
const supplyCut = (s: GameState): boolean => (supplyNetworkOf(s, tutorialPlayer(s, 'foe')).cut?.length ?? 0) > 0 || hubDamaged(s, tutorialPlayer(s, 'foe'), tutorialTile(s, 'city'));

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
      target: 'overlay-supply || open-legend',
      onEnter: (api) => api.centre(api.tile('city')),
      done: (_s, _me, ui) => !!ui.showSupply,
    },
    {
      id: 'rails',
      label: 'The weak link',
      text: "The enemy Fort at its front gets supplies through one City (ringed). No detour: it's a weak link.",
      tile: at('city'),
    },
    {
      id: 'bomb',
      label: 'Bomb the City',
      text: 'Click Bomb in the bottom bar, then the enemy City on the rail (Show me finds it). Any salvo works.',
      target: 'strike-bomb || open-forces',
      tile: at('city'),
      onEnter: (api) => {
        const s = api.state();
        refillWing(api, s, api.me(), 4);
        seen.set(s, bombers(s, api.me()));
      },
      done: (s, me) => unitsOf(s, me, 'bomber') > 0 || bombers(s, me) < (seen.get(s) ?? 0) || gone(s, tutorialTile(s, 'city')) || supplyCut(s),
    },
    {
      id: 'cut',
      label: 'Cut the supply',
      text: 'Wait for the bombs. A hit City stops the trains: the Fort is cut off and the enemy front slows.',
      tile: at('city'),
      keep: (api, s, me) => {
        const foe = api.player('foe');
        const city = api.tile('city');
        // razed by the bombs: the enemy puts it back at once, still damaged (the cut stands); a spent wing is refilled
        if (gone(s, city) && tutorialPlace(s, foe, 'city', city)) api.hitHub(foe, city);
        refillWing(api, s, me, 4);
      },
      done: (s) => supplyCut(s),
    },
  ],
};

/** How far into a season each jump lands: past its start, so its colours are in (winter: the snow is all down). */
const SEASON_INTO = 0.2;
const WINTER_INTO = 0.62;

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
      onEnter: (api) => tutorialSetSeason(api.state(), 0, SEASON_INTO),
    },
    {
      id: 'autumn',
      label: 'Autumn harvest',
      text: 'Skipping ahead. Autumn: farms bring in extra gold, up to 10%.',
      target: 'season-chip',
      onEnter: (api) => tutorialSetSeason(api.state(), 2, SEASON_INTO),
    },
    {
      id: 'winter',
      label: 'Winter snow and ice',
      text: 'Winter: snow (white, north and south) slows attacks 25%, tanks 40%. Sea ice stops ships.',
      target: 'season-chip',
      onEnter: (api) => {
        // far enough in that the snow has come down from the poles; the view shows the snow line
        tutorialSetSeason(api.state(), 3, WINTER_INTO);
        api.centre(api.tile('snow'));
      },
    },
    {
      id: 'summer',
      label: 'Attack in summer',
      text: 'Summer: nothing slows you. Attack the neighbour now: click its land.',
      tile: at('front'),
      onEnter: (api) => {
        tutorialSetSeason(api.state(), 1, SEASON_INTO);
        api.centre(api.tile('home'));
        topUp(api, { troops: 9000 });
        api.weaken(api.player('foe'), 1500);
      },
      done: (s, me) => seasonAt(s).season === 'summer' && attacking(s, me, tutorialPlayer(s, 'foe')),
    },
  ],
};

export const CHAPTERS: TutorialChapter[] = [NAVY_CHAPTER, AIR_CHAPTER, ARMOR_CHAPTER, DEFENSE_CHAPTER, DIPLOMACY_CHAPTER, SUPPLY_CHAPTER, SEASONS_CHAPTER];
