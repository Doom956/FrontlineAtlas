// Forces drawer (Y): every special unit you own, grouped, with its state in one line and its orders as buttons.
//   Fleet      warships (hull, where, what they do: Select), transports at sea (troops, destination: Find)
//   Air        per airfield: bombers and fighters stored, room, + Bomber / + Fighter / Bomb / Drop
//   Missiles   per silo: launches loaded or reload time, Rocket / Atom
//   Artillery  how much, barrage ready or not: Barrage
//   Land       tank divisions (strength, what they do: Select), + Tank division (click one of your factories)
// An empty group says in one line how to unlock it. Rows are rebuilt only when their shape changes (new unit,
// another button state); the status texts update in place at ~5 Hz, so buttons keep hover and focus.
import { artilleryOf } from '../../sim/barrage';
import { aircraftCap, buildingsOf, chargesReady, countBuildings, nextChargeIn } from '../../sim/buildings';
import { BARRAGE_MIN_ARTILLERY, TANK_DIVISION_TROOPS, TICKS_PER_SECOND, UNITS } from '../../sim/config';
import { bestFactory, canBuildTankDivision, tankDivisionCost, tankDivisionLimit } from '../../sim/tanks';
import { enterTankDivisionBuildMode, enterWarshipSpawnMode, selectAllOf } from '../selection';
import { buildingAllowed, unitAllowed } from '../../sim/rules';
import { hasTech } from '../../sim/tech';
import { unitCost } from '../../sim/units';
import type { Building, GameState, Player, Unit } from '../../sim/types';
import { aircraftAt, buildUnit, hpText, priceText, UNIT_TEXT, unitBuildStatus, unitDoing, unitName, type BuyableUnit } from '../forces';
import { iconDataUrl, type IconId } from '../icons';
import { formatCount } from '../render/common';
import { aimStrike, STRIKES, strikeStatus, type StrikeId } from '../strikes';
import { el, sectionTitle, setText, setTip, type DrawerId, type HudCtx } from './dom';
import type { DrawerPage } from './drawers';
import { iconSpan, lineIcon, worldGlyph } from './glyph';

interface Act {
  label: string;
  icon?: string;
  cls?: string;
  /** '' = enabled, else the reason it is off (tooltip) */
  off?: string;
  tip?: string;
  run: () => void;
}
interface RowSpec {
  key: string;
  /** a unit picture (icons.ts) or a building glyph */
  pic: { unit?: IconId; building?: Parameters<typeof worldGlyph>[0] };
  title: string;
  status: string;
  /** clicking the title centres the map here (-1 = no) */
  tile: number;
  acts: Act[];
  warn?: boolean;
}

function pic(p: RowSpec['pic'], px: number): HTMLElement {
  if (p.building) return iconSpan(worldGlyph(p.building, px), 'fr-ic');
  const img = el('img', 'fr-ic');
  img.alt = '';
  img.width = px;
  img.height = px;
  img.draggable = false;
  try {
    if (p.unit) img.src = iconDataUrl(p.unit, px);
  } catch {
    /* no canvas (tests) */
  }
  return img;
}

/** A group: title, optional header buttons, its rows or one line saying how to unlock it. */
class Group {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private headActs: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private key = '';
  private statusEls: HTMLElement[] = [];
  private headBtns: HTMLButtonElement[] = [];
  private rowBtns: HTMLButtonElement[][] = [];

  constructor(title: string, test: string, private say: (text: string) => void) {
    this.el = el('section', 'fgroup');
    this.el.dataset.test = `forces-${test}`;
    this.head = el('div', 'fg-head');
    this.headActs = el('div', 'fg-acts');
    this.head.append(sectionTitle(title), this.headActs);
    this.list = el('div', 'fg-list');
    this.empty = el('p', 'note fg-empty');
    this.el.append(this.head, this.list, this.empty);
  }

  /** A row / header button; an unavailable one stays focusable and says why when pressed. */
  private button(a: Act): HTMLButtonElement {
    const b = el('button', `wr-btn mini ${a.cls ?? ''}`);
    b.type = 'button';
    if (a.icon) b.append(iconSpan(lineIcon(a.icon, 14, 2)));
    b.append(el('span', 'wr-btn-l', a.label));
    if (a.off) b.setAttribute('aria-disabled', 'true');
    b.classList.toggle('off', !!a.off);
    b.addEventListener('click', () => {
      const why = b.dataset.off ?? '';
      if (why) this.say(why);
      else a.run();
    });
    this.tipOf(b, a);
    return b;
  }
  private tipOf(b: HTMLButtonElement, a: Act): void {
    const off = a.off ?? '';
    if (b.dataset.off !== off) b.dataset.off = off;
    setTip(b, [a.off, a.tip].filter(Boolean).join('\n'));
  }

