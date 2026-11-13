// The interface every art style implements (client only). A style is one module (art/<style>/index.ts) exporting a
// StyleModule: one object per art category. The renderer, the HUD portraits, the troop pills and the battle effects
// reach a style only through art/registry.ts (artFor), so styles can be mixed per category and swapped at run time.
//
// Rules for a style:
//   - Draw only; never read or write the game state (everything needed is in the arguments).
//   - Screen coordinates are CSS px on a canvas whose transform already maps CSS px to device px (`dpr` says how many
//     device px one CSS px has, for styles that want to draw finer than one CSS px).
//   - Restore what you change on the context (globalAlpha, imageSmoothingEnabled, fillStyle may stay changed).
//   - Deterministic for the same arguments: use art/shared/noise.ts with the given seed, never Math.random.
//   - Motion comes only from `timeMs` / `t` and the MotionParams numbers (art/motion.ts), so every style supports the
//     subtle, lively and cinematic presets; honour `m.reduced` (no idle motion).
//   - The far level of detail (unit markers, fleet markers with counts, the troop pills' count plates) is shared and not
//     part of a style: a style draws from mid zoom in (UnitDraw.lod).
//   - The three style folders never import each other (the detailed and realistic stubs delegate to refined until
//     they are written). Shared helpers live in art/shared/.
import type { TroopType } from '../../sim/types';
import type { ArtStyle } from './artStyle';
import type { MotionParams } from './motion';
import type { RGB } from './shared/colour';
import type { SpriteKey } from './shared/keys';

export type { MotionParams } from './motion';
export type { SpriteKey } from './shared/keys';
export type { RGB } from './shared/colour';

// ================================================================================================ units

/**
 * Level of detail of a unit sprite: 'mid' from zoom 3 to 11 (1 screen px per art pixel in the refined style), 'near'
 * closer (2 to 4). Below zoom 3 the map draws the shared far markers instead (render/pixelSprites.ts drawUnitMarker).
 */
export type UnitLod = 'mid' | 'near';

/** One unit on the map, as the renderer sees it this frame. */
export interface UnitDraw {
  /** which picture: the unit type and arsenal variant (art/shared/keys.ts spriteKey) */
  key: SpriteKey;
  /** upgrade details its owner has (art/shared/keys.ts M_* bits) */
  mods: number;
  /** the owner's colour (a band or plate, never a tint of the whole unit) */
  owner: RGB;
  /** the unit's centre on screen (CSS px) */
  x: number;
  y: number;
  /** heading in radians, 0 = east, clockwise on screen; eased between path corners, never snapped */
  angle: number;
  /** camera zoom: screen px per map tile */
  zoom: number;
  /** the map's whole-number screen px per art pixel at this zoom: 1 at mid zoom, 2 to 4 close up (render/units.ts spriteScale) */
  scale: number;
  lod: UnitLod;
  /** device px per CSS px */
  dpr: number;
  /** clock for animation (ms; propellers, flicker, bob, flames); it stands still while the art lab is paused */
  timeMs: number;
  /** how fast the heading turns (rad/s, positive = turning clockwise on screen, to starboard); planes bank with it */
  turnRate: number;
  /** speed over the ground in tiles per second of game time (0 = standing still); ships size their wake with it */
  speed: number;
  /** moved since the last tick */
  moving: boolean;
  /** stable per unit (its id), for phase offsets so a fleet does not bob in step */
  seed: number;
  /** opacity 0..1 */
  alpha: number;
  /** planes and missiles: draw their ground shadow */
  shadow: boolean;
  /**
   * How badly the unit is hurt, 0..1: 0 = full health, 1 = about to sink or be destroyed (1 - hp / max hp, read from
   * the game by the renderer: render/pixelSprites.ts unitDamage). Units without hit points to lose, the HUD portraits
   * and fleet markers get 0. A style may show it (smoke, fire, scorch marks, a list to one side) or ignore it; it never
   * changes the unit's size, heading or turret points.
   */
  damage: number;
}

