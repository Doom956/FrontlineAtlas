// The guide's content: the opening sequence (in order, when a game starts) and the contextual tips (once each, when
// they become useful). Text is one short line; `target` names the HUD element (data-test values, ' || ' = fallbacks),
// `tile` the map tile the arrow shows when there is no element. Everything here only reads the game.
import { isArsenalTech } from '../../sim/arsenal';
import { buildingCost, countBuildings } from '../../sim/buildings';
import { DOCTRINE_UNLOCK_SECONDS, TECHS } from '../../sim/config';
import { neighbors4, nearestTile, tileDist } from '../../sim/grid';
import { mods } from '../../sim/rules';
import { canResearch } from '../../sim/tech';
import { isTribe, isWater } from '../../sim/types';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { victoryShareNow } from '../../sim/victory';
import { coalitionLeader } from '../allies';
import { DOCTRINE_KEY } from '../doctrineView';
import { snapBuild } from '../placement';
import { STRIKE_ORDER, STRIKES, type StrikeId } from '../strikes';
import type { GuideCtx, GuideStep, GuideTip } from './engine';

// ------------------------------------------------------------------------------------------------ helpers

/** Tile searches are cached per game for this many ticks (they run at ~5 Hz otherwise). */
const CACHE_TICKS = 10;
const cache = new WeakMap<GameState, Map<string, { tick: number; v: number }>>();
function cached(s: GameState, key: string, f: () => number): number {
  let m = cache.get(s);
  if (!m) cache.set(s, (m = new Map()));
  const hit = m.get(key);
  if (hit && s.tick - hit.tick < CACHE_TICKS) return hit.v;
  const v = f();
  m.set(key, { tick: s.tick, v });
  return v;
}

const nb: number[] = [];
/** A tile next to land of `owner`. */
function touches(s: GameState, i: number, owner: number): boolean {
  const n = neighbors4(s.map, i, nb);
  for (let k = 0; k < n; k++) if (s.map.owner[nb[k]] === owner) return true;
  return false;
}
const isLand = (s: GameState, i: number): boolean => !isWater(s.map.terrain[i]);

/** Where the player's land is centred for searches: the capital, else the camera's view (spawn phase). */
function home(c: GuideCtx): number {
  return c.me.capital >= 0 ? c.me.capital : -1;
}

/** Empty land next to the player's border, nearest the capital (-1 = none close). */
export function expandTile(c: GuideCtx): number {
  const h = home(c);
  if (h < 0) return -1;
  return cached(c.s, `expand${c.me.id}`, () => nearestTile(c.s.map, h, 90, (i) => c.s.map.owner[i] === 0 && isLand(c.s, i) && c.s.map.fallout[i] <= 0 && touches(c.s, i, c.me.id)));
}

/** A tribe tile next to the player's border, else the nearest tribe tile (-1 = none). */
export function tribeTile(c: GuideCtx): number {
  const h = home(c);
  if (h < 0) return -1;
  const tribe = (i: number): boolean => {
    const o = c.s.map.owner[i];
    return o > 0 && o !== c.me.id && isTribe(c.s.players[o]);
  };
  return cached(c.s, `tribe${c.me.id}`, () => {
    const near = nearestTile(c.s.map, h, 120, (i) => tribe(i) && touches(c.s, i, c.me.id));
    if (near >= 0) return near;
    // none next to us: the nearest tribe's capital
    let best = -1;
    let bestD = Infinity;
    for (const p of c.s.players) {
      if (!p.alive || !isTribe(p) || p.capital < 0) continue;
      const d = tileDist(c.s.map, h, p.capital);
      if (d < bestD) (best = p.capital), (bestD = d);
    }
    return best;
  });
}

