// Diplomacy UI for peace deals and pacts: the offer panel (under the nation card), the plain-word texts shared by the
// toasts, the Diplomacy drawer and the radial menu. The rules live in sim/treaty.ts; this only asks and shows.
import { PACT_BREAKER_DURATION, PACT_LENGTHS, PEACE_DURATION } from '../../sim/config';
import { fightingRecently, canOfferPact, canOfferPeace, previewTerms, type OfferInfo, type TreatyInfo } from '../../sim/treaty';
import { alliancesAllowed, formatSeconds, isTeamGame, treatyBetween } from '../../sim/rules';
import { areAllied } from '../../sim/diplomacy';
import { isTribe, TREATY_TERMS } from '../../sim/types';
import type { GameState, Player, TreatyKind, TreatyTerm } from '../../sim/types';
import { el, setClass, setDisabled, setText, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';

const TERM_LABEL: Record<TreatyTerm, string> = {
  none: 'None',
  goldSmall: 'Gold small',
  goldLarge: 'Gold large',
  landSmall: 'Land small',
  landLarge: 'Land large',
};

const num = (n: number): string => Math.round(n).toLocaleString('en-US');

/** What `term` would make `payer` hand `receiver` now, in words with units: "1,240 gold", "86 tiles, 1 building", "nothing". */
export function termAmount(s: GameState, payer: number, receiver: number, term: TreatyTerm): string {
  if (term === 'none') return 'nothing';
  const p = previewTerms(s, payer, receiver, term);
  if (term === 'goldSmall' || term === 'goldLarge') return `${num(p.gold ?? 0)} gold`;
  const t = p.tiles ?? 0;
  const b = p.buildings ?? 0;
  return `${num(t)} ${t === 1 ? 'tile' : 'tiles'}${b ? `, ${b} building${b === 1 ? '' : 's'}` : ''}`;
}

/** "Peace deal" or "Pact". */
export function treatyKindWord(kind: TreatyKind): string {
  return kind === 'pact' ? 'Pact' : 'Peace deal';
}
export function treatyIcon(kind: TreatyKind): string {
  return kind === 'pact' ? 'pact' : 'peace';
}
/** Time line of an active treaty: "2 min 14 s left", or "Ending in 12 s" while a broken pact runs out. */
export function treatyTimeText(t: Pick<TreatyInfo, 'secondsLeft' | 'breaking'>): string {
  return t.breaking ? `Ending in ${formatSeconds(t.secondsLeft)}` : `${formatSeconds(t.secondsLeft)} left`;
}
/** Seconds left to answer an offer: "24 s". */
export function offerLeftText(o: Pick<OfferInfo, 'secondsLeft'>): string {
  return formatSeconds(o.secondsLeft);
}

/** An offer made to you, in plain words ("Red asks for peace and gives you 86 tiles"). */
export function offerSentence(s: GameState, o: OfferInfo): string {
  const from = s.players[o.from]?.name ?? 'Someone';
  if (o.kind === 'pact') {
    const renew = treatyBetween(s, o.from, o.to)?.kind === 'pact';
    return renew ? `${from} asks to renew your pact for ${formatSeconds(o.seconds)}` : `${from} offers a ${formatSeconds(o.seconds)} pact: no attacks either way`;
  }
  const gives = o.youGive !== 'none' ? `gives you ${termAmount(s, o.from, o.to, o.youGive)}` : '';
  const wants = o.theyGive !== 'none' ? `wants ${termAmount(s, o.to, o.from, o.theyGive)} from you` : '';
  const terms = [gives, wants].filter(Boolean).join(' and ');
  return `${from} asks for peace for ${formatSeconds(PEACE_DURATION)}${terms ? ` and ${terms}` : ''}`;
}
/**
 * A treaty event in the local player's words: "Red refused your peace offer", "You and Red made peace for 5 min",
 * "Your pact with Red has ended". Someone else's treaty keeps third-person words ("Red refused Atlas's peace offer").
 */
export function treatyEventText(s: GameState, me: number, e: { kind: string; message: string; players: number[] }): string {
  const name = (id: number): string => s.players[id]?.name ?? 'Someone';
  const other = e.players.find((id) => id > 0 && id !== me) ?? 0;
  const on = name(other);
  const mine = e.players.includes(me);
  const what = /pact/.test(e.message) ? 'pact offer' : 'peace offer';
  const poss = (id: number): string => (id === me ? 'your' : `${name(id)}'s`);
  const who = (id: number): string => (id === me ? 'You' : name(id));
  if (e.kind === 'treatyRefused') {
    const [from, by] = e.players;
    return `${who(by)} refused ${poss(from)} ${what}`;
  }
  if (e.kind === 'treatyOfferExpired') {
    const [from, to] = e.players;
    return `${who(to)} did not answer ${poss(from)} ${what}`;
  }
  if (!mine) return e.message;
  if (e.kind === 'treatyAccepted') {
    const m = e.message;
    const i = m.search(/ (signed|made|renewed) /);
    return i < 0 ? m : `You and ${on}${m.slice(i).replace('renewed their pact', 'renewed your pact')}`;
  }
  if (e.kind === 'treatyEnded' || e.kind === 'pactBroken') {
    const breaker = /: (.+) broke it$/.exec(e.message)?.[1];
    if (breaker) return `Your pact with ${on} is over: ${breaker === name(me) ? 'you' : breaker} broke it`;
    return /peace/.test(e.message) ? `Your peace with ${on} is over` : `Your pact with ${on} has ended`;
  }
  return e.message;
}

/** An offer you made, while it waits. */
export function sentOfferSentence(s: GameState, o: OfferInfo): string {
  return o.kind === 'pact' ? `${formatSeconds(o.seconds)} pact offered` : `Peace offered for ${formatSeconds(PEACE_DURATION)}`;
}

/** What breaking a pact costs, in plain words (the confirm text). */
export function breakPactText(name: string): string {
  return `Break the pact with ${name}? They and everyone else will trust you less, and bots see you as a pact breaker for ${formatSeconds(PACT_BREAKER_DURATION)}.`;
}
export function confirmBreakPact(ctx: HudCtx, name: string, id: number): void {
  ctx.confirm(breakPactText(name), 'Break pact', () => ctx.act({ type: 'breakPact', with: id }));
}

/** Whether the treaty buttons show for this nation at all (not you, tribes, allies, no-diplomacy and team games). */
export function treatyAvailable(s: GameState, me: Player, p: Player): boolean {
  return p.id !== me.id && !isTribe(p) && alliancesAllowed(s) && !isTeamGame(s) && !areAllied(s, me.id, p.id);
}
/** Which of the two buttons applies: peace while fighting (or while a peace offer is possible), a pact otherwise. */
export function treatyKindFor(s: GameState, me: number, other: number): TreatyKind {
  return canOfferPeace(s, me, other).ok || fightingRecently(s, me, other) ? 'peace' : 'pact';
}

export class TreatyPanel {
  readonly el: HTMLElement;
  private kind: TreatyKind | null = null;
  private other = 0;
  private theyGive: TreatyTerm = 'none';
  private youGive: TreatyTerm = 'none';
  private seconds: number = PACT_LENGTHS[0];
  private title = el('div', 'tp-title');
  private titleIc = el('span', 'tp-ic');
  private titleT = el('span');
  private peaceBox = el('div', 'tp-box');
  private pactBox = el('div', 'tp-box');
  private why = el('p', 'tp-why');
  private send: HTMLButtonElement;
  private opts = new Map<string, { b: HTMLButtonElement; amt: HTMLElement }>();
  private pactOpts = new Map<number, HTMLButtonElement>();
  private shownKind: TreatyKind | null = null;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'tp hidden');
    this.el.dataset.test = 'treaty-panel';
    this.title.append(this.titleIc, this.titleT);
    for (const [row, label] of [['they', 'They give'], ['you', 'You give']] as const) {
      const r = el('div', 'tp-row');
      r.append(el('span', 'tp-k', label));
      const seg = el('div', 'tp-seg');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', label);
      for (const term of TREATY_TERMS) {
        const b = el('button', 'tp-opt');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.test = `tp-${row}-${term}`;
        const amt = el('span', 'tp-amt', term === 'none' ? 'nothing' : '');
        b.append(el('span', 'tp-name', TERM_LABEL[term]), amt);
        b.addEventListener('click', () => {
          if (row === 'they') this.theyGive = term;
          else this.youGive = term;
          this.ctx.refreshSoon();
          this.sync();
        });
        seg.append(b);
        this.opts.set(`${row}:${term}`, { b, amt });
      }
      r.append(seg);
      this.peaceBox.append(r);
    }
    const pr = el('div', 'tp-row');
    pr.append(el('span', 'tp-k', 'Length'));
    const pseg = el('div', 'tp-seg tp-seg-pact');
    pseg.setAttribute('role', 'radiogroup');
    pseg.setAttribute('aria-label', 'Pact length');
    for (const sec of PACT_LENGTHS) {
      const b = el('button', 'tp-opt');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.test = `tp-pact-${sec}`;
      b.append(el('span', 'tp-name', `${Math.round(sec / 60)} min`));
      b.addEventListener('click', () => {
        this.seconds = sec;
        this.sync();
      });
      pseg.append(b);
      this.pactOpts.set(sec, b);
    }
    pr.append(pseg);
    this.pactBox.append(pr, el('p', 'tp-note', 'Neither side can attack the other while the pact lasts. Breaking it early costs trust.'));
    this.peaceBox.append(el('p', 'tp-note', `Peace lasts ${formatSeconds(PEACE_DURATION)} and cannot be broken. Terms are paid when they accept.`));
    const send = el('button', 'wr-btn primary tp-send');
    send.type = 'button';
    send.dataset.test = 'treaty-send';
    send.append(iconSpan(lineIcon('accept', 16)), el('span', 'wr-btn-l', 'Send offer'));
    send.addEventListener('click', () => this.submit());
    this.send = send;
    const cancel = el('button', 'wr-btn tp-cancel');
    cancel.type = 'button';
    cancel.dataset.test = 'treaty-cancel';
    cancel.append(iconSpan(lineIcon('close', 16)), el('span', 'wr-btn-l', 'Cancel'));
    cancel.addEventListener('click', () => this.close());
    const acts = el('div', 'tp-acts');
    acts.append(send, cancel);
    this.el.append(this.title, this.peaceBox, this.pactBox, this.why, acts);
  }

  get isOpen(): boolean {
    return this.kind !== null;
  }
  get current(): { kind: TreatyKind; other: number } | null {
    return this.kind ? { kind: this.kind, other: this.other } : null;
  }

  open(kind: TreatyKind, other: number): void {
    if (this.kind !== kind || this.other !== other) {
      this.theyGive = 'none';
      this.youGive = 'none';
      this.seconds = PACT_LENGTHS[0];
    }
    this.kind = kind;
    this.other = other;
    setVisible(this.el, true);
    this.ctx.refreshSoon();
    this.sync();
  }
  close(): void {
    this.kind = null;
    this.other = 0;
    setVisible(this.el, false);
  }

  private submit(): void {
    const kind = this.kind;
    if (!kind || !this.other) return;
    const ok = this.ctx.act(
      kind === 'peace' ? { type: 'offerPeace', to: this.other, theyGive: this.theyGive, youGive: this.youGive } : { type: 'offerPact', to: this.other, seconds: this.seconds },
    );
    if (ok) this.close();
  }

  private sync(): void {
    for (const [key, o] of this.opts) {
      const on = key === `they:${this.theyGive}` || key === `you:${this.youGive}`;
      o.b.setAttribute('aria-checked', String(on));
      setClass(o.b, 'on', on);
    }
    for (const [sec, b] of this.pactOpts) {
      b.setAttribute('aria-checked', String(sec === this.seconds));
      setClass(b, 'on', sec === this.seconds);
    }
  }

  update(s: GameState, me: Player): void {
    const kind = this.kind;
    if (!kind) return;
    const p = s.players[this.other];
    if (!p || !p.alive) {
      this.close();
      return;
    }
    if (this.shownKind !== kind) {
      this.shownKind = kind;
      this.titleIc.replaceChildren(iconSpan(lineIcon(treatyIcon(kind), 16)));
      setVisible(this.peaceBox, kind === 'peace');
      setVisible(this.pactBox, kind === 'pact');
      this.sync();
    }
    setText(this.titleT, kind === 'peace' ? `Peace offer to ${p.name}` : `Pact offer to ${p.name}`);
    if (kind === 'peace') {
      for (const term of TREATY_TERMS) {
        if (term === 'none') continue;
        const theirs = this.opts.get(`they:${term}`);
        const mine = this.opts.get(`you:${term}`);
        if (theirs) setText(theirs.amt, termAmount(s, p.id, me.id, term));
        if (mine) setText(mine.amt, termAmount(s, me.id, p.id, term));
      }
    }
    const chk = kind === 'peace' ? canOfferPeace(s, me.id, p.id) : canOfferPact(s, me.id, p.id);
    setDisabled(this.send, !chk.ok);
    setText(this.why, chk.ok ? '' : chk.reason);
    setVisible(this.why, !chk.ok);
  }
}
