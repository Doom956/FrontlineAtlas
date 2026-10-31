// Side drawers (right edge, one at a time, closed by default): Army, Research, Diplomacy, Events, Map key,
// the selected building and the menu (settings). Each has one big primary readout and plain-word rows.
import { enterWarshipSpawnMode } from '../selection';
import { buildSeconds, researchRule, unitAllowed } from '../../sim/rules';
import { aircraftCap, buildCostAt, buildingAt, chargesReady, canBuild, countBuildings, nextChargeIn } from '../../sim/buildings';
import { attacksOf } from '../../sim/combat';
import {
  BARRAGE_MIN_ARTILLERY,
  BUILDINGS,
  BUILDING_ORDER,
  MATCHUP,
  RESOURCE_NAMES,
  TECHS,
  TECH_ORDER,
  TERRAIN,
  TICKS_PER_SECOND,
  UNITS,
} from '../../sim/config';
import { areAllied, isTraitor } from '../../sim/diplomacy';
import { armyTotal, convertCost, hasOilShortage } from '../../sim/economy';
import { unitCost } from '../../sim/units';
import { gameSecondsAt } from '../../sim/state';
import { canResearch, hasTech } from '../../sim/tech';
import { LAND_TERRAINS, Resource } from '../../sim/types';
import type { Building, BuildingType, GameEvent, GameState, NavalVariant, Player, TechId, TerrainId, Troops } from '../../sim/types';
import { isTribe } from '../compat';
import { CATEGORY_COLORS, ICON_INFO, iconDataUrl, markerDataUrl } from '../icons';
import { CATEGORY_PLATES } from '../render/buildings';
import { rgbCss } from '../menu';
import { swatchCss } from './swatch';
import { formatCount } from '../render/common';
import { fieldArmy, maxLevel } from '../simx';
import { aimStrike, STRIKE_ORDER, STRIKES, strikeStatus } from '../strikes';
import { artilleryOf } from '../../sim/barrage';
import {
  btn,
  el,
  fmtTime,
  keycap,
  pct,
  sectionTitle,
  setClass,
  setDisabled,
  setText,
  setTip,
  setVisible,
  slider,
  syncSlider,
  type DrawerId,
  type HudCtx,
} from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { AllyHelp } from './allyHelp';
import { heartlandBonus, lastStandBonus } from '../allies';
import { ABILITY_TEXT, article, buildingTexts, RESOURCE_TEXT, TERRAIN_GLYPH, terrainEffect, terrainNote } from './text';
import { AirPanel } from './airPanel';
import { airfieldVariantLine, factoryVariantLine, reconBlock, reconLabel, reconOffered, warshipOptions } from './variantOrders';
import { warshipOrderCost } from '../../sim/navy';
import { VARIANT_NAMES } from '../../sim/variants';
import { canBuildTankDivision, tankDivisionCost, tankDivisionCount, tankDivisionLimit } from '../../sim/tanks';

export const TROOP_COLORS = { infantry: '#9aa86a', armor: '#c9a227', artillery: '#c0564a' } as const;

export interface DrawerPage {
  id: DrawerId;
  title: string;
  root: HTMLElement;
  update(s: GameState, me: Player): void;
  onOpen?(): void;
}

/** Segmented two-choice control. */
export function seg2(a: string, b: string, onA: () => void, onB: () => void): { el: HTMLElement; set: (first: boolean) => void } {
  const g = el('div', 'segc');
  const ba = el('button', 'segc-b', a);
  const bb = el('button', 'segc-b', b);
  ba.type = bb.type = 'button';
  ba.addEventListener('click', onA);
  bb.addEventListener('click', onB);
  g.append(ba, bb);
  return {
    el: g,
    set: (first) => {
      setClass(ba, 'on', first);
      setClass(bb, 'on', !first);
    },
  };
}

function mixBar(): { el: HTMLElement; set: (t: Troops) => void } {
  const bar = el('div', 'mixbar');
  const parts = (['infantry', 'armor', 'artillery'] as const).map((k) => {
    const p = el('span');
    p.style.background = TROOP_COLORS[k];
    bar.append(p);
    return p;
  });
  return {
    el: bar,
    set: (t) => {
      const sum = t.infantry + t.armor + t.artillery || 1;
      parts[0].style.width = pct(t.infantry / sum);
      parts[1].style.width = pct(t.armor / sum);
      parts[2].style.width = pct(t.artillery / sum);
    },
  };
}

// ================================================================================================ Army

export class ArmyPage implements DrawerPage {
  id: DrawerId = 'army';
  title = 'Army';
  root = el('div', 'page');
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private attackRows = new Map<number, { root: HTMLElement; target: HTMLElement; troops: HTMLElement; prog: HTMLElement }>();

