// What players see of the screen pranks and the owner's time rules (src/client/broadcast.ts, fx/prankView.ts,
// adminOnline.ts): every prank, countdown and banner ends by itself on its own timer, lengths from the server are
// clamped again, prefers-reduced-motion skips the moving ones, the map input maps clicks back through a flip or a
// wobble, and server text only ever lands in textContent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRANK_DEFAULT_SECONDS, PRANK_KINDS, PRANK_SECONDS } from '../src/net/protocol';
import type { PrankKind } from '../src/net/protocol';
import { BroadcastLayer, prankMs, turnAmount } from '../src/client/broadcast';
import type { BroadcastView } from '../src/client/broadcast';
import { mapPointer, mapShown, mapSide, prankView, setMapWarp, unwarpPoint, warpPoint } from '../src/client/fx/prankView';
import { setupInput } from '../src/client/input';
import type { InputDeps } from '../src/client/input';
import { readFileSync } from 'node:fs';
import { prankMessage } from '../src/client/adminOnline';

/** A 2D context that accepts every call (the frame loop draws into it). */
const anyCtx = (): unknown => new Proxy({}, { get: () => () => {}, set: () => true });

class FakeEl {
  className = '';
  textContent = '';
  type = '';
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  width = 0;
  height = 0;
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
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  getContext() {
    return anyCtx();
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls: string): FakeEl | undefined {
    return this.all().find((e) => e.classList.contains(cls));
  }
}

let calm = false;
function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeEl(tag), activeElement: null });
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: calm && q.includes('reduce') }));
  const root = new FakeEl('body');
  const layer = new BroadcastLayer(root as unknown as HTMLElement);
  const mapEl = new FakeEl('canvas');
  const glEl = new FakeEl('canvas');
  // a camera that lands a flight once its time is up (like camera.ts, without the easing)
  const cam = { x: 50, y: 40, zoom: 4, flying: false, flights: [] as number[][], to: [0, 0, 0, 0] };
  const land = (): void => {
    if (cam.flying && performance.now() >= cam.to[3]) {
      [cam.x, cam.y, cam.zoom] = cam.to;
      cam.flying = false;
    }
  };
  const camera = {
    get: () => {
      land();
      return { x: cam.x, y: cam.y, zoom: cam.zoom, flying: cam.flying };
    },
    flyTo: (x: number, y: number, z: number, ms: number) => {
      cam.flights.push([x, y, z, ms]);
      cam.flying = true;
      cam.to = [x, y, z, performance.now() + ms];
    },
    centerOn: (x: number, y: number) => {
      cam.flying = false;
      cam.x = x;
      cam.y = y;
    },
  };
  const view: BroadcastView = {
    code: 'ABCDEF',
    mapWidth: 100,
    mapHeight: 80,
    tileToScreen: (x, y) => ({ x, y }),
    canvas: mapEl as unknown as HTMLElement,
    focus: () => {},
    mapLayers: () => [mapEl, glEl] as unknown as HTMLElement[],
    capitalTile: () => 4050,
    ownUnit: (id) => (id === undefined || id === 7 ? { id: 7, x: 20, y: 30 } : null),
    camera,
  };
  layer.setView(() => view);
  return { root, layer, mapEl, glEl, cam };
}

