// Client side of peace deals and pacts: nation card buttons and reasons, the offer panel, the incoming offer text, the
// Treaties list time format, the radial entry, the border line partners and the help text. A small fake DOM, no browser.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { noteFight } from '../src/sim/rules';
import { activeTreaties, treatyOffersOf } from '../src/sim/treaty';
import type { GameState } from '../src/sim/types';
import type { HudCtx } from '../src/client/hud/dom';
import { NationCard } from '../src/client/hud/nationCard';
import { DiplomacyPage } from '../src/client/hud/drawers';
import { radialSpec } from '../src/client/hud/radialSpec';
import { breakPactText, offerSentence, termAmount, treatyKindWord, treatyTimeText, TreatyPanel } from '../src/client/hud/treatyUi';
import { treatyPartners } from '../src/client/render/treatyLines';
import { defaultUiState } from '../src/client/uiState';
import { claimRect, makeFlatGame } from './helpers';

const T = TICKS_PER_SECOND;

// ------------------------------------------------------------------------------------------------ a small fake DOM

class FakeEl {
  className = '';
  textContent = '';
  innerHTML = '';
  type = '';
  disabled = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> & { setProperty: (k: string, v: string) => void } = Object.assign(Object.create(null), {
    setProperty(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
  });
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  handlers = new Map<string, ((e: unknown) => void)[]>();
  classList = {
    contains: (c: string) => this.className.split(' ').includes(c),
    add: (c: string) => void (this.classList.contains(c) || (this.className = `${this.className} ${c}`.trim())),
    remove: (c: string) => void (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
  };
  constructor(public tag: string) {}
  append(...k: (FakeEl | string)[]) {
    for (const c of k) {
      if (typeof c === 'string') continue;
      c.parent?.children.splice(c.parent.children.indexOf(c), 1);
      c.parent = this;
      this.children.push(c);
    }
  }
  prepend(...k: FakeEl[]) {
    for (const c of k) {
      c.parent = this;
      this.children.unshift(c);
    }
  }
  replaceChildren(...k: FakeEl[]) {
    this.children = [];
    this.append(...k);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(t: string, h: (e: unknown) => void) {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), h]);
  }
  click() {
    for (const h of this.handlers.get('click') ?? []) h({ stopPropagation() {}, preventDefault() {} });
  }
  querySelector(sel: string): FakeEl | null {
    const cls = sel.replace(/^\./, '');
    for (const c of this.children) {
      if (c.classList.contains(cls)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  get childElementCount() {
    return this.children.length;
  }
  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  /** every text in this subtree */
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].join(' ');
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) return this;
    for (const c of this.children) {
      const f = c.find(pred);
      if (f) return f;
    }
    return null;
  }
}
function installDom(): void {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag), activeElement: null });
}

afterEach(() => vi.unstubAllGlobals());

/** 40 x 20 plains, three nations late in the game: 1 | 2 | 3 side by side (you are 1). */
function world(): GameState {
  const s = makeFlatGame(40, 20, 3, { human: true });
  claimRect(s, 1, 0, 0, 12, 19);
  claimRect(s, 2, 13, 0, 25, 19);
  claimRect(s, 3, 26, 0, 39, 19);
  s.players[2].name = 'Red';
  s.players[3].name = 'Blue';
  s.humanId = 1;
  s.tick = 10 * 60 * T;
  s.playStartTick = 0;
  for (const p of s.players) if (p.id > 0) p.gold = 10000;
  return s;
}
function makeCtx(s: GameState, acts: unknown[] = [], toasts: string[] = []): HudCtx {
  const ctx = {
    probe: () => null,
    ui: defaultUiState(),
    dispatch: (a: Parameters<HudCtx['dispatch']>[0]) => applyAction(s, 1, a),
    camera: {},
    state: () => s,
    me: () => s.players[1],
    act: (a: Parameters<HudCtx['act']>[0]) => {
      acts.push(a);
      return applyAction(s, 1, a).ok;
    },
    refreshSoon: () => {},
    openDrawer: () => {},
    closeDrawer: () => {},
    openNation: () => {},
    openTreaty: () => {},
    focusTile: () => {},
    toast: (t: string) => toasts.push(t),
    confirm: () => {},
    sound: () => {},
  };
  return ctx as unknown as HudCtx;
}
const byTest = (root: unknown, id: string): FakeEl | null => (root as FakeEl).find((e) => e.dataset.test === id);
const visible = (e: FakeEl | null): boolean => !!e && !e.classList.contains('hidden');

