// Map effects on/off (ripples, splashes, blasts, the nuke shake) and reduce motion, both picked in Settings and kept
// by settings/store.ts (which took over the old FX_STORAGE_KEY). Sounds have their own volumes.
// Reduce motion keeps the effects but drops the screen shake and the idle motion of units and fronts.
import { getSettings, setSetting } from '../settings/store';

/** Where the switch was kept before settings/store.ts (read once by its migration). */
export const FX_STORAGE_KEY = 'borderfall.fx.v1';

export function fxEnabled(): boolean {
  return getSettings().effects;
}

export function setFxEnabled(on: boolean): void {
  setSetting('effects', !!on);
}

let query: MediaQueryList | null | undefined;

/** The device asks for less motion (prefers-reduced-motion). */
export function deviceReducedMotion(): boolean {
  try {
    if (query === undefined) query = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    return !!query?.matches;
  } catch {
    return false;
  }
}

/** Less motion now: the Settings pick, or the device's when it is "Like my device". */
export function prefersReducedMotion(): boolean {
  const r = getSettings().reduceMotion;
  return r === 'on' ? true : r === 'off' ? false : deviceReducedMotion();
}
