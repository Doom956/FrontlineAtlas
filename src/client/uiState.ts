// UI state shared by input, HUD and renderer (client only, never read by the sim).
import type { Action, ActionResult, BuildingType, GameState } from '../sim/types';

export type TargetMode =
  | { kind: 'none' }
  | { kind: 'build'; building: BuildingType }
  | { kind: 'transport'; from: number } // next click = landing tile (from = chosen own coast tile, -1 = auto)
  | { kind: 'bomb'; airfield: number }
  | { kind: 'missile'; silo: number; missile: 'rocket' | 'atomBomb' }
  | { kind: 'moveWarship'; unitId: number }
  /** next click = drop zone for paratroopers (airfield: a chosen one, -1 = the nearest ready one) */
  | { kind: 'paradrop'; airfield: number }
  /** next click = centre of an artillery barrage */
  | { kind: 'barrage' };

export interface UiState {
  mode: TargetMode;
  /** share of the army sent per attack/transport, 0.01..1 */
  attackShare: number;
  /** composition of sent troops: 'all' = proportional to the army; 'custom' uses customMix weights */
  attackMixMode: 'all' | 'custom';
  customMix: { infantry: number; armor: number; artillery: number }; // weights 0..1
  hoverTile: number; // -1 none
  /** pointer position over the map in CSS px (null when it is off the map): picks the hovered warship */
  hoverPx: { x: number; y: number } | null;
  selectedTile: number; // -1 none
  paused: boolean;
  speed: 1 | 2 | 4;
  showResources: boolean; // overlay toggle (V)
  showSupply: boolean; // overlay toggle (B)
  showMinimap: boolean; // minimap toggle (M), off by default: the map itself is the overview
  /** faint glow along your heartland (set by the HUD while the Army drawer or the map key is open) */
  showHeartland: boolean;
  contextMenu: { x: number; y: number; tile: number } | null;
  /** last action failure to show as a toast */
  toast: { text: string; until: number } | null;
  /** floating texts on the map ("+120 gold"), added by the HUD, drawn and expired by the renderer */
  floaters: Floater[];
}

/** A short-lived text rising from a map position. */
export interface Floater {
  x: number; // tile coords (float)
  y: number;
  text: string;
  color: string;
  /** performance.now() when added */
  born: number;
}
export const FLOATER_MS = 1600;
export const MAX_FLOATERS = 40;

/** Adds a floater, dropping the oldest when there are too many. */
export function addFloater(ui: UiState, f: Floater): void {
  ui.floaters.push(f);
  if (ui.floaters.length > MAX_FLOATERS) ui.floaters.splice(0, ui.floaters.length - MAX_FLOATERS);
}

export function defaultUiState(): UiState {
  return {
    mode: { kind: 'none' },
    attackShare: 0.3,
    attackMixMode: 'all',
    customMix: { infantry: 1, armor: 1, artillery: 1 },
    hoverTile: -1,
    hoverPx: null,
    selectedTile: -1,
    paused: false,
    speed: 1,
    showResources: false,
    showSupply: false,
    showMinimap: false,
    showHeartland: false,
    contextMenu: null,
    toast: null,
    floaters: [],
  };
}

/** Sends an action for the human player; returns the result (the HUD toasts failures). */
export type Dispatch = (action: Action) => ActionResult;
export type GetState = () => GameState | null;