describe('nation card: Peace and Pact buttons', () => {
  it('shows Pact when not fighting, with a plain reason when it cannot be used', () => {
    installDom();
    const s = world();
    const card = new NationCard(makeCtx(s));
    card.open(2);
    card.update(s, s.players[1]);
    const pact = byTest(card.el, 'nc-pact')!;
    expect(visible(pact.parent)).toBe(true);
    expect(visible(byTest(card.el, 'nc-peace')!.parent)).toBe(false);
    expect(pact.disabled).toBe(false);
    expect(pact.text()).toContain('Pact');
    // a pact offer is sent: the button goes off and says why, in visible text
    expect(applyAction(s, 1, { type: 'offerPact', to: 2, seconds: 180 }).ok).toBe(true);
    card.update(s, s.players[1]);
    expect(pact.disabled).toBe(true);
    const why = byTest(card.el, 'nc-pact-why')!;
    expect(visible(why)).toBe(true);
    expect(why.textContent).toBe('Offer already sent');
  });

  it('shows Peace while fighting and a reason about timing when it is not allowed', () => {
    installDom();
    const s = world();
    noteFight(s, 1, 2);
    const card = new NationCard(makeCtx(s));
    card.open(2);
    card.update(s, s.players[1]);
    const peace = byTest(card.el, 'nc-peace')!;
    expect(visible(peace.parent)).toBe(true);
    expect(visible(byTest(card.el, 'nc-pact')!.parent)).toBe(false);
    expect(peace.disabled).toBe(false);
    expect(peace.text()).toContain('Peace');
    // refused: wait before asking again
    expect(applyAction(s, 1, { type: 'offerPeace', to: 2, theyGive: 'none', youGive: 'none' }).ok).toBe(true);
    expect(applyAction(s, 2, { type: 'answerTreaty', from: 1, accept: false }).ok).toBe(true);
    card.update(s, s.players[1]);
    expect(peace.disabled).toBe(true);
    expect(byTest(card.el, 'nc-peace-why')!.textContent).toMatch(/^Wait \d+ s after a refusal$/);
  });

  it('shows neither button for tribes or yourself, and keeps the older selectors', () => {
    installDom();
    const s = world();
    const card = new NationCard(makeCtx(s));
    card.open(2);
    card.update(s, s.players[1]);
    for (const id of ['nc-ally', 'nc-attack', 'nc-gift', 'nc-accept', 'nation-card']) expect(byTest(card.el, id), id).not.toBeNull();
    // yourself: no treaty buttons
    card.open(1);
    card.update(s, s.players[1]);
    expect(visible(byTest(card.el, 'nc-pact')!.parent)).toBe(false);
    expect(visible(byTest(card.el, 'nc-peace')!.parent)).toBe(false);
  });
});

describe('offer panel', () => {
  it('shows real amounts next to each term and sends offerPeace with the chosen terms', () => {
    installDom();
    const s = world();
    noteFight(s, 1, 2);
    const acts: unknown[] = [];
    const toasts: string[] = [];
    const panel = new TreatyPanel(makeCtx(s, acts, toasts));
    panel.open('peace', 2);
    panel.update(s, s.players[1]);
    // 10% of 10000 gold, paid by them (row they) or by you (row you)
    expect(byTest(panel.el, 'tp-they-goldSmall')!.text()).toContain('1,000 gold');
    expect(byTest(panel.el, 'tp-you-goldLarge')!.text()).toContain('3,000 gold');
    expect(byTest(panel.el, 'tp-they-landSmall')!.text()).toMatch(/\d+ tiles?/);
    expect(termAmount(s, 2, 1, 'none')).toBe('nothing');
    byTest(panel.el, 'tp-they-landLarge')!.click();
    byTest(panel.el, 'tp-you-goldSmall')!.click();
    expect(byTest(panel.el, 'tp-they-landLarge')!.attrs['aria-checked']).toBe('true');
    byTest(panel.el, 'treaty-send')!.click();
    expect(acts).toEqual([{ type: 'offerPeace', to: 2, theyGive: 'landLarge', youGive: 'goldSmall' }]);
    expect(panel.isOpen).toBe(false);
    expect(treatyOffersOf(s, 2).length).toBe(1);
  });

  it('sends offerPact with the chosen length and says why when sending is not possible', () => {
    installDom();
    const s = world();
    const acts: unknown[] = [];
    const panel = new TreatyPanel(makeCtx(s, acts));
    panel.open('pact', 2);
    panel.update(s, s.players[1]);
    byTest(panel.el, 'tp-pact-360')!.click();
    byTest(panel.el, 'treaty-send')!.click();
    expect(acts).toEqual([{ type: 'offerPact', to: 2, seconds: 360 }]);
    // an offer is waiting: the panel opened again shows the reason and the button is off
    panel.open('pact', 2);
    panel.update(s, s.players[1]);
    expect(byTest(panel.el, 'treaty-send')!.disabled).toBe(true);
    expect((panel.el as unknown as FakeEl).text()).toContain('Offer already sent');
  });
});

