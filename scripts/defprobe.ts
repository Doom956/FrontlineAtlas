// Defense probe for scripts/batch.ts (read-only; never changes a value of the game): flak, tank traps, coastal
// batteries, Tracking Radar, anti-radar missiles, the Counteroffensive, Siege Tanks against forts, pillar picks.
// One probe per game: afterTick(state) before batch clears state.events / state.effects, finish(state) at the end.
// Counts are plain numbers in one record (DefStats) so games merge by adding.
import { TICKS_PER_SECOND } from '../src/sim/config';
import { arsenalItem } from '../src/sim/arsenal';
import { buildingsOf } from '../src/sim/buildings';
import { isTribe } from '../src/sim/types';
import { aiDefenseCommitted } from '../src/sim/variantsAI';
import { aiStealthPick } from '../src/sim/stealth';
import { stealthPlayerReason } from '../src/sim/units';
import type { GameState } from '../src/sim/types';

export type DefStats = Record<string, number>;
export const newDefStats = (): DefStats => ({});
export function addDefStats(a: DefStats, b: DefStats): void {
  for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k];
}
const AFTER = 90 * TICKS_PER_SECOND;

export class DefenseProbe {
  readonly stats: DefStats = {};
  private lastState = new Map<number, number>();
  private sawTrap = new Set<number>();
  private trapLossSeen = new Map<number, number>();
  private forts = new Map<number, number>();
  private pending: { owner: number; tiles: number; at: number }[] = [];
  private transTroops = new Map<number, number>();
  private transHit = new Set<number>();
  private spearFoe = new Map<number, number>();
  private seen = new Set<number>();
  private add(k: string, v = 1): void {
    this.stats[k] = (this.stats[k] ?? 0) + v;
  }

  afterTick(state: GameState): void {
    for (const e of state.events) {
      const m = e.message;
      if (e.kind === 'bombing') {
        if (/flak turned back a/.test(m)) this.add(/stealth/.test(m) ? 'flakBackStealth' : /cargo/.test(m) ? 'flakBackCargo' : 'flakBackBomber');
        const strike = /^Stealth strike by /.test(m) || / bombed /.test(m) || / bombers are supporting the attack /.test(m);
        if (strike) {
          const k = /^Stealth strike/.test(m) ? 'Stealth' : 'Bomb';
          this.add('strikes' + k);
          const f = /\(flak: (\d+)% less\)/.exec(m);
          if (f) {
            this.add('flakStrikes' + k);
            this.add('flakLostPct' + k, Number(f[1]));
          }
        }
        if (/Tracking Radar spotted/.test(m)) this.add('radarSpots');
        if (/anti-radar missile of .* knocked out a SAM/.test(m)) this.add('arKnocked');
      } else if (e.kind === 'unitLost') {
        if (/coastal battery/.test(m)) this.add(/transport/i.test(m) ? 'battSunkTransport' : 'battSunkShip');
        const sd = /shot down a ([a-z -]+?)( \(|\s+of )/.exec(m);
        if (/shot down a stealth bomber/.test(m)) this.add('stealthShot');
        if (/shot down a anti-radar missile/.test(m)) this.add('arShot');
        if (sd && /shot down a stealth bomber/.test(m) && /Tracking Radar|SAM/.test(m)) this.add('stealthShotSam');
      } else if (e.kind === 'missile' && /fired an anti-radar missile/.test(m)) this.add('arFired');
      else if (e.kind === 'buildingLost' && /anti-radar missile of .* destroyed a SAM/.test(m)) this.add('arDestroyed');
      else if (e.kind === 'attackStarted' && /launched a Counteroffensive/.test(m)) {
        this.add('counterLaunch');
        const pid = e.players[0];
        this.pending.push({ owner: pid, tiles: state.players[pid].stats.tilesCaptured, at: state.tick });
      } else if (e.kind === 'info' && /Counteroffensive ready/.test(m)) this.add('counterReady');
      else if (e.kind === 'info' && /shelled a coastal battery/.test(m)) this.add('battShelled');
    }
    for (const f of state.effects) {
      if (f.kind === 'trapHit') this.add('trapHits');
      else if (f.kind === 'battery') this.add('battShots');
    }
    // new units: sorties, ships and landings, anti-radar missiles
    for (const u of state.units) {
      if (u.type === 'transport' && u.targetOwner > 0) {
        const tt = u.troops.infantry + u.troops.armor + u.troops.artillery;
        const pt = this.transTroops.get(u.id);
        if (pt !== undefined && tt < pt - 1e-6) this.add('transTroopsLost', pt - tt);
        if (pt === undefined) this.add('transTroopsLaunched', tt);
        this.transTroops.set(u.id, tt);
        // a landing that sailed into shore fire: its troops at launch, counted once
        if ((u.shoreLoss ?? 0) > 0 && !this.transHit.has(u.id)) {
          this.transHit.add(u.id);
          this.add('transHit');
          this.add('transHitLaunched', tt / Math.max(1e-9, 1 - (u.shoreLoss ?? 0)));
        }
        if (this.transHit.has(u.id) && pt !== undefined && tt < pt - 1e-6) this.add('transHitLost', pt - tt);
      }
      if (this.seen.has(u.id)) {
        if (u.type === 'tankDivision') this.divisions(state, u);
        continue;
      }
      this.seen.add(u.id);
      if (u.type === 'stealthBomber') this.add('stealthSorties');
      else if (u.type === 'bomber') this.add('bomberSorties');
      else if (u.type === 'antiRadarMissile') this.add('arMissiles');
      else if (u.type === 'transport' && u.targetOwner > 0) this.add('seaInvasions');
      else if (u.type === 'tankDivision') this.divisions(state, u);
    }
    // spearheads ended: slowed by traps or not
    if (state.tick % 5 === 0) this.fortWatch(state);
    if (state.tick % (60 * TICKS_PER_SECOND) === 0) this.minuteWatch(state);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const q = this.pending[i];
      if (state.tick - q.at < AFTER) continue;
      this.add('counterLand', state.players[q.owner].stats.tilesCaptured - q.tiles);
      this.pending.splice(i, 1);
    }
  }

