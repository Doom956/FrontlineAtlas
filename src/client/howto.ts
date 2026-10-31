// The "How to play" page (title screen and in-game help): a quick start on top, everything else in collapsible
// sections that are closed by default, plus a search box that opens the sections holding a match.
// Numbers come from the sim config, so the text follows balance changes.
import { MASTERY_CAP } from '../sim/arsenal';
import {
  ATOM_RADIUS,
  BARRAGE_DISABLE_SECONDS,
  BARRAGE_MIN_ARTILLERY,
  BARRAGE_RANGE,
  BEACHHEAD_SUPPLY_SECONDS,
  BOMBER_RADIUS,
  BUILDINGS,
  BUILDING_ORDER,
  COALITION_LAND_SHARE,
  DOCTRINES,
  DOCTRINE_ADAPT_SECONDS,
  DOCTRINE_LEVEL_SECONDS,
  DOCTRINE_SWITCH_COOLDOWN,
  DOCTRINE_UNLOCK_SECONDS,
  ENDGAME_SMALL_TILES,
  HEARTLAND_DEFENSE,
  HUMAN_GRACE_SECONDS,
  LAST_STAND_MAX,
  LAST_STAND_START,
  MATCHUP,
  OVERTIME_DROP_PER_MINUTE,
  OVERTIME_MINUTES,
  OVERTIME_MIN_SHARE,
  PARADROP_RANGE,
  RETREAT_LOSS,
  ROCKET_RADIUS,
  SAM_COOLDOWN,
  TANK_ARTILLERY_SUPPORT,
  TANK_FALLBACK_LOSS,
  TANK_FALLBACK_RADIUS,
  TANK_LAUNCH_REACH,
  TANK_SPEARHEAD_MAX_DEPTH,
  TANK_SPEARHEAD_WIDTH,
  TECHS,
  TECH_ORDER,
  TERRAIN,
  TRAITOR_DEFENSE,
  TRAITOR_DURATION,
  TRIBE_ANNEX_TILES,
  UNITS,
  ALLIANCE_DURATION,
  ALLY_TRADE_BONUS,
  AUTO_EMBARGO_SECONDS,
  VICTORY_LAND_SHARE,
} from '../sim/config';
import type { BuildingType, DoctrineId, TerrainId } from '../sim/types';
import { forceLimit } from './allies';
import { el } from './dom';
import { UNIT_TEXT } from './forces';
import { lineIcon, worldGlyph } from './hud/glyph';
import { BUILDING_SHORT, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect } from './hud/text';
import { iconDataUrl, type IconId } from './icons';
import { STRIKE_ORDER, STRIKES, type StrikeId } from './strikes';

const TROOP_LABEL = { infantry: 'Infantry', armor: 'Armor', artillery: 'Artillery' } as const;
const n = (v: number): string => v.toLocaleString('en-US');
const pct = (v: number): number => Math.round(v * 100);
const min = (seconds: number): number => Math.round(seconds / 60);

/** One line per strike: what it needs first and what it does. */
const STRIKE_HELP: Record<StrikeId, string> = {
  barrage: `Needs an Arsenal and ${n(BARRAGE_MIN_ARTILLERY)} artillery. Shells enemy land up to ${BARRAGE_RANGE} tiles from your border: kills troops, silences forts and SAM sites for ${BARRAGE_DISABLE_SECONDS} s.`,
  bomb: `Needs Flight, an Airfield and a bomber. Wrecks buildings and kills troops within ${BOMBER_RADIUS} tiles.`,
  paradrop: `Needs Flight and an Airfield. Drops infantry up to ${PARADROP_RANGE} tiles away; they attack from where they land.`,
  rocket: `Needs Rocketry and a Missile Silo. Hits anywhere: destroys enemy buildings within ${ROCKET_RADIUS} tiles.`,
  atomBomb: `Needs Nuclear Fission and a Missile Silo. Wipes out everything within ${ATOM_RADIUS} tiles, yours too; every nation turns on you.`,
};

/** True when every word of the query appears in the text (case-insensitive); an empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

interface Row {
  icon?: string;
  title: string;
  text: string;
  key?: string;
  /** a second, dimmer line (e.g. the counter) */
  note?: string;
}

