// A unit's portrait for the HUD (unit card, Forces list): the same pixel sprite the map draws close up
// (render/pixelSprites.ts drawUnitSprite), facing right in the owner's colour, on a small canvas. When the sprite art
// changes, the portraits follow; nothing is copied here. Returns null where there is no canvas (tests) or no sprite.
import type { UnitType, UnitVariant } from '../../sim/types';
import { drawUnitSprite, hasSprite } from '../render/pixelSprites';
import type { RGB } from '../render/common';

/** Draws (or redraws) a portrait into `c`, `w` x `h` CSS pixels. */
export function paintPortrait(c: HTMLCanvasElement, type: UnitType, variant: UnitVariant | undefined, owner: readonly number[], w: number, h: number): boolean {
  if (!hasSprite(type, variant)) return false;
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? Math.min(3, Math.round(devicePixelRatio)) : 1;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = c.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return false;
  ctx.clearRect(0, 0, c.width, c.height);
  // device pixels, so the sprite's cells land on whole pixels; planes cast their shadow down and right, so they sit a
  // little up and left of centre
  const air = type === 'bomber' || type === 'fighter' || type === 'transportPlane' || type === 'reconPlane' || type === 'rocket' || type === 'atomBomb';
  // ships and tanks are long and low: fit the width; planes are about as tall as long: fit the height
  const len = (air ? h - 6 : w - 4) * dpr;
  drawUnitSprite(ctx, type, variant, (w / 2 - (air ? 2 : 0)) * dpr, (h / 2 - (air ? 2 : 0)) * dpr, len, 0, [owner[0], owner[1], owner[2]] as RGB);
  return true;
}

/** A new portrait canvas, or null (no canvas or no sprite for this unit). */
export function unitPortrait(type: UnitType, variant: UnitVariant | undefined, owner: readonly number[], w = 40, h = 26, cls = 'portrait'): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.className = cls;
  c.setAttribute('aria-hidden', 'true');
  return paintPortrait(c, type, variant, owner, w, h) ? c : null;
}