  /** once a game minute: Air Mastery and Anti-radar holders at war, and what keeps the stealth bomber home */
  private minuteWatch(state: GameState): void {
    const fighting = new Set<number>();
    for (const a of state.attacks) {
      if (a.target <= 0) continue;
      fighting.add(a.attacker);
      fighting.add(a.target);
    }
    for (const p of state.players) {
      if (p.id === 0 || !p.alive || p.isHuman || isTribe(p) || !fighting.has(p.id)) continue;
      if (p.techs.includes('antiRadar')) this.add('arWarMin');
      if (!p.techs.includes('airMastery')) continue;
      this.add('stWarMin');
      const why = stealthPlayerReason(state, p.id);
      if (why) this.add(/in the air/.test(why) ? 'stGateAir' : /Recharging/.test(why) ? 'stGateRecharge' : 'stGateCost');
      else if (!aiStealthPick(state, p.id)) this.add('stGateTarget');
    }
  }

  private divisions(state: GameState, u: { id: number; state: number; trapLoss?: number; targetOwner: number; owner: number }): void {
    const prev = this.lastState.get(u.id);
    if (u.state === 3 && prev !== 3) {
      const q = state.players[u.targetOwner];
      this.spearFoe.set(u.id, q && q.techs.includes('tankTraps') ? 1 + (state.players[u.owner]?.techs.includes('siegeTanks') ? 1 : 0) : 0);
    }
    if (u.state === 3 && (u.trapLoss ?? 0) > 0) {
      this.sawTrap.add(u.id);
      this.trapLossSeen.set(u.id, Math.max(this.trapLossSeen.get(u.id) ?? 0, u.trapLoss ?? 0));
    }
    if (prev === 3 && u.state !== 3) {
      this.add('spearheads');
      if (this.sawTrap.has(u.id)) {
        this.add('spearTrapped');
        this.add('trapTroopsLost', this.trapLossSeen.get(u.id) ?? 0);
      }
      const into = this.spearFoe.get(u.id) ?? 0;
      if (into === 1) {
        this.add('spearIntoTraps');
        if (this.sawTrap.has(u.id)) this.add('spearIntoTrapsSlowed');
      } else if (into === 2) this.add('spearSiegeIntoTraps');
      this.spearFoe.delete(u.id);
      this.sawTrap.delete(u.id);
      this.trapLossSeen.delete(u.id);
    }
    this.lastState.set(u.id, u.state);
    void state;
  }