/** A good free tile for a City on the player's land: a few tiles from the capital (-1 = none). */
export function cityTile(c: GuideCtx): number {
  const h = home(c);
  if (h < 0) return -1;
  return cached(c.s, `city${c.me.id}`, () =>
    nearestTile(c.s.map, h, 40, (i) => {
      if (c.s.map.owner[i] !== c.me.id || c.s.map.building[i] !== 0 || tileDist(c.s.map, i, h) < 5) return false;
      // inside the land, not on its edge
      const w = c.s.map.width;
      for (const d of [3, -3, 3 * w, -3 * w]) if (c.s.map.owner[i + d] !== c.me.id) return false;
      const snap = snapBuild(c.s, c.me.id, 'city', i);
      return snap.tile === i && !snap.upgrade;
    }),
  );
}

/** Open land for a start near the middle of the view (spawn phase): unowned land with land and no one around. */
export function startTile(c: GuideCtx, centre: number): number {
  if (centre < 0) return -1;
  const s = c.s;
  const w = s.map.width;
  const free = (i: number): boolean => i >= 0 && i < s.map.owner.length && s.map.owner[i] === 0 && isLand(s, i);
  return cached(s, `start${centre}`, () =>
    nearestTile(s.map, centre, 120, (i) => {
      if (!free(i)) return false;
      const x = i % w;
      for (const [dx, dy] of [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, 4], [4, -4], [-4, -4]]) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || !free(i + dy * w + dx)) return false;
      }
      return true;
    }),
  );
}

/** The tile of the player's first building of a type (-1 = none). */
function buildingTile(s: GameState, me: Player, type: BuildingType): number {
  for (const b of s.buildings.values()) if (b.owner === me.id && b.type === type) return b.tile;
  return -1;
}
const owns = (s: GameState, me: Player, type: BuildingType): boolean => countBuildings(s, me.id, type, false) > 0;
const ownedBuildings = (s: GameState, me: Player): number => {
  let n = 0;
  for (const b of s.buildings.values()) if (b.owner === me.id) n++;
  return n;
};
const ownAttack = (s: GameState, me: Player, after = -1): boolean => s.attacks.some((a) => a.attacker === me.id && a.startTick > after);
const homeTroops = (me: Player): number => me.troops.infantry + me.troops.armor + me.troops.artillery;

/** The strongest attack on the player now (by troops), null = none. */
function attackOnMe(s: GameState, me: Player): { attacker: number; tile: number } | null {
  let best: { attacker: number; tile: number; n: number } | null = null;
  for (const a of s.attacks) {
    if (a.target !== me.id) continue;
    const p = s.players[a.attacker];
    if (!p || isTribe(p)) continue;
    const n = a.troops.infantry + a.troops.armor + a.troops.artillery;
    if (!best || n > best.n) best = { attacker: a.attacker, tile: a.focusTile, n };
  }
  return best;
}

/** First strike that is ready now. */
function readyStrike(c: GuideCtx): StrikeId | null {
  for (const id of STRIKE_ORDER) if (c.strike(id) === 'ready') return id;
  return null;
}

/** Any tech (or Arsenal item) the player could start now. */
function canStartAny(c: GuideCtx, arsenal: boolean): boolean {
  for (const t of Object.keys(TECHS) as TechId[]) {
    if (isArsenalTech(t) !== arsenal) continue;
    if (canResearch(c.s, c.me.id, t).ok) return true;
  }
  return false;
}

const panel = (c: GuideCtx, ...names: string[]): boolean => c.ui.openPanel !== null && names.includes(c.ui.openPanel);
const playing = (c: GuideCtx): boolean => c.s.phase === 'playing';

// ------------------------------------------------------------------------------------------------ opening

