// Unit sprites on the map and in the HUD, through the art switch (client only). render/units.ts picks the level of
// detail (far = small calm markers and fleet counts, drawn here and shared by every style; mid and near = the sprite
// of the current art style for the unit's category, art/registry.ts), and the HUD portraits (the unit card and the
// Forces list call drawUnitSprite) draw the same art as the map.
//
// What a player owns shows on their units (unitSpriteMods reads the owner's techs, read-only): arsenal variants have
// their own silhouettes and the upgrades add details (art/shared/keys.ts M_* bits). All art is original and drawn in
// code (art/<style>/).
import { UNITS } from '../../sim/config';
import { warshipMaxHp } from '../../sim/naval2';
import type { GameState, Player, Unit, UnitType, UnitVariant } from '../../sim/types';
import { artFor, motionFor } from '../art/registry';
import { setBakeBudget, atlasStats } from '../art/shared/atlas';
import { facingOf, M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, spriteKey, SPRITE_KEYS, unitCategoryOf, type SpriteKey } from '../art/shared/keys';
import type { UnitDraw, UnitLod } from '../art/types';
import type { RGB } from './common';

export { facingOf, M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, spriteKey, SPRITE_KEYS, type SpriteKey };

const AIR_TYPES: ReadonlySet<UnitType> = new Set<UnitType>(['bomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb']);

/** True when the unit has a sprite (every unit type and variant does). */
export function hasSprite(type: UnitType, variant?: UnitVariant): boolean {
  return SPRITE_KEYS.includes(spriteKey(type, variant));
}

/** True for planes and missiles (drawn above ships and tanks, with a ground shadow). */
export function isAirType(type: UnitType): boolean {
  return AIR_TYPES.has(type);
}

/** Length of a unit's sprite along its heading in screen px at map scale `scale` (1 = mid zoom), in its current style. */
export function spriteLength(type: UnitType, variant: UnitVariant | undefined, mods = 0, scale = 1): number {
  const key = spriteKey(type, variant);
  return artFor(unitCategoryOf(key)).lengthPx(key, mods, scale);
}

/** Sprites baked since the page loaded (stats). */
export const spriteStats = atlasStats;

/** The map limits how many sprites it bakes per frame (Infinity = no limit; the map sets it back after drawing). */
export function setSpriteBakeBudget(n: number): void {
  setBakeBudget(n);
}

/** Everything about one unit on the map that the art needs this frame, besides the picture. */
export interface MapSpriteState {
  zoom: number;
  scale: number;
  dpr: number;
  timeMs: number;
  turnRate: number;
  speed: number;
  moving: boolean;
  seed: number;
  /** 0 = full health .. 1 = about to sink or be destroyed (unitDamage) */
  damage: number;
}

/**
 * How badly a unit is hurt for the art, 0..1 (UnitDraw.damage): 1 - hp / max hp, read only. The max is the configured
 * hp (UNITS; warships: the sim's warshipMaxHp, which adds veterancy and the arsenal variant), or the unit's hp when that
 * is higher (an upgrade the client does not know about), so it is never negative. 0 for units with nothing to lose.
 */
export function unitDamage(u: Pick<Unit, 'type' | 'hp'> & Partial<Unit>): number {
  const hp = u.hp;
  if (typeof hp !== 'number' || !Number.isFinite(hp)) return 0;
  const base = u.type === 'warship' ? warshipMaxHp(u as Unit) : (UNITS[u.type]?.hp ?? 0);
  const max = Math.max(base, hp);
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - hp / max));
}

const draw: UnitDraw = { key: 'warship', mods: 0, owner: [0, 0, 0], x: 0, y: 0, angle: 0, zoom: 1, scale: 1, lod: 'mid', dpr: 1, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 0, alpha: 1, shadow: true, damage: 0 };

/**
 * A unit's sprite on the map in the current style of its category, centred at (x, y). False when it could not be drawn
 * this frame (draw its marker instead).
 */
export function drawMapSprite(ctx: CanvasRenderingContext2D, type: UnitType, variant: UnitVariant | undefined, x: number, y: number, angle: number, owner: RGB, mods: number, s: MapSpriteState): boolean {
  const key = spriteKey(type, variant);
  const cat = unitCategoryOf(key);
  const d = draw;
  d.key = key;
  d.mods = mods;
  d.owner = owner;
  d.x = x;
  d.y = y;
  d.angle = angle;
  d.zoom = s.zoom;
  d.scale = s.scale;
  d.lod = (s.scale >= 2 ? 'near' : 'mid') as UnitLod;
  d.dpr = s.dpr;
  d.timeMs = s.timeMs;
  d.turnRate = s.turnRate;
  d.speed = s.speed;
  d.moving = s.moving;
  d.seed = s.seed;
  d.alpha = 1;
  d.shadow = true;
  d.damage = s.damage;
  return artFor(cat).drawUnit(ctx, d, motionFor(cat));
}

/**
 * Draws a unit's sprite centred at (x, y), fitting in `lenPx` px (its length, or its span for wide planes), turned to
 * `angle`, in the current style of its category. Used by the HUD portraits. `mods` are the upgrade details to show;
 * without it, the details of the player whose colour `owner` is are used (in the game the map shows), and a tank
 * division without a variant gets that player's armor path.
 */
export function drawUnitSprite(ctx: CanvasRenderingContext2D, type: UnitType, variant: UnitVariant | undefined, x: number, y: number, lenPx: number, angle: number, owner: RGB, alpha = 1, mods?: number): boolean {
  let v = variant;
  let m = mods;
  if (m === undefined) {
    m = 0;
    const p = playerByColour(owner);
    if (p && seenState) {
      if (type === 'tankDivision' && !v) v = armorVariantOf(p);
      m = modsFor(seenState, p.id, type, v);
    }
  }
  const key = spriteKey(type, v);
  return artFor(unitCategoryOf(key)).drawPortrait(ctx, { key, mods: m, owner, x, y, boxPx: lenPx, angle, alpha });
}

