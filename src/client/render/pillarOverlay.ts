// What the pillars draw on the map (client/pillars.ts phrases them; the rules are in naval2 / armor2 / airwings):
//   - selected warships: their gun range (thin ring: enemy ships inside are fought), shelling range (dotted) and shore-
//     support range (dashed, filled: land inside is cheaper and faster to take), per variant (reach.shipReach)
//   - own warships on station: a thin line to the coast / port they cover and a small crosshair there
//   - blockades: a ring with a bar over every blockaded port you are part of (accent = yours, red = against you)
//   - escorts: a thin line from each escorting warship to the transport / trade ship it guards
//   - divisions supporting a front: a dotted line to the front and a small flag there
//   - air support: a subtle dashed disc over each live support zone of yours (and a red one over zones on your land)
//   - air superiority: the patrol circle of the selected airfield, or of every airfield while picking
//   - while aiming a stance / mode / mission: the area the click would cover (bombard range, front radius, zone)
//   - Arsenal: your recon / light-tank reveal circles (steel, fading) and minefields around ports (dotted: accent =
//     yours or an ally's, red = dangerous to you); the recon aim shows the circle the flight would reveal
// Colours: ACC is the map overlay accent (render/common.ts, light cobalt) for yours and what you aim, STEEL (pale sky)
// the navy's reach and reveals, RED what threatens you. Every ring, line and mark has a thin dark casing, so it reads
// on light land as well as on the slate sea.
// Cheap: rings and lines only, a few dozen per frame at most.
import { activeFog } from '../fog/fogView';
import { airPatrolRadius, airSupportRadius, airZones, airWingRange, wingOf } from '../../sim/airwings';
import { buildingAt, buildingsOf } from '../../sim/buildings';
import { AIR, ARMOR_SUPPORT_RADIUS, NAVY_SUPPORT_RANGE, TICKS_PER_SECOND } from '../../sim/config';
import { divisionMode } from '../../sim/armor2';
import { portBlockadedBy, warshipStance } from '../../sim/naval2';
import { areAllied } from '../../sim/diplomacy';
import { minefields } from '../../sim/specials';
import { revealsOf } from '../../sim/variants';
import { ARSENAL } from '../../sim/config';
import type { Building, GameState, Unit } from '../../sim/types';
import type { Camera } from '../camera';
import type { UiState } from '../uiState';
import type { UnitLayer } from './units';
import { shipReach } from '../reach';
import { navalReachMul } from '../../sim/variants';
import { MAP_NUM_FAMILY } from './common';

const ACC = 'rgba(147,174,248,';
const STEEL = 'rgba(160,220,255,';
const RED = 'rgba(255,107,94,';
/** the dark casing under every line (the accent's dark cobalt) */
const CASE = 'rgba(10,18,44,';

