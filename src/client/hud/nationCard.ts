// Nation card (left edge under the standings): who they are, their army and land, your relation, and the
// diplomacy buttons (Ally / Accept / Break, Gift, Embargo, Attack). Opened from the standings or the radial menu.
import { alliancesAllowed, sameTeam } from '../../sim/rules';
import { hasIntel } from '../../sim/buildings';
import { borders } from '../../sim/combat';
import { areAllied } from '../../sim/diplomacy';
import { DOCTRINES, TRAITOR_DURATION } from '../../sim/config';
import { doctrineIcon, knownDoctrine } from '../doctrineView';
import type { GameState, Player } from '../../sim/types';
import { isTribe } from '../compat';
import { troopsToSend, troopSum } from '../input';
import { swatchCss } from './swatch';
import { formatCount } from '../render/common';
import { armyOf } from '../simx';
import { btn, el, setClass, setDisabled, setText, setTip, setVisible, type HudCtx } from './dom';
import { relationOf, TROOP_COLORS } from './drawers';
import { iconSpan, lineIcon } from './glyph';
import { AllyHelp } from './allyHelp';

export const GIFT_GOLD = 200;

export class NationCard {
  readonly el: HTMLElement;
  id = 0;
  private name = el('span', 'nc-name');
  private rel = el('span', 'nc-rel');
  /** their doctrine when you know it (they border you, a Watchtower sees them, or an alliance) */
  private doc = el('span', 'nc-doc hidden');
  private docIc = el('span', 'nc-doc-ic');
  private docT = el('span', 'nc-doc-t');
  private docShown = '';
  private army = el('span', 'nc-v');
  private land = el('span', 'nc-v');
  private mix = el('div', 'mixbar');
  private mixNote = el('span', 'nc-note');
  private parts: HTMLElement[] = [];
  private ally: HTMLButtonElement;
  private accept: HTMLButtonElement;
  private decline: HTMLButtonElement;
  private brk: HTMLButtonElement;
  private gift: HTMLButtonElement;
  private embargo: HTMLButtonElement;
  private attack: HTMLButtonElement;
  /** allies: what they are up to, ask them to attack or for troops */
  private allyHelp: AllyHelp;

  constructor(private ctx: HudCtx) {
    this.el = el('section', 'ncard hidden');
    this.el.dataset.test = 'nation-card';
    const head = el('header', 'nc-head');
    const close = el('button', 'sq small');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.append(iconSpan(lineIcon('close', 14)));
    close.addEventListener('click', () => this.close());
    const titles = el('div', 'nc-titles');
    const sub = el('div', 'nc-sub');
    this.doc.dataset.test = 'nc-doctrine';
    this.doc.append(this.docIc, this.docT);
    sub.append(this.rel, this.doc);
    titles.append(this.name, sub);
    head.append(titles, close);
    const stats = el('div', 'nc-stats');
    const a = el('div', 'nc-stat');
    a.append(el('span', 'nc-k', 'Army'), this.army);
    const l = el('div', 'nc-stat');
    l.append(el('span', 'nc-k', 'Land'), this.land);
    stats.append(a, l);
    for (const k of ['infantry', 'armor', 'artillery'] as const) {
      const p = el('span');
      p.style.background = TROOP_COLORS[k];
      this.mix.append(p);
      this.parts.push(p);
    }
    const acts = el('div', 'nc-acts');
    const act = (a: Parameters<HudCtx['act']>[0]) => this.ctx.act(a);
    this.ally = btn('Ally', '', () => act({ type: 'requestAlliance', to: this.id }), 'ally');
    this.accept = btn('Accept', 'primary', () => act({ type: 'answerAlliance', from: this.id, accept: true }), 'accept');
    this.decline = btn('Decline', '', () => act({ type: 'answerAlliance', from: this.id, accept: false }), 'decline');
    this.brk = btn('Break', 'danger', () => confirmBreak(this.ctx, this.ctx.state()?.players[this.id]?.name ?? 'them', this.id), 'breakAlly');
    this.brk.dataset.tip = 'Break the alliance: you become a traitor for a while (weaker defence, everyone trusts you less)';
    this.gift = btn(`Gift ${GIFT_GOLD}`, '', () => act({ type: 'gift', to: this.id, gold: GIFT_GOLD, troops: 0 }), 'gift');
    this.gift.dataset.tip = `Give ${GIFT_GOLD} gold: they like you more`;
    this.embargo = btn('Embargo', '', () => act({ type: 'toggleEmbargo', with: this.id }), 'embargo');
    this.attack = btn('Attack', 'danger', () => this.doAttack(), 'attack');
    this.attack.dataset.test = 'nc-attack';
    this.ally.dataset.test = 'nc-ally';
    this.accept.dataset.test = 'nc-accept';
    this.gift.dataset.test = 'nc-gift';
    acts.append(this.accept, this.decline, this.ally, this.brk, this.attack, this.gift, this.embargo);
    this.allyHelp = new AllyHelp(ctx);
    this.el.append(head, stats, this.mix, this.mixNote, this.allyHelp.el, acts);
  }

  open(id: number): void {
    this.id = id;
    setVisible(this.el, true);
    this.ctx.refreshSoon();
  }
  close(): void {
    this.id = 0;
    setVisible(this.el, false);
  }
  get isOpen(): boolean {
    return this.id > 0;
  }

