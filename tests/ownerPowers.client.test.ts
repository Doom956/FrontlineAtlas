// What players see of announcements, notices and effects (src/client/broadcast.ts) and the console's announcement
// form (src/client/adminOnline.ts): server text only ever lands in textContent, cleaned and cut to the limits; markup
// stays plain text; unknown styles and effects are dropped; tile effects only count on their own room's map.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROADCAST_TEXT_MAX } from '../src/net/protocol';
import { BroadcastLayer, NOTICE_TITLE, announcementView } from '../src/client/broadcast';
import { announceMessage } from '../src/client/adminOnline';

/** Just enough DOM for the layer; innerHTML / insertAdjacentHTML / outerHTML throw so any use of them fails the test. */
function fakeDom() {
  class FakeEl {
    className = '';
    textContent = '';
    type = '';
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    style: Record<string, string> = {};
    children: FakeEl[] = [];
    parent: FakeEl | null = null;
    handlers = new Map<string, (() => void)[]>();
    classList = {
      contains: (c: string) => this.className.split(' ').includes(c),
      add: (...cs: string[]) => {
        for (const c of cs) if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
      },
      remove: (...cs: string[]) => {
        this.className = this.className.split(' ').filter((x) => x && !cs.includes(x)).join(' ');
      },
      toggle: (c: string, on?: boolean) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
    };
    constructor(public tag: string) {}
    set innerHTML(_v: string) {
      throw new Error('innerHTML must not be used');
    }
    set outerHTML(_v: string) {
      throw new Error('outerHTML must not be used');
    }
    insertAdjacentHTML(): void {
      throw new Error('insertAdjacentHTML must not be used');
    }
    append(...k: FakeEl[]) {
      for (const c of k) c.parent = this;
      this.children.push(...k);
    }
    prepend(...k: FakeEl[]) {
      for (const c of k) c.parent = this;
      this.children.unshift(...k);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    addEventListener(t: string, h: () => void) {
      this.handlers.set(t, [...(this.handlers.get(t) ?? []), h]);
    }
    click() {
      for (const h of this.handlers.get('click') ?? []) h();
    }
    /** every element below (depth first) */
    all(): FakeEl[] {
      return this.children.flatMap((c) => [c, ...c.all()]);
    }
    find(cls: string): FakeEl | undefined {
      return this.all().find((e) => e.classList.contains(cls));
    }
  }
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag), activeElement: null });
  vi.stubGlobal('window', { innerWidth: 390, innerHeight: 800, devicePixelRatio: 1 });
  return { root: new FakeEl('body'), FakeEl };
}

type Fake = ReturnType<typeof fakeDom>['root'];

