// Day and night (look only, never in the sim): a 2 minute day, 1.5 min of daylight and 30 s of night, with a soft
// dawn and dusk. The map art reads dayPhase(state.tick) each frame; nothing in src/sim may call this.
import { TICKS_PER_SECOND } from '../sim/config';

/** Seconds of one full day, of daylight in it, and of each dawn / dusk blend. */
export const DAY_SECONDS = 120;
export const DAYLIGHT_SECONDS = 90;
export const TWILIGHT_SECONDS = 10;

/** Where in the day `tick` is, 0..1 (0 = sunrise, DAYLIGHT_SECONDS / DAY_SECONDS = sunset). */
export function dayClock(tick: number): number {
  const t = (((tick / TICKS_PER_SECOND) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  return t / DAY_SECONDS;
}

const smooth = (x: number): number => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

/**
 * Daylight at `tick`, 0..1: 1 = full day, 0 = deep night. Dawn rises over TWILIGHT_SECONDS from sunrise, dusk falls
 * over TWILIGHT_SECONDS up to sunset (smoothstep), so the 90 s of day include both blends.
 */
export function dayPhase(tick: number): number {
  const t = dayClock(tick) * DAY_SECONDS;
  if (t >= DAYLIGHT_SECONDS) return 0;
  if (t < TWILIGHT_SECONDS) return smooth(t / TWILIGHT_SECONDS);
  if (t > DAYLIGHT_SECONDS - TWILIGHT_SECONDS) return smooth((DAYLIGHT_SECONDS - t) / TWILIGHT_SECONDS);
  return 1;
}
