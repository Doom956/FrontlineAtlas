// Shaded pixel unit sprites (client/render/spriteArt.ts, spriteBake.ts, pixelSprites.ts): every unit and arsenal
// variant has its own silhouette, upgrades add visible details, and reading a player's techs never writes the state.
import { describe, expect, it } from 'vitest';
import { UNITS } from '../src/sim/config';
import { UNIT_VARIANTS, type UnitType, type UnitVariant } from '../src/sim/types';
import { buildModel, M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, MOD_MASK, SPRITE_KEYS, type SpriteKey } from '../src/client/render/spriteArt';
import { FACINGS, OUTLINE, rasterize, solidCount, type Baked } from '../src/client/render/spriteBake';
import { drawUnitSprite, facingOf, hasSprite, modsFor, spriteKey, spriteLength } from '../src/client/render/pixelSprites';
import { hashState } from '../src/sim/hash';
import { makeFlatGame } from './helpers';

const BLUE: [number, number, number] = [64, 160, 255];
const bake = (key: SpriteKey, mods = 0, facing = 0, owner = BLUE): Baked => rasterize(buildModel(key, mods), 1, facing, owner);

/** Share of pixels where two sprites differ in being solid (aligned on their model origin). */
function silhouetteDiff(a: Baked, b: Baked): number {
  let diff = 0;
  let total = 0;
  for (let y = -40; y < 40; y++) {
    for (let x = -40; x < 40; x++) {
      const pa = solidAt(a, x + a.ox, y + a.oy);
      const pb = solidAt(b, x + b.ox, y + b.oy);
      if (pa || pb) total++;
      if (pa !== pb) diff++;
    }
  }
  return diff / Math.max(1, total);
}
function solidAt(b: Baked, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= b.w || y >= b.h) return false;
  return b.data[(y * b.w + x) * 4 + 3] === 255;
}
function pixelDiff(a: Baked, b: Baked): number {
  let d = 0;
  for (let y = -40; y < 40; y++)
    for (let x = -40; x < 40; x++) {
      const ia = solidAt(a, x + a.ox, y + a.oy) ? ((y + a.oy) * a.w + x + a.ox) * 4 : -1;
      const ib = solidAt(b, x + b.ox, y + b.oy) ? ((y + b.oy) * b.w + x + b.ox) * 4 : -1;
      if (ia < 0 && ib < 0) continue;
      if (ia < 0 || ib < 0 || a.data[ia] !== b.data[ib] || a.data[ia + 1] !== b.data[ib + 1] || a.data[ia + 2] !== b.data[ib + 2]) d++;
    }
  return d;
}