/** Screen position of gun `index` of a ship's salvo, drawn at (x, y) with heading `angle` at map scale `scale`. */
export function turretPoint(type: UnitType, variant: UnitVariant | undefined, index: number, x: number, y: number, angle: number, scale: number): { x: number; y: number } {
  const key = spriteKey(type, variant);
  return artFor(unitCategoryOf(key)).turretPoint(key, 0, index, x, y, angle, scale);
}

// ------------------------------------------------------------------------------------------------- upgrades

/** The game whose players the portraits look up by colour (the renderer sets it every frame). */
let seenState: GameState | null = null;
export function setSpriteState(state: GameState | null): void {
  seenState = state;
}
function playerByColour(c: RGB): Player | null {
  const s = seenState;
  if (!s) return null;
  for (const p of s.players) if (p && p.color && p.color[0] === c[0] && p.color[1] === c[1] && p.color[2] === c[2]) return p;
  return null;
}
function armorVariantOf(p: Player): UnitVariant | undefined {
  return p.techs.includes('lightTanks') ? 'lightTank' : p.techs.includes('heavyTanks') ? 'heavyTank' : undefined;
}

interface OwnerMods {
  n: number;
  navy: number;
  armor: number;
  light: number;
  heavy: number;
  bomber: number;
  heavyBomber: number;
  fighter: number;
  cargo: number;
  recon: number;
}
const ownerMods = new WeakMap<GameState, Map<number, OwnerMods>>();

function computeOwner(p: Player): OwnerMods {
  const t = new Set(p.techs);
  const armor = (t.has('armorMastery') ? M_MASTERY : 0) | (t.has('amphibiousTanks') ? M_SPECIAL : 0);
  const air = (t.has('airMastery') ? M_MASTERY : 0) | (t.has('dropTanks') ? M_SPECIAL : 0);
  const jet = t.has('jetEngines') ? M_JET : 0;
  const night = t.has('nightBombing') ? M_NIGHT : 0;
  return {
    n: p.techs.length,
    navy: (t.has('navalMastery') ? M_MASTERY : 0) | (t.has('navalMines') ? M_SPECIAL : 0),
    armor,
    light: armor | (t.has('deepRaids') ? M_PATH3 : 0),
    heavy: armor | (t.has('siegeTanks') ? M_PATH3 : 0),
    bomber: air | jet | night,
    heavyBomber: air | night | (t.has('strategicBombing') ? M_PATH3 : 0),
    fighter: air | jet,
    cargo: (t.has('dropTanks') ? M_SPECIAL : 0) | jet,
    recon: t.has('dropTanks') ? M_SPECIAL : 0,
  };
}

/** Upgrade details (spriteArt.ts M_*) a unit of `owner` shows, from the owner's techs (read only, cached per owner). */
export function modsFor(state: GameState, owner: number, type: UnitType, variant: UnitVariant | undefined): number {
  const p = state.players[owner];
  if (!p || !p.techs) return 0;
  let per = ownerMods.get(state);
  if (!per) ownerMods.set(state, (per = new Map()));
  let o = per.get(owner);
  if (!o || o.n !== p.techs.length) per.set(owner, (o = computeOwner(p)));
  switch (type) {
    case 'warship':
      return o.navy;
    case 'tankDivision':
      return variant === 'lightTank' ? o.light : variant === 'heavyTank' ? o.heavy : o.armor;
    case 'bomber':
      return variant === 'heavyBomber' ? o.heavyBomber : o.bomber;
    case 'fighter':
      return o.fighter;
    case 'transportPlane':
      return o.cargo;
    case 'reconPlane':
      return o.recon;
    default:
      return 0;
  }
}

/** Upgrade details of one unit on the map. */
export function unitSpriteMods(state: GameState, u: Unit): number {
  return modsFor(state, u.owner, u.type, u.variant);
}

// ------------------------------------------------------------------------------------------------- far zoom

/**
 * Far zoom marker: a tiny solid shape in the owner's colour with a dark edge, one per unit class (ship = lozenge,
 * tank = square, plane = small arrow, missile = dot). No detail, so hundreds of them stay calm.
 */
export function drawUnitMarker(ctx: CanvasRenderingContext2D, type: UnitType, x: number, y: number, size: number, angle: number, fill: string): void {
  const s = size;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  if (type === 'tankDivision') {
    ctx.rect(-s * 0.42, -s * 0.42, s * 0.84, s * 0.84);
  } else if (type === 'rocket' || type === 'atomBomb') {
    ctx.arc(0, 0, s * (type === 'atomBomb' ? 0.42 : 0.32), 0, Math.PI * 2);
  } else if (type === 'bomber' || type === 'fighter' || type === 'transportPlane' || type === 'reconPlane') {
    ctx.rotate(angle);
    ctx.moveTo(s * 0.55, 0);
    ctx.lineTo(-s * 0.45, s * 0.45);
    ctx.lineTo(-s * 0.2, 0);
    ctx.lineTo(-s * 0.45, -s * 0.45);
    ctx.closePath();
  } else {
    ctx.rotate(angle);
    ctx.moveTo(s * 0.62, 0);
    ctx.lineTo(s * 0.2, s * 0.3);
    ctx.lineTo(-s * 0.55, s * 0.3);
    ctx.lineTo(-s * 0.55, -s * 0.3);
    ctx.lineTo(s * 0.2, -s * 0.3);
    ctx.closePath();
  }
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(14,18,24,0.8)';
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}
