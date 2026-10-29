// UI state shared by input, HUD and renderer (client only, never read by the sim).
import type { Action, ActionResult, BuildingType, GameState } from '../sim/types';

export type TargetMode =
  | { kind: 'none' }
  | { kind: 'build'; building: BuildingType }
  | { kind: 'transport'; from: number } // next click = landing tile (from = chosen own coast tile, -1 = auto)
  | { kind: 'bomb'; airfield: number }
  | { kind: 'missile'; silo: number; missile: 'rocket' | 'atomBomb' }
  | { kind: 'moveWarship'; unitId: number };

export interface UiState {
  mode: TargetMode;
  /** share of the army sent per attack/transport, 0.01..1 */
  attackShare: number;
  /** composition of sent troops: 'all' = proportional to the army; 'custom' uses customMix weights */
  attackMixMode: 'all' | 'custom';
  customMix: { infantry: number; armor: number; artillery: number }; // weights 0..1
  hoverTile: number; // -1 none
  selectedTile: number; // -1 none
  paused: boolean;
  speed: 1 | 2 | 4;
  showResources: boolean; // overlay toggle (V)
  showSupply: boolean; // overlay toggle (B)
  contextMenu: { x: number; y: number; tile: number } | null;
  /** last action failure to show as a toast */
  toast: { text: string; until: number } | null;
}

export function defaultUiState(): UiState {
  return {
    mode: { kind: 'none' },
    attackShare: 0.3,
    attackMixMode: 'all',
    customMix: { infantry: 1, armor: 1, artillery: 1 },
    hoverTile: -1,
    selectedTile: -1,
    paused: false,
    speed: 1,
    showResources: false,
    showSupply: false,
    contextMenu: null,
    toast: null,
  };
}

/** Sends an action for the human player; returns the result (the HUD toasts failures). */
export type Dispatch = (action: Action) => ActionResult;
export type GetState = () => GameState | null;