describe('unit sprites', () => {
  it('has a sprite for every unit type and every arsenal variant, the plain unit included', () => {
    for (const type of Object.keys(UNITS) as UnitType[]) expect(hasSprite(type), type).toBe(true);
    const variantType: Record<UnitVariant, UnitType> = { destroyer: 'warship', battleship: 'warship', submarine: 'warship', carrier: 'warship', lightTank: 'tankDivision', heavyTank: 'tankDivision', groundAttack: 'bomber', heavyBomber: 'bomber' };
    for (const v of UNIT_VARIANTS) {
      expect(spriteKey(variantType[v], v)).toBe(v);
      expect(spriteKey(variantType[v], v)).not.toBe(variantType[v]);
    }
    expect(spriteKey('warship', undefined)).toBe('warship');
    expect(spriteKey('tankDivision', undefined)).toBe('tankDivision');
    expect(spriteKey('bomber', undefined)).toBe('bomber');
    for (const key of SPRITE_KEYS) expect(solidCount(bake(key)), key).toBeGreaterThan(40);
  });

  it('gives every variant a different silhouette, not only a colour', () => {
    const families: SpriteKey[][] = [
      ['warship', 'destroyer', 'battleship', 'submarine', 'carrier'],
      ['tankDivision', 'lightTank', 'heavyTank'],
      ['bomber', 'groundAttack', 'heavyBomber'],
    ];
    for (const fam of families)
      for (let i = 0; i < fam.length; i++)
        for (let j = i + 1; j < fam.length; j++) expect(silhouetteDiff(bake(fam[i]), bake(fam[j])), `${fam[i]} vs ${fam[j]}`).toBeGreaterThan(0.15);
    // sizes tell them apart too: the battleship and carrier are the longest ships, the heavy tank the biggest tank
    expect(spriteLength('warship', 'battleship')).toBeGreaterThan(spriteLength('warship', 'destroyer'));
    expect(spriteLength('warship', 'carrier')).toBeGreaterThan(spriteLength('warship', undefined));
    expect(spriteLength('tankDivision', 'heavyTank')).toBeGreaterThan(spriteLength('tankDivision', undefined));
    expect(spriteLength('tankDivision', undefined)).toBeGreaterThan(spriteLength('tankDivision', 'lightTank'));
    expect(solidCount(bake('heavyBomber'))).toBeGreaterThan(solidCount(bake('bomber')));
  });

  it('shows the upgrades a player owns as visible details', () => {
    for (const key of SPRITE_KEYS) {
      for (const bit of [M_MASTERY, M_PATH3, M_JET, M_SPECIAL, M_NIGHT]) {
        if (!(MOD_MASK[key] & bit)) continue;
        expect(pixelDiff(bake(key, 0), bake(key, bit)), `${key} mod ${bit}`).toBeGreaterThan(5);
      }
    }
    // bits a sprite cannot show change nothing
    expect(pixelDiff(bake('transport', 0), bake('transport', M_MASTERY | M_JET))).toBe(0);
  });

  it('draws a dark 1 px outline, the owner colour only on small parts, the same art every time', () => {
    const b = bake('destroyer');
    let outline = 0;
    let own = 0;
    let solid = 0;
    for (let i = 0; i < b.data.length; i += 4) {
      if (b.data[i + 3] !== 255) continue;
      solid++;
      if (b.data[i] === OUTLINE[0] && b.data[i + 1] === OUTLINE[1] && b.data[i + 2] === OUTLINE[2]) outline++;
      if (b.data[i] === BLUE[0] && b.data[i + 1] === BLUE[1] && b.data[i + 2] === BLUE[2]) own++;
    }
    expect(outline).toBeGreaterThan(30);
    expect(own).toBeGreaterThan(0);
    expect(own / solid).toBeLessThan(0.15); // a band, not a tint
    expect(Array.from(bake('destroyer').data)).toEqual(Array.from(b.data));
    // another owner changes only the owner parts
    const red = bake('destroyer', 0, 0, [220, 60, 50]);
    expect(silhouetteDiff(b, red)).toBe(0);
  });

  it('bakes 16 headings: a ship heading south is taller than wide, heading east wider than tall', () => {
    expect(FACINGS).toBe(16);
    const east = bake('battleship', 0, 0);
    const south = bake('battleship', 0, 4);
    expect(east.w).toBeGreaterThan(east.h);
    expect(south.h).toBeGreaterThan(south.w);
    expect(facingOf(0)).toBe(0);
    expect(facingOf(Math.PI / 2)).toBe(4);
    expect(facingOf(-Math.PI / 2)).toBe(12);
    expect(facingOf(Math.PI)).toBe(8);
  });

  it('reads the upgrades from the owner techs without writing to the game', () => {
    const s = makeFlatGame(30, 20, 2, { human: true });
    const before = hashState(s);
    expect(modsFor(s, 1, 'warship', 'destroyer')).toBe(0);
    s.players[1].techs.push('navalMastery', 'dropTanks', 'jetEngines', 'siegeTanks');
    const mid = hashState(s);
    expect(modsFor(s, 1, 'warship', 'destroyer') & M_MASTERY).toBeTruthy();
    expect(modsFor(s, 1, 'fighter', undefined) & (M_JET | M_SPECIAL)).toBe(M_JET | M_SPECIAL);
    expect(modsFor(s, 1, 'tankDivision', 'heavyTank') & M_PATH3).toBeTruthy();
    expect(modsFor(s, 1, 'tankDivision', 'lightTank') & M_PATH3).toBe(0);
    expect(modsFor(s, 2, 'warship', 'destroyer')).toBe(0);
    expect(hashState(s)).toBe(mid);
    expect(before).not.toBe(mid);
  });

  it('draws nothing (and does not throw) where there is no canvas', () => {
    const ctx = {} as CanvasRenderingContext2D;
    expect(drawUnitSprite(ctx, 'warship', 'battleship', 10, 10, 40, 0, BLUE)).toBe(false);
  });
});