/** The opening: start, troops, gold, expand, attack size, a City, a tribe, the standings. */
export function openingSteps(view: { centreTile: () => number; canStartNow?: () => boolean }): GuideStep[] {
  /** online, only the host has Start now: the others wait for the countdown */
  const startNow = (): boolean => view.canStartNow?.() ?? true;
  return [
    {
      id: 'spawn',
      text: 'Pick your start: click open land with room to grow.',
      tile: (c) => startTile(c, view.centreTile()),
      done: (c) => c.me.spawned || c.s.phase !== 'spawn',
    },
    {
      id: 'start',
      text: (c) => {
        const go = startNow() ? 'press Start now' : 'wait for the countdown';
        if (!c.me.spawned) return `Click open land to place your start, then ${go}.`;
        return mods(c.s).randomSpawn ? `Your start was picked for you. ${startNow() ? 'Press Start now to begin.' : 'The war begins after the countdown.'}` : `Good spot. Click again to move it, or ${go}.`;
      },
      // not placed yet (the first step was skipped): the arrow shows open land, Start now appears once placed
      target: (c) => (c.me.spawned && startNow() ? 'start-now' : undefined),
      tile: (c) => (c.me.spawned ? c.me.capital : startTile(c, view.centreTile())),
      done: (c) => c.s.phase !== 'spawn',
    },
    {
      id: 'troops',
      playingOnly: true,
      text: 'Troops: your army. They regrow by themselves, fastest when the bar is near its mark.',
      target: 'troops',
    },
    {
      id: 'gold',
      playingOnly: true,
      text: 'Gold comes in every second. It pays for buildings and research.',
      target: 'resources',
    },
    {
      id: 'expand',
      playingOnly: true,
      text: 'Click empty land next to your border to expand. Each tile costs troops.',
      tile: expandTile,
      // no empty land near the border any more (e.g. the guide was restarted later in a game): nothing to point at
      skipIf: (c) => playing(c) && c.me.capital >= 0 && expandTile(c) < 0,
      begin: (c) => ({ tiles: c.me.tiles, tick: c.s.tick }),
      done: (c, m) => c.me.tiles > m.tiles * 1.6 || ownAttack(c.s, c.me, m.tick),
      timeout: 60,
    },
    {
      id: 'share',
      playingOnly: true,
      text: 'ATTACK: the share of troops each click sends. Drag it, or press [ and ].',
      target: 'attack-share',
      begin: (c) => ({ share: c.ui.attackShare, tick: c.s.tick }),
      done: (c, m) => Math.abs(c.ui.attackShare - m.share) > 0.01 || ownAttack(c.s, c.me, m.tick),
      timeout: 45,
    },
    {
      id: 'city',
      playingOnly: true,
      text: (c) => {
        const cost = buildingCost(c.s, c.me.id, 'city').gold;
        if (c.me.gold < cost) return `A City costs ${cost} gold (you have ${Math.floor(c.me.gold)}). Then press 1 and click your land.`;
        return c.ui.buildMode === 'city' ? 'Now click your land to place the City.' : 'Build a City: press 1 (or Build), then click your land. More troops and gold.';
      },
      target: (c) => (c.ui.buildMode === 'city' ? undefined : 'build-city || build-menu-btn'),
      tile: (c) => (c.ui.buildMode === 'city' ? cityTile(c) : -1),
      // a City of their own (built, or being built) is the goal: one built before this step counts too
      done: (c) => countBuildings(c.s, c.me.id, 'city', true) > 0,
      timeout: 120,
    },
    {
      id: 'tribe',
      playingOnly: true,
      text: (c) => {
        const t = tribeTile(c);
        return t >= 0 && !touches(c.s, t, c.me.id)
          ? 'A tribe (grey land, small army) lies that way: expand at the arrow, then click it.'
          : 'Tribes (grey land, small army) are easy to take: click the one at the arrow.';
      },
      tile: (c) => {
        const t = tribeTile(c);
        if (t < 0 || touches(c.s, t, c.me.id)) return t;
        // not next to us yet: the empty land on our border nearest the tribe
        const near = cached(c.s, `toward${c.me.id}`, () =>
          nearestTile(c.s.map, t, Math.min(200, tileDist(c.s.map, t, home(c)) + 4), (i) => c.s.map.owner[i] === 0 && isLand(c.s, i) && touches(c.s, i, c.me.id)),
        );
        return near >= 0 ? near : t;
      },
      skipIf: (c) => !c.s.players.some((p) => p.alive && isTribe(p)),
      done: (c) => c.s.attacks.some((a) => a.attacker === c.me.id && a.target > 0 && isTribe(c.s.players[a.target])),
      timeout: 90,
    },
    {
      id: 'standings',
      playingOnly: true,
      text: (c) => `Standings: who holds the most land. Hold ${Math.round(victoryShareNow(c.s) * 100)}% of it, or be the last nation, to win.`,
      target: 'leaderboard',
    },
  ];
}