/** A unit's picture for the HUD (the unit card, the Forces list): the same art as the map, fitted to a box. */
export interface PortraitDraw {
  key: SpriteKey;
  mods: number;
  owner: RGB;
  /** centre of the box (device px of the portrait canvas) */
  x: number;
  y: number;
  /** what must fit: the unit's length (or its wingspan, whichever is larger) in px */
  boxPx: number;
  /** heading (radians; portraits face right, 0) */
  angle: number;
  alpha: number;
}

/** Draws one category of units: ships, land units, planes or missiles (the same object may serve all four). */
export interface UnitArt {
  /**
   * The unit's length along its heading on screen (CSS px) at map scale `scale` (UnitDraw.scale). The renderer sizes
   * hit areas, selection rings and culling from it, so keep it close to what drawUnit covers.
   */
  lengthPx(key: SpriteKey, mods: number, scale: number): number;
  /**
   * Draws a unit on the map centred at (u.x, u.y), with its ground shadow for planes and missiles when u.shadow.
   * False when it could not be drawn this frame (no canvas, or the frame's bake budget is spent): the renderer then
   * draws the unit's far marker for this frame.
   */
  drawUnit(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams): boolean;
  /** A HUD portrait. False when nothing could be drawn (no canvas). */
  drawPortrait(ctx: CanvasRenderingContext2D, p: PortraitDraw): boolean;
  /**
   * Ships: where gun `index` of a salvo fires from on screen, for a ship drawn at (x, y) with heading `angle` at map
   * scale `scale` (fx/pixelFx.ts puts the muzzle flash there). How many guns a salvo has is shared (fx/pixelFx.ts
   * SALVO: a plain warship 2, a destroyer 2 from its one turret, a battleship 3). Other units: their centre.
   */
  turretPoint(key: SpriteKey, mods: number, index: number, x: number, y: number, angle: number, scale: number): { x: number; y: number };
}

// ================================================================================================ troop icons

/** A troop marker's symbol, or 'troops' for a mix the viewer does not know (never drawn as the soldier). */
export type TroopIconKind = TroopType | 'troops';

export interface TroopIconArt {
  /**
   * Draws one troop marker with its top-left corner at (x, y): a `size` px plate in the owner's colour (16 normally, 12
   * on transports and next to nation army counts) carrying the symbol, plus a 1 px edge round it, so it covers
   * size + 2 px square (the troop pills lay their markers out on that footprint). Returns the width drawn, 0 when
   * nothing could be drawn (no canvas).
   */
  draw(ctx: CanvasRenderingContext2D, kind: TroopIconKind, x: number, y: number, owner: RGB, size: number): number;
}

// ================================================================================================ wakes and contrails

/** A unit that leaves a trail, this frame. */
export interface TrailUnit {
  /** stable emitter id (the unit's id) */
  id: number;
  key: SpriteKey;
  /** centre on screen (CSS px) and on the map (tiles, float) */
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** heading (radians, 0 = east, clockwise on screen) */
  angle: number;
  /** half the unit's length on screen (CSS px): the stern or tail is about this far behind (x, y) */
  half: number;
  /** ships: moved since the last tick (a ship standing still leaves no wake) */
  moving: boolean;
  /** tiles per second of game time */
  speed: number;
  /** rad/s, positive = turning clockwise on screen */
  turnRate: number;
  /** the motion of the unit the trail follows (ships for wakes, planes or missiles for contrails) */
  motion: MotionParams;
}

/** Where the camera is, for trails anchored to the map (they stay where they were laid while the unit moves on). */
export interface TrailView {
  /** screen position of tile (0, 0) and screen px per tile: a tile point (tx, ty) is at (ox + tx * zoom, oy + ty * zoom) */
  ox: number;
  oy: number;
  zoom: number;
  /** the map's whole-number px per art pixel (UnitDraw.scale) */
  scale: number;
  /** clock (ms) */
  now: number;
  viewW: number;
  viewH: number;
  dpr: number;
  /** false far out: lay only missile trails (old wake foam and contrails still fade out) */
  full: boolean;
}