describe('announcement banner: text safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('markup in the text or title stays plain text (textContent, never HTML)', () => {
    vi.useFakeTimers();
    const { root } = fakeDom();
    const layer = new BroadcastLayer(root as unknown as HTMLElement);
    const evil = '<img src=x onerror="alert(1)"><a href="https://phish.example">click</a>';
    layer.handle({ type: 'announcement', title: '<b>Owner</b>', text: evil, style: 'warning', seconds: 8 });
    const card = (root as Fake).find('bc-ann')!;
    expect(card).toBeTruthy();
    expect(card.find('bc-ann-text')!.textContent).toBe(evil);
    expect(card.find('bc-ann-title')!.textContent).toBe('<b>Owner</b>');
    // no element was made from the text: only the layer's own tags exist
    const tags = new Set((root as Fake).all().map((e) => e.tag));
    expect([...tags].sort()).toEqual(['button', 'canvas', 'div', 'i', 'p', 'span']);
    expect((root as Fake).all().some((e) => e.tag === 'a' || e.tag === 'img')).toBe(false);
  });

  it('cleans control and bidi characters, caps the length, and falls back to "Announcement"', () => {
    const v = announcementView({ title: '‮', text: `Hi\u0000​ there\n${'z'.repeat(400)}`, style: 'nope', seconds: 9999 });
    expect(v.title).toBe('Announcement');
    expect(v.style).toBe('info');
    expect(v.text.startsWith('Hi there z')).toBe(true);
    expect([...v.text].length).toBe(BROADCAST_TEXT_MAX);
    expect(v.ms).toBe(15_000);
    expect(announcementView({ text: 'x', seconds: 'soon' }).ms).toBe(6000);
    expect(announcementView({ text: { toString: () => 'object' } }).text).toBe('');
  });

  it('an empty or non-text announcement shows nothing; a new one replaces the old; × dismisses', () => {
    vi.useFakeTimers();
    const { root } = fakeDom();
    const layer = new BroadcastLayer(root as unknown as HTMLElement);
    expect(layer.announce({ text: '   ' })).toBeNull();
    expect(layer.announce({ text: 42 })).toBeNull();
    layer.announce({ text: 'first', style: 'info' });
    layer.announce({ text: 'second', style: 'celebration' });
    vi.advanceTimersByTime(300);
    const cards = (root as Fake).all().filter((e) => e.classList.contains('bc-ann'));
    expect(cards.map((c) => c.find('bc-ann-text')!.textContent)).toEqual(['second']);
    expect(cards[0].classList.contains('s-celebration')).toBe(true);
    cards[0].find('bc-x')!.click();
    vi.advanceTimersByTime(300);
    expect((root as Fake).all().some((e) => e.classList.contains('bc-ann'))).toBe(false);
  });

  it('notices: plain text under a neutral heading, at most three, gone after their time', () => {
    vi.useFakeTimers();
    const { root } = fakeDom();
    const layer = new BroadcastLayer(root as unknown as HTMLElement);
    layer.handle({ type: 'notice', text: '<script>x()</script>', style: 'info', seconds: 5 });
    const n = (root as Fake).find('bc-note')!;
    expect(n.find('bc-note-text')!.textContent).toBe('<script>x()</script>');
    expect(n.find('bc-note-title')!.textContent).toBe(NOTICE_TITLE);
    for (let k = 0; k < 4; k++) layer.notice(`n${k}`);
    expect((root as Fake).all().filter((e) => e.classList.contains('bc-note')).length).toBe(3);
    vi.advanceTimersByTime(9000);
    expect((root as Fake).all().filter((e) => e.classList.contains('bc-note')).length).toBe(0);
  });

  it('nothing a player sees names the console or the owner', () => {
    vi.useFakeTimers();
    const { root } = fakeDom();
    const layer = new BroadcastLayer(root as unknown as HTMLElement);
    layer.announce({ text: 'Hello', style: 'info' });
    layer.notice('Hi');
    const texts = (root as Fake).all().map((e) => `${e.textContent} ${e.attrs['aria-label'] ?? ''}`.toLowerCase());
    for (const word of ['admin', 'console', 'owner']) expect(texts.some((t) => t.includes(word))).toBe(false);
  });

  it('effects: unknown kinds are dropped; a ping on another room\'s map, or with no map, is ignored', () => {
    const { root } = fakeDom();
    const layer = new BroadcastLayer(root as unknown as HTMLElement);
    const look = (root as Fake).find('bc-look')!;
    layer.spectacle({ kind: 'laser', tile: 3 });
    layer.spectacle({ kind: 'ping', tile: 3, code: 'AAAAAA' });
    expect(look.classList.contains('hidden')).toBe(true);
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }) } as unknown as HTMLElement;
    layer.setView(() => ({ code: 'BBBBBB', mapWidth: 10, mapHeight: 10, tileToScreen: (x, y) => ({ x, y }), canvas, focus: () => {} }));
    layer.spectacle({ kind: 'ping', tile: 3, code: 'AAAAAA' });
    layer.spectacle({ kind: 'ping', tile: 100, code: 'BBBBBB' }); // off the map
    expect(look.classList.contains('hidden')).toBe(true);
    layer.spectacle({ kind: 'ping', tile: 3, code: 'BBBBBB', label: '<i>here</i>' });
    expect(look.classList.contains('hidden')).toBe(false);
    expect(look.find('bc-look-t')!.textContent).toBe('<i>here</i>');
  });
});

describe('console: the announcement form', () => {
  const f = { where: 'here' as const, here: 'ABCDEF', sel: null, title: '', text: 'Peace ends in 1 minute', style: 'warning' as const, seconds: 8 };
  it('builds the message for this game, a picked game or every screen', () => {
    expect(announceMessage(f)).toEqual({ type: 'adminAnnounce', scope: 'room', code: 'ABCDEF', title: '', text: 'Peace ends in 1 minute', style: 'warning', seconds: 8 });
    expect(announceMessage({ ...f, where: 'all' })).toMatchObject({ scope: 'all' });
    expect(announceMessage({ ...f, where: 'sel', sel: 'GHJKLM' })).toMatchObject({ scope: 'room', code: 'GHJKLM' });
  });
  it('says what is missing', () => {
    expect(announceMessage({ ...f, text: '  ' })).toBe('Write the announcement first');
    expect(announceMessage({ ...f, here: null })).toBe('You are not in a game: pick one in Games');
    expect(announceMessage({ ...f, where: 'sel', sel: null })).toBe('Pick a game in Games first');
    expect(typeof announceMessage({ ...f, text: 'x'.repeat(201) })).toBe('string');
  });
});
