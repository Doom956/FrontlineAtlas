// Key labels: the quick bar slots, the Build button and the top bar buttons carry a small key label (.hk), read
// from the same tables the key handler uses (BUILDINGS[].hotkey, DRAWER_KEYS, STRIKES[].key). No DOM in the test
// environment, so a tiny stand-in document is used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS } from '../src/sim/config';
import { DRAWER_KEYS } from '../src/client/input';
import { STRIKES, STRIKE_ORDER } from '../src/client/strikes';
import { Cluster } from '../src/client/hud/cluster';
import { QuickBar } from '../src/client/hud/quickBar';
import { StrikeBar } from '../src/client/hud/strikeBar';
import { makeFlatGame } from './helpers';

class FakeEl {
  children: FakeEl[] = [];
  classes = new Set<string>();
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style = { setProperty: () => undefined, width: '', cssText: '' } as Record<string, unknown>;
  text = '';
  type = '';
  alt = '';
  src = '';
  width = 0;
  height = 0;
  draggable = false;
  disabled = false;
  constructor(public tag: string) {}
  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }
  get classList() {
    const c = this.classes;
    return {
      add: (...n: string[]) => n.forEach((x) => c.add(x)),
      remove: (...n: string[]) => n.forEach((x) => c.delete(x)),
      contains: (n: string) => c.has(n),
      toggle: (n: string, f?: boolean) => {
        const on = f === undefined ? !c.has(n) : f;
        if (on) c.add(n);
        else c.delete(n);
        return on;
      },
    };
  }
  get textContent(): string {
    return this.text + this.children.map((k) => k.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  append(...k: (FakeEl | string)[]): void {
    for (const x of k) {
      if (typeof x === 'string') this.text += x;
      else this.children.push(x);
    }
  }
  appendChild(k: FakeEl): FakeEl {
    this.children.push(k);
    return k;
  }
  replaceChildren(...k: FakeEl[]): void {
    this.children = [];
    this.append(...k);
  }
  replaceWith(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  blur(): void {}
  querySelector(): null {
    return null;
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((k) => k.all())];
  }
  /** the label texts of the .hk children of every button inside */
  labels(): Map<string, string> {
    const out = new Map<string, string>();
    for (const b of this.all()) {
      if (b.tag !== 'button') continue;
      const hk = b.children.find((k) => k.classes.has('hk'));
      if (hk) out.set(b.dataset.test ?? b.className, hk.textContent);
    }
    return out;
  }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (t: string) => new FakeEl(t), createElementNS: (_n: string, t: string) => new FakeEl(t), addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});
afterEach(() => vi.unstubAllGlobals());

const ctx = (s: ReturnType<typeof makeFlatGame>) =>
  ({
    ui: { speed: 1, paused: false, mode: { kind: 'none' }, buildCount: 1, attackShare: 0.5, salvo: {} },
    state: () => s,
    me: () => s.players[s.humanId],
    openDrawer() {},
    refreshSoon() {},
    toast() {},
    sound() {},
  }) as never;

describe('key labels', () => {
  it('the top bar buttons show their keys', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const c = new Cluster(ctx(s), {
      isOpen: () => false,
      muted: () => false,
      toggleMute() {},
      toggleHelp() {},
      hasAudio: () => true,
      pauseMode: () => 'local',
      alertsUnread: () => 0,
    });
    c.fast();
    const l = (c.el as unknown as FakeEl).labels();
    for (const [id, key] of Object.entries(DRAWER_KEYS)) expect(l.get(`open-${id}`), id).toBe(key);
    expect(l.get('pause')).toBe('Space');
    expect(l.get('help')).toBe('?');
  });

  it('the Build button and the quick bar slots show their keys', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const q = new QuickBar(ctx(s));
    q.update(s, s.players[s.humanId]);
    const root = q.el as unknown as FakeEl;
    expect(root.labels().get('build-menu-btn')).toBe('Tab');
    const slotKeys = root.all().filter((e) => e.classes.has('qb-k')).map((e) => e.textContent).filter(Boolean);
    expect(slotKeys.length).toBeGreaterThan(0);
    const known = new Set(Object.values(BUILDINGS).map((b) => b.hotkey));
    for (const k of slotKeys) expect(known.has(k), k).toBe(true);
  });

  it('every strike button shows its key', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const sb = new StrikeBar(ctx(s));
    const l = (sb.el as unknown as FakeEl).labels();
    for (const id of STRIKE_ORDER) expect(l.get(`strike-${id}`), id).toBe(STRIKES[id].key);
  });
});
