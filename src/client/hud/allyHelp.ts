// "Allies that matter": for one ally, a short status line (will it help, is it busy) and two requests: ask it to
// attack a nation (a small picker of your enemies and neighbours) and ask it for troops. Shared by the nation card
// and the Diplomacy drawer.
import { borders } from '../../sim/combat';
import type { GameState, Player } from '../../sim/types';
import { allyRefusal } from '../../sim/allies';
import { allyAidAction, allyAttackAction, allyStatusOf, attackTargets, warsOf } from '../allies';
import { btn, el, setClass, setDisabled, setText, setTip, setVisible, type HudCtx } from './dom';
import { swatchCss } from './swatch';

export class AllyHelp {
  readonly el: HTMLElement;
  private status = el('div', 'ally-st');
  private statusT = el('span', 'ally-st-t');
  private pick = el('div', 'ally-pick hidden');
  private pickHead = el('div', 'ally-pick-h');
  private pickList = el('div', 'ally-pick-l');
  private pickKey = '';
  private askBtn: HTMLButtonElement;
  private aidBtn: HTMLButtonElement;
  private ally = 0;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'ally-help');
    this.el.dataset.test = 'ally-help';
    this.status.append(el('i', 'ally-dot'), this.statusT);
    this.askBtn = btn('Ask to attack…', 'mini', () => this.togglePick(), 'attack');
    this.askBtn.dataset.test = 'ally-ask-attack';
    const aid = btn('Ask for troops', 'mini', () => this.askAid(), 'troops');
    aid.dataset.test = 'ally-ask-aid';
    this.aidBtn = aid;
    const row = el('div', 'ally-btns');
    row.append(this.askBtn, aid);
    const cancel = btn('', 'mini ghost ally-pick-x', () => this.closePick(), 'close');
    cancel.setAttribute('aria-label', 'Cancel');
    const head = el('div', 'ally-pick-top');
    head.append(this.pickHead, cancel);
    this.pick.append(head, this.pickList);
    this.pick.dataset.test = 'ally-pick';
    this.el.append(this.status, row, this.pick);
  }

  /** ~5 Hz: the ally shown and what it is up to. */
  update(s: GameState, me: Player, ally: number): void {
    if (ally !== this.ally) {
      this.ally = ally;
      this.closePick();
    }
    const st = allyStatusOf(s, me.id, ally);
    setText(this.statusT, st.text);
    setClass(this.status, 'yes', st.willing === true);
    setClass(this.status, 'no', st.willing === false);
    // one request to your allies every so often (sim ALLY_REQUEST_COOLDOWN)
    const wait = st.askIn > 0 ? `You can ask again in ${st.askIn} s` : '';
    setDisabled(this.askBtn, !!wait);
    setDisabled(this.aidBtn, !!wait);
    setTip(this.askBtn, wait || 'Ask this ally to attack a nation: pick one from the list');
    setTip(this.aidBtn, wait || 'Ask this ally to send you troops');
    if (wait && this.picking) this.closePick();
    if (!this.pick.classList.contains('hidden')) this.fillPick(s, me);
  }

  get picking(): boolean {
    return !this.pick.classList.contains('hidden');
  }

  private togglePick(): void {
    if (this.picking) return this.closePick();
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    setVisible(this.pick, true);
    setClass(this.askBtn, 'on', true);
    this.pickKey = '';
    this.fillPick(s, me);
  }

  private closePick(): void {
    setVisible(this.pick, false);
    setClass(this.askBtn, 'on', false);
  }

  private fillPick(s: GameState, me: Player): void {
    const ally = this.ally;
    const targets = attackTargets(s, me.id, ally, (id) => borders(s, me.id, id));
    const wars = warsOf(s, me.id);
    // the ally's own refusal for each target (no border, too weak...): asking would only use up the cooldown
    const why = targets.map((id) => allyRefusal(s, ally, me.id, 'attack', id));
    const key = `${ally}|${targets.join(',')}|${[...wars].join(',')}|${why.join('/')}`;
    if (key === this.pickKey) return;
    this.pickKey = key;
    setText(this.pickHead, `Ask ${s.players[ally]?.name ?? 'them'} to attack:`);
    this.pickList.replaceChildren();
    if (!targets.length) {
      this.pickList.append(el('p', 'note', 'No enemies or neighbours to name. Right-click enemy land to ask your allies to attack there.'));
      return;
    }
    for (const [k, id] of targets.entries()) {
      const p = s.players[id];
      const b = el('button', 'pname ally-target');
      b.type = 'button';
      b.dataset.test = 'ally-target';
      const sw = el('i', 'sw');
      sw.style.background = swatchCss(p, me.id);
      b.append(sw, p.name);
      if (wars.has(id)) b.append(el('span', 'tag war', 'at war'));
      if (why[k]) {
        b.disabled = true;
        b.title = `Won't: ${why[k]}`;
        b.classList.add('no');
        b.append(el('span', 'ally-why', why[k]!.replace(/^it /, '')));
      } else b.addEventListener('click', () => this.askAttack(id));
      this.pickList.append(b);
    }
  }

  private askAttack(target: number): void {
    const s = this.ctx.state();
    const ally = this.ally;
    this.closePick();
    if (!s) return;
    if (this.ctx.act(allyAttackAction(ally, target))) {
      this.ctx.toast(`Asked ${s.players[ally]?.name ?? 'your ally'} to attack ${s.players[target]?.name ?? 'them'}`);
    }
  }

  private askAid(): void {
    const s = this.ctx.state();
    const ally = this.ally;
    if (!s) return;
    if (this.ctx.act(allyAidAction(ally))) this.ctx.toast(`Asked ${s.players[ally]?.name ?? 'your ally'} for troops`);
  }
}
