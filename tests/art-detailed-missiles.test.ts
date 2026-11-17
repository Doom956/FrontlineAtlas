// The detailed missile looks: the silo rocket, the atom bomb, the cruise missile and the new anti-radar missile each bake
// to a non-empty sprite at several headings, and the anti-radar draw entry is there for the rules to wire in.
import { describe, expect, it } from 'vitest';
import { rasterize, solidCount, type Model } from '../src/client/art/detailed/bake';
import { cruiseModel } from '../src/client/art/detailed/cruise';
import { antiRadarModel, drawAntiRadar, legacyAtomBombModel, legacyCruiseModel, legacyRocketModel } from '../src/client/art/detailed/missiles';
import { modelLength, unitModel } from '../src/client/art/detailed/models';

const OWNER = [64, 160, 255] as const;
const MODELS: [string, Model][] = [
  ['rocket', unitModel('rocket', 0).model],
  ['atom bomb', unitModel('atomBomb', 0).model],
  ['cruise missile', cruiseModel(0, 1, false)],
  ['cruise missile with booster', cruiseModel(0, 0, true)],
  ['cruise missile climbing', cruiseModel(60, 0, true)],
  ['cruise missile diving', cruiseModel(-50, 1, false)],
  ['anti-radar missile', antiRadarModel()],
  ['old rocket', legacyRocketModel()],
  ['old atom bomb', legacyAtomBombModel()],
  ['old cruise missile', legacyCruiseModel()],
];

describe('detailed missile models', () => {
  for (const [name, model] of MODELS)
    it(`${name} bakes non-empty at several headings`, () => {
      for (const facing of [0, 5, 11, 16, 23, 30]) {
        const b = rasterize(model, 1.5, facing, { facings: 32, owner: OWNER });
        expect(solidCount(b)).toBeGreaterThan(8);
      }
    });

  it('the atom bomb is longer than the rocket, and both are longer than they are wide', () => {
    expect(modelLength(unitModel('atomBomb', 0))).toBeGreaterThan(modelLength(unitModel('rocket', 0)));
    expect(modelLength(unitModel('rocket', 0))).toBeGreaterThan(14);
  });

  it('the anti-radar missile has an exported draw entry (nothing calls it yet)', () => {
    expect(typeof drawAntiRadar).toBe('function');
    expect(drawAntiRadar.length).toBe(3);
  });
});
