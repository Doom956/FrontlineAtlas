// Map hover: a compact card next to the cursor (terrain and what it does, the resource and what to build on it,
// owner and army, the building and what it does) and, in attack mode, an odds badge. In build mode the card is
// replaced by the build preview: "Build here" (green), "Upgrade to level N" (blue) or the reason (red), with costs.
import { buildingAt, fortMultiplierAt } from '../../sim/buildings';
import { borders, estimateAttack, supplyEfficiency } from '../../sim/combat';
import type { AttackEstimate } from '../../sim/combat';
import { BUILDINGS, TERRAIN } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import { isWater } from '../../sim/types';
import type { GameState, Player, TerrainId } from '../../sim/types';
import { isTribe, outnumberRatio } from '../compat';
import { isAttackable, troopsToSend, troopSum } from '../input';
import { rgbCss } from '../menu';
import { formatCount } from '../render/common';
import { armyOf, barrageCheck, barrageRange, BARRAGE_RADIUS, BuildTargetCache, maxLevel, planParadrop } from '../simx';
import { el, pct, setVisible, type HudCtx } from './dom';
import { relationOf } from './drawers';
import { iconSpan, worldGlyph } from './glyph';
import { BUILDING_SHORT, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect } from './text';

export class MapTooltip {
  readonly card: HTMLElement;
  readonly odds: HTMLElement;
  private key = '';
  private mouse = { x: 0, y: 0 };
  private build = new BuildTargetCache();

  constructor(private ctx: HudCtx) {
    this.card = el('div', 'mtip hidden');
    this.card.dataset.test = 'map-tooltip';
    this.odds = el('div', 'odds hidden');
    this.odds.dataset.test = 'odds';
  }

  setMouse(x: number, y: number): void {
    this.mouse.x = x;
    this.mouse.y = y;
  }

  /** Every frame (cheap unless the hovered tile or the mode changed) or forced at ~5 Hz. */
  update(state: GameState, me: Player, force: boolean): void {
    const ui = this.ctx.ui;
    const tile = ui.hoverTile;
    const show = tile >= 0 && tile < state.map.owner.length && !ui.contextMenu && state.phase !== 'over';
    if (!show) {
      setVisible(this.card, false);
      setVisible(this.odds, false);
      this.key = '';
      return;
    }
    const key = `${tile}|${ui.attackShare}|${ui.attackMixMode}|${ui.mode.kind}|${ui.mode.kind === 'build' ? ui.mode.building : ''}`;
    if (force || key !== this.key) {
      this.key = key;
      if (ui.mode.kind === 'build' && state.phase === 'playing') this.buildPreview(state, me, ui.mode.building, tile);
      else if ((ui.mode.kind === 'paradrop' || ui.mode.kind === 'barrage') && state.phase === 'playing') this.strikePreview(state, me, tile);
      else this.tileCard(state, me, tile);
    }
    if (!this.card.classList.contains('hidden')) this.place(this.card, this.mouse.x + 18, this.mouse.y + 20);
    if (!this.odds.classList.contains('hidden')) {
      this.odds.style.transform = `translate(${Math.round(this.mouse.x + 16)}px, ${Math.round(this.mouse.y - 34)}px)`;
    }
  }

  private place(e: HTMLElement, x: number, y: number): void {
    const w = e.offsetWidth;
    const h = e.offsetHeight;
    let px = x;
    let py = y;
    if (px + w > window.innerWidth - 8) px = Math.max(8, x - w - 32);
    // keep clear of the command bar at the bottom
    const bottom = window.innerHeight - 110;
    if (py + h > bottom) py = Math.max(8, y - h - 34);
    e.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  }

  private line(icon: string, main: string, sub?: string, cls = ''): HTMLElement {
    const r = el('div', 'mt-row ' + cls);
    r.append(iconSpan(icon, 'mt-ic'));
    const t = el('div', 'mt-t');
    t.append(el('span', 'mt-main', main));
    if (sub) t.append(el('span', 'mt-sub', sub));
    r.append(t);
    return r;
  }

