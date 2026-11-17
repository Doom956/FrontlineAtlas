// Stealth multi-target in the aiming chip at the top (client/stealth.ts, sim units.ts stealthAimsReason): while a
// stealth strike is aimed, "Add target" switches to picking up to STEALTH.multiMax aim points (each click adds one,
// smaller blasts), and "Launch" sends them. One click without "Add target" is still one strike at one target.
import { STEALTH } from '../../sim/config';
import { stealthAimsReason } from '../../sim/units';
import type { GameState, Player } from '../../sim/types';
import { el, setDisabled, setText, setTip, setVisible, btn, type HudCtx } from './dom';

export class StealthAims {
  readonly el: HTMLElement;
  private add: HTMLButtonElement;
  private launch: HTMLButtonElement;
  private count: HTMLElement;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'salvo stealth-aims hidden');
    this.el.dataset.test = 'stealth-aims';
    this.count = el('span', 'salvo-n');
    this.add = btn('Add target', 'ghost', (e) => {
      e.stopPropagation();
      this.add.blur();
      const m = this.ctx.ui.mode;
      if (m.kind === 'stealth' && !m.aims) this.ctx.ui.mode = { ...m, aims: [] };
      this.ctx.refreshSoon();
    }, 'plus');
    this.add.dataset.test = 'stealth-add-target';
    this.launch = btn('Launch', 'danger', (e) => {
      e.stopPropagation();
      this.launch.blur();
      const m = this.ctx.ui.mode;
      if (m.kind !== 'stealth' || !m.aims || !m.aims.length) return;
      const [tile, tile2, tile3] = m.aims;
      const ok = this.ctx.act({ type: 'stealthStrike', airfield: m.airfield, tile, ...(tile2 !== undefined ? { tile2 } : {}), ...(tile3 !== undefined ? { tile3 } : {}) });
      if (ok) this.ctx.ui.mode = { kind: 'none' };
      this.ctx.refreshSoon();
    }, 'stealth');
    this.launch.dataset.test = 'stealth-launch';
    this.el.append(this.add, this.count, this.launch);
  }

  /** Every frame (cheap): shows while a stealth strike is aimed. */
  update(s: GameState, me: Player): void {
    const m = this.ctx.ui.mode;
    setVisible(this.el, m.kind === 'stealth');
    if (m.kind !== 'stealth') return;
    const multi = !!m.aims;
    setVisible(this.add, !multi);
    setVisible(this.launch, multi);
    setVisible(this.count, multi);
    setTip(this.add, `Pick up to ${STEALTH.multiMax} targets within ${STEALTH.multiSpread} tiles of each other, then Launch. Each blast is smaller (${STEALTH.multiRadius} tiles).`);
    if (!multi) return;
    const n = m.aims!.length;
    setText(this.count, `${n} of ${STEALTH.multiMax} targets`);
    const why = n ? stealthAimsReason(s, me.id, m.airfield, m.aims!) : 'Click a target first';
    setDisabled(this.launch, why !== '');
    setTip(this.launch, why || `Send the stealth bomber at ${n} target${n === 1 ? '' : 's'}`);
  }
}
