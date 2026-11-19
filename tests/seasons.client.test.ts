// Seasons, client side: the top bar's season chip (hud/cluster.ts) with its one-line effect and the winter warning
// toast, the season icons, and the look-only day and night (client/dayNight.ts). A tiny stand-in DOM, as in
// keyLabels.client.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cluster, fmtSeasonLeft } from '../src/client/hud/cluster';
import { pixelIcon } from '../src/client/hud/pixelIcons';
import { DAY_SECONDS, dayClock, dayPhase } from '../src/client/dayNight';
import { SEASON, TICKS_PER_SECOND } from '../src/sim/config';
import { SEASON_TICKS } from '../src/sim/seasons';
import type { GameState } from '../src/sim/types';
import { makeFlatGame } from './helpers';

class FakeEl {
  children: FakeEl[] = [];
  classes = new Set<string>();
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: (() => void)[] = [];
  style = { setProperty: () => undefined, width: '', cssText: '' } as Record<string, unknown>;
  text = '';
  type = '';
  innerHTML = '';
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
  addEventListener(kind: string, f: () => void): void {
    if (kind === 'click') this.listeners.push(f);
  }
  removeEventListener(): void {}
  blur(): void {}
  querySelector(): null {
    return null;
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((k) => k.all())];
  }
  find(test: string): FakeEl {
    const e = this.all().find((k) => k.dataset.test === test);
    if (!e) throw new Error(`no ${test}`);
    return e;
  }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (t: string) => new FakeEl(t), createElementNS: (_n: string, t: string) => new FakeEl(t), addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
});
afterEach(() => vi.unstubAllGlobals());

function cluster(s: GameState, toasts: string[]): FakeEl & { up: () => void } {
  const ctx = {
    ui: { speed: 1, paused: false, mode: { kind: 'none' }, buildCount: 1, attackShare: 0.5, salvo: {}, playRealMs: 0 },
    state: () => s,
    me: () => s.players[s.humanId],
    openDrawer() {},
    refreshSoon() {},
    toast: (t: string) => toasts.push(t),
    sound() {},
  } as never;
  const c = new Cluster(ctx, { isOpen: () => false, muted: () => false, toggleMute() {}, toggleHelp() {}, hasAudio: () => true, pauseMode: () => 'local', alertsUnread: () => 0 });
  const root = c.el as unknown as FakeEl & { up: () => void };
  root.up = () => c.update(s, s.players[s.humanId]);
  return root;
}

describe('season chip', () => {
  it('shows the icon, the word and the time left; a click shows the effect line', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    s.playStartTick = s.tick - (3 * SEASON_TICKS + SEASON_TICKS - 800); // winter, 80 s left
    const toasts: string[] = [];
    const root = cluster(s, toasts);
    root.up();
    const chip = root.find('season-chip');
    expect(chip.tag).toBe('button');
    expect(chip.dataset.season).toBe('winter');
    expect(chip.textContent).toBe('Winter: 1 min 20 s left');
    expect(chip.attrs['aria-label']).toMatch(/^Winter: 1 min 20 s left/);
    const line = root.find('season-line');
    expect(line.classes.has('hidden')).toBe(true);
    expect(line.textContent).toMatch(/^Attacks through snow are slower/);
    chip.listeners.forEach((f) => f());
    expect(line.classes.has('hidden')).toBe(false);
    expect(chip.attrs['aria-expanded']).toBe('true');
    s.settings.modifiers.seasonEffects = false;
    root.up();
    expect(line.textContent).toBe('Season effects are off in this game');
  });

  it('warns once 30 s before winter, only with effects on', () => {
    const s = makeFlatGame(20, 20, 2, { human: true });
    const toasts: string[] = [];
    const root = cluster(s, toasts);
    s.playStartTick = s.tick - (3 * SEASON_TICKS - (SEASON.winterWarnSeconds + 5) * TICKS_PER_SECOND);
    root.up();
    expect(toasts).toEqual([]);
    s.playStartTick -= 6 * TICKS_PER_SECOND;
    root.up();
    root.up();
    expect(toasts).toEqual(['Winter is coming: snow will slow attacks']);
    const off = makeFlatGame(20, 20, 2, { human: true });
    off.settings.modifiers.seasonEffects = false;
    const quiet: string[] = [];
    const r2 = cluster(off, quiet);
    off.playStartTick = off.tick - (3 * SEASON_TICKS - 10 * TICKS_PER_SECOND);
    r2.up();
    expect(quiet).toEqual([]);
  });

  it('time left in plain words, and a pixel icon per season', () => {
    expect(fmtSeasonLeft(80)).toBe('1 min 20 s');
    expect(fmtSeasonLeft(120)).toBe('2 min');
    expect(fmtSeasonLeft(39.2)).toBe('40 s');
    for (const k of ['spring', 'summer', 'autumn', 'winter']) expect(pixelIcon(k, 16)).toMatch(/^<svg/);
  });
});

describe('day and night (look only)', () => {
  it('a 2 minute day: 90 s of light with a soft dawn and dusk, 30 s of night', () => {
    const at = (sec: number): number => dayPhase(sec * TICKS_PER_SECOND);
    expect(DAY_SECONDS).toBe(120);
    expect(at(0)).toBe(0);
    expect(at(5)).toBeCloseTo(0.5, 6);
    expect(at(30)).toBe(1);
    expect(at(85)).toBeCloseTo(0.5, 6);
    expect(at(95)).toBe(0);
    expect(at(119)).toBe(0);
    expect(at(125)).toBeCloseTo(0.5, 6);
    expect(dayClock(60 * TICKS_PER_SECOND)).toBeCloseTo(0.5, 9);
    for (let t = 0; t < 1200; t += 7) {
      expect(dayPhase(t)).toBeGreaterThanOrEqual(0);
      expect(dayPhase(t)).toBeLessThanOrEqual(1);
    }
  });
});