  private tileCard(state: GameState, me: Player, tile: number): void {
    const map = state.map;
    const tid = map.terrain[tile] as TerrainId;
    const terr = TERRAIN[tid];
    const owner = map.owner[tile];
    const op = state.players[owner];
    const rows: HTMLElement[] = [];
    rows.push(this.line(worldGlyph(TERRAIN_GLYPH[tid], 18), terr.name + (map.coastal[tile] ? ' (coast)' : ''), terrainEffect(tid), 'terr'));
    let odds: { text: string; cls: string } | null = null;
    if (!isWater(tid)) {
      const res = map.resource[tile];
      if (res && RESOURCE_TEXT[res]) {
        const r = RESOURCE_TEXT[res];
        rows.push(this.line(worldGlyph(res === 1 ? 'iron' : res === 2 ? 'oil' : 'fertile', 18), r.name, r.use, 'res'));
      }
      if (owner && op) {
        const rel = owner === me.id ? 'Your land' : relationOf(state, me, owner).text;
        const army = owner === me.id ? '' : `army ${formatCount(armyOf(state, owner))}`;
        const r = this.line('', op.name, [rel, army].filter(Boolean).join(', '), 'own');
        const sw = r.querySelector('.mt-ic') as HTMLElement;
        sw.classList.add('sw');
        sw.style.background = rgbCss(op.color);
        rows.push(r);
      } else rows.push(this.line('', 'Wilderness', 'Nobody owns it: cheap to take', 'own wild'));
      const b = buildingAt(state, tile);
      if (b) {
        const info = BUILDINGS[b.type];
        const lv = maxLevel(b.type);
        const name = info.name + (lv > 1 ? ` level ${b.level}` : '') + (b.buildLeft > 0 ? ' (being built)' : '');
        rows.push(this.line(worldGlyph(b.type, 18), name, BUILDING_SHORT[b.type] + (owner === me.id ? '. Click for details' : ''), 'bld'));
      }
      const def = terr.defense * (owner ? fortMultiplierAt(state, tile, owner) : 1);
      if (def > terr.defense + 0.01) rows.push(this.line(worldGlyph('fort', 18), `Fortified: defence x${def.toFixed(1)}`, 'Artillery is strong against forts', 'warn'));
      if (map.fallout[tile] > 0) rows.push(this.line(worldGlyph('silo', 18), `Fallout: ${Math.ceil(map.fallout[tile])} s`, 'Nobody can hold or build here', 'bad'));
      if (state.phase === 'playing') {
        if (owner === me.id) {
          const sup = supplyEfficiency(state, me.id, tile);
          if (sup < 0.99) rows.push(this.line('', `Supply ${pct(sup)}`, 'Far from cities and depots: fronts here fight weaker', 'warn'));
        } else if (isAttackable(state, me.id, tile) && this.ctx.ui.mode.kind === 'none') {
          const send = troopsToSend(me, this.ctx.ui);
          const est = estimateAttack(state, me.id, tile, send);
          if (est) {
            const n = troopSum(send);
            if (est.lossPerTile > 0) rows.push(this.line('', `Click to attack with ${formatCount(n)}`, `about ${formatCount(n / est.lossPerTile)} tiles, ${formatCount(est.lossPerTile)} lost per tile`, 'atk'));
            odds = this.oddsBadge(state, me, owner, est, n);
          }
        }
      }
    }
    this.card.className = 'mtip';
    this.card.replaceChildren(...rows);
    if (odds) {
      this.odds.className = 'odds ' + odds.cls;
      this.odds.textContent = odds.text;
    }
    setVisible(this.odds, !!odds);
  }

