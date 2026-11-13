// The selected unit's card: a small card next to your selected warship (it follows the ship) with its type, owner,
// hull and current order, while the line at the top says what a click does. Esc or the X cancels the selection.
// Read top to bottom: portrait (the map sprite), name and owner with its stance; one strength line (label, bar, number);
// then what it is doing, what it does by itself, and its reach.
import { divisionMode, divisionStrength } from '../../sim/armor2';
import { divisionReachLine, shipReachLine } from '../reach';
import { warshipMaxHp, warshipStance } from '../../sim/naval2';
import { MODE_INFO, STANCE_INFO, vetOf } from '../pillars';
import type { GameState, Player } from '../../sim/types';
import { hpText, unitDoing } from '../forces';
import { unitAutoLine } from '../follow';
import { iconDataUrl } from '../icons';
import { el, setText, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';
import { mapShown } from '../fx/prankView';
import { paintPortrait } from './portrait';

export class UnitCard {
  readonly el: HTMLElement;
  private title = el('span', 'uc-t');
  private sub = el('span', 'uc-s');
  private hp = el('span', 'uc-hp');
  private hpFill = el('i');
  private strK = el('span', 'uc-k', 'Hull');
  private strV = el('span', 'uc-v');
  private order = el('div', 'uc-o');
  /** what it does by itself ("Auto: supporting the front with Azuria") */
  private auto = el('div', 'uc-a');
  private range = el('div', 'uc-r', '');
  private shown = -1;
  private lastMs = 0;
  private img: HTMLImageElement;
  private imgType = 'warship';
  /** the sprite portrait (render/pixelSprites.ts); the painted icon stays as the fallback without a canvas */
  private pic = document.createElement('canvas');
  private picKey = '';

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'ucard hidden');
    this.el.dataset.test = 'unit-card';
    this.el.setAttribute('role', 'status');
    const img = el('img', 'uc-ic');
    this.img = img;
    img.alt = '';
    img.width = 26;
    img.height = 26;
    try {
      img.src = iconDataUrl('warship', 26);
    } catch {
      /* no canvas */
    }
    const head = el('div', 'uc-head');
    const tt = el('div', 'uc-tt');
    tt.append(this.title, this.sub);
    const x = el('button', 'mc-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Deselect');
    x.append(iconSpan(lineIcon('close', 12, 2)));
    x.addEventListener('click', () => {
      ctx.ui.mode = { kind: 'none' };
      ctx.ui.selection = [];
      ctx.ui.pendingSpearhead = null;
    });
    this.pic.className = 'uc-pic hidden';
    this.pic.setAttribute('aria-hidden', 'true');
    head.append(this.pic, img, tt, x);
    this.hp.append(this.hpFill);
    const str = el('div', 'uc-str');
    str.append(this.strK, this.hp, this.strV);
    this.auto.dataset.test = 'unit-auto';
    this.el.append(head, str, this.order, this.auto, this.range);
  }

  /** Every frame: follow the selected warship on screen; texts at ~5 Hz. */
  update(state: GameState, me: Player): void {
    const now = performance.now();
    const force = now - this.lastMs > 200;
    const m = this.ctx.ui.mode;
    // the warship picked from the Forces drawer, or the one unit selected on the map (selection.ts)
    const sel = this.ctx.ui.selection;
    const id = m.kind === 'moveWarship' ? m.unitId : m.kind === 'none' && sel.length === 1 ? sel[0] : -1;
    const u = id >= 0 ? state.units.find((q) => q.id === id && q.hp > 0) : undefined;
    if (!u) {
      if (id >= 0 && m.kind === 'moveWarship') this.ctx.ui.mode = { kind: 'none' }; // sunk while selected
      setVisible(this.el, false);
      this.shown = -1;
      return;
    }
    if (force || this.shown !== id) {
      this.shown = id;
      this.lastMs = now;
      const tank = u.type === 'tankDivision';
      const same = state.units.filter((q) => q.owner === me.id && q.type === u.type);
      setText(this.title, `${tank ? 'Tank division' : 'Warship'} ${same.indexOf(u) + 1}`);
      const lvl = vetOf(u).level;
      setText(this.sub, `Yours · ${tank ? MODE_INFO[divisionMode(u)].name : STANCE_INFO[warshipStance(u)].name}${lvl ? ` · veteran ${lvl}` : ''}`);
      const owner = state.players.find((p) => p.id === u.owner)?.color ?? me.color;
      const pk = `${u.type}|${u.variant ?? ''}|${owner.join(',')}`;
      if (pk !== this.picKey) {
        this.picKey = pk;
        const ok = paintPortrait(this.pic, u.type, u.variant, owner, 44, 28);
        setVisible(this.pic, ok);
        setVisible(this.img, !ok);
      }
      if (this.imgType !== u.type) {
        this.imgType = u.type;
        try {
          this.img.src = iconDataUrl(tank ? 'armor' : 'warship', 26);
        } catch {
          /* no canvas */
        }
      }
      setText(this.range, tank ? divisionReachLine(state, u) : shipReachLine(state, u));
      const share = tank ? divisionStrength(u) : Math.max(0, u.hp) / Math.max(1, warshipMaxHp(u));
      this.hpFill.style.width = `${Math.round(Math.min(1, share) * 100)}%`;
      this.hp.dataset.tip = tank ? `Strength ${Math.round(share * 100)}%` : `Hull ${hpText(u)}`;
      setText(this.strK, tank ? 'Strength' : 'Hull');
      setText(this.strV, tank ? `${Math.round(share * 100)}%` : hpText(u));
      setText(this.order, unitDoing(state, me, u));
      const auto = unitAutoLine(state, me.id, u);
      setText(this.auto, auto);
      setVisible(this.auto, auto !== '');
    }
    const at = this.ctx.probe()?.unitScreen(id);
    setVisible(this.el, !!at);
    if (!at) return;
    const p = mapShown(at.x, at.y); // a screen prank may show the map turned (fx/prankView.ts)
    // to the right of the ship, flipped left near the screen edge
    const w = this.el.offsetWidth || 200;
    const x = p.x + 22 + w > window.innerWidth - 8 ? p.x - 22 - w : p.x + 22;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(p.y - 24)}px)`;
  }
}
