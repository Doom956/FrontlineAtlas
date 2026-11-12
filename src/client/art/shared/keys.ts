// Which picture a unit is (client only, shared by every art style): the sprite key of a unit type and arsenal variant,
// its art category, and the upgrade details a player owns as bits. Pure data, no drawing.
import type { UnitType, UnitVariant } from '../../../sim/types';

/** Upgrade details a unit shows (bit mask), read from its owner's techs by render/pixelSprites.ts modsFor. */
export const M_MASTERY = 1;
/** the third arsenal path: Deep Raids (light tank), Siege Tanks (heavy tank), Strategic Bombing (heavy bomber) */
export const M_PATH3 = 2;
export const M_JET = 4;
/** Naval Mines, Amphibious Tanks, Drop Tanks */
export const M_SPECIAL = 8;
export const M_NIGHT = 16;
export const ALL_MODS = M_MASTERY | M_PATH3 | M_JET | M_SPECIAL | M_NIGHT;

export type SpriteKey =
  | 'warship'
  | 'destroyer'
  | 'battleship'
  | 'submarine'
  | 'carrier'
  | 'transport'
  | 'tradeShip'
  | 'tankDivision'
  | 'lightTank'
  | 'heavyTank'
  | 'bomber'
  | 'groundAttack'
  | 'heavyBomber'
  | 'fighter'
  | 'transportPlane'
  | 'reconPlane'
  | 'rocket'
  | 'atomBomb';

export const SPRITE_KEYS: readonly SpriteKey[] = ['warship', 'destroyer', 'battleship', 'submarine', 'carrier', 'transport', 'tradeShip', 'tankDivision', 'lightTank', 'heavyTank', 'bomber', 'groundAttack', 'heavyBomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb'];

export const SHIP_KEYS: readonly SpriteKey[] = ['warship', 'destroyer', 'battleship', 'submarine', 'carrier', 'transport', 'tradeShip'];
export const LAND_KEYS: readonly SpriteKey[] = ['tankDivision', 'lightTank', 'heavyTank'];
export const PLANE_KEYS: readonly SpriteKey[] = ['bomber', 'groundAttack', 'heavyBomber', 'fighter', 'transportPlane', 'reconPlane'];
export const MISSILE_KEYS: readonly SpriteKey[] = ['rocket', 'atomBomb'];

/** The art categories that draw units. */
export type UnitArtCategory = 'ships' | 'land' | 'air' | 'missiles';

/** Sprite key of a unit: arsenal variants have their own art; the unit before any arsenal pick keeps its plain look. */
export function spriteKey(type: UnitType, variant: UnitVariant | undefined): SpriteKey {
  if (type === 'warship') return variant === 'destroyer' || variant === 'battleship' || variant === 'submarine' || variant === 'carrier' ? variant : 'warship';
  if (type === 'tankDivision') return variant === 'lightTank' || variant === 'heavyTank' ? variant : 'tankDivision';
  if (type === 'bomber') return variant === 'groundAttack' || variant === 'heavyBomber' ? variant : 'bomber';
  return type;
}

/** The art category that draws a sprite. */
export function unitCategoryOf(key: SpriteKey): UnitArtCategory {
  if (key === 'rocket' || key === 'atomBomb') return 'missiles';
  if (key === 'tankDivision' || key === 'lightTank' || key === 'heavyTank') return 'land';
  if (PLANE_KEYS.includes(key)) return 'air';
  return 'ships';
}

/** Planes and missiles: drawn above ships and tanks, with a ground shadow. */
export function isAirKey(key: SpriteKey): boolean {
  const c = unitCategoryOf(key);
  return c === 'air' || c === 'missiles';
}

/** Heading in radians to one of `n` facings (0 = east, clockwise on screen). */
export function facingOf(angle: number, n = 16): number {
  const step = (Math.PI * 2) / n;
  return ((Math.round(angle / step) % n) + n) % n;
}

/** The unit type a sprite belongs to (arsenal variants to their base type). */
export function unitTypeOf(key: SpriteKey): UnitType {
  switch (key) {
    case 'destroyer':
    case 'battleship':
    case 'submarine':
    case 'carrier':
      return 'warship';
    case 'lightTank':
    case 'heavyTank':
      return 'tankDivision';
    case 'groundAttack':
    case 'heavyBomber':
      return 'bomber';
    default:
      return key;
  }
}

/** The arsenal variant a sprite shows (undefined for a plain unit). */
export function variantOf(key: SpriteKey): UnitVariant | undefined {
  switch (key) {
    case 'destroyer':
    case 'battleship':
    case 'submarine':
    case 'carrier':
    case 'lightTank':
    case 'heavyTank':
    case 'groundAttack':
    case 'heavyBomber':
      return key;
    default:
      return undefined;
  }
}