  constructor(private ctx: HudCtx) {
    const ui = ctx.ui;
    // primary readout: the whole army and its mix
    const big = el('div', 'big-read');
    const bv = el('span', 'big-v');
    const bl = el('span', 'big-l', 'troops in total');
    big.append(bv, bl);
    const mb = mixBar();
    const legend = el('div', 'mix-legend');
    const lt = (['infantry', 'armor', 'artillery'] as const).map((k) => {
      const s = el('span', 'ml');
      const dot = el('i');
      dot.style.background = TROOP_COLORS[k];
      const v = el('b');
      s.append(dot, k[0].toUpperCase() + k.slice(1) + ' ', v);
      legend.append(s);
      return v;
    });
    // the heartland glow shows on the map while this drawer is open: say what it is
    const heart = el('p', 'note army-heart hidden');
    this.root.append(big, mb.el, legend, heart);
    this.upd.push((s, me) => {
      const core = me.capital >= 0 ? heartlandBonus(s, me.capital) : 0;
      const ls = lastStandBonus(s, me.id);
      setVisible(heart, core > 0 || ls > 0);
      setText(heart, [core > 0 ? `Gold edge on the map: your heartland, up to +${pct(core)} defence.` : '', ls > 0 ? `Last stand: +${pct(ls)} defence while outnumbered.` : ''].filter(Boolean).join(' '));
    });
    this.upd.push((s, me) => {
      setText(bv, formatCount(fieldArmy(s, me.id)));
      mb.set(me.troops);
      const t = me.troops;
      setText(lt[0], formatCount(t.infantry));
      setText(lt[1], formatCount(t.armor));
      setText(lt[2], formatCount(t.artillery));
    });

    // army mix target
    this.root.append(sectionTitle('Troop mix'));
    const autoSeg = seg2(
      'Auto',
      'Manual',
      () => ctx.act({ type: 'setAuto', mix: true }),
      () => ctx.act({ type: 'setAuto', mix: false }),
    );
    autoSeg.el.dataset.test = 'auto-mix';
    const note = el('p', 'note');
    this.root.append(autoSeg.el, note);
    const mk = (kind: 'armor' | 'artillery') => {
      const r = el('div', 'slider-row has-dot');
      const dot = el('i', 'dot');
      dot.style.background = TROOP_COLORS[kind];
      const s = slider(0, 80, 5);
      s.dataset.test = `mix-${kind}`;
      const v = el('span', 'sv');
      r.append(dot, el('span', 'sl', kind === 'armor' ? 'Armor' : 'Artillery'), s, v);
      r.dataset.tip =
        kind === 'armor'
          ? 'Target share of armor. Factories convert infantry into armor (gold and iron each). Armor is strong on open ground and burns oil.'
          : 'Target share of artillery. Arsenals convert infantry into artillery. Artillery breaks forts but is fragile alone.';
      this.root.append(r);
      return { s, v };
    };
    const armor = mk('armor');
    const art = mk('artillery');
    const send = () => ctx.act({ type: 'setArmyMix', armor: Number(armor.s.value) / 100, artillery: Number(art.s.value) / 100 });
    armor.s.addEventListener('input', send);
    art.s.addEventListener('input', send);
    const status = el('p', 'status');
    this.root.append(status);
    this.upd.push((s, me) => {
      const auto = !!me.auto.mix;
      autoSeg.set(auto);
      setText(note, auto ? 'Your factories and arsenals aim for a mix that beats your neighbours. Move a slider to take over.' : 'You set the mix. Factories make armor, Arsenals make artillery.');
      syncSlider(armor.s, Math.round(me.armyMix.armor * 100));
      syncSlider(art.s, Math.round(me.armyMix.artillery * 100));
      const army = armyTotal(me.troops) || 1;
      setText(armor.v, `${pct(me.troops.armor / army)} / ${pct(me.armyMix.armor)}`);
      setText(art.v, `${pct(me.troops.artillery / army)} / ${pct(me.armyMix.artillery)}`);
      const fac = countBuildings(s, me.id, 'factory');
      const ars = countBuildings(s, me.id, 'arsenal');
      const msgs: string[] = [];
      let cls = 'ok';
      for (const [need, n, kind, bname] of [
        [me.armyMix.armor * army - me.troops.armor > 1, fac, 'armor', 'Factory'],
        [me.armyMix.artillery * army - me.troops.artillery > 1, ars, 'artillery', 'Arsenal'],
      ] as const) {
        if (!need) continue;
        if (n === 0) {
          msgs.push(`Build ${article(bname)} ${bname} to make ${kind}.`);
          cls = 'warn';
          continue;
        }
        const c = convertCost(me, kind, s);
        if (me.gold < c.gold || me.iron < c.iron) {
          msgs.push(`Making ${kind} needs ${me.iron < c.iron ? 'iron' : 'gold'}.`);
          cls = 'warn';
        } else msgs.push(`Making ${kind}.`);
      }
      if (hasOilShortage(s, me.id)) {
        msgs.push('Out of oil: armor fights at half strength.');
        cls = 'bad';
      }
      setText(status, msgs.length ? msgs.join(' ') : `Mix reached. Factories ${fac}, Arsenals ${ars}.`);
      status.className = 'status ' + cls;
    });

    // what an attack sends
    this.root.append(sectionTitle('Attacks send'));
    const sendSeg = seg2(
      'All types',
      'Custom',
      () => {
        ui.attackMixMode = 'all';
        ctx.refreshSoon();
      },
      () => {
        ui.attackMixMode = 'custom';
        ctx.refreshSoon();
      },
    );
    this.root.append(sendSeg.el);
    const custom = el('div', 'custom');
    const cs = (['infantry', 'armor', 'artillery'] as const).map((k) => {
      const r = el('div', 'slider-row has-dot');
      const dot = el('i', 'dot');
      dot.style.background = TROOP_COLORS[k];
      const s = slider(0, 100, 5);
      s.addEventListener('input', () => {
        ui.customMix[k] = Number(s.value) / 100;
        ctx.refreshSoon();
      });
      const v = el('span', 'sv');
      r.append(dot, el('span', 'sl', k[0].toUpperCase() + k.slice(1)), s, v);
      custom.append(r);
      return { k, s, v };
    });
    this.root.append(custom);
    this.upd.push(() => {
      sendSeg.set(ui.attackMixMode === 'all');
      setVisible(custom, ui.attackMixMode === 'custom');
      const w = ui.customMix.infantry + ui.customMix.armor + ui.customMix.artillery || 1;
      for (const c of cs) {
        syncSlider(c.s, Math.round(ui.customMix[c.k] * 100));
        setText(c.v, pct(ui.customMix[c.k] / w));
      }
    });

    // active attacks
    this.root.append(sectionTitle('Active attacks'));
    const list = el('div', 'rows');
    const empty = el('p', 'note', 'No attacks. Click land next to yours to attack it.');
    this.root.append(list, empty);
    this.upd.push((s, me) => {
      const attacks = attacksOf(s, me.id);
      const ids = new Set(attacks.map((a) => a.id));
      for (const [id, r] of this.attackRows) {
        if (!ids.has(id)) {
          r.root.remove();
          this.attackRows.delete(id);
        }
      }
      for (const a of attacks) {
        let r = this.attackRows.get(a.id);
        if (!r) {
          const root = el('div', 'arow');
          const target = el('button', 'arow-t');
          target.type = 'button';
          const troops = el('span', 'arow-n');
          const prog = el('span', 'arow-p');
          const id = a.id;
          target.addEventListener('click', () => {
            const cur = ctx.state()?.attacks.find((x) => x.id === id);
            if (cur) ctx.focusTile(cur.focusTile, false);
          });
          const ret = btn('', 'icon danger', () => ctx.act({ type: 'retreat', attackId: id }), 'retreat');
          ret.dataset.tip = 'Retreat: troops come home (a quarter is lost against a nation)';
          const info = el('div', 'arow-i');
          info.append(troops, prog);
          root.append(target, info, ret);
          r = { root, target, troops, prog };
          this.attackRows.set(a.id, r);
          list.append(root);
        }
        const tp = s.players[a.target];
        setText(r.target, a.target === 0 ? 'Wilderness' : tp?.name ?? 'Unknown');
        r.target.style.setProperty('--c', a.target === 0 ? '#8d918a' : swatchCss(tp, me.id));
        setText(r.troops, `${formatCount(armyTotal(a.troops))} troops`);
        setText(r.prog, `+${formatCount(a.tilesTaken)} tiles, lost ${formatCount(a.losses)}`);
      }
      setVisible(empty, attacks.length === 0);
    });

    // artillery: what it is for, how to get it, how much you have
    const artSec = el('div', 'artsec');
    artSec.dataset.test = 'army-artillery';
    const artHead = el('div', 'art-head');
    const artIc = el('img', 'art-ic');
    artIc.alt = '';
    artIc.width = 28;
    artIc.height = 28;
    try {
      artIc.src = iconDataUrl('artillery', 28);
    } catch {
      /* no canvas */
    }
    const artCount = el('b', 'art-n');
    const artOf = el('span', 'art-of');
    const artRead = el('div', 'art-read');
    artRead.append(artCount, artOf);
    artHead.append(artIc, artRead);
    const artBar = el('div', 'art-bar');
    const artFill = el('span');
    artBar.append(artFill);
    const artWhat = el('p', 'note', 'Artillery breaks forts, hills and dug-in fronts, and fires the artillery barrage.');
    const artHow = el('p', 'note');
    artSec.append(sectionTitle('Artillery'), artHead, artBar, artWhat, artHow);
    // right under the troop mix, whose Artillery slider it refers to
    status.after(artSec);
    this.upd.push((s, me) => {
      const art = artilleryOf(s, me.id);
      setText(artCount, formatCount(art));
      setText(artOf, art >= BARRAGE_MIN_ARTILLERY ? 'artillery: enough for a barrage (Z)' : `artillery: a barrage needs ${formatCount(BARRAGE_MIN_ARTILLERY)}`);
      artFill.style.width = pct(Math.min(1, art / BARRAGE_MIN_ARTILLERY));
      setClass(artBar, 'full', art >= BARRAGE_MIN_ARTILLERY);
      const ars = countBuildings(s, me.id, 'arsenal', true);
      setText(
        artHow,
        ars === 0
          ? `To get it: build an Arsenal (Build menu, key ${BUILDINGS.arsenal.hotkey}), then raise the Artillery slider above.`
          : me.auto.mix
            ? 'Your Arsenals make it as the auto mix needs. To make more now, raise the Artillery slider above.'
            : me.armyMix.artillery < 0.05
              ? 'Your Arsenals are idle: raise the Artillery slider above.'
              : `Your Arsenals turn infantry into artillery up to ${pct(me.armyMix.artillery)} of the army.`,
      );
    });

    // special units (warships, aircraft, missiles) and their strikes are in the Forces drawer (Y)
    const fwd = btn('Warships, aircraft, missiles: Forces (Y)', 'wide ghost', () => ctx.openDrawer('forces'), 'forces');
    fwd.dataset.test = 'army-to-forces';
    this.root.append(fwd);
  }

  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }
}