export class PillarOverlay {
  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, units: UnitLayer, frac: number, nowMs: number): void {
    const me = state.humanId;
    if (me <= 0 || state.phase !== 'playing') return;
    const w = state.map.width;
    const z = cam.zoom;
    const at = (t: number) => cam.tileToScreen((t % w) + 0.5, ((t / w) | 0) + 0.5);
    const posOf = (u: Unit) => {
      const p = units.pos(u, frac);
      return cam.tileToScreen(p.x + 0.5, p.y + 0.5);
    };
    const onScreen = (x: number, y: number, r: number) => x + r > 0 && y + r > 0 && x - r < cam.viewW && y - r < cam.viewH;
    const sel = new Set(ui.selection);
    const range = NAVY_SUPPORT_RANGE * navalReachMul(state, me); // a standard ship's shore support (aiming a bombard)
    const byId = new Map<number, Unit>();
    for (const u of state.units) byId.set(u.id, u);
    ctx.save();
    ctx.lineCap = 'round';

    // ---- air: own support zones (subtle) and zones over your land (warning)
    for (const zn of airZones(state)) {
      const mine = zn.owner === me;
      if (!mine && zn.victim !== me) continue;
      const c = at(zn.tile);
      const r = Math.max(6, zn.radius * z);
      if (!onScreen(c.x, c.y, r)) continue;
      const left = Math.max(0, Math.min(1, (zn.untilTick - state.tick) / (AIR.supportSeconds * TICKS_PER_SECOND)));
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `${mine ? ACC : RED}${0.05 + 0.05 * left})`;
      ctx.fill();
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `${CASE}${0.3 + 0.2 * left})`;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = `${mine ? ACC : RED}${0.35 + 0.3 * left})`;
      ctx.stroke();
      ctx.setLineDash([]);
      if (mine && z >= 1.2) planeMark(ctx, c.x, c.y - r - 7, `${ACC}0.9)`);
    }

    // ---- air: the selected airfield (or every airfield while picking): patrol circle / mission reach
    const picking = ui.mode.kind === 'pillarPick' ? ui.mode : null;
    const selB = ui.selectedTile >= 0 ? buildingAt(state, ui.selectedTile) : undefined;
    const fields: Building[] = [];
    if (selB && selB.type === 'airfield' && selB.owner === me) fields.push(selB);
    else if (picking && picking.pick.startsWith('air')) {
      if (picking.airfield >= 0) {
        const b = buildingAt(state, picking.airfield);
        if (b) fields.push(b);
      } else fields.push(...buildingsOf(state, me, 'airfield').filter((b) => b.buildLeft <= 0));
    }
    for (const b of fields) {
      const c = at(b.tile);
      const wg = wingOf(state, b);
      if (wg?.mission === 'superiority' || picking?.pick === 'airSuperiority') {
        const centre = picking?.pick === 'airSuperiority' && ui.hoverTile >= 0 ? at(ui.hoverTile) : wg && wg.target >= 0 ? at(wg.target) : c;
        ring(ctx, centre.x, centre.y, airPatrolRadius(b, state) * z, `${STEEL}0.55)`, [6, 4], `${STEEL}0.05)`);
      }
      if (picking && (picking.pick === 'airSupport' || picking.pick === 'airStrategic')) ring(ctx, c.x, c.y, airWingRange(b, state) * z, `${ACC}0.4)`, [2, 6]);
    }
    if (picking && picking.pick === 'airSupport' && ui.hoverTile >= 0) {
      const b = picking.airfield >= 0 ? buildingAt(state, picking.airfield) : fields[0];
      const c = at(ui.hoverTile);
      ring(ctx, c.x, c.y, airSupportRadius(b) * z, `${ACC}0.8)`, [4, 3], `${ACC}0.08)`);
    }

    // ---- warships: range of the selected ones, station lines, escort links
    const ringed: { x: number; y: number }[] = [];
    for (const u of state.units) {
      if (u.owner !== me || u.hp <= 0) continue;
      if (u.type === 'warship') {
        const p = posOf(u);
        // one set of rings per group of ships close together (a fleet of 5 draws one set, not five)
        if (sel.has(u.id) && !ringed.some((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < Math.max(24, 12 * z))) {
          ringed.push(p);
          const r = shipReach(state, u);
          if (r.support > 0) ring(ctx, p.x, p.y, r.support * z, `${STEEL}0.45)`, [5, 5], `${STEEL}0.035)`);
          if (r.shell > 0 && Math.abs(r.shell - r.support) > 1.5) ring(ctx, p.x, p.y, r.shell * z, `${ACC}0.45)`, [1, 4]);
          ring(ctx, p.x, p.y, r.weapon * z, `${RED}0.4)`, []);
          if (z >= 0.9 && ringed.length === 1) {
            ringLabel(ctx, p.x, p.y - r.weapon * z, `guns ${Math.round(r.weapon)}`, `${RED}0.85)`);
            if (r.support > 0) ringLabel(ctx, p.x, p.y + r.support * z, `shore support ${Math.round(r.support)}`, `${STEEL}0.9)`);
            if (r.shell > 0 && Math.abs(r.shell - r.support) > 1.5) ringLabel(ctx, p.x, p.y - r.shell * z, `shelling ${Math.floor(r.shell)}`, `${ACC}0.9)`);
          }
        }
        if (u.state === 3 && u.station !== undefined && u.station >= 0) {
          const s = at(u.station);
          line(ctx, p.x, p.y, s.x, s.y, `${warshipStance(u) === 'blockade' ? ACC : STEEL}0.45)`, [2, 4]);
          cross(ctx, s.x, s.y, Math.max(4, Math.min(9, z * 1.6)), `${STEEL}0.85)`);
        } else if (u.state === 4 && u.station !== undefined) {
          const t = byId.get(u.station);
          if (t && t.hp > 0) {
            const q = posOf(t);
            line(ctx, p.x, p.y, q.x, q.y, `${STEEL}0.7)`, []);
          }
        }
      } else if (u.type === 'tankDivision' && divisionMode(u) === 'support' && u.station !== undefined && u.station >= 0 && u.state !== 3) {
        const p = posOf(u);
        const s = at(u.station);
        line(ctx, p.x, p.y, s.x, s.y, `${ACC}${sel.has(u.id) ? 0.7 : 0.35})`, [1, 4]);
        flag(ctx, s.x, s.y, `${ACC}0.9)`);
        if (sel.has(u.id)) ring(ctx, s.x, s.y, ARMOR_SUPPORT_RADIUS * z, `${ACC}0.3)`, [3, 6]);
      }
    }

    // ---- blockades: ports you blockade (accent) and your ports under blockade (red)
    for (const b of state.buildings.values()) {
      if (b.type !== 'port' || b.owner <= 0) continue;
      const by = portBlockadedBy(state, b.tile);
      if (!by || (by !== me && b.owner !== me)) continue;
      const c = at(b.tile);
      const r = Math.max(7, Math.min(14, z * 2.4));
      if (!onScreen(c.x, c.y, r)) continue;
      const col = by === me ? `${ACC}0.95)` : `${RED}0.95)`;
      const pulse = 0.5 + 0.5 * Math.sin(nowMs / 400);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r + pulse * 1.5, 0, Math.PI * 2);
      ctx.moveTo(c.x - r * 0.7, c.y + r * 0.7);
      ctx.lineTo(c.x + r * 0.7, c.y - r * 0.7);
      ctx.lineWidth = 4;
      ctx.strokeStyle = `${CASE}0.55)`;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
    }

    // ---- Arsenal: reveal circles of yours, minefields (yours / allied accent, hostile red)
    for (const rv of revealsOf(state, me)) {
      const c = at(rv.tile);
      const r = rv.radius * z;
      if (!onScreen(c.x, c.y, r)) continue;
      const fade = Math.min(1, rv.secondsLeft / 10);
      ring(ctx, c.x, c.y, r, `${STEEL}${0.25 + 0.4 * fade})`, rv.kind === 1 ? [6, 4] : [2, 4], rv.kind === 1 ? `${STEEL}${0.04 + 0.04 * fade})` : undefined);
    }
    const fog = activeFog(state);
    for (const f of minefields(state)) {
      const friendly = f.owner === me || areAllied(state, me, f.owner);
      // fog of war: hostile minefields only around ports in water you have explored
      if (fog && !friendly && !fog.explored(Math.round(f.y) * w + Math.round(f.x))) continue;
      const c = cam.tileToScreen(f.x + 0.5, f.y + 0.5);
      const r = f.radius * z;
      if (!onScreen(c.x, c.y, r)) continue;
      ring(ctx, c.x, c.y, r, friendly ? `${ACC}0.35)` : `${RED}0.55)`, [1, 5], friendly ? undefined : `${RED}0.04)`);
    }
    if (ui.mode.kind === 'recon' && ui.hoverTile >= 0) {
      const c = at(ui.hoverTile);
      ring(ctx, c.x, c.y, ARSENAL.reconRadius * z, `${STEEL}0.8)`, [6, 4], `${STEEL}0.06)`);
    }

    // ---- aiming: what the click would cover
    if (picking && ui.hoverTile >= 0) {
      const c = at(ui.hoverTile);
      if (picking.pick === 'bombard') ring(ctx, c.x, c.y, range * z, `${STEEL}0.75)`, [5, 4], `${STEEL}0.06)`);
      else if (picking.pick === 'front') ring(ctx, c.x, c.y, ARMOR_SUPPORT_RADIUS * z, `${ACC}0.7)`, [5, 4], `${ACC}0.05)`);
      else if (picking.pick === 'blockade') ring(ctx, c.x, c.y, Math.max(8, 3 * z), `${ACC}0.9)`, []);
    }
    ctx.restore();
  }
}

