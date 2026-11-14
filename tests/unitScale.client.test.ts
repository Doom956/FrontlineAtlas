// One pixel size for a scene: the effects tied to units (muzzle flashes, deaths, fx/pixelFx.ts) use the unit sprites'
// own scale (render/units.ts spriteScale, 1.5 at mid zoom), so a ship's flashes sit on its barrels and a death is the
// size of the unit that died.
import { describe, expect, it } from 'vitest';
import { detailedUnits } from '../src/client/art/detailed/units';
import { pixelSize } from '../src/client/fx/pixelFx';
import { MID_UNIT_SCALE, spriteScale } from '../src/client/render/units';

describe('effects and units share one pixel size', () => {
  it('uses the sprite scale at every zoom (1.5 at mid zoom)', () => {
    for (const z of [2, 3, 4, 5, 8, 10.9, 11, 15, 21.9, 22, 31, 32, 40]) expect(pixelSize(z), `zoom ${z}`).toBe(spriteScale(z));
    expect(pixelSize(6)).toBe(MID_UNIT_SCALE);
  });

  it('puts a battleship gun where the 1.5x ship has it, not where a 1x ship would', () => {
    const at1 = detailedUnits.turretPoint('battleship', 0, 0, 0, 0, 0, 1);
    const at = detailedUnits.turretPoint('battleship', 0, 0, 0, 0, 0, pixelSize(6));
    // the gun is out along the hull, and 1.5 times further out at 1.5x
    expect(Math.abs(at1.x)).toBeGreaterThan(3);
    expect(at.x / at1.x).toBeCloseTo(MID_UNIT_SCALE, 1);
  });
});