  /** Odds badge: outnumbering against a nation (exact with intel), how far troops reach in the wilderness. */
  private oddsBadge(state: GameState, me: Player, owner: number, est: AttackEstimate, sent: number): { text: string; cls: string } {
    if (!borders(state, me.id, owner)) return { text: owner ? 'No shared border: goes by sea' : 'Not next to you: goes by sea', cls: 'ok' };
    const loss = est.lossPerTile;
    const reach = loss > 0 ? sent / loss : Infinity;
    const reachCls = reach >= 40 ? 'good' : reach >= 12 ? 'ok' : 'bad';
    if (owner === 0) return { text: `${Number.isFinite(reach) ? '≈' + formatCount(reach) : 'all'} tiles`, cls: reachCls };
    const op = state.players[owner];
    const ratio = outnumberRatio(est, sent, armyTotal(op.troops));
    if (ratio === null) return { text: `${formatCount(loss)} lost per tile`, cls: reachCls };
    const cls = ratio >= 1.5 && reach >= 12 ? 'good' : ratio >= 0.8 && reach >= 5 ? 'ok' : 'bad';
    let r: string;
    if (isTribe(op)) r = ratio >= 1.5 ? 'You outnumber them' : ratio >= 0.8 ? 'Even fight' : 'Outnumbered';
    else {
      const x = (v: number): string => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
      r = ratio >= 1.1 ? `You ${x(ratio)}x stronger` : ratio > 0.9 ? 'Even fight' : `They are ${x(1 / ratio)}x stronger`;
    }
    return { text: r, cls };
  }

  /** Build mode: the ghost on the map says what happens (build / upgrade / why not); the cursor shows the price. */
  private buildPreview(state: GameState, me: Player, type: keyof typeof BUILDINGS, tile: number): void {
    const t = this.build.get(state, me.id, type, tile);
    const info = BUILDINGS[type];
    const row = el('div', 'mt-price');
    row.append(iconSpan(worldGlyph(type, 18), 'mt-ic'));
    row.append(el('span', me.gold >= t.cost.gold ? 'g' : 'g bad', `${formatCount(t.cost.gold)} gold`));
    if (t.cost.iron > 0) row.append(el('span', me.iron >= t.cost.iron ? 'g' : 'g bad', `${formatCount(t.cost.iron)} iron`));
    row.append(el('span', 'dim', `${info.buildTime} s`));
    const hint = el('div', 'mt-hint', t.ok ? 'Shift: place several. Esc: stop.' : 'Esc: stop.');
    this.card.className = `mtip price ${t.ok ? (t.upgrade ? 'up' : 'ok') : 'no'}`;
    this.card.replaceChildren(row, hint);
    setVisible(this.odds, false);
  }

  private strikePreview(state: GameState, me: Player, tile: number): void {
    const ui = this.ctx.ui;
    const rows: HTMLElement[] = [];
    let why: string;
    let title: string;
    if (ui.mode.kind === 'paradrop') {
      const plan = planParadrop(state, me, ui, tile, ui.mode.airfield);
      why = plan.reason;
      title = why || `Drop ${formatCount(plan.troops)} paratroopers here`;
      rows.push(this.line(worldGlyph('paradrop', 20), title, why ? 'Pick enemy or empty land in the dashed ring' : 'They land and attack from this point', 'head'));
    } else {
      why = barrageCheck(state, me.id, tile);
      title = why || 'Shell this area';
      rows.push(this.line(worldGlyph('barrage', 20), title, why ? `Guns reach ${barrageRange(me)} tiles from your land` : `Shells land in 2 s on ${BARRAGE_RADIUS} tiles around: kills defenders, knocks out forts and SAMs`, 'head'));
    }
    rows.push(el('div', 'mt-hint', 'Click to confirm, Esc to cancel'));
    this.card.className = `mtip build ${why ? 'no' : 'ok'}`;
    this.card.replaceChildren(...rows);
    setVisible(this.odds, false);
  }
}
