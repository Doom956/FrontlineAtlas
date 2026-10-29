// Pure client helpers (no DOM): troop selection for attacks and transports, attackable tiles, transport origin.
import { describe, expect, it } from 'vitest';
import { formAlliance } from '../src/sim/diplomacy';
import { Terrain } from '../src/sim/types';
import { autoTransportFrom, isAttackable, troopsToSend } from '../src/client/input';
import { defaultUiState } from '../src/client/uiState';
import { claimRect, makeFlatGame, troopSum } from './helpers';

describe('troopsToSend', () => {
  it('sends the share of every type in proportion ("all")', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const p = s.players[1];
    p.troops = { infantry: 1000, armor: 400, artillery: 200 };
    const ui = defaultUiState();
    ui.attackShare = 0.25;
    expect(troopsToSend(p, ui)).toEqual({ infantry: 250, armor: 100, artillery: 50 });
  });

  it('applies normalised custom weights to the share of the whole army, capped per type', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const p = s.players[1];
    p.troops = { infantry: 1000, armor: 100, artillery: 0 };
    const ui = defaultUiState();
    ui.attackShare = 0.5; // 550 troops wanted
    ui.attackMixMode = 'custom';
    ui.customMix = { infantry: 1, armor: 1, artillery: 0 };
    const t = troopsToSend(p, ui);
    expect(t.infantry).toBeCloseTo(275);
    expect(t.armor).toBe(100); // capped: wanted 275
    expect(t.artillery).toBe(0);
    // never more than the player has
    ui.attackShare = 1;
    ui.customMix = { infantry: 0, armor: 0, artillery: 1 };
    expect(troopSum(troopsToSend(p, ui))).toBe(0);
  });

  it('sends nothing with all custom weights at zero', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const ui = defaultUiState();
    ui.attackMixMode = 'custom';
    ui.customMix = { infantry: 0, armor: 0, artillery: 0 };
    expect(troopSum(troopsToSend(s.players[1], ui))).toBe(0);
  });
});

describe('isAttackable', () => {
  it('allows neutral and enemy land, not own, allied or water tiles', () => {
    const s = makeFlatGame(30, 10, 3, { human: true });
    claimRect(s, 1, 0, 0, 4, 9);
    claimRect(s, 2, 10, 0, 14, 9);
    claimRect(s, 3, 20, 0, 24, 9);
    const w = s.map.width;
    expect(isAttackable(s, 1, 2 * w + 2)).toBe(false); // own
    expect(isAttackable(s, 1, 2 * w + 7)).toBe(true); // neutral
    expect(isAttackable(s, 1, 2 * w + 12)).toBe(true); // enemy
    formAlliance(s, 1, 3);
    expect(isAttackable(s, 1, 2 * w + 22)).toBe(false); // ally
    s.map.terrain[2 * w + 8] = Terrain.DeepWater;
    expect(isAttackable(s, 1, 2 * w + 8)).toBe(false); // water
  });
});

describe('autoTransportFrom', () => {
  it('picks the own coastal tile nearest to the target, or -1 without coast', () => {
    const s = makeFlatGame(30, 10, 2, { human: true });
    claimRect(s, 1, 0, 0, 9, 9);
    const w = s.map.width;
    expect(autoTransportFrom(s, 1, 5 * w + 25)).toBe(-1); // no water anywhere
    // A sea column at x = 10..19: own coast is x = 9.
    for (let y = 0; y < 10; y++) for (let x = 10; x < 20; x++) s.map.terrain[y * w + x] = Terrain.DeepWater;
    for (let y = 0; y < 10; y++) s.map.coastal[y * w + 9] = 1;
    expect(autoTransportFrom(s, 1, 7 * w + 20)).toBe(7 * w + 9);
  });
});