  set(head: Act[], rows: RowSpec[], empty: string, focus: (t: number) => void): void {
    const key = head.map((a) => `${a.label}:${a.off ? 1 : 0}`).join('|') + '#' + rows.map((r) => `${r.key}:${r.title}:${r.warn ? 1 : 0}:${r.acts.map((a) => `${a.label}:${a.cls ?? ''}:${a.off ? 1 : 0}`).join(',')}`).join(';') + '#' + empty;
    if (key !== this.key) {
      this.key = key;
      this.headBtns = head.map((a) => this.button(a));
      this.headActs.replaceChildren(...this.headBtns);
      this.statusEls = [];
      this.rowBtns = [];
      this.list.replaceChildren(
        ...rows.map((r) => {
          const row = el('div', 'frow2' + (r.warn ? ' warn' : ''));
          const t = el(r.tile >= 0 ? 'button' : 'span', 'fr-t', r.title);
          if (t instanceof HTMLButtonElement) {
            t.type = 'button';
            t.dataset.tip = 'Show on the map';
            const tile = r.tile;
            t.addEventListener('click', () => focus(tile));
          }
          const st = el('span', 'fr-s', r.status);
          this.statusEls.push(st);
          const txt = el('div', 'fr-txt');
          txt.append(t, st);
          const acts = el('div', 'fr-acts');
          const bs = r.acts.map((a) => this.button(a));
          this.rowBtns.push(bs);
          acts.append(...bs);
          row.append(pic(r.pic, 26), txt, acts);
          return row;
        }),
      );
      setText(this.empty, empty);
    }
    rows.forEach((r, k) => {
      const st = this.statusEls[k];
      if (st) setText(st, r.status);
      r.acts.forEach((a, j) => {
        const b = this.rowBtns[k]?.[j];
        if (b) this.tipOf(b, a);
      });
    });
    head.forEach((a, j) => {
      const b = this.headBtns[j];
      if (b) this.tipOf(b, a);
    });
    this.empty.classList.toggle('hidden', !empty);
  }
}

export class ForcesPage implements DrawerPage {
  id: DrawerId = 'forces';
  title = 'Forces';
  root = el('div', 'page forces');
  private fleet: Group;
  private air: Group;
  private missiles: Group;
  private artillery: Group;
  private land: Group;

  constructor(private ctx: HudCtx) {
    const say = (t: string) => {
      ctx.toast(t, 'info');
      ctx.sound('uiError');
    };
    this.fleet = new Group('Fleet', 'fleet', say);
    this.air = new Group('Air', 'air', say);
    this.missiles = new Group('Missiles', 'missiles', say);
    this.artillery = new Group('Artillery', 'artillery', say);
    this.land = new Group('Land', 'land', say);
    const intro = el('p', 'note', 'Click a unit\'s name to find it. Select warships or tank divisions (click, Shift+click, Shift+drag a box; Shift+W all warships, Shift+A all divisions), then click where they go. Transports: click land across the sea. Esc cancels.');
    this.root.append(intro, this.fleet.el, this.land.el, this.air.el, this.missiles.el, this.artillery.el);
  }

