// What the radial menu offers for a tile: the likely action in the centre, the rest on the ring.
import { alliancesAllowed, buildingAllowed, sameTeam, unitAllowed } from '../../sim/rules';
import { buildCostAt, buildingAt, canBuild, chargesReady, countBuildings } from '../../sim/buildings';
import { BUILDINGS, BUILDING_ORDER, RESOURCE_NAMES, TERRAIN, UNITS } from '../../sim/config';
import { areAllied } from '../../sim/diplomacy';
import { hasTech } from '../../sim/tech';
import { isWater, Resource } from '../../sim/types';
import type { BuildingType, GameState, Player, TerrainId } from '../../sim/types';
import { isAttackable, sendTransport, troopsToSend, troopSum } from '../input';
import { swatchCss } from './swatch';
import type { RadialItem, RadialSpec } from '../radial';
import { formatCount } from '../render/common';
import { maxLevel } from '../simx';
import { blastSummary, modeFor, STRIKE_ORDER, STRIKES, strikeAction, strikeStatus, strikeTarget, type StrikeId } from '../strikes';
import { pct, type HudCtx } from './dom';
import { techNear } from './commandBar';
import { confirmBreak, GIFT_GOLD } from './nationCard';
import { allyAttackAction, bestAllyFor } from '../allies';
import { isTribe } from '../compat';

const RADIAL_LABEL: Record<StrikeId, string> = { barrage: 'Barrage', bomb: 'Bomb', paradrop: 'Paratroopers', rocket: 'Rocket', atomBomb: 'Atom bomb' };

function costText(gold: number, iron: number): string {
  return `${formatCount(gold)} gold` + (iron > 0 ? ` + ${formatCount(iron)} iron` : '');
}

/** Best building for an own empty tile: a deposit building, a first port, a farm on fertile land, a city, a market. */
function bestBuilding(state: GameState, me: Player, tile: number): BuildingType | null {
  const map = state.map;
  const cand: BuildingType[] = ['mine', 'oilWell'];
  if (map.coastal[tile] && countBuildings(state, me.id, 'port', true) === 0) cand.push('port');
  if (map.resource[tile] === Resource.Fertile) cand.push('farm');
  cand.push('city', 'market', 'farm', 'lab', 'barracks');
  for (const t of cand) if (canBuild(state, me.id, t, tile).ok) return t;
  return null;
}

function buildItem(ctx: HudCtx, state: GameState, me: Player, type: BuildingType, tile: number): RadialItem {
  const r = canBuild(state, me.id, type, tile);
  const c = buildCostAt(state, me.id, type, tile);
  return {
    label: BUILDINGS[type].name.replace('Research ', '').replace('Supply ', '').replace('Missile ', ''),
    icon: '',
    glyph: type,
    hint: costText(c.gold, c.iron),
    disabled: r.ok ? undefined : r.reason ?? 'Cannot build here',
    run: () => ctx.act({ type: 'build', building: type, tile }),
  };
}

