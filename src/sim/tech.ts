// Research tree.
import { TECHS, TICK_SECONDS } from './config';
import { addEvent } from './state';
import type { ActionResult, GameState, Player, TechId } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

export function hasTech(p: Player, t: TechId): boolean {
  return p.techs.includes(t);
}
export function canResearch(state: GameState, playerId: number, t: TechId): ActionResult {
  const p = state.players[playerId];
  const info = TECHS[t];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (!info) return FAIL('Unknown tech');
  if (hasTech(p, t)) return FAIL(`${info.name} is already researched`);
  if (p.researching === t) return FAIL(`Already researching ${info.name}`);
  const missing = info.requires.filter((r) => !hasTech(p, r));
  if (missing.length) return FAIL(`Needs ${missing.map((r) => TECHS[r].name).join(' and ')}`);
  if (p.gold < info.gold) return FAIL(`Not enough gold (${info.gold})`);
  return { ok: true };
}
/**
 * Pays gold and starts (replacing the current research loses its progress). Science saved up while nothing was
 * being researched (Player.science) is spent first.
 */
export function startResearch(state: GameState, playerId: number, t: TechId): ActionResult {
  const ok = canResearch(state, playerId, t);
  if (!ok.ok) return ok;
  const p = state.players[playerId];
  const info = TECHS[t];
  p.gold -= info.gold;
  p.researching = t;
  const take = Math.min(p.science, info.science);
  p.science -= take;
  p.researchProgress = take;
  return { ok: true };
}
/**
 * Science income goes into the current tech (or the science stock when idle); on completion push to techs,
 * overflow goes to the stock, 'researchDone' event.
 */
export function updateResearch(state: GameState): void {
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || !p.spawned) continue;
    const gained = p.income.science * TICK_SECONDS;
    if (!p.researching) {
      p.science += gained;
      continue;
    }
    const info = TECHS[p.researching];
    p.researchProgress += gained;
    if (p.researchProgress >= info.science - 1e-9) {
      p.science += Math.max(0, p.researchProgress - info.science);
      if (!hasTech(p, p.researching)) p.techs.push(p.researching);
      addEvent(state, 'researchDone', `Research complete: ${info.name}`, [p.id], -1);
      p.researching = null;
      p.researchProgress = 0;
    }
  }
}
