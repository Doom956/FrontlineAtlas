// Canvas renderer: terrain, territory, borders, buildings, units, fronts, effects, overlays, minimap.
import type { GameState } from '../sim/types';
import type { Camera } from './camera';
import type { UiState } from './uiState';

export class Renderer {
  constructor(public canvas: HTMLCanvasElement, public minimap: HTMLCanvasElement) {
    // TODO(WP-F)
  }
  /** Call once per new game (builds the terrain image). */
  setGame(state: GameState): void {
    // TODO(WP-F)
  }
  /** Draws a frame. Diffs map.owner against its own copy to update only changed tiles of the territory layer. */
  render(state: GameState, camera: Camera, ui: UiState, nowMs: number): void {
    // TODO(WP-F)
  }
  /** Minimap click -> tile coords, or null if outside. */
  minimapToTile(mx: number, my: number): { x: number; y: number } | null {
    // TODO(WP-F)
    return null;
  }
}