export function radialSpec(ctx: HudCtx, state: GameState, me: Player, tile: number): RadialSpec {
  const map = state.map;
  const h = me.id;
  const owner = map.owner[tile];
  const water = isWater(map.terrain[tile]);
  const terr = TERRAIN[map.terrain[tile] as TerrainId];
  const res = map.resource[tile];
  const op = owner ? state.players[owner] : null;
  const w = map.width;

  const ui = ctx.ui;
  const send = troopsToSend(me, ui);
  const sendText = `${formatCount(troopSum(send))} troops (${pct(ui.attackShare)})`;
  const slices: RadialItem[] = [];
  let centre: RadialItem | null = null;
  const title = op ? op.name + (owner === h ? ' (you)' : '') : water ? terr.name : 'Wilderness';
  const subtitle = water ? '' : terr.name + (res ? `, ${RESOURCE_NAMES[res] === 'Fertile' ? 'fertile land' : RESOURCE_NAMES[res].toLowerCase()}` : '');

  if (water) {
    const ships = state.units.filter((u) => u.owner === h && u.type === 'warship');
    if (ships.length) {
      const tx = tile % w;
      const ty = (tile / w) | 0;
      ships.sort((a, b) => (a.x - tx) ** 2 + (a.y - ty) ** 2 - ((b.x - tx) ** 2 + (b.y - ty) ** 2));
      centre = { label: 'Move warship', icon: 'warship', hint: 'The nearest warship patrols here', run: () => ctx.act({ type: 'moveWarship', unitId: ships[0].id, tile }) };
    }
  } else if (owner === h) {
    const b = buildingAt(state, tile);
    const buildMenu: RadialItem = {
      label: 'Build',
      icon: 'build',
      hint: 'Pick a building for this tile',
      submenu: () => BUILDING_ORDER.filter((t) => techNear(me, BUILDINGS[t].tech) && buildingAllowed(state, t)).map((t) => buildItem(ctx, state, me, t, tile)),
    };
    if (b && b.level < maxLevel(b.type)) {
      const r = canBuild(state, h, b.type, tile);
      const c = buildCostAt(state, h, b.type, tile);
      centre = { label: `Level ${b.level + 1}`, icon: 'upgrade', hint: `Upgrade the ${BUILDINGS[b.type].name}: ${costText(c.gold, c.iron)}`, disabled: r.ok ? undefined : r.reason, run: () => ctx.act({ type: 'build', building: b.type, tile }) };
    } else if (!b) {
      const best = bestBuilding(state, me, tile);
      if (best) {
        const it = buildItem(ctx, state, me, best, tile);
        centre = { ...it, label: `Build ${it.label}` };
      }
    }
    const details = () => {
      ui.selectedTile = tile;
      ctx.openDrawer('building');
    };
    if (b && !centre) centre = { label: BUILDINGS[b.type].name, icon: 'info', hint: 'Show what it does and its actions', run: details };
    if (!b && !centre) centre = buildMenu;
    else if (!b) slices.push(buildMenu);
    if (b && b.owner === h) {
      if (centre?.icon !== 'info') slices.push({ label: 'Details', icon: 'info', run: details });
      if (b.type === 'port' && b.buildLeft <= 0) {
        slices.push({ label: 'Transport', icon: 'transport', hint: 'Then click a coast to land on', run: () => (ui.mode = { kind: 'transport', from: tile }) });
        const u = UNITS.warship;
        if (unitAllowed(state, 'warship')) slices.push({
          label: 'Warship',
          icon: 'warship',
          hint: costText(u.gold, u.iron),
          disabled: !hasTech(me, 'navigation') ? 'Research Navigation first' : me.gold < u.gold ? 'Not enough gold' : me.iron < u.iron ? 'Not enough iron' : undefined,
          run: () => ctx.act({ type: 'buildWarship', port: tile }),
        });
      }
      if (b.type === 'airfield' && b.buildLeft <= 0) {
        slices.push({ label: 'Bomb', icon: 'bomb', danger: true, disabled: b.bombers > 0 ? undefined : 'No bombers here', hint: 'Then click a target', run: () => (ui.mode = { kind: 'bomb', airfield: tile }) });
        slices.push({ label: 'Paratroopers', icon: 'paradrop', danger: true, hint: 'Then click a drop zone', run: () => (ui.mode = { kind: 'paradrop', airfield: tile }) });
      }
      if (b.type === 'silo' && b.buildLeft <= 0) {
        for (const kind of ['rocket', 'atomBomb'] as const) {
          const u = UNITS[kind];
          if (u.tech && !hasTech(me, u.tech)) continue;
          if (kind === 'atomBomb' && !unitAllowed(state, 'atomBomb')) continue;
          slices.push({
            label: kind === 'rocket' ? 'Rocket' : 'Atom bomb',
            icon: kind === 'rocket' ? 'rocket' : 'atom',
            danger: true,
            hint: costText(u.gold, u.iron),
            disabled: chargesReady(b) <= 0 ? 'Reloading' : me.gold < u.gold ? 'Not enough gold' : undefined,
            run: () => (ui.mode = { kind: 'missile', silo: tile, missile: kind }),
          });
        }
      }
      const bName = BUILDINGS[b.type].name;
      slices.push({
        label: 'Demolish',
        icon: 'demolish',
        danger: true,
        hint: `Remove the ${bName} (a quarter back)`,
        run: () => ctx.confirm(`Demolish your ${bName}? You get a quarter of its price back.`, 'Demolish', () => ctx.act({ type: 'demolish', tile })),
      });
    }
  } else if (isAttackable(state, h, tile)) {
    centre = {
      label: owner ? 'Attack' : 'Expand',
      icon: owner ? 'attack' : 'expand',
      hint: sendText,
      run: () => ctx.act({ type: 'attack', tile, troops: troopsToSend(me, ui) }),
    };
    if (map.coastal[tile]) {
      slices.push({ label: 'By sea', icon: 'transport', hint: `Land ${sendText} here by transport`, run: () => sendTransport(state, ui, ctx.dispatch, -1, tile) });
    }
    // strikes: the same five as the command bar's STRIKES group, once they are unlocked (locked ones stay off the ring)
    for (const id of STRIKE_ORDER) {
      if (!owner && id !== 'paradrop') continue;
      const st = strikeStatus(state, me, id);
      if (!st.allowed || st.state === 'locked') continue;
      const m = modeFor(id);
      const t = st.state === 'ready' ? strikeTarget(state, me, ui, m, tile) : null;
      const a = t ? strikeAction(m, tile, t) : null;
      slices.push({
        label: RADIAL_LABEL[id],
        icon: STRIKES[id].line,
        danger: true,
        hint: t && t.ok ? blastSummary(state, m, t) + (t.covered ? `. ${t.covered}` : '') : STRIKES[id].what,
        disabled: st.state !== 'ready' ? st.line : t && !t.ok ? t.reason : undefined,
        run: () => {
          if (a) ctx.act(a);
        },
      });
    }
  }

  if (owner && owner !== h && op && op.alive) {
    const o = owner;
    const allied = areAllied(state, h, o);
    const inReq = state.allianceRequests.some((r) => r.from === o && r.to === h);
    const outReq = state.allianceRequests.some((r) => r.from === h && r.to === o);
    slices.push({ label: 'Nation', icon: 'info', hint: `${op.name}: army, land and diplomacy`, run: () => ctx.openNation(o) });
    // allies that matter: ask the ally most likely to say yes (one request per cooldown)
    if (!allied && !isTribe(op)) {
      const best = bestAllyFor(state, h, o);
      const an = best.ally ? state.players[best.ally].name : '';
      slices.push({
        label: 'Ask allies',
        icon: 'diplomacy',
        hint: an ? `Ask allies to attack here (${an})` : 'Ask allies to attack here',
        disabled: best.ally ? undefined : best.why,
        run: () => {
          if (ctx.act(allyAttackAction(best.ally, o))) ctx.toast(`Asked ${an} to attack ${op.name}`);
        },
      });
    }
    if (inReq) {
      slices.push({ label: 'Accept ally', icon: 'accept', hint: `${op.name} asked for an alliance`, run: () => ctx.act({ type: 'answerAlliance', from: o, accept: true }) });
      slices.push({ label: 'Decline', icon: 'decline', run: () => ctx.act({ type: 'answerAlliance', from: o, accept: false }) });
    } else if (allied) {
      const troops = Math.floor(me.troops.infantry * ui.attackShare);
      centre = {
        label: 'Send troops',
        icon: 'troops',
        hint: `${formatCount(troops)} infantry to your ally`,
        disabled: troops < 1 ? 'No infantry to send' : undefined,
        run: () => ctx.act({ type: 'gift', to: o, gold: 0, troops }),
      };
      if (!sameTeam(state, h, o)) {
        slices.push({ label: 'Break', icon: 'breakAlly', danger: true, hint: 'Break the alliance: you become a traitor for a while', run: () => confirmBreak(ctx, op.name, o) });
      }
    } else {
      slices.push({ label: 'Ally', icon: 'ally', hint: `Ask ${op.name} for an alliance`, disabled: !alliancesAllowed(state) ? 'Alliances are off in this game' : outReq ? 'Request already sent' : undefined, run: () => ctx.act({ type: 'requestAlliance', to: o }) });
    }
    slices.push({
      label: `Gift ${GIFT_GOLD}`,
      icon: 'gift',
      hint: `${GIFT_GOLD} gold: they will like you more`,
      disabled: me.gold < GIFT_GOLD ? 'Not enough gold' : undefined,
      run: () => ctx.act({ type: 'gift', to: o, gold: GIFT_GOLD, troops: 0 }),
    });
    const mine = state.attacks.filter((a) => a.attacker === h && a.target === o);
    if (mine.length) {
      slices.push({ label: 'Retreat', icon: 'retreat', danger: true, hint: `Call off ${mine.length > 1 ? `${mine.length} attacks` : 'the attack'} (a quarter is lost)`, run: () => mine.forEach((a) => ctx.dispatch({ type: 'retreat', attackId: a.id })) });
    }
  } else if (!water && owner === 0) {
    const mine = state.attacks.filter((a) => a.attacker === h && a.target === 0);
    if (mine.length) slices.push({ label: 'Stop', icon: 'stop', danger: true, hint: 'Stop expanding into the wilderness', run: () => mine.forEach((a) => ctx.dispatch({ type: 'retreat', attackId: a.id })) });
  }
  return { title, subtitle, color: op ? swatchCss(op, h) : undefined, centre, slices };
}