export { ResearchPage } from './researchTree';

// ================================================================================================ Diplomacy

export class DiplomacyPage implements DrawerPage {
  id: DrawerId = 'diplomacy';
  title = 'Diplomacy';
  root = el('div', 'page');
  private body = el('div', 'dip');
  private key = '';
  /** per ally: status line and the two requests (kept across rebuilds so an open picker stays open) */
  private helps = new Map<number, AllyHelp>();

  constructor(private ctx: HudCtx) {
    this.root.append(this.body);
  }

  update(s: GameState, me: Player): void {
    const inReq = s.allianceRequests.filter((r) => r.to === me.id);
    const outReq = s.allianceRequests.filter((r) => r.from === me.id);
    const allies = s.alliances.filter((a) => a.a === me.id || a.b === me.id);
    for (const a of allies) {
      const other = a.a === me.id ? a.b : a.a;
      let h = this.helps.get(other);
      if (!h) this.helps.set(other, (h = new AllyHelp(this.ctx)));
      h.update(s, me, other);
    }
    const traitors = s.players.filter((p) => p && p.alive && p.id !== me.id && isTraitor(s, p.id));
    const key = [
      inReq.map((r) => r.from).join(','),
      outReq.map((r) => r.to).join(','),
      allies.map((a) => `${a.a}-${a.b}-${Math.floor((a.expiresTick - s.tick) / (TICKS_PER_SECOND * 5))}`).join(','),
      me.embargoes.join(','),
      traitors.map((p) => p.id).join(','),
      Math.floor(me.gold / 200),
    ].join('|');
    if (key === this.key) return;
    this.key = key;
    const b = this.body;
    b.replaceChildren();
    const big = el('div', 'big-read');
    big.append(el('span', 'big-v', String(allies.length)), el('span', 'big-l', allies.length === 1 ? 'alliance' : 'alliances'));
    b.append(big);
    const nameBtn = (id: number): HTMLElement => {
      const p = s.players[id];
      const n = el('button', 'pname');
      n.type = 'button';
      const sw = el('i', 'sw');
      sw.style.background = swatchCss(p, me.id);
      n.append(sw, p.name);
      n.addEventListener('click', () => this.ctx.openNation(id));
      return n;
    };
    if (inReq.length) {
      b.append(sectionTitle('Asking you'));
      for (const r of inReq) {
        const row = el('div', 'drow');
        row.append(
          nameBtn(r.from),
          btn('Accept', 'primary mini', () => this.ctx.act({ type: 'answerAlliance', from: r.from, accept: true })),
          btn('Decline', 'mini', () => this.ctx.act({ type: 'answerAlliance', from: r.from, accept: false })),
        );
        b.append(row);
      }
    }
    b.append(sectionTitle('Allies'));
    if (!allies.length) b.append(el('p', 'note', 'No allies. Right-click a nation or open its card from the standings to ask. Allies cannot attack each other, share what they see, and you can ask them to attack your enemies or send troops.'));
    for (const a of allies) {
      const other = a.a === me.id ? a.b : a.a;
      const row = el('div', 'drow');
      const left = (a.expiresTick - s.tick) / TICKS_PER_SECOND;
      const brk = btn('Break', 'mini danger', () => this.ctx.act({ type: 'breakAlliance', with: other }));
      brk.dataset.tip = 'Break the alliance: you become a traitor for a while (weaker defence, everyone trusts you less)';
      row.append(nameBtn(other), el('span', 'dmeta', `${fmtTime(left)} left`), brk);
      const box = el('div', 'ally-row');
      box.append(row);
      const h = this.helps.get(other);
      if (h) box.append(h.el);
      b.append(box);
    }
    for (const id of [...this.helps.keys()]) if (!allies.some((a) => a.a === id || a.b === id)) this.helps.delete(id);
    if (outReq.length) {
      b.append(sectionTitle('Waiting for an answer'));
      for (const r of outReq) {
        const row = el('div', 'drow');
        row.append(nameBtn(r.to), el('span', 'dmeta', `${fmtTime((r.expiresTick - s.tick) / TICKS_PER_SECOND)}`));
        b.append(row);
      }
    }
    if (me.embargoes.length) {
      b.append(sectionTitle('Embargoes'));
      for (const id of me.embargoes) {
        if (!s.players[id]?.alive) continue;
        const row = el('div', 'drow');
        row.append(nameBtn(id), btn('Lift', 'mini', () => this.ctx.act({ type: 'toggleEmbargo', with: id })));
        b.append(row);
      }
    }
    if (traitors.length) {
      b.append(sectionTitle('Traitors right now'));
      b.append(el('p', 'note', 'They broke an alliance: their defence is weaker for a short while.'));
      for (const p of traitors.slice(0, 8)) {
        const row = el('div', 'drow');
        row.append(nameBtn(p.id));
        b.append(row);
      }
    }
  }
}

