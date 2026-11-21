// The Tutorials menu (src/client/tutorial/menuEntry.ts): the title screen's row, and the list with the basics first
// ("Start here" until done), a card for each chapter with its icon, plain name, "about N min" and a tick when done,
// nothing locked, and the "All tutorials done" badge once every tutorial was finished. A tiny fake DOM, no browser.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

type Handler = (e: unknown) => void;
class FakeText {
  constructor(public textContent: string) {}
}
class FakeEl {
  className = '';
  id = '';
  type = '';
  value = '';
  min = '';
  max = '';
  step = '';
  href = '';
  target = '';
  rel = '';
  title = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  children: (FakeEl | FakeText)[] = [];
  handlers = new Map<string, Handler[]>();
  private text = '';
  classList = {
    contains: (c: string) => this.className.split(' ').includes(c),
    add: (c: string) => void (this.classList.contains(c) || (this.className = `${this.className} ${c}`.trim())),
    remove: (c: string) => void (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
  };
  constructor(public tag: string) {}
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(_v: string) {
    this.children = [];
    this.text = '';
  }
  append(...xs: (FakeEl | FakeText | string)[]): void {
    for (const x of xs) this.children.push(typeof x === 'string' ? new FakeText(x) : x);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  addEventListener(t: string, h: Handler): void {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), h]);
  }
  fire(t: string): void {
    for (const h of this.handlers.get(t) ?? []) h({});
  }
  click(): void {
    if (!this.disabled) this.fire('click');
  }
  querySelector(): null {
    return null;
  }
}

const g = globalThis as Record<string, unknown>;
const saved = { document: g.document, localStorage: g.localStorage };
g.document = {
  createElement: (t: string) => new FakeEl(t),
  createTextNode: (t: string) => new FakeText(t),
  activeElement: null,
  documentElement: new FakeEl('html'),
};
afterAll(() => {
  g.document = saved.document;
  g.localStorage = saved.localStorage;
});


class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
}
beforeEach(() => {
  g.localStorage = new MemStorage();
});

const { tutorialButton, tutorialList } = await import('../src/client/tutorial/menuEntry');
const { ALL_TUTORIALS } = await import('../src/client/tutorial/catalog');
const { markChapterDone } = await import('../src/client/tutorial/engine');

function all(root: FakeEl, pred: (e: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (pred(root)) out.push(root);
  for (const c of root.children) if (c instanceof FakeEl) all(c, pred, out);
  return out;
}
const byTest = (root: FakeEl, t: string): FakeEl | undefined => all(root, (e) => e.dataset.test === t)[0];

describe('Tutorials menu', () => {
  it('lists the basics first, then a card for each chapter, with plain names and about N min', () => {
    const list = tutorialList(() => {}) as unknown as FakeEl;
    const cards = all(list, (e) => /^tut-card-[a-z]+$/.test(e.dataset.test ?? ''));
    expect(cards.map((c) => c.dataset.test)).toEqual(['tut-card-basics', 'tut-card-navy', 'tut-card-air', 'tut-card-armor', 'tut-card-defense', 'tut-card-diplomacy', 'tut-card-supply', 'tut-card-seasons']);
    // each card says its plain name first, then what it teaches and how long it takes
    expect(cards.map((c) => c.attrs['aria-label'].split(':')[0])).toEqual(['Basics', 'Navy', 'Air', 'Armor', 'Defense', 'Diplomacy', 'Supply', 'Seasons']);
    for (const c of cards) expect(c.attrs['aria-label']).toMatch(/, about \d+ minutes/);
    for (const c of ALL_TUTORIALS) {
      const note = byTest(list, `tut-card-note-${c.id}`)!;
      expect(note.textContent).toBe(`about ${c.minutes} min`);
    }
    expect(byTest(list, 'tut-start-here')?.textContent).toBe('Start here');
  });

  it('is not locked: every card is an enabled button that starts its chapter', () => {
    const started: string[] = [];
    const list = tutorialList((id) => started.push(id)) as unknown as FakeEl;
    for (const c of ALL_TUTORIALS) {
      const card = byTest(list, `tut-card-${c.id}`)!;
      expect(card.tag).toBe('button');
      expect(card.disabled).toBe(false);
      card.click();
    }
    expect(started).toEqual(ALL_TUTORIALS.map((c) => c.id));
  });

  it('a finished chapter shows a tick and "Done"; "Start here" goes once the basics are done', () => {
    markChapterDone('basics');
    markChapterDone('navy');
    const list = tutorialList(() => {}) as unknown as FakeEl;
    expect(byTest(list, 'tut-card-note-navy')!.textContent).toContain('Done');
    expect(byTest(list, 'tut-card-note-navy')!.className).toContain('done');
    expect(byTest(list, 'tut-card-note-air')!.textContent).toBe('about 3 min');
    expect(byTest(list, 'tut-start-here')).toBeUndefined();
  });

  it('the Tutorials row: counts what is done and carries the "All tutorials done" badge only when every one is', () => {
    const row = () => tutorialButton(() => {}) as unknown as FakeEl;
    expect(byTest(row(), 'menu-tutorial-note')!.textContent).toBe('0 of 8 done');
    expect(byTest(row(), 'tutorials-all-done')).toBeUndefined();
    for (const c of ALL_TUTORIALS.slice(0, -1)) markChapterDone(c.id);
    expect(byTest(row(), 'tutorials-all-done')).toBeUndefined();
    expect(byTest(row(), 'menu-tutorial-note')!.textContent).toBe('7 of 8 done');
    markChapterDone(ALL_TUTORIALS[ALL_TUTORIALS.length - 1].id);
    const done = row();
    expect(byTest(done, 'tutorials-all-done')!.textContent).toContain('All tutorials done');
    expect(byTest(done, 'menu-tutorial-note')).toBeUndefined();
    expect(done.dataset.test).toBe('menu-tutorial');
  });
});
