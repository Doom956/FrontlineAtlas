// Plain-word explanations for the HUD: terrain, resources, buildings, build categories, abilities.
// Numbers come from config, so the text follows balance changes.
import { BUILDINGS, TECHS, TERRAIN } from '../../sim/config';
import { Resource } from '../../sim/types';
import type { BuildingType, TerrainId } from '../../sim/types';
import type { TerrainGlyphId } from './glyph';

export const TERRAIN_GLYPH: Record<number, TerrainGlyphId> = {
  0: 'water',
  1: 'water',
  2: 'plains',
  3: 'forest',
  4: 'hills',
  5: 'mountains',
  6: 'desert',
  7: 'swamp',
  8: 'tundra',
};

function pctDelta(v: number): string {
  const d = Math.round((v - 1) * 100);
  return `${d > 0 ? '+' : ''}${d}%`;
}

/** One line on what a terrain does, e.g. "+40% defence; infantry strong, armor weak; attacks 30% slower". */
export function terrainEffect(id: TerrainId): string {
  const t = TERRAIN[id];
  if (id <= 1) return id === 0 ? 'Open sea: only ships cross it.' : 'Coastal water: transports land troops from here.';
  const parts: string[] = [];
  parts.push(Math.abs(t.defense - 1) < 0.01 ? 'normal defence' : `${pctDelta(t.defense)} defence`);
  const strong: string[] = [];
  const weak: string[] = [];
  for (const k of ['infantry', 'armor', 'artillery'] as const) {
    if (t.attack[k] > 1.05) strong.push(k);
    else if (t.attack[k] < 0.95) weak.push(k);
  }
  const tw: string[] = [];
  if (strong.length) tw.push(`${strong.join(' and ')} strong`);
  if (weak.length) tw.push(`${weak.join(' and ')} weak`);
  if (tw.length) parts.push(tw.join(', '));
  if (t.speed < 0.95) parts.push(`attacks ${Math.round((1 - t.speed) * 100)}% slower`);
  return parts.join('; ');
}

/** Second line: what the land is worth and what can't be built. */
export function terrainNote(id: TerrainId): string {
  const t = TERRAIN[id];
  if (id <= 1) return '';
  const notes: string[] = [];
  if (t.popPerTile >= 25) notes.push('Rich land: raises your troop cap the most');
  else if (t.popPerTile <= 8) notes.push('Poor land: adds little to your troop cap');
  if (t.noBuild.length) notes.push(`no ${t.noBuild.map((b) => BUILDINGS[b].name + 's').join(' or ')}`);
  return notes.join('; ');
}

export interface ResourceText {
  name: string;
  /** what to build there and what it gives */
  use: string;
  build: BuildingType;
}
export const RESOURCE_TEXT: Record<number, ResourceText> = {
  [Resource.Iron]: { name: 'Iron', use: 'Build a Mine within 2 tiles: iron for armor, artillery and military buildings.', build: 'mine' },
  [Resource.Oil]: { name: 'Oil', use: 'Build an Oil Well within 2 tiles: oil keeps armor and aircraft running.', build: 'oilWell' },
  [Resource.Fertile]: { name: 'Fertile land', use: 'A Farm here counts double: more troops and faster growth.', build: 'farm' },
};

/** Short "what it does" per building (the tooltip's first line; the config description has the numbers). */
export const BUILDING_SHORT: Record<BuildingType, string> = {
  city: 'More troops and gold; supplies nearby fronts',
  farm: 'More troops and faster regrowth',
  market: 'More gold',
  mine: 'Iron from a nearby iron deposit',
  oilWell: 'Oil from a nearby oil deposit',
  barracks: 'Faster troop regrowth, fewer infantry losses',
  factory: 'Turns troops into armor',
  arsenal: 'Turns troops into artillery',
  fort: 'Attackers lose double and slow down nearby',
  supplyDepot: 'Supplies fronts far from your cities',
  watchtower: 'See enemy army mixes nearby, early warnings',
  port: 'Trade gold, faster transports, warships',
  lab: 'More science for research',
  hospital: 'Part of your attack losses come back',
  airfield: 'Bombers, fighters and paratroopers',
  sam: 'Shoots down missiles and aircraft',
  silo: 'Launches rockets and atom bombs',
};

/** Short line and long description of a building, adjusted to the game's rules (a silo without atom bombs). */
export function buildingTexts(noNukes: boolean, type: BuildingType, description: string): { short: string; description: string } {
  if (type === 'silo' && noNukes) return { short: 'Launches rockets', description: 'Launches rockets (Rocketry); one launch slot per level. Atom bombs are off in this game.' };
  return { short: BUILDING_SHORT[type], description };
}

export type BuildTab = 'economy' | 'military' | 'defence' | 'special';
export const BUILD_TABS: { id: BuildTab; label: string }[] = [
  { id: 'economy', label: 'Economy' },
  { id: 'military', label: 'Military' },
  { id: 'defence', label: 'Defence' },
  { id: 'special', label: 'Special' },
];
export const BUILD_TAB_OF: Record<BuildingType, BuildTab> = {
  city: 'economy',
  farm: 'economy',
  market: 'economy',
  mine: 'economy',
  oilWell: 'economy',
  lab: 'economy',
  barracks: 'military',
  factory: 'military',
  arsenal: 'military',
  supplyDepot: 'military',
  hospital: 'military',
  fort: 'defence',
  watchtower: 'defence',
  sam: 'defence',
  port: 'special',
  airfield: 'special',
  silo: 'special',
};

export function techName(t: keyof typeof TECHS): string {
  return TECHS[t].name;
}

export const ABILITY_TEXT = {
  paradrop:
    'Paratroopers: a cargo plane from your Airfield drops troops behind enemy lines. They land as a new attack from the drop point. Needs Flight and an Airfield in range; the plane needs time to come back.',
  barrage:
    'Artillery barrage: your artillery shells an area near your border. Kills defending troops there and damages buildings. Needs artillery at home; the guns reload between barrages.',
} as const;

export function article(name: string): string {
  return /^[AEIOU]/i.test(name) ? 'an' : 'a';
}
