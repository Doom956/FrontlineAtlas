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
import { isIncoming, unitDoing } from '../src/client/forces';
import { modeFor, strikeTarget } from '../src/client/strikes';
import { pillarPickClick } from '../src/client/pillars';
import { defaultUiState } from '../src/client/uiState';
import { computeCoastAndLand } from '../src/sim/mapgen';
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

describe('fog: nothing about hidden land leaks through previews, picks and status lines', () => {
  /** You (1) with a silo, an airfield with bombers and every strike researched; nation 2 far away, never seen. */
  function armed(): GameState {
    const s = game();
    const me = s.players[1];
    me.techs.push('rocketry', 'nuclearFission', 'flight');
    me.gold = 1e7;
    me.iron = 1e6;
    me.oil = 1e6;
    addBuilding(s, 'silo', 1, at(s, 8, 8));
    addBuilding(s, 'airfield', 1, at(s, 10, 10)).bombers = 4;
    step(s);
    return s;
  }

  it('strike previews over dark land say the same whoever holds it; land last seen as enemy can be aimed at', () => {
    const s = armed();
    const me = s.players[1];
    const ui = defaultUiState();
    const feed = new TileFeed();
    feed.reset(s);
    fogFor(s).attach(feed);
    const look = (): void => {
      step(s);
      fogFor(s);
      feed.update(s.tick * 100, 1);
    };
    const enemy = at(s, 300, 300);
    const empty = at(s, 150, 150);
    expect(fogFor(s).explored(enemy)).toBe(false);
    for (const id of ['rocket', 'atomBomb', 'bomb'] as const) {
      const a = strikeTarget(s, me, ui, modeFor(id), enemy);
      const b = strikeTarget(s, me, ui, modeFor(id), empty);
      expect(a.ok).toBe(false);
      expect({ ok: a.ok, reason: a.reason, victim: a.victim, enemyTiles: a.enemyTiles, blind: a.blind }).toEqual({ ok: b.ok, reason: b.reason, victim: b.victim, enemyTiles: b.enemyTiles, blind: b.blind });
      expect(a.reason).toMatch(/^Unexplored/);
    }
    // Seen once (a transport passes by), then out of view: a rocket may aim there, and keeps doing so after the land
    // changes hands while hidden; what it would hit is not counted.
    const ship = addUnit(s, 'transport', 1, 300, 300);
    look();
    s.units.splice(s.units.indexOf(ship), 1);
    look();
    expect(fogFor(s).visible(enemy)).toBe(false);
    expect(fogFor(s).explored(enemy)).toBe(true);
    const seen = strikeTarget(s, me, ui, modeFor('rocket'), enemy);
    expect(seen.ok).toBe(true);
    expect(seen.blind).toBe(true);
    expect(seen.enemyTiles).toBe(0);
    for (let y = 290; y < 311; y++) for (let x = 290; x < 311; x++) setOwner(s, at(s, x, y), 0); // Varkos keeps the rest
    look();
    expect(s.players[2].alive).toBe(true);
    expect(knownOwnerOf(s, enemy)).toBe(2);
    const gone = strikeTarget(s, me, ui, modeFor('rocket'), enemy);
    expect({ ok: gone.ok, reason: gone.reason }).toEqual({ ok: seen.ok, reason: seen.reason });
  });

  it('the warship Blockade pick only finds ports you know and never names a nation you have not met', () => {
    const s = makeFlatGame(320, 120, 3, { human: true, seed: 5 });
    const W = s.map.width;
    for (let y = 60; y < 120; y++) for (let x = 0; x < W; x++) s.map.terrain[y * W + x] = 0;
    computeCoastAndLand(s.map);
    s.settings.modifiers = { ...s.settings.modifiers, fogOfWar: true };
    claimRect(s, 1, 0, 40, 15, 59);
    claimRect(s, 2, 250, 40, 290, 59);
    s.players[2].name = 'Varkos';
    s.humanId = 1;
    addBuilding(s, 'port', 2, 59 * W + 270);
    const ship = addUnit(s, 'warship', 1, 10, 70, { hp: 100 });
    s.fog = createFog(s);
    step(s);
    const sent: unknown[] = [];
    const dispatch = (a: unknown) => (sent.push(a), { ok: true });
    const ui = { mode: { kind: 'pillarPick', pick: 'blockade', unitIds: [ship.id], airfield: -1, label: '' } } as never;
    const hidden = pillarPickClick(s, ui, dispatch, 62 * W + 271);
    const sea = pillarPickClick(s, ui, dispatch, 62 * W + 150);
    expect(hidden).toEqual(sea);
    expect(hidden.ok).toBe(false);
    expect(sent).toEqual([]);
    // Bombard on dark coast: no nation is pinned (none known there)
    (ui as { mode: { pick: string } }).mode.pick = 'bombard';
    pillarPickClick(s, ui, dispatch, 59 * W + 260);
    expect(JSON.stringify(sent)).not.toContain('setUnitStance');
    expect(JSON.stringify(sent)).not.toContain('Varkos');
  });

  it('a strategic air pick on dark land is refused without asking the sim', () => {
    const s = armed();
    const sent: unknown[] = [];
    const ui = { mode: { kind: 'pillarPick', pick: 'airStrategic', unitIds: [], airfield: at(s, 10, 10), label: '' } } as never;
    const a = pillarPickClick(s, ui, (x: unknown) => (sent.push(x), { ok: true }), at(s, 300, 300));
    const b = pillarPickClick(s, ui, (x: unknown) => (sent.push(x), { ok: true }), at(s, 150, 150));
    expect(a).toEqual(b);
    expect(a.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('your units heading into the dark say "unexplored", not who holds it', () => {
    const s = game();
    const me = s.players[1];
    const t = addUnit(s, 'transport', 1, 8, 20, { target: at(s, 300, 300) });
    const m = addUnit(s, 'rocket', 1, 8, 8, { target: at(s, 300, 300) });
    expect(unitDoing(s, me, t)).toBe('500 troops heading to unexplored land');
    expect(unitDoing(s, me, m)).toBe('Falling on unexplored land');
    for (const u of [t, m]) expect(unitDoing(s, me, u)).not.toContain('Varkos');
  });

  it('an atom bomb broadcast names no nation you have not met and gives no spot on land you never saw', () => {
    const s = game();
    const e: GameEvent = { tick: s.tick, kind: 'nuke', message: 'Varkos dropped an atom bomb on Orlen: 3 buildings destroyed, 1200 troops killed', players: [], tile: at(s, 300, 300) };
    const f = fogEvent(s, e);
    expect(f.message).toBe('An unknown nation dropped an atom bomb on an unknown nation: 3 buildings destroyed, 1200 troops killed');
    expect(f.tile).toBe(-1);
    expect(e.message).toContain('Varkos'); // the sim's event is untouched
    s.allianceRequests.push({ from: 2, to: 1, expiresTick: s.tick + 100 });
    step(s);
    expect(fogEvent(s, e).message).toBe('Varkos dropped an atom bomb on an unknown nation: 3 buildings destroyed, 1200 troops killed');
  });

  it('a neighbour whose land pokes into a block in view is met and in sight, wherever in the block it is', () => {
    const s = game();
    claimRect(s, 2, 33, 1, 38, 6); // inside block (2, 0), clear of its centre and corners
    step(s);
    const fog = fogFor(s);
    expect(fog.visible(at(s, 35, 3))).toBe(true);
    expect(fog.isMet(2)).toBe(true);
    expect(fog.armyShown(s, 2)).not.toBeNull();
    expect(nationName(s, 2)).toBe('Varkos');
  });

  it('a nation moving into view is noticed without any change of your vision', () => {
    const s = game();
    const fog = fogFor(s);
    expect(fog.isMet(3)).toBe(false);
    // Orlen's land grows into a block you already see; your own vision does not change
    claimRect(s, 3, 36, 20, 39, 23);
    for (let k = 0; k < 6; k++) {
      s.tick++;
      fogFor(s);
    }
    expect(fog.isMet(3)).toBe(true);
  });
});

describe('fog of war: vision of blocs', () => {
  it("an ally's part of your view is its last own stamp; the own stamps are hashed", () => {
    const s = game();
    s.alliances.push({ a: 1, b: 2, expiresTick: s.tick + 1e6 });
    updateFog(s, true);
    const f = s.fog!;
    for (let k = 0; k < f.words; k++) expect(f.now[1]![k]).toBe((f.own[1]![k] | f.own[2]![k]) >>> 0);
    const h = hashState(s);
    f.own[3]![0] ^= 1;
    expect(hashState(s)).not.toBe(h);
    f.own[3]![0] ^= 1;
    expect(hashState(s)).toBe(h);
  });
});