/** One live set of trails (the map keeps one per art category; the art lab one per cell). */
export interface TrailLayer {
  /** Forgets every trail (a new game). */
  clear(): void;
  /**
   * One frame: lays new trail behind `units` (only the units this layer draws: ships for wakes; planes and missiles
   * for contrails) and draws every live trail, the old ones fading where they were laid.
   */
  frame(ctx: CanvasRenderingContext2D, units: readonly TrailUnit[], view: TrailView): void;
}

/** Wakes (ships) or contrails (planes, missiles). */
export interface TrailArt {
  createLayer(): TrailLayer;
}

// ================================================================================================ explosions

/**
 * shell: a shell landing (barrages, a ship's shell on land); bomb: one bomb of a bomber's or air strike's stick; hit: a
 * ship or fort hit; air: a plane shot down (it bursts in the air); missile: a rocket's warhead; atom: the atom bomb;
 * splash: a shell or bomb landing in water; flak: an anti-air burst at a plane.
 */
export type BlastKind = 'shell' | 'bomb' | 'hit' | 'air' | 'missile' | 'atom' | 'splash' | 'flak';
export const BLAST_KINDS: readonly BlastKind[] = ['shell', 'bomb', 'hit', 'air', 'missile', 'atom', 'splash', 'flak'];

/** One frame of a blast. */
export interface BlastDraw {
  kind: BlastKind;
  /** the blast's centre on screen (CSS px); for 'air' where the plane was (a style draws it a little above) */
  x: number;
  y: number;
  /** 0 at the first flash, 1 when it is over (age / duration) */
  t: number;
  ageMs: number;
  durMs: number;
  zoom: number;
  /** the map's whole-number px per art pixel (UnitDraw.scale) */
  scale: number;
  /**
   * The sim's blast radius in tiles for 'missile' and 'atom' (the fireball grows with it); 0 for the small ones (a
   * style may read a positive value on a small one as a size multiplier: a plane crashing into the sea)
   */
  rt: number;
  /** 0..1, the blast's own look */
  seed: number;
  /** prefers-reduced-motion: show a still burst, no flipbook */
  reduced: boolean;
  dpr: number;
}

/**
 * Aftermath effects of the map's event layer (fx/layer.ts): splash = a ship sinking (foam rings, spray, pieces going
 * under), smoke = a plane going down (puffs rising and drifting), dust = earth thrown up after shells, fortDust = a
 * fort coming down (a heavier ring of dust and debris).
 */
export type MapFxKind = 'splash' | 'smoke' | 'dust' | 'fortDust';
export const MAP_FX_KINDS: readonly MapFxKind[] = ['splash', 'smoke', 'dust', 'fortDust'];

export interface MapFxDraw {
  kind: MapFxKind;
  x: number;
  y: number;
  /** 0..1 of its life (fixed per kind, fx/map.ts FX_INFO) */
  t: number;
  zoom: number;
  /** 0..1 */
  seed: number;
  /** spread in tiles (dust: the barrage radius); 0 otherwise */
  rt: number;
  dpr: number;
}

// ------------------------------------------------------------------------------------------------- deaths

/**
 * A unit destroyed, as the map saw it go (fx/deaths.ts finds them, read-only): plane = a plane shot down (hit, it
 * catches fire, falls and crashes), missile = a rocket or atom bomb shot down in the air (it bursts and its pieces
 * fall), tank = a tank division destroyed (a burning wreck), ship = a ship sunk (it lists, burns and goes under).
 */
export type DeathKind = 'plane' | 'missile' | 'tank' | 'ship';
export const DEATH_KINDS: readonly DeathKind[] = ['plane', 'missile', 'tank', 'ship'];

/**
 * How far a falling plane goes on along its heading before it hits the ground, in tiles. The map reads the ground
 * there (DeathDraw.water) and leaves its crash crater there; a style draws the crash there too.
 */
export const DEATH_GLIDE_TILES = 2.2;

