// Mouse and keyboard handling on the map canvas.
import type { Camera } from './camera';
import type { Renderer } from './renderer';
import type { Dispatch, GetState, UiState } from './uiState';

export interface InputDeps {
  canvas: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
  camera: Camera;
  renderer: Renderer;
  ui: UiState;
  getState: GetState;
  dispatch: Dispatch;
  /** HUD callbacks for keys that open panels */
  openResearch: () => void;
  toggleHelp: () => void;
}

export function setupInput(deps: InputDeps): () => void {
  // TODO(WP-G): returns a cleanup function that removes listeners
  return () => {};
}
