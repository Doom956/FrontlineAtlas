// Map hover: a compact card next to the cursor (terrain and what it does, the resource and what to build on it,
// owner and army, the building and what it does) and, in attack mode, an odds badge. In build mode the card is
// replaced by the build preview: "Build here" (green), "Upgrade to level N" (blue) or the reason (red), with costs.
import { buildSeconds, unitAllowed } from '../../sim/rules';
import { buildingAt, fortMultiplierAt } from '../../sim/buildings';
import { borders, estimateAttack, supplyEfficiency } from '../../sim/combat';
import type { AttackEstimate } from '../../sim/combat';
import { BUILDINGS, TERRAIN, UNITS } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import { isWater } from '../../sim/types';
import type { GameState, Player, TerrainId, Unit } from '../../sim/types';
import { hpText, isIncoming, UNIT_TEXT, unitDoing, unitIcon, unitName, type SpecialId } from '../forces';
import { isTribe, outnumberRatio } from '../compat';
import { isAttackable, troopsToSend, troopSum } from '../input';
import { swatchCss } from './swatch';
import { formatCount } from '../render/common';
import { armyOf, barrageRange, BuildTargetCache, maxLevel } from '../simx';
import { blastSummary, ownHitWarning, STRIKES, strikeOfMode, strikeTarget } from '../strikes';
import { iconDataUrl } from '../icons';
import { el, fmtSeconds, pct, setVisible, type HudCtx } from './dom';
import { relationOf } from './drawers';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { forceLimit, heartlandBonus, lastStandBonus } from '../allies';
import { buildingTexts, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect } from './text';
import { bulkPreviews, bulkPreviewText, effectiveCount } from './buildMenu';
import { shiftHeld } from './quickBar';

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
    // any unit under the pointer (yours or not) gets its own card while no order is being aimed
    const probe = this.ctx.probe();
    const uid = ui.mode.kind === 'none' && probe && ui.hoverPx ? probe.unitAt(ui.hoverPx.x, ui.hoverPx.y) : -1;
    const unit = uid >= 0 ? state.units.find((u) => u.id === uid && u.hp > 0) : undefined;
    const key = `${tile}|${unit ? unit.id : -1}|${ui.attackShare}|${ui.attackMixMode}|${ui.mode.kind}|${ui.mode.kind === 'build' ? ui.mode.building : ''}|${effectiveCount(ui, shiftHeld())}|${ui.selection.length > 0}`;
    if (force || key !== this.key) {
      this.key = key;
      if (unit) this.unitCard(state, me, unit);
      else if (ui.mode.kind === 'moveWarship') this.shipOrder(state, tile);
      else if (ui.mode.kind === 'build' && state.phase === 'playing') this.buildPreview(state, me, ui.mode.building, tile);
      else if (strikeOfMode(ui.mode) && state.phase === 'playing') this.strikePreview(state, me, tile);
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
    let odds: { text: string; cls: string; sub?: string } | null = null;
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
        sw.style.background = swatchCss(op, me.id);
        rows.push(r);
      } else rows.push(this.line('', 'Wilderness', 'Nobody owns it: cheap to take', 'own wild'));
      const b = buildingAt(state, tile);
      if (b) {
        const info = BUILDINGS[b.type];
        const lv = maxLevel(b.type);
        const name = info.name + (lv > 1 ? ` level ${b.level}` : '') + (b.buildLeft > 0 ? ' (being built)' : '');
        rows.push(this.line(worldGlyph(b.type, 18), name, buildingTexts(!unitAllowed(state, 'atomBomb'), b.type, info.description).short + (owner === me.id ? '. Click for details' : ''), 'bld'));
      }
      const def = terr.defense * (owner ? fortMultiplierAt(state, tile, owner) : 1);
      if (def > terr.defense + 0.01) rows.push(this.line(worldGlyph('fort', 18), `Fortified: defence x${def.toFixed(1)}`, 'Artillery is strong against forts', 'warn'));
      // heartland (deep inside a nation) and last stand (a nation fighting outnumbered) defend harder
      if (owner && op && !isTribe(op)) {
        const core = heartlandBonus(state, tile);
        const yours = owner === me.id;
        if (core > 0) rows.push(this.line(lineIcon('shield', 18), `Heartland: +${pct(core)} defence`, yours ? 'Deep inside your land: attackers lose more here' : 'Deep inside their land: attacks lose more here', 'core'));
        // yours: against whoever attacks you now; theirs: against you
        const ls = yours ? lastStandBonus(state, owner) : lastStandBonus(state, owner, me.id);
        if (ls > 0) rows.push(this.line(lineIcon('shield', 18), `Last stand: +${pct(ls)} while outnumbered`, yours ? 'Your land fights harder while you are outnumbered' : 'They fight harder while outnumbered', 'warn'));
      }
      if (map.fallout[tile] > 0) rows.push(this.line(worldGlyph('silo', 18), `Fallout: ${Math.ceil(map.fallout[tile])} s`, 'Nobody can hold or build here', 'bad'));
      if (state.phase === 'playing') {
        if (owner === me.id) {
          const sup = supplyEfficiency(state, me.id, tile);
          if (sup < 0.99) rows.push(this.line('', `Supply ${pct(sup)}`, 'Far from cities and depots: fronts here fight weaker', 'warn'));
        } else if (isAttackable(state, me.id, tile) && this.ctx.ui.mode.kind === 'none' && !this.ctx.ui.selection.length) {
          // (with units selected a click is their order, not an attack: selection.ts)
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
      if (odds.sub) this.odds.append(el('span', 'odds-sub', odds.sub));
    }
    setVisible(this.odds, !!odds);
  }

  /** A warship is selected: say what a click here does. */
  private shipOrder(state: GameState, tile: number): void {
    const water = isWater(state.map.terrain[tile]);
    const ok = water || !!state.map.coastal[tile];
    this.card.className = `mtip build ${ok ? 'ok' : 'no'}`;
    this.card.replaceChildren(
      this.line(lineIcon('warship', 18), ok ? 'Sail here' : 'Warships sail on water', ok ? 'It patrols around this spot' : 'Pick a water tile', 'head'),
      el('div', 'mt-hint', 'Esc or right-click: cancel.'),
    );
    setVisible(this.odds, false);
  }

  /** A unit under the pointer: what it is, whose, its hull, what it carries and what it is doing. */
  private unitCard(state: GameState, me: Player, u: Unit): void {
    const own = u.owner === me.id;
    const op = state.players[u.owner];
    let pic = '';
    try {
      pic = `<img src="${iconDataUrl(unitIcon(u.type), 22)}" width="22" height="22" alt="">`;
    } catch {
      /* no canvas */
    }
    const rows: HTMLElement[] = [];
    const who = own ? 'Yours' : op ? `${op.name}, ${relationOf(state, me, u.owner).text.toLowerCase()}` : 'Unknown';
    const head = this.line(pic, unitName(u), who, 'head');
    if (op && !own) {
      const sw = el('span', 'sw');
      sw.style.background = swatchCss(op, me.id);
      head.querySelector('.mt-main')?.prepend(sw);
    }
    rows.push(head);
    if (UNITS[u.type].hp > 1) rows.push(this.line('', `Hull ${hpText(u)}`, u.type === 'warship' ? 'Hit by enemy warships only' : '', 'own'));
    const incoming = isIncoming(state, me.id, u);
    rows.push(el('div', incoming ? 'mt-warn' : 'mt-doing', (incoming ? 'Coming at you: ' : '') + unitDoing(state, me, u)));
    const t = u.type === 'transportPlane' ? 'transportPlane' : u.type;
    if (t in UNIT_TEXT) rows.push(el('div', 'mt-hint', own && u.type === 'warship' ? 'Click to select it, then click water to move it.' : UNIT_TEXT[t as SpecialId].counter));
    this.card.className = 'mtip unit' + (incoming ? ' incoming' : '');
    this.card.replaceChildren(...rows);
    setVisible(this.odds, false);
  }

  /** Odds badge: outnumbering against a nation (exact with intel), how far troops reach in the wilderness. */
  private oddsBadge(state: GameState, me: Player, owner: number, est: AttackEstimate, sent: number): { text: string; cls: string; sub?: string } {
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
    const x = (v: number): string => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
    if (isTribe(op)) r = ratio >= 1.5 ? 'You outnumber them' : ratio >= 0.8 ? 'Even fight' : 'Outnumbered';
    else {
      r = ratio >= 1.1 ? `You ${x(ratio)}x stronger` : ratio > 0.9 ? 'Even fight' : `They are ${x(1 / ratio)}x stronger`;
    }
    // the force limit: outnumbering beyond it barely helps, so the extra troops are better kept at home
    const cap = forceLimit();
    if (ratio >= cap) {
      const enough = (sent * cap) / ratio;
      return { text: r, cls, sub: `Extra troops beyond ${Number.isInteger(cap) ? cap : x(cap)}x add little here (≈${formatCount(enough)} is enough)` };
    }
    return { text: r, cls };
  }

  /** Build mode: the ghost on the map says what happens (build / upgrade / why not); the cursor shows the price. */
  private buildPreview(state: GameState, me: Player, type: keyof typeof BUILDINGS, tile: number): void {
    const n = effectiveCount(this.ctx.ui, shiftHeld());
    if (n > 1) return this.bulkPreview(state, me, type, tile, n);
    const t = this.build.get(state, me.id, type, tile);
    const info = BUILDINGS[type];
    const row = el('div', 'mt-price');
    row.append(iconSpan(worldGlyph(type, 18), 'mt-ic'));
    row.append(el('span', me.gold >= t.cost.gold ? 'g' : 'g bad', `${formatCount(t.cost.gold)} gold`));
    if (t.cost.iron > 0) row.append(el('span', me.iron >= t.cost.iron ? 'g' : 'g bad', `${formatCount(t.cost.iron)} iron`));
    row.append(el('span', 'dim', fmtSeconds(buildSeconds(state, info.buildTime))));
    const hint = el('div', 'mt-hint', t.ok ? 'Shift: x5 levels. Esc: stop.' : 'Esc: stop.');
    this.card.className = `mtip price ${t.ok ? (t.upgrade ? 'up' : 'ok') : 'no'}`;
    this.card.replaceChildren(row, hint);
    setVisible(this.odds, false);
  }
  /** x3 / x5: "City -> level 5: 4 upgrades queued, 12.4k gold" or "Can afford 3 of 5" (sim buildManyPreview). */
  private bulkPreview(state: GameState, me: Player, type: keyof typeof BUILDINGS, tile: number, n: number): void {
    const pv = bulkPreviews.build(state, me.id, type, tile, n);
    const t = bulkPreviewText(pv, type);
    const row = el('div', 'mt-price');
    row.append(iconSpan(worldGlyph(type, 18), 'mt-ic'), el('span', t.tone === 'no' ? 'g bad' : 'g', t.text));
    const sub = el('div', 'mt-hint', t.sub ? `${t.sub}. Esc: stop.` : 'Esc: stop.');
    this.card.className = `mtip price ${t.tone === 'no' ? 'no' : t.tone === 'up' ? 'up' : 'ok'}`;
    this.card.replaceChildren(row, sub);
    setVisible(this.odds, false);
  }


  private strikePreview(state: GameState, me: Player, tile: number): void {
    const ui = this.ctx.ui;
    const m = ui.mode;
    const id = strikeOfMode(m);
    if (!id) return;
    const t = strikeTarget(state, me, ui, m, tile);
    const info = STRIKES[id];
    const pic = `<img src="${iconDataUrl(info.icon, 22)}" width="22" height="22" alt="">`;
    const rows: HTMLElement[] = [];
    if (t.ok) {
      const title =
        id === 'barrage' ? 'Shell this area' : id === 'bomb' ? 'Bomb this area' : id === 'paradrop' ? `Drop ${formatCount(t.troops)} paratroopers here` : id === 'rocket' ? 'Fire a rocket here' : 'Drop the atom bomb here';
      rows.push(this.line(pic, title, blastSummary(state, m, t), 'head'));
      const own = ownHitWarning(m, t);
      if (own) rows.push(el('div', 'mt-warn', own));
      if (t.covered) rows.push(el('div', 'mt-warn', t.covered));
      rows.push(el('div', 'mt-hint', 'Click to fire. Shift: fire again. Esc or right-click: cancel.'));
    } else {
      const help =
        id === 'barrage'
          ? `Guns reach ${barrageRange(me)} tiles from your border: the lit zone`
          : id === 'paradrop'
            ? 'Pick enemy or empty land inside a gold ring'
            : 'Pick enemy land';
      rows.push(this.line(pic, t.reason || 'Not possible here', help, 'head'));
      rows.push(el('div', 'mt-hint', 'Esc or right-click: cancel.'));
    }
    this.card.className = `mtip build ${t.ok ? 'ok' : 'no'}`;
    this.card.replaceChildren(...rows);
    setVisible(this.odds, false);
  }
}