/**
 * Which part of a death a call draws: 'ground' what lies on the ground or the sea (an oil slick, foam, floating or
 * sunk wreckage, a burnt hull, a landed turret, scorch, shadows), drawn under the units; 'air' what stands up or flies
 * (a falling plane, a thrown turret in the air, fireballs, flashes, flames and smoke), drawn over them. Absent: both.
 */
export type DeathLayer = 'ground' | 'air';

/** One frame of a unit's death. */
export interface DeathDraw {
  kind: DeathKind;
  /** the part to draw (absent: all of it, as the art lab does) */
  layer?: DeathLayer;
  /** the unit's picture, its upgrades and its owner's colour, as the map drew it */
  key: SpriteKey;
  mods: number;
  owner: RGB;
  /** where it was when it was hit (CSS px; planes and missiles in the air, where the map drew them) and its heading */
  x: number;
  y: number;
  angle: number;
  /**
   * Water where it comes down: under a plane at its crash point (DEATH_GLIDE_TILES along its heading), under a
   * missile below the burst; always for ships, for a tank when it was wading.
   */
  water: boolean;
  /** 0 at the hit, 1 when it is over (age / duration) */
  t: number;
  ageMs: number;
  durMs: number;
  zoom: number;
  /** the map's whole-number px per art pixel (UnitDraw.scale) */
  scale: number;
  /** 0..1, its own look (the spin, where the fires are, the pieces) */
  seed: number;
  /** prefers-reduced-motion: still frames */
  reduced: boolean;
  dpr: number;
}

/** How long a death takes and when it reaches the ground or is under (ms after the hit; ExplosionArt.deathTimes). */
export interface DeathTimes {
  durMs: number;
  /** a plane's crash, a missile's last piece down, a ship gone under; for a tank the blast itself (0) */
  impactMs: number;
}