function pic(id: IconId, px = 18): string {
  try {
    return `<img src="${iconDataUrl(id, px)}" width="${px}" height="${px}" alt="">`;
  } catch {
    return '';
  }
}

/** The page. Call once per place it is shown; each call builds its own DOM and search state. */
export function howToPlayContent(): HTMLElement {
  const root = el('div', 'howto');

  // ---------------------------------------------------------------- builders
  const item = (row: Row): HTMLLIElement => {
    const li = el('li', 'hw-item');
    if (row.icon !== undefined) {
      const ic = el('span', 'hw-ico');
      ic.innerHTML = row.icon;
      li.append(ic);
    }
    const t = el('span', 'hw-t');
    t.append(el('b', '', row.title));
    if (row.key) t.append(el('kbd', '', row.key));
    const d = el('span', 'hw-d', row.text);
    if (row.note) d.append(el('span', 'hw-note', row.note));
    li.append(t, d);
    return li;
  };
  const list = (rows: Row[], withIcons = false): HTMLUListElement => {
    const ul = el('ul', withIcons ? 'hw-list hw-icons' : 'hw-list');
    for (const r of rows) ul.append(item(r));
    return ul;
  };
  /** A titled block inside a section; hidden by the search when none of its items match. */
  const group = (title: string, body: HTMLElement): HTMLElement => {
    const g = el('div', 'hw-grp');
    if (title) g.append(el('h4', 'hw-sub', title));
    g.append(body);
    return g;
  };
  const section = (title: string, hint: string, groups: HTMLElement[]): HTMLDetailsElement => {
    const d = el('details', 'hw-sec');
    const s = el('summary');
    s.append(el('span', 'hw-h', title), el('span', 'hw-hint', hint));
    const body = el('div', 'hw-body');
    body.append(...groups);
    d.append(s, body);
    return d;
  };
  const table = (head: string[], rows: { cells: (string | HTMLElement)[]; cls?: string[] }[], cls = ''): HTMLTableElement => {
    const t = el('table', `tbl ${cls}`.trim());
    const h = el('tr');
    for (const c of head) h.append(el('th', '', c));
    const th = el('thead');
    th.append(h);
    const tb = el('tbody');
    for (const r of rows) {
      const tr = el('tr', 'hw-item');
      r.cells.forEach((c, i) => {
        const td = el('td', r.cls?.[i] ?? '');
        td.append(c);
        tr.append(td);
      });
      tb.append(tr);
    }
    t.append(th, tb);
    return t;
  };

  // ---------------------------------------------------------------- search
  const find = el('div', 'hw-find');
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search the guide: fort, ally, tank, T ...';
  input.setAttribute('aria-label', 'Search the guide');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.test = 'howto-search';
  const count = el('span', 'hw-count');
  count.setAttribute('aria-live', 'polite');
  find.append(input, count);

  // ---------------------------------------------------------------- quick start
  const quickRows: Row[] = [
    { icon: lineIcon('expand', 18), title: 'Expand', text: 'Click empty land next to yours. Click an enemy border to attack it.' },
    { icon: lineIcon('attack', 18), title: 'Attack %', text: 'Bottom bar, keys [ and ]: the share of your troops each click sends. Click again to send more.', key: '[ ]' },
    { icon: worldGlyph('city', 18), title: 'Cities', text: 'More troops and gold. Farms add troops, Markets add gold.' },
    { icon: lineIcon('build', 18), title: 'Build', text: 'Open the build menu, pick a building, click your land.', key: 'Tab' },
    { icon: lineIcon('science', 18), title: 'Research', text: 'Science builds up by itself. Auto picks techs; choose your own here.', key: 'T' },
    { icon: lineIcon('doctrine', 18), title: 'Doctrines', text: `At ${min(DOCTRINE_UNLOCK_SECONDS)}:00 pick a play style: Blitz, Fortress, Siege ...`, key: 'Shift D' },
    { icon: lineIcon('rocket', 18), title: 'Strikes', text: 'A strike icon lights up in the bottom bar when ready: press its key, click the target.' },
    { icon: lineIcon('ally', 18), title: 'Allies', text: 'Click a nation in the standings, then Ally. Allies cannot attack each other.', key: 'P' },
  ];
  const quick = el('section', 'hw-quick');
  quick.append(
    el('h3', 'hw-qh', 'Quick start'),
    el('p', 'hw-goal', `Win with ${pct(VICTORY_LAND_SHARE)}% of the land or as the last nation standing. First click a land tile to place your capital.`),
    list(quickRows, true),
  );
  quick.querySelector('ul')?.classList.add('hw-qlist');

  // ---------------------------------------------------------------- combat and terrain
  const attackRows: Row[] = [
    { title: 'Target', text: 'A click picks who you hit (nation, tribe or wilderness), not a point: the whole shared border advances. Click again to add troops.' },
    { title: 'Odds', text: `Send more than the defender has at home to lose fewer troops per tile. Past ${forceLimit()}:1 extra troops add little; the odds badge says when.` },
    { title: 'Hit back', text: 'Attacking a nation that attacks you cancels its attack troop for troop.' },
    { title: 'Retreat', text: `Costs ${pct(RETREAT_LOSS)}% of the troops (nothing in the wilderness).` },
    { title: 'Across water', text: `A transport leaves from your nearest coast. A landing is supplied for ${BEACHHEAD_SUPPLY_SECONDS} s.` },
    { title: 'Regrowth', text: 'Troops regrow fastest near the brass marker on the troop bar (about 40% of the cap). A full bar barely grows: keep spending.' },
    { title: 'Heartland', text: `Land deep inside a nation's borders defends up to x${1 + HEARTLAND_DEFENSE} better.` },
    { title: 'Last stand', text: `A nation ${LAST_STAND_START}x or more smaller than its attacker defends up to x${1 + LAST_STAND_MAX}.` },
    { title: 'Supply', text: 'Fronts far from your capital, cities and supply depots fight weaker (overlay: B). Forts protect the hatched land.', key: 'B' },
    { title: 'Tribes', text: 'Small grey peoples with an army number. They never attack, accept any alliance (not from a traitor) and are cheap land early.' },
    { title: 'Collapse', text: `A nation under ${ENDGAME_SMALL_TILES} tiles (a tribe: ${TRIBE_ANNEX_TILES}) falls when hit; you get ${min(HUMAN_GRACE_SECONDS)} min to grow first. Pockets walled in by one nation are annexed.` },
    { title: 'Overtime', text: `After ${OVERTIME_MINUTES} min the land share needed to win drops ${pct(OVERTIME_DROP_PER_MINUTE)}% a minute, down to ${pct(OVERTIME_MIN_SHARE)}%.` },
  ];
  const troopOrder = ['infantry', 'armor', 'artillery'] as const;
  const matchup = table(
    ['Attacker', ...troopOrder.map((d) => `vs ${TROOP_LABEL[d]}`)],
    troopOrder.map((a) => ({
      cells: [TROOP_LABEL[a], ...troopOrder.map((d) => `x${MATCHUP[a][d].toFixed(1)}`)],
      cls: ['b', ...troopOrder.map((d) => (MATCHUP[a][d] > 1.05 ? 'good' : MATCHUP[a][d] < 0.95 ? 'bad' : ''))],
    })),
  );
  const troopRows: Row[] = [
    { title: 'Infantry', text: 'Grows by itself. Best in forest, hills and mountains.' },
    { title: 'Armor', text: 'Made at Factories. Fast and strong on open ground, poor in rough terrain, burns oil.' },
    { title: 'Artillery', text: 'Made at Arsenals. Breaks forts; fragile alone.' },
    { title: 'Mix', text: 'Auto (default) counters your neighbours; set it yourself in Army. Army sizes are public; the mix shows only near your Watchtowers or for allies.', key: 'U' },
  ];
  const terrainRows: Row[] = ([2, 3, 4, 5, 6, 7, 8] as TerrainId[]).map((id) => ({
    icon: worldGlyph(TERRAIN_GLYPH[id], 18),
    title: TERRAIN[id].name,
    text: terrainEffect(id) + '.',
  }));
  const resourceRows: Row[] = ([[1, 'iron'], [2, 'oil'], [3, 'fertile']] as const).map(([k, id]) => ({
    icon: worldGlyph(id, 18),
    title: RESOURCE_TEXT[k].name,
    text: RESOURCE_TEXT[k].use,
  }));
  const combat = section('Combat and terrain', 'attacks, troop types, terrain', [
    group('Attacks and the end of a game', list(attackRows)),
    group('Troop types', (() => {
      const w = el('div');
      w.append(list(troopRows), matchup);
      return w;
    })()),
    group('Terrain', list(terrainRows, true)),
    group('Resources', list(resourceRows, true)),
  ]);

  // ---------------------------------------------------------------- buildings
  const buildRows: Row[] = [
    { title: 'Place', text: 'Pick a building (hotkey or build bar), click your land. It snaps to the nearest free spot; near one of the same kind it upgrades. Cursor preview: green builds, blue upgrades, red says why not.' },
    { title: 'Build x3 / x5', text: 'Or hold Shift: one click queues that many levels (a City goes straight to level 5). Only what you can pay is queued; the building card cancels for a refund.' },
    { title: 'Upgrade many', text: 'Hold Shift and drag a box over your buildings: they are selected (chips filter by type). Press U or click Upgrade x1 / x3 / x5: every one gets more levels, cheapest first, as far as your money goes. Shift+U switches x1 / x3 / x5; Esc clears.' },
    { title: 'Quick bar', text: 'Six buildings you use most sit by the Build button. Right-click one in the menu to pin it.' },
    { title: 'Spend', text: 'Button next to your gold. Mercenaries: troops now for gold (the price rises with each hire). War bonds: gold now for stronger attacks for a while.' },
  ];
  const buildingRows: Row[] = BUILDING_ORDER.map((b: BuildingType) => {
    const info = BUILDINGS[b];
    return {
      icon: worldGlyph(b, 18),
      title: info.name,
      key: info.hotkey || undefined,
      text: BUILDING_SHORT[b] + (info.tech ? `. Needs ${TECHS[info.tech].name}` : '') + '.',
    };
  });
  const buildings = section('Buildings', 'placing, upgrading, every building', [
    group('Placing and spending', list(buildRows)),
    group('All buildings (locked ones appear once their tech is close)', list(buildingRows, true)),
  ]);

  // ---------------------------------------------------------------- research and doctrines
  const tiers = Math.max(...TECH_ORDER.map((t) => TECHS[t].tier));
  const researchRows: Row[] = [
    { title: 'Science', text: `Builds up over time (Research Labs add more). ${TECH_ORDER.length} techs in ${tiers} tiers; each also costs gold.` },
    { title: 'Auto', text: 'The next useful tech starts by itself. Choosing one by hand turns Auto off.', key: 'T' },
    { title: 'OR pairs', text: 'Some techs come in pairs marked OR (Stock Exchange or Free Trade, Blitz Tactics or Trench Warfare ...). Taking one locks the other for good.' },
    { title: 'Switching', text: 'Clicking another tech while one is in progress asks for a second click: the current one loses its progress and gold.' },
  ];
  const arsenalRows: Row[] = [
    { title: 'Arsenal tab', text: 'The second tab of the Research panel: one row each for Navy, Armor, Air and Shared. Bought like any tech.', key: 'T' },
    { title: 'Paths', text: 'Each pillar forks (OR): Destroyers + Battleships or Submarines + Carriers; Light or Heavy tanks; Ground-attack planes or Heavy bombers. One path per game.' },
    { title: 'Specials', text: 'New behaviour, not stats: Naval Mines, Amphibious Tanks, Drop Tanks, Night Bombing, Early Warning. Any path can take them.' },
    { title: 'Shared', text: 'Mechanized Infantry holds what spearheads take; Recon Planes reveal armies, doctrines and buildings (order it at an Airfield).' },
    { title: 'Mastery', text: `The last card of a row. At most ${MASTERY_CAP} masteries per game: the header counts "Mastery 1 of ${MASTERY_CAP}".` },
  ];
  const doctrineRows: Row[] = [
    { title: 'Unlock', text: `At ${min(DOCTRINE_UNLOCK_SECONDS)}:00 (half that in a fast game) pick one. It only adds a bonus: every unit, building and strike stays open. The picker marks the three that suit your land and neighbours.`, key: 'Shift D' },
    { title: 'Levels', text: `Level 2 after ${min(DOCTRINE_LEVEL_SECONDS[1])} min, level 3 (a small extra perk) after ${min(DOCTRINE_LEVEL_SECONDS[2])} min with the same doctrine.` },
    { title: 'Switching', text: `The first choice is free. A switch costs gold, leaves you ${DOCTRINE_ADAPT_SECONDS} s with none, restarts at level 1, then has a ${min(DOCTRINE_SWITCH_COOLDOWN)} min cooldown.` },
    { title: 'Scouting', text: "A neighbour's doctrine shows on its card once you share a border, have a Watchtower near it or are allied. Counter it." },
  ];
  const doctrineList: Row[] = (Object.keys(DOCTRINES) as DoctrineId[]).map((id) => ({
    icon: lineIcon(DOCTRINES[id].icon, 18),
    title: DOCTRINES[id].name,
    text: DOCTRINES[id].short,
  }));
  const research = section('Research and doctrines', 'techs, OR pairs, Arsenal paths, mastery, play styles', [
    group('Research', list(researchRows)),
    group('Arsenal: navy, armor and air paths', list(arsenalRows)),
    group('Doctrines', list(doctrineRows)),
    group('The doctrines', list(doctrineList, true)),
  ]);

  // ---------------------------------------------------------------- special units and strikes
  const strikeRows: Row[] = STRIKE_ORDER.map((id) => ({ icon: pic(STRIKES[id].icon), title: STRIKES[id].name, text: STRIKE_HELP[id], key: STRIKES[id].key }));
  const strikeHow: Row[] = [
    { title: 'Fire', text: 'A ready strike shows at the right end of the bottom bar (a ring while it reloads). Press its key, then click the target. Esc or right-click cancels. Forces says how to unlock the locked ones.', key: 'Y' },
  ];
  const unitRows: Row[] = (['warship', 'transport', 'bomber', 'fighter', 'transportPlane'] as const).map((id) => ({
    icon: pic(UNIT_TEXT[id].icon),
    title: UNIT_TEXT[id].name,
    text: UNIT_TEXT[id].what,
    note: `Counter: ${UNIT_TEXT[id].counter}`,
  }));
  const unitHow: Row[] = [
    { title: 'Buy', text: 'Warships, bombers and fighters are in the Military group of the build menu (or at a Port / Airfield). Forces lists everything you own with its orders.', key: 'Y' },
    { title: 'Orders', text: 'Click your warship (or Select in Forces), then click water to move it. Shift+W selects every warship. Hover any unit to see what it is doing; enemy units heading for you get a red ring.' },
  ];
  const tank = UNITS.tankDivision;
  const tankRows: Row[] = [
    { title: 'Build', text: `Military group, needs Mechanization and a Factory (one per Factory level). Costs ${n(tank.gold)} gold, ${tank.iron} iron, ${tank.oil} oil and takes armor from your pool.` },
    { title: 'Move', text: 'Select it like a warship (click, or Shift+drag a box; Shift+A picks all), then click your land.' },
    { title: 'Spearhead', text: `Click enemy land within ${TANK_LAUNCH_REACH} tiles of your border: a ${TANK_SPEARHEAD_WIDTH}-tile-wide breakthrough up to ${TANK_SPEARHEAD_MAX_DEPTH} tiles deep. Fast on plains and desert, slow in forest, hills and swamp.` },
    { title: 'Stalls at', text: `Mountains and forts, unless ${pct(TANK_ARTILLERY_SUPPORT)}% of the division is artillery (then slowly, at high loss).` },
    { title: 'Overrun', text: `A division that is not attacking and loses the ground under it falls back to your land within ${TANK_FALLBACK_RADIUS} tiles (${pct(TANK_FALLBACK_LOSS)}% of its troops lost) if it still has a fifth of a full division, else it is overrun and its troops go home.` },
  ];
  const counterTable = table(
    ['Threat', 'Stopped by'],
    [
      ['Bomber, cargo plane', 'SAM sites; fighters at an Airfield'],
      ['Rocket', 'SAM sites (one hit)'],
      ['Atom bomb', 'SAM sites (two hits)'],
      ['Artillery shells', 'Nothing: only range limits them'],
      ['Warship, transport', 'Enemy warships'],
      ['Attacks on land', 'Forts slow them; artillery and barrages break forts'],
      ['Tank spearhead', 'Mountains and forts; armor-heavy defence'],
    ].map((r) => ({ cells: r })),
    'keys-tbl',
  );
  const samRows: Row[] = [
    { title: 'SAM sites', text: `Never miss. A level-L SAM holds L shots and reloads one every ${SAM_COOLDOWN} s divided by L. Send more threats than it can load, or silence it with a barrage first.` },
  ];
  const special = section('Special units and strikes', 'strikes, warships, planes, tank divisions, counters', [
    group('Strikes', (() => {
      const w = el('div');
      w.append(list(strikeHow), list(strikeRows, true));
      return w;
    })()),
    group('Warships and aircraft', (() => {
      const w = el('div');
      w.append(list(unitHow), list(unitRows, true));
      return w;
    })()),
    group('Tank divisions', list(tankRows)),
    group('Counters', (() => {
      const w = el('div');
      w.append(counterTable, list(samRows));
      return w;
    })()),
  ]);

  // ---------------------------------------------------------------- diplomacy and allies
  const dipRows: Row[] = [
    { title: 'Actions', text: "Ally, Gift and Embargo are on a nation's card (click it in the standings) and in the radial menu.", key: 'P' },
    { title: 'Alliances', text: `Last ${min(ALLIANCE_DURATION)} min; both sides can renew in the last minute. Allies cannot attack each other, and trade pays allies ${pct(ALLY_TRADE_BONUS)}% more.` },
    { title: 'Traitor', text: `Breaking an alliance makes you a traitor for ${TRAITOR_DURATION} s: defence x${TRAITOR_DEFENSE} and everyone trusts you less.` },
    { title: 'Attacked', text: `The attacker loses trade with you for ${min(AUTO_EMBARGO_SECONDS)} min and pending alliance requests between you are cancelled.` },
    { title: 'Ask allies', text: 'The line under an ally\'s name says whether it will help or is busy. "Ask to attack..." names an enemy, "Ask for troops" asks for some; right-click enemy land for "Ask allies". The answer comes as a toast.' },
    { title: 'Fund an ally', text: 'Spend > fund: send gold; for a while it fights harder against your enemies and joins your wars more readily.' },
    { title: 'Coalitions', text: `When one nation holds ${pct(COALITION_LAND_SHARE)}% of the land and is well ahead, the others team up against it. A toast says so.` },
    { title: 'Teams', text: 'In a teams game, teammates are allied all game and win together.' },
    { title: 'Symbols', text: 'Crown: biggest nation. Handshake: ally. Envelope: alliance request. Broken shield: traitor.' },
  ];
  const diplomacy = section('Diplomacy and allies', 'alliances, traitors, asking for help', [group('', list(dipRows))]);

  // ---------------------------------------------------------------- multiplayer
  const mpRows: Row[] = [
    { title: 'Public games', text: 'Multiplayer on the title screen lists them (Free for all, Teams, Special with random modifiers). Join one: it starts when its countdown ends and AI nations fill the free places.' },
    { title: 'Private lobby', text: 'Create private lobby: the single-player setup plus a seat count. Share the 6-character code or invite link; friends press Join. The host changes settings, kicks and presses Start.' },
    { title: 'Host pause', text: 'Only the host of a private game can pause (Space or the pause button). Guests see the button disabled; public games never pause.', key: 'Space' },
    { title: 'Speed', text: 'No game speed online: the server sets the clock.' },
    { title: 'Watch', text: 'Joins as a spectator: the whole map, no actions. A player whose nation falls keeps watching.' },
    { title: 'Reconnect', text: 'If your connection drops, the game reconnects and catches up. Reload the page to get back into your game.' },
  ];
  const multiplayer = section('Multiplayer', 'public games, private lobbies, host pause', [group('', list(mpRows))]);

  // ---------------------------------------------------------------- controls
  const keys: [string[], string][] = [
    [['Left click'], 'Attack land next to yours; select your building; place a building in build mode'],
    [['Right click', 'long press'], 'Radial menu: the likely action in the middle, the rest on a ring'],
    [['Drag', 'W A S D', 'arrows'], 'Pan the map'],
    [['Wheel'], 'Zoom'],
    [['Tab'], 'Build menu'],
    [['1-9', '0', 'Q E R H F G N'], 'Building hotkeys (hold Shift to place several)'],
    [['[', ']'], 'Attack share -/+'],
    [['U', 'Y', 'T', 'P', 'J', 'L'], 'Army, Forces, Research, Diplomacy, Events, Map key (terrain and symbols)'],
    [['Shift D'], 'Doctrine picker'],
    [['Shift W', 'Shift A'], 'Select every warship / tank division'],
    [['Shift drag'], 'Box: select your warships, tank divisions and buildings inside'],
    [['U', 'Shift U'], 'With buildings selected: upgrade them / switch x1, x3, x5'],
    [['Z X K I O'], 'Strikes: barrage, bomb, paradrop, rocket, atom bomb'],
    [['Space'], 'Pause (single player; the host of a private game)'],
    [['+', '-'], 'Game speed (single player)'],
    [['V', 'B', 'M'], 'Resource overlay / supply overlay / minimap'],
    [['C'], 'Centre on your capital'],
    [['?', 'F1'], 'This help'],
    [['Esc'], 'Cancel or close'],
  ];
  const keysTable = table(
    ['Key', 'Action'],
    keys.map(([ks, d]) => {
      const c = el('span', 'hw-keys');
      for (const k of ks) c.append(el('kbd', '', k));
      return { cells: [c, d] };
    }),
    'keys-tbl',
  );
  const controls = section('Controls', 'hotkeys', [group('', keysTable)]);

  const sections = [combat, buildings, research, special, diplomacy, multiplayer, controls];
  const empty = el('p', 'hw-empty hidden', 'Nothing matches. Try a shorter word.');
  root.append(find, quick, ...sections, empty);

  // ---------------------------------------------------------------- search behaviour
  const items = Array.from(root.querySelectorAll<HTMLElement>('.hw-item'));
  const texts = new Map(items.map((i) => [i, (i.textContent ?? '').toLowerCase()]));
  const groups = Array.from(root.querySelectorAll<HTMLElement>('.hw-grp'));
  const tables = Array.from(root.querySelectorAll<HTMLElement>('table'));
  let saved: boolean[] | null = null;

  const clearMarks = (): void => {
    const marks = root.querySelectorAll('mark.hw-hit');
    marks.forEach((m) => m.replaceWith(document.createTextNode(m.textContent ?? '')));
    if (marks.length) root.normalize();
  };
  const highlight = (target: HTMLElement, words: string[]): void => {
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) nodes.push(nd as Text);
    for (const tn of nodes) {
      const parts = tn.data.split(re);
      if (parts.length < 2) continue;
      const frag = document.createDocumentFragment();
      parts.forEach((p, i) => {
        if (!p) return;
        if (i % 2 === 1) frag.append(el('mark', 'hw-hit', p));
        else frag.append(p);
      });
      tn.replaceWith(frag);
    }
  };
  const apply = (): void => {
    clearMarks();
    const q = input.value.trim();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      for (const i of items) i.hidden = false;
      for (const g of groups) g.hidden = false;
      for (const t of tables) t.hidden = false;
      quick.hidden = false;
      sections.forEach((d, k) => {
        d.hidden = false;
        if (saved) d.open = saved[k];
      });
      saved = null;
      count.textContent = '';
      empty.classList.add('hidden');
      return;
    }
    if (!saved) saved = sections.map((d) => d.open);
    let hits = 0;
    for (const i of items) {
      const ok = matchesQuery(texts.get(i) ?? '', q);
      i.hidden = !ok;
      if (ok) {
        hits++;
        highlight(i, words);
      }
    }
    for (const t of tables) t.hidden = !t.querySelector('.hw-item:not([hidden])');
    for (const g of groups) g.hidden = !g.querySelector('.hw-item:not([hidden])');
    quick.hidden = !quick.querySelector('.hw-item:not([hidden])');
    for (const d of sections) {
      const any = !!d.querySelector('.hw-item:not([hidden])');
      d.hidden = !any;
      d.open = any;
    }
    count.textContent = hits ? `${hits} match${hits === 1 ? '' : 'es'}` : '';
    empty.classList.toggle('hidden', hits > 0);
  };
  input.addEventListener('input', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // first Esc clears the search; the next one leaves the box so Esc can close the page
    if (input.value) {
      input.value = '';
      apply();
    } else {
      input.blur();
    }
    e.stopPropagation();
  });

  return root;
}