// ------------------------------------------------------------------------------------------------ tips

/** The contextual tips, most useful first when several apply at once. */
export function guideTips(): GuideTip[] {
  /** tick since which the player's troops are full and no attack of theirs runs (per game) */
  const idleSince = new WeakMap<GameState, number>();
  /** the last attack on the player (per game): the tip keeps naming it and pointing at it after a short attack ends */
  const lastAttack = new WeakMap<GameState, { attacker: number; tile: number }>();
  const attack = (c: GuideCtx): { attacker: number; tile: number; now: boolean } | null => {
    const a = attackOnMe(c.s, c.me);
    if (a) lastAttack.set(c.s, a);
    const last = a ?? lastAttack.get(c.s);
    return last ? { ...last, now: !!a } : null;
  };
  return [
    {
      id: 'attacked',
      critical: true,
      text: (c) => {
        const a = attack(c);
        const name = (a && c.s.players[a.attacker]?.name) || 'A neighbour';
        return a && !a.now
          ? `${name} attacked you. Keep troops at home, hit back, or build a Fort (9) on that border.`
          : `${name} attacks you! Troops at home defend. Hit back, or build a Fort (9) there.`;
      },
      tile: (c) => attack(c)?.tile ?? -1,
      when: (c) => playing(c) && attackOnMe(c.s, c.me) !== null,
    },
    {
      id: 'research',
      text: 'Press T for Research and pick a tech: new buildings, stronger troops.',
      target: 'open-research',
      when: (c) => playing(c) && c.sec >= 40 && (c.me.researching !== null || canStartAny(c, false)),
      still: (c) => !panel(c, 'research', 'arsenal'),
      done: (c) => panel(c, 'research', 'arsenal'),
    },
    {
      id: 'doctrine',
      text: `Doctrines are open (${DOCTRINE_KEY}): pick a style of war. It grows the longer you keep it.`,
      target: 'doctrine-go || open-doctrine',
      when: (c) => playing(c) && c.sec >= DOCTRINE_UNLOCK_SECONDS && !c.me.doctrine.id,
      still: (c) => !c.me.doctrine.id,
      done: (c) => !!c.me.doctrine.id,
    },
    {
      id: 'idle',
      text: 'Troops full and idle: they stop growing. Attack, expand or build.',
      target: 'troops',
      when: (c) => {
        const full = playing(c) && c.me.maxPop > 0 && homeTroops(c.me) >= c.me.maxPop * 0.95 && !ownAttack(c.s, c.me);
        if (!full) {
          idleSince.delete(c.s);
          return false;
        }
        const t0 = idleSince.get(c.s) ?? c.s.tick;
        idleSince.set(c.s, t0);
        return c.s.tick - t0 >= 150; // 15 s
      },
      still: (c) => !ownAttack(c.s, c.me),
      done: (c) => ownAttack(c.s, c.me),
    },
    {
      id: 'strike',
      text: (c) => {
        const id = readyStrike(c);
        return id ? `${STRIKES[id].name} ready: press ${STRIKES[id].key} or this button, then click the target.` : 'A strike is ready.';
      },
      target: (c) => {
        const id = readyStrike(c);
        return id ? `strike-${id}` : undefined;
      },
      when: (c) => playing(c) && readyStrike(c) !== null,
      done: (c) => c.ui.aiming !== null,
    },
    {
      id: 'navy',
      text: (c) =>
        c.ui.selectedTile >= 0 && c.s.map.building[c.ui.selectedTile] > 0
          ? 'Order a Warship here. Selected ships take stances: hunt, escort, bombard, blockade.'
          : 'Click your Port, then Warship. Select ships to give them a stance.',
      target: 'order-warship || order-destroyer || order-submarine',
      tile: (c) => buildingTile(c.s, c.me, 'port'),
      when: (c) => playing(c) && owns(c.s, c.me, 'port'),
      done: (c) => c.s.units.some((u) => u.owner === c.me.id && u.type === 'warship'),
    },
    {
      id: 'armor',
      text: 'Click your Factory, then Tank division. Select it, then click enemy land to spearhead.',
      target: 'order-tank-division',
      tile: (c) => buildingTile(c.s, c.me, 'factory'),
      when: (c) => playing(c) && owns(c.s, c.me, 'factory'),
      done: (c) => c.s.units.some((u) => u.owner === c.me.id && u.type === 'tankDivision'),
    },
    {
      id: 'air',
      text: 'Click your Airfield: buy Bombers, then pick Support (a front) or Strategic (income).',
      target: 'air-support || order-bomber',
      tile: (c) => buildingTile(c.s, c.me, 'airfield'),
      when: (c) => playing(c) && owns(c.s, c.me, 'airfield'),
      done: (c) => (c.s.air?.wings ?? []).some((w) => w.owner === c.me.id && (w.mission === 'support' || w.mission === 'strategic')),
    },
    {
      id: 'alliance',
      text: (c) => {
        const r = c.s.allianceRequests.find((q) => q.to === c.me.id);
        const name = r ? c.s.players[r.from]?.name ?? 'A nation' : 'A nation';
        return `${name} offers an alliance. Open Diplomacy (P) to accept or decline.`;
      },
      // the nation's card when it is open, else the Diplomacy button (it carries the request count); the nation
      // is often not in the short standings list
      target: 'nc-accept || open-diplomacy',
      when: (c) => playing(c) && c.s.allianceRequests.some((q) => q.to === c.me.id),
      done: (c) => !c.s.allianceRequests.some((q) => q.to === c.me.id),
    },
    {
      id: 'coalition',
      text: (c) =>
        coalitionLeader(c.s) === c.me.id
          ? 'Nations formed a coalition against you. Fort your borders and find allies.'
          : 'Nations formed a coalition against the leader: join in, or grow in peace.',
      target: (c) => {
        const l = coalitionLeader(c.s);
        return l ? `lb-row-${l} || leaderboard` : 'leaderboard';
      },
      when: (c) => playing(c) && coalitionLeader(c.s) > 0,
    },
    {
      id: 'arsenal',
      text: 'Arsenal (T, Arsenal tab): better ships, tanks and planes. Each splits into two paths: pick one.',
      target: (c) => (panel(c, 'research') ? 'tab-arsenal' : 'open-research'),
      // later in the game (after the doctrine pick opens), once an Arsenal item can be started
      when: (c) => playing(c) && c.sec >= DOCTRINE_UNLOCK_SECONDS + 60 && canStartAny(c, true),
      still: (c) => !panel(c, 'arsenal'),
      done: (c) => panel(c, 'arsenal'),
    },
    {
      id: 'upgrade',
      text: 'Upgrade many at once: Shift-drag over your buildings, then Upgrade x1, x3 or x5.',
      target: 'building-selection',
      tile: (c) => c.me.capital,
      when: (c) => playing(c) && ownedBuildings(c.s, c.me) >= 5,
      done: (c) => c.ui.selectedBuildings > 0,
    },
  ];
}