/** A tiny label on a ring (centred on its top or bottom point). */
function ringLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.font = `600 10px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(10,13,21,0.72)';
  ctx.fillRect(x - w / 2, y - 7, w, 14);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** A thin stroke of the current path over a faint dark casing (readable on light land and on the sea). */
function cased(ctx: CanvasRenderingContext2D, stroke: string, width = 1.25): void {
  // dashes and dots get square ends: round ends would ring every dash with the casing
  const cap = ctx.lineCap;
  if (ctx.getLineDash().length) ctx.lineCap = 'butt';
  ctx.lineWidth = width + 1.75;
  ctx.strokeStyle = `${CASE}0.32)`;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.lineCap = cap;
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string, dash: number[], fill?: string): void {
  if (r < 2) return;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.setLineDash(dash);
  cased(ctx, stroke);
  ctx.setLineDash([]);
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stroke: string, dash: number[]): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.setLineDash(dash);
  cased(ctx, stroke);
  ctx.setLineDash([]);
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stroke: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
  ctx.moveTo(x - r, y);
  ctx.lineTo(x - r * 0.3, y);
  ctx.moveTo(x + r * 0.3, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y - r * 0.3);
  ctx.moveTo(x, y + r * 0.3);
  ctx.lineTo(x, y + r);
  cased(ctx, stroke);
}

function flag(ctx: CanvasRenderingContext2D, x: number, y: number, col: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 11);
  cased(ctx, col, 1.5);
  ctx.beginPath();
  ctx.moveTo(x, y - 11);
  ctx.lineTo(x + 7, y - 8.5);
  ctx.lineTo(x, y - 6);
  ctx.closePath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `${CASE}0.45)`;
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.fill();
}

/** A tiny plane chevron (air support marker). */
function planeMark(ctx: CanvasRenderingContext2D, x: number, y: number, col: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x + 6, y + 3);
  ctx.lineTo(x, y + 1);
  ctx.lineTo(x - 6, y + 3);
  ctx.closePath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `${CASE}0.45)`;
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.fill();
}