// ================================================================================================ Events

export class EventsPage implements DrawerPage {
  id: DrawerId = 'events';
  title = 'Events';
  root = el('div', 'page');
  private list = el('div', 'ev-list');
  private count = 0;

  constructor(private ctx: HudCtx) {
    this.root.append(this.list);
    this.list.append(el('p', 'note ev-empty', 'Nothing yet.'));
  }

  add(state: GameState, e: GameEvent, focus: number): void {
    if (this.count === 0) this.list.replaceChildren();
    this.count++;
    const row = el(focus >= 0 ? 'button' : 'div', `ev k-${e.kind}`);
    if (row instanceof HTMLButtonElement) {
      row.type = 'button';
      row.addEventListener('click', () => this.ctx.focusTile(focus, true));
      row.dataset.tip = 'Show on the map';
    }
    row.append(el('span', 'ev-t', fmtTime(gameSecondsAt(state, e.tick))), el('span', 'ev-m', e.message));
    this.list.prepend(row);
    while (this.list.childElementCount > 80) this.list.lastElementChild?.remove();
  }

  update(): void {}
}

// ================================================================================================ Map key

export class LegendPage implements DrawerPage {
  id: DrawerId = 'legend';
  title = 'Map key';
  root = el('div', 'page legend');

  constructor() {
    const r = this.root;
    r.append(el('p', 'note', 'What you see on the map and what it does. Hover any tile for the same in short.'));
    r.append(sectionTitle('Terrain'));
    for (const id of LAND_TERRAINS as TerrainId[]) {
      const t = TERRAIN[id];
      const row = el('div', 'lg');
      const sw = el('span', 'lg-sw');
      sw.style.background = rgbCss(t.color);
      sw.innerHTML = worldGlyph(TERRAIN_GLYPH[id], 20);
      const txt = el('div', 'lg-t');
      txt.append(el('b', '', t.name), el('span', '', terrainEffect(id)));
      const note = terrainNote(id);
      if (note) txt.append(el('span', 'dim', note));
      row.append(sw, txt);
      r.append(row);
    }
    const water = el('div', 'lg');
    const wsw = el('span', 'lg-sw');
    wsw.style.background = rgbCss(TERRAIN[1].color);
    wsw.innerHTML = worldGlyph('water', 20);
    const wt = el('div', 'lg-t');
    wt.append(el('b', '', 'Water'), el('span', '', 'Only transports cross it: click land across the sea to send one.'));
    water.append(wsw, wt);
    r.append(water);

    r.append(sectionTitle('Resources'));
    for (const res of [Resource.Iron, Resource.Oil, Resource.Fertile]) {
      const info = RESOURCE_TEXT[res];
      const row = el('div', 'lg');
      const sw = el('span', 'lg-sw plain');
      const img = el('img');
      img.alt = '';
      img.width = img.height = 26;
      try {
        img.src = markerDataUrl(res === Resource.Iron ? 'iron' : res === Resource.Oil ? 'oil' : 'fertile', 26);
      } catch {
        /* no canvas */
      }
      sw.append(img);
      const txt = el('div', 'lg-t');
      txt.append(el('b', '', RESOURCE_NAMES[res] === 'Fertile' ? 'Fertile land' : RESOURCE_NAMES[res]), el('span', '', info.use));
      row.append(sw, txt);
      r.append(row);
    }

    r.append(sectionTitle('Borders and marks'));
    const mark = (cls: string, title: string, text: string, inner = '') => {
      const row = el('div', 'lg');
      const sw = el('span', 'lg-sw mark ' + cls);
      sw.innerHTML = inner;
      const txt = el('div', 'lg-t');
      txt.append(el('b', '', title), el('span', '', text));
      row.append(sw, txt);
      r.append(row);
    };
    mark('m-you', 'Your border', 'A white line around your land.');
    mark('m-ally', 'Ally border', 'Light dashed line: allies cannot attack each other.');
    mark('m-traitor', 'Traitor', 'Red border: they broke an alliance and defend worse for a while.');
    mark('m-tribe', 'Tribes', 'Grey wash with an army number (the name when zoomed in): weak peoples, easy early land.');
    mark('m-fort', 'Fort cover', 'Hatched land: attackers there lose double and slow down.');
    mark('m-capital', 'Capital', 'Star: the heart of a nation. Taking it costs them gold.', worldGlyph('capital', 16));
    mark('m-front', 'Front', 'Yellow flashes are your gains, red flashes your losses.');
    mark('m-heart', 'Heartland', 'Faint gold edge (shown while this key or Army is open): your land deep inside your borders defends harder. Hover a tile for the bonus.');

    r.append(sectionTitle('Buildings'));
    const cats = el('p', 'note');
    cats.append('The plate colour says what a building does: ');
    const catNames: [keyof typeof CATEGORY_COLORS, string][] = [
      ['economy', 'economy'],
      ['production', 'troops'],
      ['defence', 'defence'],
      ['logistics', 'logistics'],
      ['advanced', 'air and missiles'],
    ];
    catNames.forEach(([c, label], k) => {
      const dot = el('i', 'sw');
      dot.style.background = CATEGORY_PLATES[c];
      cats.append(dot, label + (k < catNames.length - 1 ? ', ' : '.'));
    });
    cats.append(' The frame is the owner\'s colour; zoom in close to see the names.');
    r.append(cats);
    for (const type of BUILDING_ORDER) {
      const info = BUILDINGS[type];
      const row = el('div', 'lg');
      const sw = el('span', 'lg-sw plain');
      const img = el('img');
      img.alt = '';
      img.width = img.height = 26;
      try {
        const cat = ICON_INFO[type].category;
        img.src = markerDataUrl(type, 26, { plate: cat ? CATEGORY_PLATES[cat] : '#5d6573' });
      } catch {
        /* no canvas */
      }
      sw.append(img);
      const txt = el('div', 'lg-t');
      txt.append(el('b', '', `${info.name} (${info.hotkey})`), el('span', '', info.description));
      row.append(sw, txt);
      r.append(row);
    }

    r.append(sectionTitle('Units'));
    const unit = (icon: string, title: string, text: string) => {
      const row = el('div', 'lg');
      const sw = el('span', 'lg-sw plain');
      sw.innerHTML = icon;
      const txt = el('div', 'lg-t');
      txt.append(el('b', '', title), el('span', '', text));
      row.append(sw, txt);
      r.append(row);
    };
    unit(lineIcon('transport', 22), 'Transport', 'Carries troops across water; the number shows how many.');
    unit(lineIcon('warship', 22), 'Warship', 'Sinks enemy ships and shells coasts near its port.');
    unit(lineIcon('bomb', 22), 'Bomber', 'Flies from an airfield and bombs buildings and troops.');
    unit(worldGlyph('transportPlane', 22), 'Cargo plane', 'Carries paratroopers to a drop zone.');
    unit(lineIcon('rocket', 22), 'Rocket and atom bomb', 'Launched from silos; a red ring with a countdown marks one flying at you.');

    r.append(sectionTitle('Strikes'));
    unit(worldGlyph('paradrop', 22), 'Paratroopers', ABILITY_TEXT.paradrop);
    unit(worldGlyph('barrage', 22), 'Artillery barrage', ABILITY_TEXT.barrage);

    r.append(sectionTitle('Troop counters'));
    const t = el('table', 'tbl');
    const head = el('tr');
    head.append(el('th', '', 'Attacker'));
    for (const d of ['infantry', 'armor', 'artillery'] as const) head.append(el('th', '', `vs ${d}`));
    t.append(head);
    for (const a of ['infantry', 'armor', 'artillery'] as const) {
      const row = el('tr');
      row.append(el('td', 'b', a[0].toUpperCase() + a.slice(1)));
      for (const d of ['infantry', 'armor', 'artillery'] as const) {
        const v = MATCHUP[a][d];
        row.append(el('td', v > 1.05 ? 'good' : v < 0.95 ? 'bad' : '', `x${v.toFixed(1)}`));
      }
      t.append(row);
    }
    r.append(t);
  }

