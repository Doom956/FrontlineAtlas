// Supply lines, in words (client only, no DOM): the toasts for the supply events as the viewer sees them, the line a
// strike target shows when it would cut an enemy's supply, and the map key entries for the supply art. The sim names
// the events for the event list (supplylines.ts); here the same facts are phrased from the viewer's side: "Your ...",
// "You cut Red's supply at their city: their eastern front is slower for 45 s". Cities and ports have no names in the game, so a hub is said
// by its kind and a front by the compass word the sim gives.
import { SUPPLY_LINES, TICKS_PER_SECOND } from '../sim/config';
import { buildingAt } from '../sim/buildings';
import { forEachInRadius } from '../sim/grid';
import { hubCutSources, hubRepairSeconds } from '../sim/supplylines';
import type { GameEvent, GameState, Player, SupplyEventInfo } from '../sim/types';

export interface SupplyToast {
  text: string;
  kind: 'good' | 'bad' | 'info' | 'warn';
  icon: string;
  /** same key = replaces the toast still showing */
  key: string;
}

/** A hub kind as a plain word ("beachhead" is a landing). */
export function hubWord(kind: SupplyEventInfo['hubKind']): string {
  if (!kind) return 'hub';
  return kind === 'beachhead' ? 'landing' : kind;
}

const front = (dir: string): string => (dir ? `${dir} front` : 'front');
const forts = (n: number): string => `${n} ${n === 1 ? 'fort' : 'forts'}`;

/**
 * The toast of a supply event for `me`, or null (not a supply event, or not about me). The sim sends each side its own
 * copy of an event, so a nation named in `players` only ever reads its own side.
 */
export function supplyToast(state: GameState, me: Player, e: GameEvent): SupplyToast | null {
  const s = e.supply;
  if (!s || (e.players.length && !e.players.includes(me.id))) return null;
  const mine = s.owner === me.id;
  const byMe = s.by === me.id && !mine;
  const owner = state.players[s.owner]?.name ?? 'The enemy';
  const kind = hubWord(s.hubKind);
  const cut = s.sources.length;
  switch (e.kind) {
    case 'supplyHubDamaged':
      if (mine) {
        return cut
          ? { text: `Your supply is cut at your ${kind}: repair in ${s.seconds} s`, kind: 'bad', icon: 'down', key: `sup:hit:${e.tile}` }
          : { text: `Your ${kind} was hit: repair in ${s.seconds} s, supply rerouted`, kind: 'warn', icon: 'signal', key: `sup:hit:${e.tile}` };
      }
      if (byMe) {
        return cut
          ? { text: `You cut ${owner}'s supply at their ${kind}: their ${front(s.direction)} is slower for ${s.seconds} s`, kind: 'good', icon: 'signal', key: `sup:cut:${s.owner}:${e.tile}` }
          : { text: `You hit ${owner}'s ${kind}: they rerouted, nothing cut`, kind: 'info', icon: 'signal', key: `sup:cut:${s.owner}:${e.tile}` };
      }
      return null;
    case 'supplyCut':
      if (mine) return { text: `Your ${s.direction ? `${s.direction} ` : ''}supply is cut: ${forts(cut)} out of reach`, kind: 'bad', icon: 'down', key: 'sup:cut' };
      if (byMe) return { text: `You cut ${owner}'s supply: their ${front(s.direction)} is slower`, kind: 'good', icon: 'signal', key: `sup:cut:${s.owner}` };
      return null;
    case 'supplyRestored':
      return mine ? { text: 'Supply restored', kind: 'good', icon: 'accept', key: 'sup:restored' } : null;
    case 'supplyHubRepaired':
      return mine ? { text: `Your ${kind} is repaired`, kind: 'good', icon: 'accept', key: `sup:fix:${e.tile}` } : null;
    case 'convoySunk':
      if (mine) return { text: `Your convoy was sunk: next one in ${s.seconds || SUPPLY_LINES.convoyEverySeconds} s`, kind: 'bad', icon: 'anchor', key: `sup:convoy:${e.tile}` };
      if (byMe) return { text: `You sank ${owner}'s convoy: their sea lane is cut for ${s.seconds} s`, kind: 'good', icon: 'anchor', key: `sup:convoy:${s.owner}:${e.tile}` };
      return null;
    default:
      return null;
  }
}

/** What a hit on one enemy supply hub would do now: the sources it cuts (a fort or a landing each) and its repair time. */
export interface SupplyCutPreview {
  tile: number;
  forts: number;
  landings: number;
  seconds: number;
}

/**
 * The enemy hub inside a blast (`radius` tiles round `tile`) whose damage would cut the most supply from its owner, or
 * null when none would cut anything. `seen` says whether the viewer can see a hub's tile (fog of war). Pure read.
 */
export function supplyCutAt(state: GameState, attacker: number, tile: number, radius: number, seen?: (tile: number) => boolean): SupplyCutPreview | null {
  const map = state.map;
  let best: SupplyCutPreview | null = null;
  forEachInRadius(map, tile, Math.max(0, radius), (i) => {
    if (!map.building[i]) return;
    const owner = map.owner[i];
    if (owner <= 0 || owner === attacker || (seen && !seen(i))) return;
    const src = hubCutSources(state, attacker, i);
    if (!src.length) return;
    let landings = 0;
    for (const t of src) if (buildingAt(state, t)?.type !== 'fort') landings++;
    if (!best || src.length > best.forts + best.landings) best = { tile: i, forts: src.length - landings, landings, seconds: hubRepairSeconds(state, owner, i) };
  });
  return best;
}

/** The target line: "Cuts supply to 2 forts" (and landings), or null. */
export function cutsSupplyText(c: SupplyCutPreview | null): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.forts) parts.push(forts(c.forts));
  if (c.landings) parts.push(`${c.landings} ${c.landings === 1 ? 'landing' : 'landings'}`);
  return `Cuts supply to ${parts.join(' and ')}`;
}

/** The line under it: how long the hub stays out. */
export function cutsSupplySub(c: SupplyCutPreview): string {
  return `Their hub takes ${c.seconds} s to repair, and the front it feeds fights weaker until then`;
}

/** Map key entries of the supply art: title and plain words, in the order the key lists them. */
export const SUPPLY_KEY: readonly { id: string; title: string; text: string }[] = [
  { id: 'rail', title: 'Rail', text: 'A rail joins your capital, cities, factories, ports and forts over your own land (zoom in for the track). Enemy rails you can see are shown too.' },
  { id: 'train', title: 'Train', text: 'A train runs along a rail toward the front, in its owner\'s colour (zoom in to see it). It only shows the supply is flowing.' },
  { id: 'convoy', title: 'Convoy', text: `A dotted sea lane joins two ports. A convoy sails it for ${SUPPLY_LINES.convoySailSeconds} s every ${SUPPLY_LINES.convoyEverySeconds} s. A warship near the lane sinks it and cuts the lane.` },
  { id: 'damaged', title: 'Damaged hub', text: `Smoke, a broken rail and a "Repair ${SUPPLY_LINES.repairSeconds} s" timer (a red cross when zoomed out): no route passes this hub until it is repaired.` },
  { id: 'cutfront', title: 'Cut front', text: 'Grey shimmer along a border with a "Supply cut" label: the forts there have no route to their capital and fight weaker.' },
];

/** Seconds left on a repair timer at a tick (never below 1 while damaged). */
export function repairLeft(state: GameState, damagedUntil: number): number {
  return Math.max(1, Math.ceil((damagedUntil - state.tick) / TICKS_PER_SECOND));
}