  /** forts newly knocked out while a Siege Tanks spearhead of a hostile nation is within reach */
  private fortWatch(state: GameState): void {
    const heads = state.units.filter((u) => u.type === 'tankDivision' && u.state === 3 && u.hp > 0 && state.players[u.owner]?.techs.includes('siegeTanks'));
    for (const b of state.buildings.values()) {
      if (b.type !== 'fort') continue;
      const was = this.forts.get(b.id) ?? 0;
      this.forts.set(b.id, b.disabledUntil);
      if (b.disabledUntil <= state.tick || b.disabledUntil <= was) continue;
      const w = state.map.width;
      const near = heads.some((u) => u.owner !== b.owner && Math.hypot(u.x - (b.tile % w), u.y - ((b.tile / w) | 0)) < 20);
      if (!near) continue;
      this.add('siegeFortKnocks');
      if (state.players[b.owner]?.techs.includes('flakGuns') || state.players[b.owner]?.techs.includes('tankTraps') || state.players[b.owner]?.techs.includes('coastalBatteries')) this.add('siegeKnocksDefenseFort');
    }
  }

  finish(state: GameState): void {
    this.add('gameSeconds', state.tick / TICKS_PER_SECOND);
    for (const p of state.players) {
      if (p.id === 0 || isTribe(p) || !p.spawned) continue;
      this.add('nations');
      this.add('capturedTotal', p.stats.tilesCaptured);
      if ((p.techs.includes('flakGuns') || p.techs.includes('tankTraps')) && p.personality === 'turtle') this.add('defPickTurtle');
      if (p.personality === 'turtle') this.add('turtles');
      if (aiDefenseCommitted(state, p.id)) this.add('defCommitted');
      const pillars = new Set<string>();
      for (const t of p.techs) {
        const it = arsenalItem(t);
        if (it && it.pillar !== 'shared' && (it.kind === 'variant' || it.kind === 'mastery')) pillars.add(it.pillar);
      }
      for (const k of pillars) this.add('pick_' + k);
      if (p.techs.includes('flakGuns')) this.add('has_flakGuns');
      if (p.techs.includes('tankTraps')) this.add('has_tankTraps');
      if (p.techs.includes('coastalBatteries')) this.add('has_coastalBatteries');
      if (p.techs.includes('trackingRadar')) this.add('has_trackingRadar');
      if (p.techs.includes('antiRadar')) this.add('has_antiRadar');
      if (p.techs.includes('siegeTanks')) this.add('has_siegeTanks');
      if (p.techs.includes('defenseMastery')) this.add('has_defenseMastery');
      void buildingsOf;
    }
  }
}

