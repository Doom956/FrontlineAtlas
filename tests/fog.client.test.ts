// Fog of war, client side (src/client/fog/fogView.ts and the panels that read it): the known map in the tile feed
// (hidden changes wait, a reveal catches up without capture flashes), remembered buildings, nations met and in sight,
// and that the standings, the nation card and event texts show nothing about nations you have not met.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { createFog, updateFog } from '../src/sim/fog';
import { hashState } from '../src/sim/hash';
import { newId, setOwner } from '../src/sim/state';
import type { Building, BuildingType, GameEvent, GameState, Unit, UnitType } from '../src/sim/types';
import { fogEvent, fogFor, knownOwnerOf, nationName, UNKNOWN_NATION } from '../src/client/fog/fogView';
import { KIND_MASK, TileFeed } from '../src/client/render/tiles';
import { Leaderboard } from '../src/client/hud/leaderboard';
import { NationCard } from '../src/client/hud/nationCard';
import { isIncoming } from '../src/client/forces';
import { isAttackable } from '../src/client/input';
import type { HudCtx } from '../src/client/hud/dom';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 320 x 320 plains: you (1) hold the top-left block, 2 the bottom-right corner, 3 the top-right corner. Fog on. */
function game(): GameState {
  const s = makeFlatGame(320, 320, 3, { human: true, seed: 5 });
  s.settings.modifiers = { ...s.settings.modifiers, fogOfWar: true };
  claimRect(s, 1, 0, 0, 15, 15);
  claimRect(s, 2, 288, 288, 319, 319);
  claimRect(s, 3, 280, 0, 319, 31);
  s.players[2].name = 'Varkos';
  s.players[3].name = 'Orlen';
  s.humanId = 1;
  s.fog = createFog(s);
  step(s);
  return s;
}
/** One tick's worth for the view: vision refreshed for everyone, the tick counter moved. */
function step(s: GameState): void {
  s.tick++;
  updateFog(s, true);
}
function addUnit(s: GameState, type: UnitType, owner: number, x: number, y: number, extra: Partial<Unit> = {}): Unit {
  const u: Unit = { id: newId(s), type, owner, x, y, target: at(s, x, y), home: at(s, x, y), path: [], pathPos: 0, troops: { infantry: 500, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 0, ...extra };
  s.units.push(u);
  return u;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 2, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

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
function hudCtx(s: GameState): HudCtx & { opened: number[] } {
  const ctx = {
    opened: [] as number[],
    probe: () => null,
    ui: { attackShare: 0.3, attackMixMode: 'all', customMix: { infantry: 1, armor: 1, artillery: 1 }, mode: { kind: 'none' }, selection: [] },
    dispatch: () => ({ ok: true }),
    camera: {},
    state: () => s,
    me: () => s.players[1],
    act: () => true,
    refreshSoon: () => {},
    openDrawer: () => {},
    closeDrawer: () => {},
    openNation: (id: number) => ctx.opened.push(id),
    focusTile: () => {},
    toast: () => {},
    confirm: () => {},
    sound: () => {},
  };
  return ctx as unknown as HudCtx & { opened: number[] };
}

describe('fog view: nations met and in sight', () => {
  it('a far nation is unknown until something of yours sees it; then met for good, army only while in sight', () => {
    const s = game();
    const fog = fogFor(s);
    expect(fog.active).toBe(true);
    expect(fog.isMet(1)).toBe(true);
    expect(fog.isMet(2)).toBe(false);
    expect(fog.isMet(3)).toBe(false);
    expect(nationName(s, 3)).toBe(UNKNOWN_NATION);
    expect(fog.armyShown(s, 3)).toBeNull();
    const ship = addUnit(s, 'transport', 1, 290, 20);
    step(s);
    fogFor(s); // the HUD's reads refresh the view
    expect(fog.isMet(3)).toBe(true);
    expect(fog.inSight.has(3)).toBe(true);
    expect(fog.armyShown(s, 3)).toBeGreaterThan(0);
    expect(nationName(s, 3)).toBe('Orlen');
    s.units.splice(s.units.indexOf(ship), 1);
    step(s);
    fogFor(s);
    expect(fog.isMet(3)).toBe(true);
    expect(fog.inSight.has(3)).toBe(false);
    expect(fog.armyShown(s, 3)).toBeNull();
  });

  it('no fog for a spectator, after the end and without the rule', () => {
    const s = game();
    s.humanId = 0;
    expect(fogFor(s).active).toBe(false);
    s.humanId = 1;
    s.phase = 'over';
    expect(fogFor(s).active).toBe(false);
    const off = makeFlatGame(64, 64, 2, { human: true });
    expect(knownOwnerOf(off, 0)).toBe(off.map.owner[0]);
  });

  it('an alliance request makes the other side met; allies are always met and in sight', () => {
    const s = game();
    s.allianceRequests.push({ from: 2, to: 1, expiresTick: s.tick + 100 });
    step(s);
    expect(fogFor(s).isMet(2)).toBe(true);
    s.alliances.push({ a: 1, b: 3, expiresTick: s.tick + 1000 } as GameState['alliances'][number]);
    step(s);
    expect(fogFor(s).inSight.has(3)).toBe(true);
  });
});

describe('fog view: the known map', () => {
  it('a hidden capture waits in the feed; a reveal applies it without a flash', () => {
    const s = game();
    const feed = new TileFeed();
    feed.reset(s);
    const fog = fogFor(s);
    fog.attach(feed);
    const t = at(s, 300, 10);
    // Unexplored: owner 0 in the known map, attackable unknown land.
    expect(feed.owner(t)).toBe(0);
    expect(knownOwnerOf(s, t)).toBe(0);
    expect(isAttackable(s, 1, t)).toBe(true);
    // Seen once: the mirror takes Orlen's land.
    const ship = addUnit(s, 'transport', 1, 300, 20);
    step(s);
    fogFor(s);
    feed.update(0, 1);
    expect(feed.owner(t)).toBe(3);
    // Out of view again: Varkos takes it, the known map still says Orlen (last seen).
    s.units.splice(s.units.indexOf(ship), 1);
    step(s);
    fogFor(s);
    setOwner(s, t, 2);
    feed.update(100, 1);
    expect(feed.owner(t)).toBe(3);
    expect(knownOwnerOf(s, t)).toBe(3);
    // Back in view: caught up, no capture flash for news that is old.
    addUnit(s, 'transport', 1, 300, 20);
    step(s);
    fogFor(s);
    feed.update(200, 1);
    expect(feed.owner(t)).toBe(2);
    expect(feed.mirror[t] & KIND_MASK).toBe(0);
  });

  it('buildings seen are remembered greyed after the view moves on, and a destroyed one stays until you look again', () => {
    const s = game();
    const tile = at(s, 300, 20);
    const b = addBuilding(s, 'city', 3, tile);
    const fog = fogFor(s);
    expect(fog.buildingAt(s, tile)).toBeNull(); // never seen
    const ship = addUnit(s, 'transport', 1, 300, 40);
    step(s);
    expect(fogFor(s).buildingAt(s, tile)).toMatchObject({ type: 'city', owner: 3, live: true });
    s.units.splice(s.units.indexOf(ship), 1);
    step(s);
    s.buildings.delete(b.id);
    s.map.building[tile] = 0;
    markBuildingsChanged(s);
    expect(fogFor(s).buildingAt(s, tile)).toMatchObject({ type: 'city', owner: 3, level: 2, live: false });
    expect(fogFor(s).knownCapital(s, 3)).toBe(-1);
    addUnit(s, 'transport', 1, 300, 40);
    step(s);
    expect(fogFor(s).buildingAt(s, tile)).toBeNull();
  });

  it('enemy transports count as incoming only once seen; reads leave the sim alone', () => {
    const s = game();
    const far = addUnit(s, 'transport', 2, 200, 200, { target: at(s, 5, 5) });
    expect(isIncoming(s, 1, far)).toBe(false);
    expect(fogFor(s).unitShown(s, far)).toBe(false);
    far.x = 30;
    far.y = 30;
    step(s);
    const h = hashState(s);
    expect(isIncoming(s, 1, far)).toBe(true);
    // the view's reads (memory, nations met, known owners) change nothing the sim hashes
    const fog = fogFor(s);
    for (let t = 0; t < s.map.owner.length; t += 997) {
      fog.knownOwner(s, t);
      fog.buildingAt(s, t);
    }
    fog.armyShown(s, 2);
    expect(hashState(s)).toBe(h);
  });
});

describe('fog: what the HUD shows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('standings rank every nation by land but name only nations you have met, with "?" for an army out of sight', () => {
    installDom();
    const s = game();
    const ctx = hudCtx(s);
    const lb = new Leaderboard(ctx);
    (lb as unknown as { all: boolean }).all = true;
    lb.update(s, s.players[1]);
    const root = lb.el as unknown as FakeEl;
    const text = root.text();
    expect(text).not.toContain('Varkos');
    expect(text).not.toContain('Orlen');
    expect(text).toContain('Unknown'); // the short form of UNKNOWN_NATION (narrow column; the tip says the rest)
    const row3 = root.find((e) => e.dataset.test === 'lb-row-3')!;
    expect(row3.classList.contains('unmet')).toBe(true);
    // Met and in sight: name and army; out of sight again: "?".
    const ship = addUnit(s, 'transport', 1, 290, 20);
    step(s);
    lb.update(s, s.players[1]);
    expect(row3.text()).toContain('Orlen');
    expect(row3.text()).not.toContain('?');
    s.units.splice(s.units.indexOf(ship), 1);
    step(s);
    lb.update(s, s.players[1]);
    expect(row3.text()).toContain('Orlen');
    expect(row3.find((e) => e.classList.contains('c-army'))!.textContent).toBe('?');
    expect(root.text()).not.toContain('Varkos');
  });

  it('the nation card does not open on a nation you have not met; once met it hides an army out of sight', () => {
    installDom();
    const s = game();
    const card = new NationCard(hudCtx(s));
    card.open(2);
    card.update(s, s.players[1]);
    expect(card.isOpen).toBe(false);
    s.allianceRequests.push({ from: 2, to: 1, expiresTick: s.tick + 100 });
    step(s);
    card.open(2);
    card.update(s, s.players[1]);
    expect(card.isOpen).toBe(true);
    const root = card.el as unknown as FakeEl;
    expect(root.text()).toContain('Varkos');
    expect(root.find((e) => e.classList.contains('nc-v'))!.textContent).toBe('?');
    // the card attacks the capital: unknown and no shared border = the button is off
    const attack = root.find((e) => e.dataset.test === 'nc-attack')!;
    expect(attack.disabled).toBe(true);
    expect(attack.dataset.tip).toMatch(/do not know where they are/);
  });

  it('the fall of a nation you have not met is news without its name', () => {
    const s = game();
    const e: GameEvent = { tick: s.tick, kind: 'eliminated', message: 'Varkos has been eliminated by Orlen', players: [], tile: -1 };
    expect(fogEvent(s, e).message).toBe('A nation you have not met has fallen');
    expect(e.message).toBe('Varkos has been eliminated by Orlen'); // the sim's event is untouched
    s.allianceRequests.push({ from: 2, to: 1, expiresTick: s.tick + 100 });
    step(s);
    expect(fogEvent(s, e).message).toBe('Varkos has been eliminated by a nation you have not met');
    s.phase = 'over';
    expect(fogEvent(s, e).message).toBe('Varkos has been eliminated by Orlen');
  });
});