  private near(): { x: number; y: number } {
    return { x: this.ctx.camera.x, y: this.ctx.camera.y };
  }
  private tileOf(s: GameState, u: Unit): number {
    const w = s.map.width;
    return Math.max(0, Math.min(s.map.height - 1, Math.round(u.y))) * w + Math.max(0, Math.min(w - 1, Math.round(u.x)));
  }
  private buy(kind: BuyableUnit): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    if (kind === 'warship') {
      // warships appear where you click (water near one of your ports): selection.ts
      const no = enterWarshipSpawnMode(this.ctx.ui, s, me);
      if (no) {
        this.ctx.toast(`Warship: ${no}`, 'info');
        this.ctx.sound('uiError');
      } else this.ctx.closeDrawer();
      return;
    }
    const why = buildUnit(s, me, (a) => this.ctx.dispatch(a), kind, this.near());
    if (why) {
      this.ctx.toast(`${UNITS[kind].name}: ${why}`, 'info');
      this.ctx.sound('uiError');
    }
    this.ctx.refreshSoon();
  }
  /** Enter the factory click mode for a new tank division (or say why not). */
  private tankMode(): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    const no = enterTankDivisionBuildMode(this.ctx.ui, s, me);
    if (no) {
      this.ctx.toast(`Tank division: ${no}`, 'info');
      this.ctx.sound('uiError');
    } else this.ctx.closeDrawer();
  }
  private selectAll(s: GameState, me: Player, type: 'warship' | 'tankDivision'): void {
    this.ctx.ui.mode = { kind: 'none' };
    this.ctx.ui.selection = selectAllOf(s, me.id, type);
    this.ctx.ui.pendingSpearhead = null;
    this.ctx.closeDrawer();
  }
  private aim(id: StrikeId, mode?: () => void): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    if (mode) mode();
    else {
      const why = aimStrike(s, me, this.ctx.ui, id);
      if (why) {
        this.ctx.toast(`${STRIKES[id].name}: ${why}`, 'info');
        return;
      }
    }
    this.ctx.closeDrawer();
  }
  private buyAct(s: GameState, me: Player, kind: BuyableUnit, label: string): Act {
    const st = unitBuildStatus(s, me, kind, this.near());
    return { label, icon: 'plus', off: st.ok ? '' : st.line, tip: `${UNITS[kind].name}: ${priceText(kind, s, me.id)}. ${UNIT_TEXT[kind].what}`, run: () => this.buy(kind) };
  }

  update(s: GameState, me: Player): void {
    const ctx = this.ctx;
    const focus = (t: number) => ctx.focusTile(t, true);
    const mine = s.units.filter((u) => u.owner === me.id && u.hp > 0);

    // ---- fleet
    {
      const rows: RowSpec[] = [];
      const ships = mine.filter((u) => u.type === 'warship');
      ships.forEach((u, k) => {
        const sel = (ctx.ui.mode.kind === 'moveWarship' && ctx.ui.mode.unitId === u.id) || ctx.ui.selection.includes(u.id);
        rows.push({
          key: `w${u.id}`,
          pic: { unit: 'warship' },
          title: `Warship ${k + 1}`,
          status: `Hull ${hpText(u)} · ${unitDoing(s, me, u)}`,
          tile: this.tileOf(s, u),
          warn: u.hp < UNITS.warship.hp,
          acts: [
            {
              label: sel ? 'Selected' : 'Select',
              cls: sel ? 'on' : '',
              tip: 'Select it, then click water to send it there',
              run: () => {
                ctx.ui.mode = { kind: 'none' };
                ctx.ui.selection = [u.id];
                ctx.ui.pendingSpearhead = null;
                ctx.ui.contextMenu = null;
                const cur = ctx.state()?.units.find((q) => q.id === u.id);
                if (cur) ctx.focusTile(this.tileOf(s, cur), false);
                ctx.closeDrawer();
              },
            },
          ],
        });
      });
      for (const u of mine.filter((q) => q.type === 'transport')) {
        rows.push({ key: `t${u.id}`, pic: { unit: 'transport' }, title: 'Transport', status: unitDoing(s, me, u), tile: this.tileOf(s, u), acts: [] });
      }
      const st = unitBuildStatus(s, me, 'warship', this.near());
      const head = st.allowed ? [this.buyAct(s, me, 'warship', 'Warship')] : [];
      const empty = !st.allowed
        ? 'Warships are off in this game. Transports still sail: click land across the sea.'
        : ships.length
          ? ''
          : st.locked
            ? `Warships: ${UNIT_TEXT.warship.unlock.toLowerCase()}.`
            : 'No warships yet: + Warship, then click water near your Port.';
      if (ships.length > 1) head.push({ label: 'All', tip: 'Select every warship (Shift+W)', run: () => this.selectAll(s, me, 'warship') });
      this.fleet.set(head, rows, empty, focus);
    }

    // ---- land: tank divisions
    {
      const rows: RowSpec[] = [];
      const tanks = mine.filter((u) => u.type === 'tankDivision');
      tanks.forEach((u, k) => {
        const sel = ctx.ui.selection.includes(u.id);
        rows.push({
          key: `d${u.id}`,
          pic: { unit: 'armor' },
          title: `Tank division ${k + 1}`,
          status: unitDoing(s, me, u),
          tile: this.tileOf(s, u),
          acts: [
            {
              label: sel ? 'Selected' : 'Select',
              cls: sel ? 'on' : '',
              off: u.state === 3 ? 'In a spearhead: it takes no orders until it ends' : '',
              tip: 'Select it, then click your land to move it or enemy land at your border to launch a spearhead',
              run: () => {
                ctx.ui.mode = { kind: 'none' };
                ctx.ui.selection = [u.id];
                ctx.ui.pendingSpearhead = null;
                ctx.ui.contextMenu = null;
                ctx.focusTile(this.tileOf(s, u), false);
                ctx.closeDrawer();
              },
            },
          ],
        });
      });
      const building = (s.unitQueue ?? []).filter((q) => q.type === 'tankDivision' && q.owner === me.id);
      building.forEach((q) => {
        rows.push({ key: `q${q.id}`, pic: { unit: 'armor' }, title: 'Tank division', status: `Being built: ${Math.max(0, Math.ceil((q.readyTick - s.tick) / TICKS_PER_SECOND))} s`, tile: q.site, acts: [] });
      });
      const c = tankDivisionCost(s, me.id);
      const limit = tankDivisionLimit(s, me.id);
      const can = canBuildTankDivision(s, me.id, Math.max(0, bestFactory(s, me.id)));
      const noFactory = bestFactory(s, me.id) < 0;
      const off = noFactory ? 'Build a Factory first: tank divisions are built at one' : can.ok ? '' : can.reason ?? 'Not possible now';
      const head: Act[] = [
        {
          label: 'Tank division',
          icon: 'plus',
          off,
          tip: `Tank division: ${formatCount(c.gold)} gold, ${c.iron} iron, ${c.oil} oil and ${formatCount(TANK_DIVISION_TROOPS.armor)} armor with an escort from your army. One per Factory level (${limit} now). Click one of your factories.`,
          run: () => this.tankMode(),
        },
      ];
      if (tanks.length > 1) head.push({ label: 'All', tip: 'Select every tank division (Shift+A)', run: () => this.selectAll(s, me, 'tankDivision') });
      const empty = tanks.length || building.length ? '' : hasTech(me, 'mechanization') ? 'No tank divisions yet: + Tank division, then click one of your factories.' : 'Tank divisions: research Mechanization and build a Factory.';
      this.land.set(head, rows, empty, focus);
    }

    // ---- air
    {
      const allowed = buildingAllowed(s, 'airfield') && (unitAllowed(s, 'bomber') || unitAllowed(s, 'fighter') || unitAllowed(s, 'paradrop'));
      const fields = buildingsOf(s, me.id, 'airfield');
      const rows: RowSpec[] = [];
      fields.forEach((b: Building, k) => {
        const built = b.buildLeft <= 0;
        const room = aircraftCap(b) - aircraftAt(s, b);
        const acts: Act[] = [];
        if (built) {
          for (const kind of ['bomber', 'fighter'] as const) {
            if (!unitAllowed(s, kind)) continue;
            const u = unitCost(s, me.id, kind);
            const off = room <= 0 ? 'This airfield is full: upgrade it for more room' : me.gold < u.gold ? `Needs ${formatCount(u.gold)} gold` : me.iron < u.iron ? `Needs ${u.iron} iron` : me.oil < u.oil ? `Needs ${u.oil} oil` : '';
            acts.push({ label: kind === 'bomber' ? 'Bomber' : 'Fighter', icon: 'plus', off, tip: `${UNITS[kind].name}: ${priceText(kind, s, me.id)}. ${UNIT_TEXT[kind].what}`, run: () => ctx.act({ type: 'buildAircraft', airfield: b.tile, kind }) });
          }
          if (unitAllowed(s, 'bomber')) acts.push({ label: 'Bomb', icon: 'bomb', cls: 'danger', off: b.bombers > 0 ? '' : 'No bombers here: build one first', tip: STRIKES.bomb.what, run: () => this.aim('bomb', () => (ctx.ui.mode = { kind: 'bomb', airfield: b.tile })) });
          if (unitAllowed(s, 'paradrop')) acts.push({ label: 'Paradrop', icon: 'paradrop', cls: 'danger', off: b.dropCooldown > 0 ? `Next drop in ${Math.ceil(b.dropCooldown)} s` : '', tip: STRIKES.paradrop.what, run: () => this.aim('paradrop', () => (ctx.ui.mode = { kind: 'paradrop', airfield: b.tile })) });
        }
        rows.push({
          key: `a${b.id}:${built}`,
          pic: { building: 'airfield' },
          title: `Airfield ${k + 1}${b.level > 1 ? ` (level ${b.level})` : ''}`,
          status: built ? `${b.bombers} bomber${b.bombers === 1 ? '' : 's'}, ${b.fighters} fighter${b.fighters === 1 ? '' : 's'} · room for ${Math.max(0, room)} more` : `Being built: ${Math.ceil(b.buildLeft)} s`,
          tile: b.tile,
          acts,
        });
      });
      for (const u of mine.filter((q) => q.type === 'bomber' || q.type === 'transportPlane')) {
        rows.push({ key: `p${u.id}`, pic: { unit: u.type === 'bomber' ? 'bomber' : 'transportPlane' }, title: unitName(u), status: unitDoing(s, me, u), tile: this.tileOf(s, u), acts: [] });
      }
      const empty = !allowed ? 'Aircraft are off in this game.' : fields.length ? '' : hasTech(me, 'flight') ? 'Bombers and fighters: build an Airfield (Build menu, F).' : `Bombers and fighters: ${UNIT_TEXT.bomber.unlock.toLowerCase()}.`;
      this.air.set([], rows, empty, focus);
    }

    // ---- missiles
    {
      const allowed = buildingAllowed(s, 'silo');
      const silos = buildingsOf(s, me.id, 'silo');
      const rows: RowSpec[] = [];
      silos.forEach((b, k) => {
        const built = b.buildLeft <= 0;
        const ready = built ? chargesReady(b) : 0;
        const acts: Act[] = [];
        if (built) {
          for (const kind of ['rocket', 'atomBomb'] as const) {
            if (kind === 'atomBomb' && !unitAllowed(s, 'atomBomb')) continue;
            const u = UNITS[kind];
            const off = u.tech && !hasTech(me, u.tech) ? `Research ${u.tech === 'nuclearFission' ? 'Nuclear Fission' : 'Rocketry'} first` : ready <= 0 ? 'Reloading' : me.gold < u.gold ? `Needs ${formatCount(u.gold)} gold` : me.iron < u.iron ? `Needs ${u.iron} iron` : me.oil < u.oil ? `Needs ${u.oil} oil` : '';
            acts.push({ label: kind === 'rocket' ? 'Rocket' : 'Atom', icon: kind === 'rocket' ? 'rocket' : 'atom', cls: 'danger', off, tip: `${STRIKES[kind].what} ${priceText(kind)}.`, run: () => this.aim(kind, () => (ctx.ui.mode = { kind: 'missile', silo: b.tile, missile: kind })) });
          }
        }
        rows.push({
          key: `s${b.id}:${built}`,
          pic: { building: 'silo' },
          title: `Missile Silo ${k + 1}${b.level > 1 ? ` (level ${b.level})` : ''}`,
          status: !built ? `Being built: ${Math.ceil(b.buildLeft)} s` : ready > 0 ? `${ready} of ${Math.max(1, b.level)} launch${b.level > 1 ? 'es' : ''} loaded` : `Reloading: ${Math.ceil(nextChargeIn(b))} s`,
          tile: b.tile,
          acts,
        });
      });
      for (const u of mine.filter((q) => q.type === 'rocket' || q.type === 'atomBomb')) {
        rows.push({ key: `m${u.id}`, pic: { unit: u.type === 'rocket' ? 'rocket' : 'atomBomb' }, title: unitName(u), status: unitDoing(s, me, u), tile: this.tileOf(s, u), acts: [] });
      }
      const empty = !allowed ? 'Missiles are off in this game.' : silos.length ? '' : hasTech(me, 'rocketry') ? 'Rockets: build a Missile Silo (Build menu, N).' : `Rockets: ${UNIT_TEXT.rocket.unlock.toLowerCase()}.`;
      this.missiles.set([], rows, empty, focus);
    }

    // ---- artillery
    {
      const art = artilleryOf(s, me.id);
      const st = strikeStatus(s, me, 'barrage');
      const rows: RowSpec[] = [];
      const ars = countBuildings(s, me.id, 'arsenal', true);
      if (art > 0 || ars > 0) {
        rows.push({
          key: 'art',
          pic: { unit: 'artillery' },
          title: `${formatCount(art)} artillery`,
          status: art >= BARRAGE_MIN_ARTILLERY ? st.line : `A barrage needs ${formatCount(BARRAGE_MIN_ARTILLERY)}: raise Artillery in the Army drawer (U)`,
          tile: -1,
          acts: [
            { label: 'Barrage', icon: 'barrage', cls: 'danger', off: st.state === 'ready' ? '' : st.line, tip: STRIKES.barrage.what, run: () => this.aim('barrage') },
            { label: 'Mix', icon: 'army', tip: 'Army drawer: set how much of your army is artillery', run: () => ctx.openDrawer('army') },
          ],
        });
      }
      this.artillery.set([], rows, rows.length ? '' : `Artillery: ${UNIT_TEXT.artillery.unlock.charAt(0).toLowerCase()}${UNIT_TEXT.artillery.unlock.slice(1)}.`, focus);
    }
  }
}