describe('incoming offers and the Treaties list', () => {
  it('words an incoming peace offer in plain words and a pact with its length', () => {
    const s = world();
    noteFight(s, 2, 1);
    expect(applyAction(s, 2, { type: 'offerPeace', to: 1, theyGive: 'none', youGive: 'goldSmall' }).ok).toBe(true);
    const o = treatyOffersOf(s, 1)[0];
    expect(offerSentence(s, o)).toBe('Red asks for peace for 3 min and gives you 1,000 gold');
    const s2 = world();
    expect(applyAction(s2, 2, { type: 'offerPact', to: 1, seconds: 360 }).ok).toBe(true);
    expect(offerSentence(s2, treatyOffersOf(s2, 1)[0])).toBe('Red offers a 6 min pact: no attacks either way');
  });

  it('answering dispatches answerTreaty and signs the treaty', () => {
    const s = world();
    expect(applyAction(s, 2, { type: 'offerPact', to: 1, seconds: 180 }).ok).toBe(true);
    const acts: unknown[] = [];
    const ctx = makeCtx(s, acts);
    // the toast and drawer buttons run exactly this
    ctx.act({ type: 'answerTreaty', from: 2, accept: true });
    expect(acts).toEqual([{ type: 'answerTreaty', from: 2, accept: true }]);
    expect(activeTreaties(s, 1).map((t) => t.kind)).toEqual(['pact']);
  });

  it('formats time left as minutes and seconds, and "Ending in" while a pact is being broken', () => {
    expect(treatyTimeText({ secondsLeft: 134, breaking: false })).toBe('2 min 14 s left');
    expect(treatyTimeText({ secondsLeft: 180, breaking: false })).toBe('3 min left');
    expect(treatyTimeText({ secondsLeft: 12, breaking: true })).toBe('Ending in 12 s');
    expect(treatyKindWord('pact')).toBe('Pact');
    expect(treatyKindWord('peace')).toBe('Peace deal');
    expect(breakPactText('Red')).toMatch(/They and everyone else will trust you less, and bots see you as a pact breaker for 2 min/);
  });

  it('lists your treaty partners for the map line, with the break state', () => {
    const s = world();
    expect(applyAction(s, 1, { type: 'offerPact', to: 2, seconds: 180 }).ok).toBe(true);
    expect(applyAction(s, 2, { type: 'answerTreaty', from: 1, accept: true }).ok).toBe(true);
    expect(treatyPartners(s, 1)).toEqual([{ other: 2, breaking: false }]);
    expect(applyAction(s, 1, { type: 'breakPact', with: 2 }).ok).toBe(true);
    expect(treatyPartners(s, 1)).toEqual([{ other: 2, breaking: true }]);
    expect(treatyPartners(s, 3)).toEqual([]);
  });
});

describe('radial menu', () => {
  it('offers Pact when not fighting and Peace while fighting', () => {
    const s = world();
    const ctx = makeCtx(s);
    const find = (label: string) => radialSpec(ctx, s, s.players[1], 5 * 40 + 20)?.slices.find((x) => x.label === label);
    const spec = radialSpec(ctx, s, s.players[1], 5 * 40 + 20);
    expect(spec?.slices.some((x) => x.label === 'Pact')).toBe(true);
    expect(find('Peace')).toBeUndefined();
    noteFight(s, 1, 2);
    expect(find('Peace')?.icon).toBe('peace');
    expect(find('Pact')).toBeUndefined();
  });
});

describe('Diplomacy drawer', () => {
  it('lists incoming offers with Accept and Decline, and treaties with time left and a Break button on pacts only', () => {
    installDom();
    const s = world();
    const acts: unknown[] = [];
    const page = new DiplomacyPage(makeCtx(s, acts));
    expect(applyAction(s, 2, { type: 'offerPact', to: 1, seconds: 180 }).ok).toBe(true);
    page.update(s, s.players[1]);
    const root = page.root as unknown as FakeEl;
    expect(root.text()).toContain('Asking you');
    byTest(root, 'treaty-decline')!.click();
    expect(acts).toEqual([{ type: 'answerTreaty', from: 2, accept: false }]);
    // a signed pact with Blue, then a peace deal with Red
    expect(applyAction(s, 3, { type: 'offerPact', to: 1, seconds: 180 }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'answerTreaty', from: 3, accept: true }).ok).toBe(true);
    page.update(s, s.players[1]);
    expect(root.text()).toContain('Treaties');
    expect(root.text()).toContain('Pact, 3 min left');
    expect(byTest(root, 'treaty-break')).not.toBeNull();
    s.tick += 10 * T;
    page.update(s, s.players[1]);
    expect(root.text()).toContain('Pact, 2 min 50 s left');
  });
});