describe('pranks: each one ends by itself', () => {
  beforeEach(() => {
    calm = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lengths are clamped to 2..10 s, with each kind\'s own default', () => {
    for (const k of PRANK_KINDS) {
      expect(prankMs(k, 9999)).toBe(PRANK_SECONDS[1] * 1000);
      expect(prankMs(k, 0)).toBe(PRANK_SECONDS[0] * 1000);
      expect(prankMs(k, 'long')).toBe(PRANK_DEFAULT_SECONDS[k] * 1000);
      expect(PRANK_DEFAULT_SECONDS[k]).toBeLessThanOrEqual(PRANK_SECONDS[1]);
    }
  });

  it.each(PRANK_KINDS.map((k) => [k]))('%s: on, then off after at most 10 s, with everything it changed put back', (kind: PrankKind) => {
    const { root, layer, mapEl, glEl } = setup();
    layer.handle({ type: 'spectacle', kind, seconds: 9999 });
    expect(layer.activePranks()).toContain(kind);
    if (kind === 'disco') expect(prankView.hue).toBeGreaterThan(0);
    if (kind === 'ducks') expect(prankView.ducks).toBe(true);
    if (kind === 'fogPuff') expect(root.find('bc-fog')!.classList.contains('on')).toBe(true);
    vi.advanceTimersByTime(PRANK_SECONDS[1] * 1000 + 50);
    expect(layer.activePranks()).toEqual([]);
    expect(prankView).toMatchObject({ hue: 0, ducks: false, warp: null });
    expect(mapEl.style.transform ?? '').toBe('');
    expect(glEl.style.transform ?? '').toBe('');
    expect(root.find('bc-fog')!.classList.contains('hidden')).toBe(true);
    expect(root.find('bc-count')!.classList.contains('hidden')).toBe(true);
    layer.destroy();
  });

  it('a flip turns the map layers while it runs (frames), and the mirror mode only mirrors', () => {
    const { layer, mapEl, glEl } = setup();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    layer.prank('flip', { mode: 'mirror', seconds: 4 });
    vi.advanceTimersByTime(2000);
    frames.shift()?.(performance.now());
    expect(prankView.warp).toMatchObject({ sx: -1, rot: 0, moving: false });
    expect(mapEl.style.transform).toContain('scale(-1.0000, 1.0000)');
    expect(glEl.style.transform).toBe(mapEl.style.transform);
    vi.advanceTimersByTime(2100);
    expect(prankView.warp).toBeNull();
    expect(mapEl.style.transform).toBe('');
  });

  it('a new game or the menu ends every prank at once', () => {
    const { layer } = setup();
    for (const k of PRANK_KINDS) layer.prank(k);
    expect(layer.activePranks().length).toBe(PRANK_KINDS.length);
    layer.setView(null);
    expect(layer.activePranks()).toEqual([]);
    expect(prankView).toMatchObject({ hue: 0, ducks: false, warp: null });
    // without a map only the cloud can show
    expect(layer.prank('ducks')).toBe(false);
    expect(layer.prank('fogPuff')).toBe(true);
  });

  it('the pretend bomb: "Incoming!" over the capital, then "Gotcha!" and confetti, all inside its time', () => {
    const { root, layer } = setup();
    layer.handle({ type: 'spectacle', kind: 'fakeBomb', seconds: 7, label: '<b>real?</b>' });
    const count = root.find('bc-count')!;
    expect(count.find('bc-count-l')!.textContent).toBe('Incoming!');
    expect(count.classList.contains('bomb')).toBe(true);
    expect(root.find('bc-look')!.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(count.find('bc-count-n')!.textContent).toBe('Gotcha!');
    expect(count.find('bc-count-l')!.textContent).toBe('Just confetti');
    vi.advanceTimersByTime(2050);
    expect(count.classList.contains('hidden')).toBe(true);
    // the sender's label is never shown on it
    expect(root.all().some((e) => e.textContent.includes('real?'))).toBe(false);
  });

  it('the chase glides to one of the player\'s units, follows, glides back; a pan by the player ends it there', () => {
    const { layer, cam } = setup();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const run = (ms: number): void => {
      for (let t = 0; t < ms; t += 50) {
        vi.advanceTimersByTime(50);
        frames.shift()?.(performance.now());
      }
    };
    layer.prank('chase', { seconds: 6 });
    expect(cam.flights[0].slice(0, 2)).toEqual([20.5, 30.5]);
    run(1000);
    run(1000);
    expect(Math.abs(cam.x - 20.5)).toBeLessThan(1);
    run(4100);
    expect(cam.flights.at(-1)!.slice(0, 3)).toEqual([50, 40, 4]);
    expect(layer.activePranks()).toEqual([]);
    // again, and the player pans mid-way: no glide back
    cam.flights.length = 0;
    layer.prank('chase', { seconds: 6 });
    run(1500);
    cam.x += 5;
    run(200);
    expect(layer.activePranks()).toEqual([]);
    run(6000);
    expect(cam.flights.length).toBe(1);
  });

  it('countdowns are clamped to 15 s and end by themselves', () => {
    const { root, layer } = setup();
    layer.handle({ type: 'spectacle', kind: 'countdown', seconds: 600, label: '<i>soon</i>' });
    const count = root.find('bc-count')!;
    expect(count.find('bc-count-n')!.textContent).toBe('15');
    expect(count.find('bc-count-l')!.textContent).toBe('<i>soon</i>');
    vi.advanceTimersByTime(15_000 + 1700);
    expect(count.classList.contains('hidden')).toBe(true);
  });

  it('banners: 6 s by default, 15 s at most; a new one replaces the old', () => {
    const { root, layer } = setup();
    layer.announce({ text: 'one' });
    vi.advanceTimersByTime(5900);
    expect(root.all().filter((e) => e.classList.contains('bc-ann')).length).toBe(1);
    vi.advanceTimersByTime(400);
    expect(root.all().filter((e) => e.classList.contains('bc-ann')).length).toBe(0);
    layer.announce({ text: 'two', seconds: 120 });
    layer.announce({ text: 'three', seconds: 120 });
    vi.advanceTimersByTime(300);
    expect(root.all().filter((e) => e.classList.contains('bc-ann')).map((e) => e.find('bc-ann-text')!.textContent)).toEqual(['three']);
    vi.advanceTimersByTime(15_000);
    expect(root.all().some((e) => e.classList.contains('bc-ann'))).toBe(false);
  });

  it('one-player notices go after 5 s', () => {
    const { root, layer } = setup();
    layer.notice('hello');
    vi.advanceTimersByTime(4900);
    expect(root.find('bc-note')).toBeTruthy();
    vi.advanceTimersByTime(200);
    expect(root.find('bc-note')).toBeUndefined();
  });
});

describe('pranks: reduced motion', () => {
  afterEach(() => {
    calm = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('no flip, wobble or chase; disco holds one colour turn; ducks, bomb and cloud still show', () => {
    calm = true;
    const { layer, cam } = setup();
    expect(layer.prank('flip')).toBe(false);
    expect(layer.prank('earthquake')).toBe(false);
    expect(layer.prank('chase')).toBe(false);
    expect(cam.flights).toEqual([]);
    expect(prankView.warp).toBeNull();
    expect(layer.prank('disco')).toBe(true);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const h = prankView.hue;
    vi.advanceTimersByTime(1000);
    frames.shift()?.(performance.now());
    expect(prankView.hue).toBe(h);
    for (const k of ['ducks', 'fakeBomb', 'fogPuff'] as const) expect(layer.prank(k)).toBe(true);
    vi.advanceTimersByTime(PRANK_SECONDS[1] * 1000 + 50);
    expect(layer.activePranks()).toEqual([]);
  });
});

describe('pranks: clicks land where the player sees', () => {
  it('warp and unwarp are inverses (flip, mirror, wobble)', () => {
    const warps = [
      { rot: Math.PI, sx: 1, sy: 1, dx: 0, dy: 0, moving: false },
      { rot: 0, sx: -1, sy: 1, dx: 0, dy: 0, moving: false },
      { rot: 0.011, sx: 1, sy: 1, dx: 4.2, dy: -3.1, moving: false },
      { rot: Math.PI * 0.4, sx: 1, sy: 1, dx: 1, dy: 2, moving: true },
    ];
    for (const w of warps) {
      for (const [x, y] of [[0, 0], [100, 50], [799, 599], [400, 300]]) {
        const a = warpPoint(w, x, y, 800, 600);
        const b = unwarpPoint(w, a.x, a.y, 800, 600);
        expect(b.x).toBeCloseTo(x, 6);
        expect(b.y).toBeCloseTo(y, 6);
      }
    }
  });

  it('upside down: a click at the top left of the screen is the bottom right of the map', () => {
    const canvas = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }) } as unknown as HTMLElement;
    expect(mapPointer(canvas, 110, 70)).toEqual({ x: 100, y: 50 });
    prankView.warp = { rot: Math.PI, sx: 1, sy: 1, dx: 0, dy: 0, moving: false };
    const p = mapPointer(canvas, 110, 70);
    expect(p.x).toBeCloseTo(700, 6);
    expect(p.y).toBeCloseTo(550, 6);
    prankView.warp = { rot: 0, sx: -1, sy: 1, dx: 0, dy: 0, moving: false };
    expect(mapPointer(canvas, 110, 70).x).toBeCloseTo(700, 6);
    prankView.warp = null;
  });

  it('a turn eases in and out over half a second', () => {
    expect(turnAmount(0, 0, 5000)).toBe(0);
    expect(turnAmount(250, 0, 5000)).toBeCloseTo(0.5, 6);
    expect(turnAmount(2500, 0, 5000)).toBe(1);
    expect(turnAmount(5000, 0, 5000)).toBe(0);
  });
});

describe('console: the prank form', () => {
  const f = { where: 'here' as const, here: 'ABCDEF', sel: null, memberId: null, kind: 'flip' as const, seconds: null };
  it('builds the message for a game, one player or every screen', () => {
    expect(prankMessage(f)).toEqual({ type: 'adminSpectacle', scope: 'room', code: 'ABCDEF', kind: 'flip', mode: 'upside' });
    expect(prankMessage({ ...f, kind: 'ducks', memberId: 3, seconds: 9 })).toEqual({ type: 'adminSpectacle', scope: 'room', code: 'ABCDEF', kind: 'ducks', memberId: 3, seconds: 9 });
    expect(prankMessage({ ...f, where: 'all', kind: 'disco', memberId: 3 })).toEqual({ type: 'adminSpectacle', scope: 'all', kind: 'disco' });
  });
  it('refuses lengths over 10 s and a missing game', () => {
    expect(prankMessage({ ...f, seconds: 11 })).toBe('Seconds: 2 to 10');
    expect(prankMessage({ ...f, here: null })).toBe('You are not in a game: pick one in Games');
  });
});

describe('pranks: a press held across a flip', () => {
  type H = (e: Record<string, unknown>) => void;
  const setup = () => {
    const on: Record<string, H> = {};
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener: (t: string, h: H) => (on[t] = h),
      setPointerCapture: () => {},
      classList: { add: () => {}, remove: () => {} },
    };
    const minimap = { addEventListener: () => {} };
    vi.stubGlobal('window', { addEventListener: () => {}, setTimeout, innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal('document', { addEventListener: () => {}, querySelector: () => canvas });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const camera = { pan: vi.fn(), screenToTile: (x: number, y: number) => ({ x, y }) };
    const ui = { contextMenu: null, mode: { kind: 'none' }, hoverTile: -1, hoverPx: null, selectBox: null as unknown };
    const stop = setupInput({ canvas, minimap, camera, renderer: {}, ui, getState: () => null, dispatch: () => {}, openResearch: () => {}, toggleHelp: () => {} } as unknown as InputDeps);
    const ev = (x: number, y: number, more: Record<string, unknown> = {}) => ({ pointerId: 1, button: 0, clientX: x, clientY: y, pointerType: 'mouse', shiftKey: false, preventDefault: () => {}, ...more });
    return { on, camera, ui, stop, ev };
  };
  afterEach(() => {
    setMapWarp(null);
    vi.unstubAllGlobals();
  });

  it('a drag that is still held when a mirror flip turns stops panning (no jump of thousands of px)', () => {
    const { on, camera, stop, ev } = setup();
    on.pointerdown(ev(540, 300));
    on.pointermove(ev(560, 300));
    expect(camera.pan).toHaveBeenCalledTimes(1);
    // mid-turn the mirror is almost flat: a 1 px move would be a huge pan
    setMapWarp({ rot: 0, sx: 0.02, sy: 1, dx: 0, dy: 0, moving: true });
    on.pointermove(ev(561, 300));
    setMapWarp({ rot: 0, sx: -1, sy: 1, dx: 0, dy: 0, moving: false });
    on.pointermove(ev(562, 300));
    on.pointermove(ev(580, 300));
    expect(camera.pan).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a press held through a whole turn with no move in between is let go too', () => {
    const { on, camera, stop, ev } = setup();
    on.pointerdown(ev(540, 300));
    setMapWarp({ rot: Math.PI / 2, sx: 1, sy: 1, dx: 0, dy: 0, moving: true });
    setMapWarp({ rot: Math.PI, sx: 1, sy: 1, dx: 0, dy: 0, moving: false });
    on.pointermove(ev(600, 300));
    expect(camera.pan).not.toHaveBeenCalled();
    // a new press after the turn pans as usual (through the flip)
    on.pointerup(ev(600, 300));
    on.pointerdown(ev(600, 300));
    on.pointermove(ev(620, 300));
    expect(camera.pan).toHaveBeenCalledTimes(1);
    expect(camera.pan.mock.calls[0][0]).toBeCloseTo(-20, 6);
    stop();
  });

  it('a slow machine that misses the whole turn between two frames lets the press go too', () => {
    const { on, camera, stop, ev } = setup();
    on.pointerdown(ev(1000, 400));
    on.pointermove(ev(990, 400));
    expect(camera.pan).toHaveBeenCalledTimes(1);
    // no frame while it turned: the next frame already shows the map mirrored (the pointer maps 990 -> -190)
    prankView.warp = { rot: 0, sx: -1, sy: 1, dx: 0, dy: 0, moving: false };
    on.pointermove(ev(982, 400));
    on.pointermove(ev(974, 400));
    on.pointerup(ev(974, 400));
    expect(camera.pan).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a Shift box being drawn is dropped when a flip turns', () => {
    const { on, ui, stop, ev } = setup();
    on.pointerdown(ev(100, 100, { shiftKey: true }));
    on.pointermove(ev(200, 200, { shiftKey: true }));
    expect(ui.selectBox).not.toBeNull();
    setMapWarp({ rot: 1, sx: 1, sy: 1, dx: 0, dy: 0, moving: true });
    on.pointermove(ev(210, 210, { shiftKey: true }));
    expect(ui.selectBox).toBeNull();
    stop();
  });
});

describe('pranks: HUD markers over the map follow the flip', () => {
  afterEach(() => {
    setMapWarp(null);
    vi.unstubAllGlobals();
  });
  it('mapShown: unchanged with no prank, mirrored through the centre when upside down', () => {
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal('document', { querySelector: () => ({ clientWidth: 800, clientHeight: 600 }) });
    expect(mapShown(100, 50)).toEqual({ x: 100, y: 50 });
    setMapWarp({ rot: Math.PI, sx: 1, sy: 1, dx: 0, dy: 0, moving: false });
    const p = mapShown(100, 50);
    expect(p.x).toBeCloseTo(700, 6);
    expect(p.y).toBeCloseTo(550, 6);
    setMapWarp({ rot: 0, sx: -1, sy: 1, dx: 0, dy: 0, moving: false });
    expect(mapShown(100, 50).x).toBeCloseTo(700, 6);
  });
  it('mapSide: which way round the map shows (a wobble alone counts as the usual way)', () => {
    expect(mapSide()).toBe('');
    setMapWarp({ rot: 0.011, sx: 1, sy: 1, dx: 4, dy: -3, moving: false });
    expect(mapSide()).toBe('');
    setMapWarp({ rot: Math.PI + 0.01, sx: 1, sy: 1, dx: 0, dy: 0, moving: false });
    expect(mapSide()).toBe('u');
    setMapWarp({ rot: -0.01, sx: -1, sy: 1, dx: 0, dy: 0, moving: false });
    expect(mapSide()).toBe('m');
  });
  it('the unit card, the alert ping and the guide ring are placed through the warp', () => {
    const src = (f: string) => readFileSync(new URL(`../src/client/${f}`, import.meta.url), 'utf8');
    expect(src('hud/unitCard.ts')).toMatch(/mapShown\(at\.x, at\.y\)/);
    expect(src('hud/alerts.ts')).toMatch(/mapShown\(t\.x, t\.y\)/);
    expect(src('guide/guide.ts')).toMatch(/mapPointOnPage\(canvas, t\.x, t\.y\)/);
  });
});

describe('banners on a phone held sideways', () => {
  it('the phone sizes (21 px text, 90% wide) also apply to short screens, not only narrow ones', () => {
    const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');
    const at = css.indexOf('@media (max-width: 640px), (max-height: 500px) {\n  .bc-stack');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf('\n}\n', at));
    expect(block).toMatch(/\.bc-ann-text \{\s*font-size: 21px;/);
    expect(block).toMatch(/width: 90vw;/);
  });
});

describe('jumpscare', () => {
  afterEach(() => {
    calm = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is a full-screen scare that needs no map and clears itself', () => {
    calm = false;
    const { root, layer } = setup();
    layer.setView(null); // no game on screen: the scare still works
    expect(layer.prank('jumpscare')).toBe(true);
    const jump = root.find('bc-jump')!;
    expect(jump.classList.contains('on')).toBe(true);
    expect(jump.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(PRANK_SECONDS[1] * 1000 + 50);
    expect(layer.activePranks()).toEqual([]);
    expect(jump.classList.contains('hidden')).toBe(true);
    expect(jump.classList.contains('on')).toBe(false);
    layer.destroy();
  });

  it('is mild and silent for reduced motion (calm, not the harsh flash)', () => {
    calm = true;
    const { root, layer } = setup();
    expect(layer.prank('jumpscare')).toBe(true);
    const jump = root.find('bc-jump')!;
    expect(jump.classList.contains('calm')).toBe(true);
    expect(jump.classList.contains('on')).toBe(false);
    expect(jump.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(PRANK_SECONDS[1] * 1000 + 50);
    expect(jump.classList.contains('hidden')).toBe(true);
    layer.destroy();
  });
});
