// Map effects on/off (ripples, splashes, blasts, the nuke shake). Saved per browser; sounds have their own volumes.
// prefers-reduced-motion keeps the effects but drops the screen shake.

export const FX_STORAGE_KEY = 'borderfall.fx.v1';

let enabled: boolean | null = null;

function load(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(FX_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function fxEnabled(): boolean {
  if (enabled === null) enabled = load();
  return enabled;
}

export function setFxEnabled(on: boolean): void {
  enabled = !!on;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FX_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: not remembered */
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