  update(): void {}
}

// ================================================================================================ selected building

export class BuildingPage implements DrawerPage {
  id: DrawerId = 'building';
  title = 'Building';
  root = el('div', 'page');
  private key = '';
  private upd: ((s: GameState, me: Player, b: Building) => void)[] = [];
  tile = -1;

  constructor(private ctx: HudCtx) {}

  /** The building shown, or null when it is gone or no longer yours. */
  current(s: GameState, me: Player): Building | null {
    if (this.tile < 0 || this.tile >= s.map.owner.length) return null;
    const b = buildingAt(s, this.tile);
    return b && b.owner === me.id ? b : null;
  }

  update(s: GameState, me: Player): void {
    const b = this.current(s, me);
    if (!b) return;
    const warships = s.units.filter((u) => u.owner === me.id && u.type === 'warship').map((u) => u.id);
    const key = `${b.id}|${b.type}|${b.level}|${b.buildLeft > 0}|${me.techs.length}|${b.type === 'port' ? warships.join(',') : ''}`;
    if (key !== this.key) {
      this.key = key;
      this.build(s, me, b, warships);
    }
    for (const f of this.upd) f(s, me, b);
  }

  private build(s: GameState, me: Player, b: Building, warships: number[]): void {
    const ctx = this.ctx;
    const allowedNow = (kind: 'atomBomb' | 'warship'): boolean => unitAllowed(s, kind);
    const r = this.root;
    r.replaceChildren();
    this.upd = [];
    const info = BUILDINGS[b.type];
    const tile = b.tile;
    const lv = maxLevel(b.type);
    const tx = buildingTexts(!unitAllowed(s, 'atomBomb'), b.type, info.description);
    this.title = info.name;
    const head = el('div', 'bhead');
    const ic = iconSpan(worldGlyph(b.type, 40), 'bhead-ic');
    const ht = el('div', 'bhead-t');
    ht.append(el('span', 'big-v', info.name), el('span', 'big-l', lv > 1 ? `Level ${b.level} of ${lv}` : tx.short));
    head.append(ic, ht);
    r.append(head, el('p', 'desc', tx.description));
    const prog = el('div', 'pbar');
    const fill = el('span');
    prog.append(fill);
    const progText = el('p', 'note');
    r.append(prog, progText);
    this.upd.push((_s, _me, bb) => {
      const building = bb.buildLeft > 0;
      const upgrading = bb.buildLeft <= 0 && bb.upgradeLeft > 0;
      setVisible(prog, building || upgrading);
      if (building) {
        fill.style.width = pct(1 - bb.buildLeft / buildSeconds(_s, info.buildTime));
        setText(progText, `Being built: ${Math.ceil(bb.buildLeft)} s`);
      } else if (upgrading) {
        fill.style.width = pct(1 - bb.upgradeLeft / buildSeconds(_s, info.buildTime));
        setText(progText, `Upgrading to level ${bb.level + 1}: ${Math.ceil(bb.upgradeLeft)} s`);
      } else setText(progText, bb.hp < 1 ? `Damaged: ${pct(bb.hp)}` : '');
    });
    const actions = el('div', 'bacts');
    r.append(actions);
    const add = (label: string, cls: string, icon: string, run: () => void, check: (s: GameState, me: Player, bb: Building) => string) => {
      const x = btn(label, cls, run, icon);
      actions.append(x);
      this.upd.push((ss, m, bb) => {
        const why = check(ss, m, bb);
        setDisabled(x, why !== '');
        setTip(x, why);
      });
      return x;
    };
    if (b.level < lv) {
      const c = buildCostAt(s, me.id, b.type, tile);
      add(`Upgrade to level ${b.level + 1} (${formatCount(c.gold)} gold${c.iron ? `, ${formatCount(c.iron)} iron` : ''})`, 'primary wide', 'upgrade', () => ctx.act({ type: 'build', building: b.type, tile }), (ss, m) => {
        const res = canBuild(ss, m.id, b.type, tile);
        return res.ok ? '' : res.reason ?? '';
      });
    }
    // levels queued by Build x3 / x5 or Upgrade x3 / x5: how many, and a button that cancels them (refund)
    {
      const q = el('p', 'note bq-note');
      const cancel = btn('Cancel queued levels', 'ghost wide', () => ctx.act({ type: 'cancelQueuedLevels', tile }), 'close');
      cancel.dataset.test = 'cancel-queued';
      actions.append(cancel);
      actions.before(q);
      this.upd.push((_s, _m, bb) => {
        const n = bb.queuedLevels || 0;
        const paid = bb.queuedPaid;
        setVisible(q, n > 0);
        setVisible(cancel, n > 0);
        if (n > 0) {
          setText(q, `${n} more level${n === 1 ? '' : 's'} queued: up to level ${bb.level + (bb.upgradeLeft > 0 ? 1 : 0) + n}, one after another`);
          const lab = cancel.querySelector('.wr-btn-l');
          if (lab) lab.textContent = `Cancel ${n} queued level${n === 1 ? '' : 's'}${paid ? ` (refund ${formatCount(paid.gold)} gold${paid.iron >= 1 ? `, ${formatCount(paid.iron)} iron` : ''})` : ''}`;
        }
      });
    }
    if (b.type === 'airfield') {
      const counts = el('p', 'note');
      actions.before(counts);
      this.upd.push((_s, _m, bb) => setText(counts, `${bb.bombers} bombers, ${bb.fighters} fighters (room for ${aircraftCap(bb)})`));
      // the wing's standing mission: Support front / Strategic / Superiority / Idle (hud/airPanel.ts)
      const wing = new AirPanel(ctx, tile);
      actions.before(wing.el);
      this.upd.push((ss, m, bb) => wing.update(ss, m, bb));
      for (const kind of ['bomber', 'fighter'] as const) {
        const name = UNITS[kind].name;
        const g = ctx.state();
        const first = g ? unitCost(g, b.owner, kind) : UNITS[kind];
        add(`${name} (${formatCount(first.gold)} gold)`, '', 'plus', () => ctx.act({ type: 'buildAircraft', airfield: tile, kind }), (ss, m, bb) => {
          const u = unitCost(ss, m.id, kind);
          return bb.buildLeft > 0 ? 'Still being built' : bb.bombers + bb.fighters >= aircraftCap(bb) ? 'Airfield is full' : m.gold < u.gold ? 'Not enough gold' : m.iron < u.iron ? 'Not enough iron' : m.oil < u.oil ? 'Not enough oil' : '';
        });
      }
      add('Bomb a target', 'danger', 'bomb', () => (ctx.ui.mode = { kind: 'bomb', airfield: tile }), (_ss, _m, bb) => (bb.bombers > 0 ? '' : 'No bombers here'));
      add('Paratroopers', 'danger', 'paradrop', () => (ctx.ui.mode = { kind: 'paradrop', airfield: tile }), (_ss, m, bb) =>
        !hasTech(m, 'flight') ? 'Research Flight first' : bb.buildLeft > 0 ? 'Still being built' : bb.dropCooldown > 0 ? `Next drop ready in ${Math.ceil(bb.dropCooldown)} s` : '',
      );
      // Arsenal (hud/variantOrders.ts): the bomber type of the Air path, and recon flights
      const airNote = el('p', 'note');
      actions.before(airNote);
      this.upd.push((ss, m) => setText(airNote, airfieldVariantLine(ss, m)));
      if (reconOffered(me)) {
        const rb = add(reconLabel(b), '', 'eye', () => {
          ctx.ui.mode = { kind: 'recon', airfield: tile }; // the mode chip shows reconHint()
        }, (ss, m, bb) => reconBlock(ss, m, bb));
        rb.dataset.test = 'order-recon';
      }
    }
    if (b.type === 'factory') {
      // the same Tank division order as the Build menu, right where a player looks for it (this Factory builds it)
      const note = el('p', 'note');
      actions.before(note);
      this.upd.push((ss, m, bb) => setText(note, bb.buildLeft > 0 ? '' : `${tankDivisionCount(ss, m.id)} of ${tankDivisionLimit(ss, m.id)} tank divisions. ${factoryVariantLine(ss, m)} A division is commandable: set it to Support front and it breaks through weak spots by itself.`.replace('  ', ' ')));
      const g0 = ctx.state();
      const price = g0 ? formatCount(tankDivisionCost(g0, b.owner).gold) : '';
      add(`Tank division (${price} gold)`, '', 'plus', () => ctx.act({ type: 'buildTankDivision', tile }), (ss, m, bb) => {
        if (bb.buildLeft > 0) return 'Still being built';
        const r = canBuildTankDivision(ss, m.id, tile);
        return r.ok ? '' : r.reason ?? 'Not possible now';
      });
    }
    if (b.type === 'silo') {
      const cd = el('p', 'note');
      actions.before(cd);
      this.upd.push((_s, _m, bb) => setText(cd, bb.buildLeft > 0 ? '' : chargesReady(bb) > 0 ? `${chargesReady(bb)} of ${Math.max(1, bb.level)} launches ready` : `Reloading: ${Math.ceil(nextChargeIn(bb))} s`));
      for (const kind of ['rocket', 'atomBomb'] as const) {
        if (kind === 'atomBomb' && !allowedNow('atomBomb')) continue;
        const u = UNITS[kind];
        add(`${u.name} (${formatCount(u.gold)} gold)`, 'danger', kind === 'rocket' ? 'rocket' : 'atom', () => (ctx.ui.mode = { kind: 'missile', silo: tile, missile: kind }), (_ss, m, bb) =>
          u.tech && !hasTech(m, u.tech) ? `Research ${TECHS[u.tech].name} first` : bb.buildLeft > 0 ? 'Still being built' : chargesReady(bb) <= 0 ? 'Reloading' : m.gold < u.gold ? 'Not enough gold' : m.iron < u.iron ? 'Not enough iron' : m.oil < u.oil ? 'Not enough oil' : '',
        );
      }
    }
    if (b.type === 'port') {
      // one button per ship of the chosen Navy path (hud/variantOrders.ts); the standard warship before a pick
      if (allowedNow('warship')) for (const o of warshipOptions(s, me)) {
        const x = add(`${o.label} (${formatCount(o.gold)} gold)`, '', 'warship', () => warshipClickMode(ctx, o.variant), (ss, m, bb) => {
          const u = warshipOrderCost(ss, m.id, o.variant);
          return !hasTech(m, 'navigation') ? 'Research Navigation first' : bb.buildLeft > 0 ? 'Still being built' : m.gold < u.gold ? 'Not enough gold' : m.iron < u.iron ? 'Not enough iron' : m.oil < u.oil ? 'Not enough oil' : '';
        });
        x.dataset.test = `order-${o.variant ?? 'warship'}`;
        if (!x.dataset.tip) x.dataset.tip = o.tip;
      }
      add('Send a transport', '', 'transport', () => (ctx.ui.mode = { kind: 'transport', from: tile }), (_ss, _m, bb) => (bb.buildLeft > 0 ? 'Still being built' : ''));
      if (warships.length) {
        r.append(sectionTitle('Warships'));
        warships.slice(0, 8).forEach((id, k) => {
          const row = el('div', 'drow');
          const sel = btn('Select', 'mini', () => {
            ctx.ui.mode = { kind: 'moveWarship', unitId: id };
            ctx.closeDrawer();
          });
          sel.dataset.tip = 'Select it, then click water to send it there';
          row.append(el('span', 'pname', `Warship ${k + 1}`), sel);
          r.append(row);
        });
      }
    }
    let confirmUntil = 0;
    const demo = btn('Demolish', 'ghost danger', () => {
      const now = performance.now();
      if (now > confirmUntil) {
        confirmUntil = now + 2500;
        const l = demo.querySelector('.wr-btn-l');
        if (l) l.textContent = 'Click again to demolish';
        setTimeout(() => {
          if (l) l.textContent = 'Demolish';
        }, 2500);
        return;
      }
      if (ctx.act({ type: 'demolish', tile })) {
        ctx.ui.selectedTile = -1;
        ctx.closeDrawer();
      }
    }, 'demolish');
    demo.dataset.tip = 'Remove this building (a quarter of the price back)';
    r.append(demo);
  }
}