export function defReport(s: DefStats, games: number): string[] {
  const g = (k: string): number => s[k] ?? 0;
  const per = (k: string): string => (g(k) / Math.max(1, games)).toFixed(2);
  const pct = (a: number, b: number): string => (b > 0 ? ((100 * a) / b).toFixed(0) + '%' : '-');
  const n = Math.max(1, g('nations'));
  const L: string[] = [];
  L.push(`DEFENSE PROBE (${games} games, ${g('nations')} AI nations; per game unless noted)`);
  L.push(`pillar picks (share of AI nations holding an item of the pillar): ${['navy', 'armor', 'air', 'defense'].map((p) => `${p} ${pct(g('pick_' + p), n)}`).join(', ')}`);
  L.push(`defense committed at the end ${pct(g('defCommitted'), n)} of nations; turtles ${pct(g('turtles'), n)}, of the defense holders ${pct(g('defPickTurtle'), g('has_flakGuns') + g('has_tankTraps'))} are turtles`);
  L.push(`defense techs held (share of nations): flak ${pct(g('has_flakGuns'), n)}, traps ${pct(g('has_tankTraps'), n)}, batteries ${pct(g('has_coastalBatteries'), n)}, radar ${pct(g('has_trackingRadar'), n)}, antiRadar ${pct(g('has_antiRadar'), n)}, siege ${pct(g('has_siegeTanks'), n)}, mastery ${pct(g('has_defenseMastery'), n)}`);
  L.push(`flak: bomber sorties ${per('bomberSorties')}, strikes ${per('strikesBomb')}, worn by flak ${pct(g('flakStrikesBomb'), g('strikesBomb'))}, mean bomb effect lost ${(g('flakLostPctBomb') / Math.max(1, g('strikesBomb'))).toFixed(1)}% (of all strikes), turned back ${per('flakBackBomber')} (${pct(g('flakBackBomber'), g('bomberSorties'))} of sorties), stealth turned back ${per('flakBackStealth')}`);
  L.push(`traps: spearheads ${per('spearheads')}, slowed by traps ${per('spearTrapped')} (${pct(g('spearTrapped'), g('spearheads'))}), trap hits ${per('trapHits')}, troops lost to traps ${per('trapTroopsLost')}`);
  L.push(`traps: spearheads into a Traps holder ${per('spearIntoTraps')}, slowed there ${per('spearIntoTrapsSlowed')} (${pct(g('spearIntoTrapsSlowed'), g('spearIntoTraps'))}); Siege Tanks spearheads into a Traps holder ${per('spearSiegeIntoTraps')}`);
  L.push(`batteries: shots ${per('battShots')}, ships sunk ${per('battSunkShip')}, transports sunk ${per('battSunkTransport')} of ${per('seaInvasions')} sea invasions (${pct(g('battSunkTransport'), g('seaInvasions'))}), batteries shelled silent ${per('battShelled')}, troops lost on invading transports ${pct(g('transTroopsLost'), g('transTroopsLaunched'))} of those launched`);
  L.push(`batteries: landings that sailed into shore fire ${per('transHit')} (${pct(g('transHit'), g('seaInvasions'))} of sea invasions), troops they lost ${pct(g('transHitLost'), g('transHitLaunched'))} of theirs`);
  L.push(`stealth: Air Mastery holder minutes at war ${per('stWarMin')}, sorties per 2 such minutes ${((2 * g('stealthSorties')) / Math.max(1, g('stWarMin'))).toFixed(2)}; kept home by: in the air ${pct(g('stGateAir'), g('stWarMin'))}, recharging ${pct(g('stGateRecharge'), g('stWarMin'))}, cost ${pct(g('stGateCost'), g('stWarMin'))}, pacing or no target ${pct(g('stGateTarget'), g('stWarMin'))}`);
  L.push(`anti-radar: holder minutes at war ${per('arWarMin')}, missiles per 2 such minutes ${((2 * g('arFired')) / Math.max(1, g('arWarMin'))).toFixed(2)}`);
  L.push(`stealth: sorties ${per('stealthSorties')}, strikes landed ${per('strikesStealth')}, radar spots ${per('radarSpots')}, shot down ${per('stealthShot')} (${per('stealthShotSam')} by SAM/radar); lost per sortie ${pct(g('stealthShot'), g('stealthSorties'))}, strikes per sortie ${pct(g('strikesStealth'), g('stealthSorties'))}`);
  L.push(`anti-radar: fired ${per('arFired')} (missiles built ${per('arMissiles')}), shot down ${per('arShot')} (${pct(g('arShot'), g('arFired'))}), SAMs knocked out ${per('arKnocked')}, destroyed ${per('arDestroyed')}`);
  L.push(`counteroffensive: ready ${per('counterReady')}, launches ${per('counterLaunch')}, tiles captured in the next 90 s ${(g('counterLand') / Math.max(1, g('counterLaunch'))).toFixed(0)} per launch (a nation's average 90 s: ${(g('capturedTotal') / Math.max(1, g('nations')) / Math.max(1, (g('gameSeconds') / Math.max(1, games)) / 90)).toFixed(0)})`);
  L.push(`siege tanks: forts knocked out ${per('siegeFortKnocks')}, of them held by a Defense nation ${per('siegeKnocksDefenseFort')}`);
  return L;
}
