// The top-right clock in single player counts real seconds played (steady at any x1/x2/x4 speed), not game time.
// The real accumulation happens in the frame loop (main.ts) and is play-checked; here we lock the field and seed.
import { describe, expect, it } from 'vitest';
import { defaultUiState } from '../src/client/uiState';
import { gameSeconds } from '../src/sim/state';
import { tick } from '../src/sim/sim';
import { makeFlatGame } from './helpers';

describe('real-time clock (single player)', () => {
  it('a fresh ui starts its real clock at zero', () => {
    expect(defaultUiState().playRealMs).toBe(0);
  });

  it('game time still advances with ticks (the online clock and the loaded-save seed use it)', () => {
    const s = makeFlatGame(40, 30, 2, { human: true });
    s.phase = 'playing';
    s.playStartTick = s.tick;
    const before = gameSeconds(s);
    for (let k = 0; k < 40; k++) tick(s);
    expect(gameSeconds(s)).toBeGreaterThan(before);
    // a loaded save seeds the real clock from game time, so continuing keeps the clock where it was
    const seededMs = gameSeconds(s) * 1000;
    expect(seededMs).toBeGreaterThan(0);
  });
});