// ================================================================================================ settings

export interface SettingsHooks {
  audio(): { master: number; sfx: number; music: number; muted: boolean } | null;
  setVolume(master?: number, sfx?: number, music?: number): void;
  setMuted(m: boolean): void;
  advisorOn(): boolean;
  setAdvisor(on: boolean): void;
  restartTutorial(): void;
  leave(): void;
}

export class SettingsPage implements DrawerPage {
  id: DrawerId = 'settings';
  title = 'Menu';
  root = el('div', 'page');
  private sync: (() => void)[] = [];

  constructor(ctx: HudCtx, hooks: SettingsHooks) {
    const r = this.root;
    const a = hooks.audio();
    if (a) {
      r.append(sectionTitle('Sound'));
      const vol = (label: string, get: () => number, set: (v: number) => void) => {
        const row = el('div', 'slider-row');
        const s = slider(0, 100, 5);
        const v = el('span', 'sv');
        s.addEventListener('input', () => {
          set(Number(s.value) / 100);
          setText(v, `${s.value}%`);
        });
        row.append(el('span', 'sl', label), s, v);
        r.append(row);
        this.sync.push(() => {
          syncSlider(s, Math.round(get() * 100));
          setText(v, `${Math.round(get() * 100)}%`);
        });
      };
      vol('Master', () => hooks.audio()?.master ?? 0, (v) => hooks.setVolume(v));
      vol('Effects', () => hooks.audio()?.sfx ?? 0, (v) => hooks.setVolume(undefined, v));
      vol('Music', () => hooks.audio()?.music ?? 0, (v) => hooks.setVolume(undefined, undefined, v));
      const mute = seg2('Sound on', 'Muted', () => hooks.setMuted(false), () => hooks.setMuted(true));
      r.append(mute.el);
      this.sync.push(() => mute.set(!(hooks.audio()?.muted ?? false)));
    }
    r.append(sectionTitle('Help'));
    const adv = seg2('Advisor on', 'Advisor off', () => hooks.setAdvisor(true), () => hooks.setAdvisor(false));
    adv.el.dataset.test = 'advisor-toggle';
    r.append(adv.el, el('p', 'note', 'The advisor line above the command bar suggests a useful next step.'));
    this.sync.push(() => adv.set(hooks.advisorOn()));
    r.append(btn('Show the tutorial again', 'wide', () => hooks.restartTutorial(), 'help'));
    r.append(sectionTitle('Map'));
    const mm = seg2('Minimap shown', 'Minimap hidden', () => (ctx.ui.showMinimap = true), () => (ctx.ui.showMinimap = false));
    r.append(mm.el, el('p', 'note', 'Key M. Overlays: B shows supply, V shows resources.'));
    this.sync.push(() => mm.set(ctx.ui.showMinimap));
    r.append(sectionTitle('Game'));
    let confirmUntil = 0;
    const leave = btn('Leave to the main menu', 'danger wide', () => {
      const now = performance.now();
      if (now < confirmUntil || ctx.state()?.phase === 'over') {
        hooks.leave();
        return;
      }
      confirmUntil = now + 2500;
      ctx.toast('Click again to leave this game');
    }, 'exit');
    leave.dataset.test = 'leave';
    r.append(leave);
  }