  private doAttack(): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    const p = s?.players[this.id];
    if (!s || !me || !p || p.capital < 0) return;
    this.ctx.act({ type: 'attack', tile: p.capital, troops: troopsToSend(me, this.ctx.ui) });
  }

  update(s: GameState, me: Player): void {
    if (!this.id) return;
    const p = s.players[this.id];
    if (!p || !p.alive) {
      this.close();
      return;
    }
    const isMe = p.id === me.id;
    this.el.style.setProperty('--c', swatchCss(p, me.id));
    setText(this.name, p.name);
    const rel = relationOf(s, me, p.id);
    setText(this.rel, rel.text);
    this.rel.className = 'nc-rel ' + rel.cls;
    const kd = isMe ? null : knownDoctrine(s, me.id, p.id);
    setVisible(this.doc, !!kd);
    if (kd) {
      const key = `${kd.id}:${kd.level}:${kd.adapting}`;
      if (key !== this.docShown) {
        this.docShown = key;
        const d = DOCTRINES[kd.id];
        this.doc.style.setProperty('--dc', d.color);
        this.docIc.replaceChildren(iconSpan(lineIcon(doctrineIcon(kd.id), 13)));
        setText(this.docT, kd.adapting ? `${d.name}, adapting` : `${d.name} L${kd.level}`);
        // what applies now: level 2 replaces level 1's numbers, level 3 adds its perk
        const now = kd.adapting ? ['Adapting after a switch: no bonus yet.'] : [d.levels[kd.level >= 2 ? 1 : 0], ...(kd.level >= 3 ? [d.levels[2]] : [])];
        setTip(this.doc, [`Doctrine: ${d.name}${kd.adapting ? '' : `, level ${kd.level}`}`, d.short, ...now].join('\n'));
      }
    }
    setText(this.army, formatCount(armyOf(s, p.id)));
    setText(this.land, `${((p.tiles / Math.max(1, s.map.landTileCount)) * 100).toFixed(1)}%`);
    const intel = isMe || hasIntel(s, me.id, p.id);
    setVisible(this.mix, intel);
    if (intel) {
      const t = p.troops;
      const sum = t.infantry + t.armor + t.artillery || 1;
      this.parts[0].style.width = `${(t.infantry / sum) * 100}%`;
      this.parts[1].style.width = `${(t.armor / sum) * 100}%`;
      this.parts[2].style.width = `${(t.artillery / sum) * 100}%`;
      setText(this.mixNote, `Infantry ${formatCount(t.infantry)}, armor ${formatCount(t.armor)}, artillery ${formatCount(t.artillery)}`);
    } else setText(this.mixNote, 'Troop mix unknown: build a Watchtower near them or ally with them.');
    const allied = areAllied(s, me.id, p.id);
    setVisible(this.allyHelp.el, !isMe && allied);
    if (!isMe && allied) this.allyHelp.update(s, me, p.id);
    const inReq = s.allianceRequests.some((r) => r.from === p.id && r.to === me.id);
    const outReq = s.allianceRequests.some((r) => r.from === me.id && r.to === p.id);
    setVisible(this.accept, !isMe && inReq);
    setVisible(this.decline, !isMe && inReq);
    const teammate = sameTeam(s, me.id, p.id);
    const noAlliances = !alliancesAllowed(s);
    setVisible(this.ally, !isMe && !allied && !inReq);
    setDisabled(this.ally, outReq || noAlliances);
    setTip(this.ally, noAlliances ? 'Alliances are off in this game' : outReq ? 'Request sent: waiting for their answer' : isTribe(p) ? 'Tribes accept every alliance' : 'Ask for an alliance');
    const allyLbl = this.ally.querySelector('.wr-btn-l');
    if (allyLbl) setText(allyLbl as HTMLElement, outReq ? 'Requested…' : 'Ally');
    setVisible(this.brk, !isMe && allied && !teammate);
    setVisible(this.gift, !isMe);
    setDisabled(this.gift, me.gold < GIFT_GOLD);
    setVisible(this.embargo, !isMe && !isTribe(p));
    const emb = me.embargoes.includes(p.id);
    setClass(this.embargo, 'on', emb);
    const lbl = this.embargo.querySelector('.wr-btn-l');
    if (lbl) setText(lbl as HTMLElement, emb ? 'Lift embargo' : 'Embargo');
    setTip(this.embargo, emb ? 'Allow trade ships with them again' : 'Stop trade ships between you');
    setVisible(this.attack, !isMe && !allied);
    const send = troopSum(troopsToSend(me, this.ctx.ui));
    const near = borders(s, me.id, p.id);
    setTip(this.attack, `Send ${formatCount(send)} troops (${Math.round(this.ctx.ui.attackShare * 100)}%) ${near ? 'across your shared border' : 'by sea: you share no border'}`);
  }
}

/** Breaking an alliance makes you a traitor: ask first (shared by the radial menu and the nation card). */
export function confirmBreak(ctx: HudCtx, name: string, id: number): void {
  ctx.confirm(
    `Break the alliance with ${name}? You become a traitor for ${TRAITOR_DURATION} s: weaker defence, and everyone trusts you less.`,
    'Break',
    () => ctx.act({ type: 'breakAlliance', with: id }),
  );
}
