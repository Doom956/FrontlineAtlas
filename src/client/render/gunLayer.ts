// The turning guns over the cached building sprites (flak pits, coastal batteries). The building's sprite holds what
// stands still; each gun head is its own small sprite baked at GUN_FACINGS headings (art/detailed/guns.ts) and cached by
// kind, owner colour, look, pixel scale, dpr and heading, so a turn is a swap between cached sprites, never a rebake of
// the building. Where a head points is fx/gunAim.ts (target, idle pose, smooth turn, recoil). No Math.random or Date here.
import { FORE, LIFT } from '../art/detailed/bake';
import { bakeGun, GUN_FACINGS, muzzleOffset, type BakedGun, type GunKind } from '../art/detailed/guns';
import { gunMounts, type BuildingSpec } from '../art/detailed/buildings';
import type { RGB } from '../art/shared/colour';
import { facingHeading, idleAngle, quantFacing, RECOIL_BACK, type GunAim } from '../fx/gunAim';
import { fxEnabled } from '../fx/settings';
import { tankFxLevel } from '../fx/tankFire';
import type { ArtLook } from './buildingArt';

/** The cache key of a gun head: kind, owner colour, look, pixel scale, dpr and the baked heading (0..GUN_FACINGS - 1). */
export function gunKey(kind: GunKind, owner: readonly number[], look: ArtLook, scale: number, dpr: number, facing: number): string {
  return `${kind}|${owner[0]},${owner[1]},${owner[2]}|${look}|${scale}|${dpr}|${facing}`;
}

const CACHE_MAX = 600;
/** New heads baked a frame at most (a turning gun takes the nearest cached heading meanwhile). */
export const GUN_BAKES_PER_FRAME = 8;

/** Baked gun heads, shared by every gun with the same key. */
export class GunSprites {
  private cache = new Map<string, BakedGun>();
  private budget = GUN_BAKES_PER_FRAME;
  /** heads baked (stats and tests) */
  baked = 0;

  newFrame(): void {
    this.budget = GUN_BAKES_PER_FRAME;
  }
  get size(): number {
    return this.cache.size;
  }
  clear(): void {
    this.cache.clear();
  }
  peek(key: string): BakedGun | null {
    return this.cache.get(key) ?? null;
  }
  /** The head for `key`: cached, or baked when the frame's budget allows (`force` bakes regardless), else null. */
  get(key: string, bake: () => BakedGun, force = false): BakedGun | null {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (this.budget <= 0 && !force) return null;
    this.budget--;
    const s = bake();
    this.baked++;
    this.cache.set(key, s);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return s;
  }
}

/** What the layer needs to know about the building it draws guns on. */
export interface GunSite {
  tile: number;
  spec: BuildingSpec;
  owner: RGB;
  look: ArtLook;
  /** pixel scale of the building's sprite and the screen px per tile */
  scale: number;
  zoom: number;
  dpr: number;
  /** the building's centre as a tile (float), on screen (CSS px), and the model origin's screen position */
  btx: number;
  bty: number;
  x: number;
  y: number;
  ax: number;
  ay: number;
  /** quarter turns the sprite is rotated by (a port facing the sea) and the screen angle of the sea (idle pose of coastal guns) */
  turns: number;
  sea: number;
  alpha: number;
  nowMs: number;
}

export class GunLayer {
  readonly sprites = new GunSprites();
  /** guns drawn last frame (stats, tests) */
  drawn = 0;

  newFrame(): void {
    this.sprites.newFrame();
    this.drawn = 0;
  }

  /** The head of a gun at the nearest cached heading to `f`, baking `f` when the budget allows. */
  private head(kind: GunKind, s: GunSite, f: number): BakedGun | null {
    const bake = (g: number): (() => BakedGun) => () => bakeGun(kind, s.owner, s.scale, s.dpr, g);
    const exact = this.sprites.get(gunKey(kind, s.owner, s.look, s.scale, s.dpr, f), bake(f));
    if (exact) return exact;
    for (let k = 1; k <= GUN_FACINGS / 2; k++) {
      for (const g of [(f + k) % GUN_FACINGS, (f - k + GUN_FACINGS) % GUN_FACINGS]) {
        const hit = this.sprites.peek(gunKey(kind, s.owner, s.look, s.scale, s.dpr, g));
        if (hit) return hit;
      }
    }
    // nothing cached at all: the first head must show, over the frame's budget
    return this.sprites.get(gunKey(kind, s.owner, s.look, s.scale, s.dpr, f), bake(f), true);
  }

  /** Draws every turning gun of one building over its sprite and starts the flashes of shots due. */
  draw(ctx: CanvasRenderingContext2D, aim: GunAim, s: GunSite): void {
    const mounts = gunMounts(s.spec);
    if (!mounts.length) return;
    const live = fxEnabled();
    const ca = Math.cos((s.turns * Math.PI) / 2);
    const sa = Math.sin((s.turns * Math.PI) / 2);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * s.alpha;
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i];
      // the mount's top on screen: where the sprite put it (turned with the sprite for a port)
      const gu = m.u * s.scale;
      const gv = m.v * FORE * s.scale;
      const rx = gu * ca - gv * sa;
      const ry = gu * sa + gv * ca;
      const lift = m.z * LIFT * s.scale;
      const lx = lift * sa;
      const ly = -lift * ca;
      const mx = s.ax + rx + lx;
      const my = s.ay + ry + ly;
      // the mount's ground point as a tile, for the heading
      const gx = s.ax + rx;
      const gy = s.ay + ry;
      const pose = live ? aim.headingOf(s.tile, m.kind, i, s.btx + (gx - s.x) / s.zoom, s.bty + (gy - s.y) / s.zoom, idleAngle(m.kind, s.sea), s.nowMs) : idleAngle(m.kind, s.sea);
      const f = quantFacing(pose);
      const spr = this.head(m.kind, s, f);
      if (!spr) continue;
      const th = facingHeading(f);
      const back = live ? RECOIL_BACK[m.kind] * aim.recoilOf(s.tile, m.kind, i, s.nowMs) * s.scale : 0;
      const px = Math.round((mx - spr.ox - Math.cos(th) * back) * s.dpr) / s.dpr;
      const py = Math.round((my - spr.oy - Math.sin(th) * FORE * back) * s.dpr) / s.dpr;
      ctx.drawImage(spr.canvas, px, py, spr.w, spr.h);
      this.drawn++;
      if (live && tankFxLevel(s.zoom) === 'full' && aim.takeShot(s.tile, i, mounts.length, s.nowMs)) {
        const mo = muzzleOffset(m.kind, th, s.scale);
        const sx = mx + mo.x;
        const sy = my + mo.y;
        aim.addFlash(s.tile, m.kind, s.btx + (sx - s.x) / s.zoom, s.bty + (sy - s.y) / s.zoom, pose, s.nowMs);
      }
    }
    ctx.globalAlpha = prev;
  }
}
