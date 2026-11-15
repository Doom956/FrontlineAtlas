// The Settings panel (src/client/settings/panel.ts) on a tiny fake DOM: four tabs with plain names, one section shown
// at a time, the test selectors the tools rely on, controls that save at once, Test sound that says why it is off,
// a Reset to defaults per section, and the Gameplay hooks (the live HUD in a game, saved picks on the title screen).
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
const saved = { document: g.document };
g.document = {
  createElement: (t: string) => new FakeEl(t),
  createTextNode: (t: string) => new FakeText(t),
  activeElement: null,
  documentElement: new FakeEl('html'),
};
afterAll(() => {
  g.document = saved.document;
});

const { SettingsPanel, SETTINGS_TABS } = await import('../src/client/settings/panel');
const { setSettingsProbes } = await import('../src/client/settings/apply');
const store = await import('../src/client/settings/store');
const { mapStyle } = await import('../src/client/render/mapStyle');

function all(root: FakeEl, pred: (e: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (pred(root)) out.push(root);
  for (const c of root.children) if (c instanceof FakeEl) all(c, pred, out);
  return out;
}
const byTest = (root: FakeEl, t: string): FakeEl => {
  const found = all(root, (e) => e.dataset.test === t);
  if (found.length !== 1) throw new Error(`data-test=${t}: ${found.length} found`);
  return found[0];
};
const button = (root: FakeEl, text: string): FakeEl => {
  const found = all(root, (e) => e.tag === 'button' && e.textContent === text);
  if (!found.length) throw new Error(`no button "${text}"`);
  return found[0];
};

function hooks(chat = false) {
  const h = { advisor: true, guide: true, restarts: 0, chatOn: true };
  return {
    h,
    gameplay: {
      advisorOn: () => h.advisor,
      setAdvisor: (on: boolean) => void (h.advisor = on),
      guideOn: () => h.guide,
      setGuide: (on: boolean) => void (h.guide = on),
      restartGuide: () => void h.restarts++,
      restartNote: 'The guide starts again.',
      chat: chat ? { on: () => h.chatOn, set: (on: boolean) => void (h.chatOn = on) } : undefined,
    },
  };
}

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

beforeEach(() => store.useSettingsStorage(new MemStore()));

describe('Settings panel', () => {
  it('has four tabs with plain names, and shows one section at a time', () => {
    const p = new SettingsPanel({ gameplay: hooks().gameplay });
    const root = p.el as unknown as FakeEl;
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['Sound', 'Display', 'Gameplay', 'About']);
    const tabs = all(root, (e) => e.attrs.role === 'tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Sound', 'Display', 'Gameplay', 'About']);
    for (const id of ['sound', 'display', 'gameplay', 'about']) {
      expect(byTest(root, `settings-tab-${id}`).attrs['aria-controls']).toBe(`set-sec-${id}`);
      expect(byTest(root, `settings-sec-${id}`).attrs.role).toBe('tabpanel');
    }
    p.show('sound');
    expect(byTest(root, 'settings-sec-sound').hidden).toBe(false);
    expect(byTest(root, 'settings-sec-display').hidden).toBe(true);
    byTest(root, 'settings-tab-display').click();
    expect(p.openTab).toBe('display');
    expect(byTest(root, 'settings-sec-display').hidden).toBe(false);
    expect(byTest(root, 'settings-sec-sound').hidden).toBe(true);
    expect(byTest(root, 'settings-tab-display').attrs['aria-selected']).toBe('true');
    expect(byTest(root, 'settings-tab-sound').attrs['aria-selected']).toBe('false');
    // the next panel opens on the tab used last
    expect(new SettingsPanel({ gameplay: hooks().gameplay }).openTab).toBe('display');
  });

  it('Sound: volumes in %, mute, Test sound that says why it is off, and a reset', () => {
    let played = 0;
    setSettingsProbes({ testSound: () => (played++, true) });
    const p = new SettingsPanel({ gameplay: hooks().gameplay });
    const sec = byTest(p.el as unknown as FakeEl, 'settings-sec-sound');
    const master = byTest(sec, 'vol-master');
    expect(master.attrs['aria-label']).toBe('Master volume');
    master.value = '30';
    master.fire('input');
    expect(store.getSettings().master).toBeCloseTo(0.3);
    expect(sec.textContent).toContain('30%');
    const test = byTest(sec, 'settings-test-sound');
    test.click();
    expect(played).toBe(1);
    button(sec, 'Muted').click();
    expect(store.getSettings().muted).toBe(true);
    expect(test.disabled).toBe(true);
    expect(sec.textContent).toContain('Sound is muted: pick Sound on to test it.');
    expect(sec.textContent).toContain('Fighting is heard where you look');
    byTest(sec, 'settings-reset-sound').click();
    expect(store.getSettings()).toMatchObject({ master: store.DEFAULT_SETTINGS.master, muted: false });
    expect(test.disabled).toBe(false);
  });

  it('Display: only reduce motion and graphics quality, saved at once; the looks are not offered', () => {
    const p = new SettingsPanel({ gameplay: hooks().gameplay });
    const sec = byTest(p.el as unknown as FakeEl, 'settings-sec-display');
    // the map look, unit art, unit motion and map effects are gone: every player gets the defaults
    for (const t of ['map-style', 'settings-art', 'settings-motion', 'fx-toggle']) expect(all(sec, (e) => e.dataset.test === t)).toHaveLength(0);
    for (const word of ['Map look', 'Unit art', 'Unit motion', 'Map effects', 'Classic', 'Realistic', 'Cinematic']) expect(sec.textContent).not.toContain(word);
    expect(mapStyle()).toBe('ground');
    button(byTest(sec, 'settings-reduce-motion'), 'On').click();
    expect(store.getSettings().reduceMotion).toBe('on');
    const q = byTest(sec, 'settings-quality');
    expect(all(q, (e) => e.tag === 'button').map((b) => b.textContent)).toEqual(['Auto', 'High', 'Low']);
    button(q, 'Low').click();
    expect(store.getSettings().quality).toBe('low');
    expect(button(q, 'Low').attrs['aria-pressed']).toBe('true');
    byTest(sec, 'settings-reset-display').click();
    expect(store.getSettings()).toEqual(store.DEFAULT_SETTINGS);
    expect(mapStyle()).toBe('ground');
  });

  it('Display in a game: the extra rows come before the reset', () => {
    const p = new SettingsPanel({
      gameplay: hooks().gameplay,
      displayExtra: (sec) => {
        const x = document.createElement('div');
        x.dataset.test = 'supply-toggle';
        sec.append(x);
      },
    });
    const sec = byTest(p.el as unknown as FakeEl, 'settings-sec-display');
    const kids = sec.children.filter((c): c is FakeEl => c instanceof FakeEl);
    expect(kids.findIndex((c) => c.dataset.test === 'supply-toggle')).toBeLessThan(kids.findIndex((c) => c.dataset.test === 'settings-reset-display'));
  });

  it('Gameplay: advisor and guide switches, restart guide, chat only online, and a reset', () => {
    const { h, gameplay } = hooks();
    const p = new SettingsPanel({ gameplay });
    const sec = byTest(p.el as unknown as FakeEl, 'settings-sec-gameplay');
    button(byTest(sec, 'advisor-toggle'), 'Advisor off').click();
    button(byTest(sec, 'guide-toggle'), 'Guide off').click();
    expect(h).toMatchObject({ advisor: false, guide: false });
    byTest(sec, 'guide-restart').click();
    expect(h.restarts).toBe(1);
    expect(sec.textContent).toContain('The guide starts again.');
    expect(all(sec, (e) => e.dataset.test === 'chat-toggle')).toHaveLength(0);
    byTest(sec, 'settings-reset-gameplay').click();
    expect(h).toMatchObject({ advisor: true, guide: true });

    const online = hooks(true);
    const p2 = new SettingsPanel({ gameplay: online.gameplay });
    const sec2 = byTest(p2.el as unknown as FakeEl, 'settings-sec-gameplay');
    button(byTest(sec2, 'chat-toggle'), 'Chat off').click();
    expect(online.h.chatOn).toBe(false);
  });

  it('About: the version and build, then the credits', () => {
    const p = new SettingsPanel({ gameplay: hooks().gameplay });
    const sec = byTest(p.el as unknown as FakeEl, 'settings-sec-about');
    const facts = byTest(sec, 'settings-version').textContent;
    expect(facts).toContain('Version');
    expect(facts).toContain('Build');
    expect(facts).toContain('Multiplayer version');
    expect(byTest(sec, 'credits').textContent).toContain('Sound and music (CC BY)');
  });
});