export interface ExplosionArt {
  /** How long a blast of this kind lasts (ms). The pool frees it after; the far blink keeps the same length. */
  durationMs(kind: BlastKind, m: MotionParams): number;
  /** One frame of a blast (from zoom 2 in; farther out the shared far blink stands for the small ones). */
  draw(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void;
  /** One frame of a sinking ship, a falling plane's smoke or dust. */
  drawMapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw, m: MotionParams): void;
  /**
   * Optional: a style that animates deaths gives their times (the returned object may be reused) and draws them,
   * from zoom 2 in (farther out the map shows the far blink). A style without them shows its small blasts instead:
   * a plane's burst in the air and its smoke, a ship's hit and its sinking splash, a hit on a tank or a missile.
   */
  deathTimes?(kind: DeathKind, m: MotionParams): DeathTimes;
  drawDeath?(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void;
}

// ================================================================================================ craters

export interface CraterDraw {
  /** centre on screen (CSS px) and radius on screen (the crater's radius in tiles times the zoom) */
  x: number;
  y: number;
  radiusPx: number;
  /** 0 fresh .. 1 gone: its age over its life (the life already includes MotionParams.craterLife) */
  q: number;
  zoom: number;
  scale: number;
  /** 0..1, the crater's own shape */
  seed: number;
  dpr: number;
  /**
   * True for the atom bomb's ground mark: radiusPx is still its crater, but the mark may spread a blast zone (scorched,
   * flattened, burning ground) out to CRATER_ATOM_REACH x radiusPx; the map culls and clips it that far. Absent or
   * false for every other crater, which stays within CRATER_REACH x radiusPx.
   */
  atom?: boolean;
}

/** How far a crater's drawing may reach, in crater radii (scorch ring, smoke and fire at its rim). */
export const CRATER_REACH = 1.8;
/** How far the atom bomb's ground mark may reach, in crater radii: its blast zone (the sim's blast radius is about 3.1). */
export const CRATER_ATOM_REACH = 3.3;

export interface CraterArt {
  /**
   * Draws a crater on the ground under the units (from zoom 1.5 in), fading out toward q = 1 by itself. At the coast
   * the caller has already clipped the canvas to the land tiles.
   */
  draw(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams): void;
}

// ================================================================================================ cannon fire

/** cannon: a warship's shell; tracer: anti-air fire at a plane (SAM sites, airfields, carriers); torpedo: a submarine's. */
export type ShellKind = 'cannon' | 'tracer' | 'torpedo';

export interface MuzzleDraw {
  /** the muzzle on screen (UnitArt.turretPoint of the firing ship) and the direction to the target (radians) */
  x: number;
  y: number;
  aim: number;
  /** 0..1 of the flash (CannonArt.flashMs) */
  t: number;
  zoom: number;
  scale: number;
  seed: number;
  dpr: number;
}

export interface ShellDraw {
  kind: ShellKind;
  /** from the firing unit to where it lands (screen CSS px) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0..1 of its flight */
  t: number;
  zoom: number;
  scale: number;
  seed: number;
  dpr: number;
}

export interface CannonArt {
  /** How long one muzzle flash lasts (ms). */
  flashMs(m: MotionParams): number;
  drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void;
  /** A shell, tracer burst or torpedo wake in flight (its landing is a blast: shell, splash or flak). */
  drawShell(ctx: CanvasRenderingContext2D, s: ShellDraw, m: MotionParams): void;
}

// ================================================================================================ paratroopers

/**
 * One frame of a paratrooper drop: the troops of a cargo plane that reached its drop point, coming down under
 * parachutes round it and landing. The map draws drops at every zoom (far out too), under the units.
 */
export interface ParadropDraw {
  /** the drop point on screen (CSS px): where the troops land */
  x: number;
  y: number;
  /** the owner's colour (the canopies) */
  owner: RGB;
  /** ms since the plane arrived, the drop's whole length (ParadropArt.durationMs) and 0..1 of it (ageMs / durMs) */
  ageMs: number;
  durMs: number;
  t: number;
  /** how many parachutes (6 on the map) */
  count: number;
  /** camera zoom (screen px per tile) and the map's whole-number px per art pixel at it (UnitDraw.scale) */
  zoom: number;
  scale: number;
  /** 0..1, the drop's own scatter (where each parachute comes down) */
  seed: number;
  dpr: number;
}

/** The small parachute mark next to a cargo plane in flight (mid and close zoom, beside its troop pill). */
export interface ParachuteMarkDraw {
  /** the plane's centre on screen (CSS px) and about half its drawn size (px); the refined mark sits off its lower right */
  x: number;
  y: number;
  half: number;
  /** the owner's colour */
  owner: RGB;
  zoom: number;
  dpr: number;
}

/** Paratroopers: the drop round a drop point and the parachute mark on a cargo plane. Motion: the planes' (air). */
export interface ParadropArt {
  /** How long a drop shows, from the plane arriving to the last parachute faded out on the ground (ms). */
  durationMs(m: MotionParams): number;
  /** How far from the drop point a drop's drawing reaches at a zoom (CSS px); the map skips drops farther off screen. */
  reachPx(zoom: number): number;
  /** One frame of a drop (t from 0 to 1): parachutes open, drift down with a little sway, land and fade out. */
  draw(ctx: CanvasRenderingContext2D, d: ParadropDraw, m: MotionParams): void;
  /** The parachute mark on a cargo plane in flight. */
  drawMark(ctx: CanvasRenderingContext2D, p: ParachuteMarkDraw, m: MotionParams): void;
}

// ================================================================================================ a style

/** Everything one art style draws, one object per art category (art/artStyle.ts ArtCategory). */
export interface StyleModule {
  readonly id: ArtStyle;
  readonly ships: UnitArt;
  readonly land: UnitArt;
  readonly air: UnitArt;
  readonly missiles: UnitArt;
  readonly troopIcons: TroopIconArt;
  readonly wakes: TrailArt;
  readonly contrails: TrailArt;
  readonly explosions: ExplosionArt;
  readonly craters: CraterArt;
  readonly cannonFire: CannonArt;
  readonly paradrop: ParadropArt;
}