  update(): void {
    for (const f of this.sync) f();
  }
  onOpen(): void {
    this.update();
  }
}

// ================================================================================================ the drawer

export class Drawer {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private body: HTMLElement;
  private pages = new Map<DrawerId, DrawerPage>();
  open: DrawerId | null = null;

  constructor(ctx: HudCtx) {
    this.el = el('aside', 'drawer hidden');
    this.el.dataset.test = 'drawer';
    const head = el('header', 'dr-head');
    this.title = el('h2', 'dr-title');
    const close = el('button', 'sq dr-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close (Esc)');
    close.dataset.tip = 'Close  (Esc)';
    close.append(iconSpan(lineIcon('close', 16)));
    close.addEventListener('click', () => ctx.closeDrawer());
    head.append(this.title, close);
    this.body = el('div', 'dr-body');
    this.el.append(head, this.body);
  }

  add(p: DrawerPage): void {
    this.pages.set(p.id, p);
  }
  page<T extends DrawerPage>(id: DrawerId): T {
    return this.pages.get(id) as T;
  }

  show(id: DrawerId): void {
    const p = this.pages.get(id);
    if (!p) return;
    const was = this.open;
    this.open = id;
    this.title.textContent = p.title;
    this.el.dataset.page = id;
    this.body.replaceChildren(p.root);
    this.body.scrollTop = 0;
    if (!was) {
      this.el.classList.remove('hidden');
      this.el.classList.remove('slide');
      void this.el.offsetWidth;
      this.el.classList.add('slide');
    }
    p.onOpen?.();
  }
  hide(): void {
    this.open = null;
    this.el.classList.add('hidden');
  }
  update(s: GameState, me: Player): void {
    if (!this.open) return;
    const p = this.pages.get(this.open)!;
    p.update(s, me);
    if (this.title.textContent !== p.title) this.title.textContent = p.title;
  }
}

