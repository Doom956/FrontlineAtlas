// One simulation tick (100 ms of game time). Fixed system order for determinism.
import { updateAdvisor } from './advisor';
import { clearLeaderCache, updateAllies } from './allies';
import { aiSpawn, updateAI } from './ai';
import { updateBuildings } from './buildings';
import { updateBuildQueues } from './bulkbuild';
import { updateSpending } from './spending';
import { updateBarrages } from './barrage';
import { clearArmyCache, updateAttacks, updateHeartlands, updateSupply } from './combat';
import { MAX_EVENTS, TICKS_PER_SECOND, TICK_SECONDS } from './config';
import { updateDiplomacy } from './diplomacy';
import { updateDoctrines } from './doctrines';
import { updateEconomy } from './economy';
import { updateEndgame } from './endgame';
import { mods, updateRules } from './rules';
import { addEvent, autoSpawnRemaining, pruneEliminated, randomSpawnHumans } from './state';
import { updateResearch } from './tech';
import { updateProcurement } from './procurement';
import { updateUnits } from './units';
import { updateAir } from './airwings';
import { clearIntelCache, updateArsenal } from './variants';
import { updateNavyQueue } from './navy';
import { clearDefenseCache, updateTanks } from './tanks';
import { updateSpecials } from './specials';
import { updateWarMemory } from './naval2';
import { updateTutorial } from './tutorialScenario';
import { updateVictory } from './victory';
import type { GameState } from './types';

/** Effects older than this are dropped (the client should be done with them). */
const EFFECT_TTL_TICKS = 3 * TICKS_PER_SECOND;

export function tick(state: GameState): void {
  if (state.phase === 'over') return;
  clearArmyCache(state); // client reads between ticks must not fill it (combat.ts)
  clearIntelCache(state); // the same for recon intel (variants.ts)
  clearDefenseCache(state); // division defence (tanks.ts)
  clearLeaderCache(state); // runaway leader (allies.ts)

  if (state.phase === 'spawn') {
    if (state.tick === 0 && mods(state).randomSpawn) randomSpawnHumans(state);
    aiSpawn(state);
    state.spawnLeft -= TICK_SECONDS;
    if (state.spawnLeft <= 1e-9) {
      state.spawnLeft = 0;
      autoSpawnRemaining(state);
      state.phase = 'playing';
      state.playStartTick = state.tick;
      addEvent(state, 'info', 'The war begins!', [], -1);
    }
  } else {
    updateDoctrines(state);
    updateEconomy(state);
    updateResearch(state);
    updateProcurement(state); // Arsenal deliveries
    updateBuildings(state);
    updateBuildQueues(state);
    updateSupply(state);
    updateHeartlands(state);
    updateAttacks(state);
    updateWarMemory(state);
    updateEndgame(state);
    pruneEliminated(state);
    updateSpecials(state); // mines, wading tank divisions (specials.ts); before updateUnits drops sunk ships
    updateUnits(state);
    updateAir(state);
    updateArsenal(state); // recon planes, reveals, hold zones (variants.ts)
    updateNavyQueue(state);
    updateTanks(state);
    updateBarrages(state);
    pruneEliminated(state);
    updateDiplomacy(state);
    updateAllies(state);
    updateSpending(state);
    updateAI(state);
    updateAdvisor(state);
    if (state.tutorial) updateTutorial(state); // tutorial games only (tutorialScenario.ts)
    updateVictory(state);
    updateRules(state, (message) => addEvent(state, 'info', message, [], -1));
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
