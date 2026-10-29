// One simulation tick (100 ms of game time). Fixed system order for determinism.
import { aiSpawn, updateAI } from './ai';
import { updateBuildings } from './buildings';
import { updateAttacks, updateSupply } from './combat';
import { MAX_EVENTS, TICKS_PER_SECOND, TICK_SECONDS } from './config';
import { updateDiplomacy } from './diplomacy';
import { updateEconomy } from './economy';
import { addEvent, autoSpawnRemaining, pruneEliminated } from './state';
import { updateResearch } from './tech';
import { updateUnits } from './units';
import { updateVictory } from './victory';
import type { GameState } from './types';

/** Effects older than this are dropped (the client should be done with them). */
const EFFECT_TTL_TICKS = 3 * TICKS_PER_SECOND;

export function tick(state: GameState): void {
  if (state.phase === 'over') return;

  if (state.phase === 'spawn') {
    aiSpawn(state);
    state.spawnLeft -= TICK_SECONDS;
    if (state.spawnLeft <= 1e-9) {
      state.spawnLeft = 0;
      autoSpawnRemaining(state);
      state.phase = 'playing';
      addEvent(state, 'info', 'The war begins!', [], -1);
    }
  } else {
    updateEconomy(state);
    updateResearch(state);
    updateBuildings(state);
    updateSupply(state);
    updateAttacks(state);
    pruneEliminated(state);
    updateUnits(state);
    pruneEliminated(state);
    updateDiplomacy(state);
    updateAI(state);
    updateVictory(state);
  }

  state.tick++;
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  if (state.effects.length) {
    const t = state.tick;
    if (state.effects.some((e) => t - e.tick > EFFECT_TTL_TICKS)) {
      state.effects = state.effects.filter((e) => t - e.tick <= EFFECT_TTL_TICKS);
    }
  }
}
