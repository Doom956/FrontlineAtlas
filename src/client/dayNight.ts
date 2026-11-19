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

/** Seconds either side of the middle of dawn and of dusk with some warm glow (it peaks in the middle of the change). */
export const WARM_SECONDS = 14;

/** The warm dawn and dusk glow at `tick`, 0..1: highest three quarters into the dawn, a quarter into the dusk. */
export function dayWarmth(tick: number): number {
  const t = dayClock(tick) * DAY_SECONDS;
  // on the light side of each change, where the sun is low but up (as the art lab's dawn and dusk)
  const dawn = TWILIGHT_SECONDS * 0.75;
  const dusk = DAYLIGHT_SECONDS - TWILIGHT_SECONDS * 0.75;
  // dawn sits by the wrap: the last seconds of the night count as just before it
  const dDawn = Math.min(Math.abs(t - dawn), Math.abs(t - DAY_SECONDS - dawn));
  const d = Math.min(dDawn, Math.abs(t - dusk));
  return smooth(1 - d / WARM_SECONDS);
}

/** Named moments of the day in seconds after sunrise (tests, screenshots): dawn and dusk at their warmest, noon, mid night. */
export const DAY_TIMES = { dawn: TWILIGHT_SECONDS * 0.75, noon: 45, dusk: DAYLIGHT_SECONDS - TWILIGHT_SECONDS * 0.75, night: 105 } as const;