/** Relation text for a nation (shared by the card and tooltips). */
export function relationOf(s: GameState, me: Player, id: number): { text: string; cls: string } {
  const p = s.players[id];
  if (!p) return { text: '', cls: '' };
  if (id === me.id) return { text: 'You', cls: 'me' };
  const parts: string[] = [];
  let cls = 'neutral';
  if (areAllied(s, me.id, id)) {
    parts.push('Ally');
    cls = 'ally';
  } else if (s.allianceRequests.some((r) => r.from === id && r.to === me.id)) {
    parts.push('Wants an alliance');
    cls = 'req';
  } else if (s.allianceRequests.some((r) => r.from === me.id && r.to === id)) {
    parts.push('Request sent');
  } else if (s.attacks.some((a) => (a.attacker === me.id && a.target === id) || (a.attacker === id && a.target === me.id))) {
    parts.push('At war');
    cls = 'war';
  } else parts.push(isTribe(p) ? 'Tribe' : 'No treaty');
  if (isTraitor(s, id)) {
    parts.push('traitor');
    cls += ' traitor';
  }
  if (me.embargoes.includes(id)) parts.push('embargoed');
  return { text: parts.join(', '), cls };
}

/** Port "Warship" buttons: the next click picks the water tile (selection.ts spawn mode, valid area shaded). */
function warshipClickMode(ctx: HudCtx, variant?: NavalVariant): void {
  const g = ctx.state();
  const m = ctx.me();
  if (!g || !m) return;
  const why = enterWarshipSpawnMode(ctx.ui, g, m, variant);
  const name = variant ? VARIANT_NAMES[variant] : 'Warship';
  ctx.toast(why ? `${name}: ${why}` : `${name}: click a water tile near your port. Esc cancels.`, why ? 'bad' : 'info');
}
