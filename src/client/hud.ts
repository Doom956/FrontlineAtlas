// DOM HUD: top bar, build bar, attack panel, research modal, diplomacy/leaderboard, event log, tooltip, toasts,
// context menu, spawn banner, game-over screen.
import type { GameState } from '../sim/types';
import type { Camera } from './camera';
import type { Dispatch, UiState } from './uiState';

export class Hud {
  constructor(public root: HTMLElement, public ui: UiState, public dispatch: Dispatch, public camera: Camera) {
    // TODO(WP-G)
  }
  /** Called every frame; throttle expensive DOM updates internally (e.g. 5 Hz). */
  update(state: GameState): void {
    // TODO(WP-G)
  }
  openResearch(): void {
    // TODO(WP-G)
  }
  toggleHelp(): void {
    // TODO(WP-G)
  }
  destroy(): void {
    // TODO(WP-G)
  }
}
