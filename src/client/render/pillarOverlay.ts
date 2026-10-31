// What the pillars draw on the map (client/pillars.ts phrases them; the rules are in naval2 / armor2 / airwings):
//   - selected warships: their shore-support range (dashed ring; land inside is cheaper and faster to take)
//   - own warships on station: a thin line to the coast / port they cover and a small crosshair there
//   - blockades: a ring with a bar over every blockaded port you are part of (brass = yours, red = against you)
//   - escorts: a thin line from each escorting warship to the transport / trade ship it guards
//   - divisions supporting a front: a dotted line to the front and a small flag there
//   - air support: a subtle dashed disc over each live support zone of yours (and a red one over zones on your land)
//   - air superiority: the patrol circle of the selected airfield, or of every airfield while picking
//   - while aiming a stance / mode / mission: the area the click would cover (bombard range, front radius, zone)
// Cheap: rings and lines only, a few dozen per frame at most.
import { airPatrolRadius, airSupportRadius, airZones, airWingRange, wingOf } from '../../sim/airwings';
import { buildingAt, buildingsOf } from '../../sim/buildings';
import { AIR, ARMOR_SUPPORT_RADIUS, NAVY_CARRIER_SUPPORT_RANGE, NAVY_SUPPORT_RANGE, TICKS_PER_SECOND } from '../../sim/config';
import { divisionMode } from '../../sim/armor2';
import { portBlockadedBy, warshipStance } from '../../sim/naval2';
import { hasTech } from '../../sim/tech';
import type { Building, GameState, Unit } from '../../sim/types';
import type { Camera } from '../camera';
import type { UiState } from '../uiState';
import type { UnitLayer } from './units';

const BRASS = 'rgba(227,192,78,';
const STEEL = 'rgba(160,220,255,';
const RED = 'rgba(255,107,94,';

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
    const range = NAVY_SUPPORT_RANGE * (hasTech(state.players[me], 'carriers') ? NAVY_CARRIER_SUPPORT_RANGE : 1);
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
      ctx.fillStyle = `${mine ? BRASS : RED}${0.05 + 0.05 * left})`;
      ctx.fill();
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `${mine ? BRASS : RED}${0.35 + 0.3 * left})`;
      ctx.stroke();
      ctx.setLineDash([]);
      if (mine && z >= 1.2) planeMark(ctx, c.x, c.y - r - 7, `${BRASS}0.9)`);
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
      if (picking && (picking.pick === 'airSupport' || picking.pick === 'airStrategic')) ring(ctx, c.x, c.y, airWingRange(b, state) * z, `${BRASS}0.4)`, [2, 6]);
    }
    if (picking && picking.pick === 'airSupport' && ui.hoverTile >= 0) {
      const b = picking.airfield >= 0 ? buildingAt(state, picking.airfield) : fields[0];
      const c = at(ui.hoverTile);
      ring(ctx, c.x, c.y, airSupportRadius(b) * z, `${BRASS}0.8)`, [4, 3], `${BRASS}0.08)`);
    }

    // ---- warships: range of the selected ones, station lines, escort links
    const ringed: { x: number; y: number }[] = [];
    for (const u of state.units) {
      if (u.owner !== me || u.hp <= 0) continue;
      if (u.type === 'warship') {
        const p = posOf(u);
        // one ring per group of ships close together (a fleet of 5 draws one ring, not five)
        if (sel.has(u.id) && !ringed.some((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < range * z * 0.7)) {
          ringed.push(p);
          ring(ctx, p.x, p.y, range * z, `${STEEL}0.45)`, [5, 5], `${STEEL}0.035)`);
        }
        if (u.state === 3 && u.station !== undefined && u.station >= 0) {
          const s = at(u.station);
          line(ctx, p.x, p.y, s.x, s.y, `${warshipStance(u) === 'blockade' ? BRASS : STEEL}0.45)`, [2, 4]);
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
        line(ctx, p.x, p.y, s.x, s.y, `${BRASS}${sel.has(u.id) ? 0.7 : 0.35})`, [1, 4]);
        flag(ctx, s.x, s.y, `${BRASS}0.9)`);
        if (sel.has(u.id)) ring(ctx, s.x, s.y, ARMOR_SUPPORT_RADIUS * z, `${BRASS}0.3)`, [3, 6]);
      }
    }

    // ---- blockades: ports you blockade (brass) and your ports under blockade (red)
    for (const b of state.buildings.values()) {
      if (b.type !== 'port' || b.owner <= 0) continue;
      const by = portBlockadedBy(state, b.tile);
      if (!by || (by !== me && b.owner !== me)) continue;
      const c = at(b.tile);
      const r = Math.max(7, Math.min(14, z * 2.4));
      if (!onScreen(c.x, c.y, r)) continue;
      const col = by === me ? `${BRASS}0.95)` : `${RED}0.95)`;
      const pulse = 0.5 + 0.5 * Math.sin(nowMs / 400);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r + pulse * 1.5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c.x - r * 0.7, c.y + r * 0.7);
      ctx.lineTo(c.x + r * 0.7, c.y - r * 0.7);
      ctx.stroke();
    }

    // ---- aiming: what the click would cover
    if (picking && ui.hoverTile >= 0) {
      const c = at(ui.hoverTile);
      if (picking.pick === 'bombard') ring(ctx, c.x, c.y, range * z, `${STEEL}0.75)`, [5, 4], `${STEEL}0.06)`);
      else if (picking.pick === 'front') ring(ctx, c.x, c.y, ARMOR_SUPPORT_RADIUS * z, `${BRASS}0.7)`, [5, 4], `${BRASS}0.05)`);
      else if (picking.pick === 'blockade') ring(ctx, c.x, c.y, Math.max(8, 3 * z), `${BRASS}0.9)`, []);
    }
    ctx.restore();
  }
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
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.setLineDash([]);
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stroke: string, dash: number[]): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.setLineDash(dash);
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = stroke;
  ctx.stroke();
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
  ctx.lineWidth = 1.25;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function flag(ctx: CanvasRenderingContext2D, x: number, y: number, col: string): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - 11);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = col;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 11);
  ctx.lineTo(x + 7, y - 8.5);
  ctx.lineTo(x, y - 6);
  ctx.closePath();
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
  ctx.fillStyle = col;
  ctx.fill();
}
