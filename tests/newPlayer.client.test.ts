// The new-player pass (src/client/hud/newPlayer.ts): controls appear when they become useful, each with a one-time
// "New:" note, never blocking; the finished-games counter and the switch (src/client/settings/store.ts) end it.
import { beforeEach, describe, expect, it } from 'vitest';
import { KEY_SECONDS, NewPlayerPass, ownsUnit, passWants, PASS_CONTROLS, PASS_NOTES, RESEARCH_SECONDS, START_BUILDS, type PassControl, type PassFacts } from '../src/client/hud/newPlayer';
import {
  DEFAULT_SETTINGS,
  FA_SETTINGS_KEY,
  getSettings,
  newPlayerPassOn,
  noteGameFinished,
  PASS_GAMES,
  resetPassMigration,
  setSetting,
  useSettingsStorage,
} from '../src/client/settings/store';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { setOwner } from '../src/sim/state';
import { tick } from '../src/sim/sim';
import type { BuildingType, GameState } from '../src/sim/types';
import { makeFlatGame } from './helpers';

class MemStore {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
}
let mem: MemStore;
beforeEach(() => {
  mem = new MemStore();
  useSettingsStorage(mem);
  resetPassMigration();
});

const NONE: PassFacts = { seconds: 0, hasCity: false, hasUnit: false, neighbour: false, offer: false, event: false, alert: false };

describe('new-player pass: what each control waits for', () => {
  it('shows nothing extra at the start', () => {
    const w = passWants(NONE);
    for (const c of PASS_CONTROLS) expect(w[c], c).toBe(false);
  });
  it('Research: after the first City, or at 1 min', () => {
    expect(passWants({ ...NONE, hasCity: true }).research).toBe(true);
    expect(passWants({ ...NONE, seconds: RESEARCH_SECONDS - 1 }).research).toBe(false);
    expect(passWants({ ...NONE, seconds: RESEARCH_SECONDS }).research).toBe(true);
    expect(passWants({ ...NONE, hasCity: true }).moreBuilds).toBe(true);
  });
  it('Army and Forces: when you own your first unit', () => {
    const w = passWants({ ...NONE, hasUnit: true });
    expect(w.army && w.forces).toBe(true);
    expect(w.research).toBe(false);
  });
  it('Diplomacy: when a nation borders you, or an offer arrives', () => {
    expect(passWants({ ...NONE, neighbour: true }).diplomacy).toBe(true);
    expect(passWants({ ...NONE, offer: true }).diplomacy).toBe(true);
  });
  it('Events and Alerts: on the first event or alert', () => {
    expect(passWants({ ...NONE, event: true })).toMatchObject({ events: true, alerts: false });
    expect(passWants({ ...NONE, alert: true })).toMatchObject({ events: false, alerts: true });
  });
  it('Map key and the season chip: at 2 min', () => {
    expect(passWants({ ...NONE, seconds: KEY_SECONDS - 1 })).toMatchObject({ legend: false, season: false });
    expect(passWants({ ...NONE, seconds: KEY_SECONDS })).toMatchObject({ legend: true, season: true });
  });
  it('every note is one line that starts with New:, no em dash', () => {
    for (const c of PASS_CONTROLS) {
      expect(PASS_NOTES[c], c).toMatch(/^New: /);
      expect(PASS_NOTES[c], c).not.toMatch(/[\n\u2014]/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ the class on a real game

interface Rec {
  drawers: Map<string, boolean>;
  season: boolean | null;
  builds: readonly BuildingType[] | null | undefined;
  notes: string[];
}
function rig(active = true): { pass: NewPlayerPass; rec: Rec; on: { v: boolean } } {
  const rec: Rec = { drawers: new Map(), season: null, builds: undefined, notes: [] };
  const on = { v: active };
  const pass = new NewPlayerPass(
    {
      setDrawer: (id, shown) => rec.drawers.set(id, shown),
      setSeason: (shown) => (rec.season = shown),
      setBuilds: (only) => (rec.builds = only),
      note: (_k, text) => rec.notes.push(text),
    },
    () => on.v,
  );
  return { pass, rec, on };
}
/** Two nations side by side with a gap: me (1, human) at x 0..9, another (2) at x 20..29, 40 x 10 plain land. */
function world(): GameState {
  const s = makeFlatGame(40, 10, 2, { human: true });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setOwner(s, y * 40 + x, 1);
  for (let y = 0; y < 10; y++) for (let x = 20; x < 30; x++) setOwner(s, y * 40 + x, 2);
  s.players[1].capital = 5 * 40 + 5;
  return s;
}
/** Game time passes (the clock only: the pass reads time, not the sim). */
const run = (s: GameState, seconds: number): void => {
  s.tick += seconds * TICKS_PER_SECOND;
};
const simulate = (s: GameState, seconds: number): void => {
  for (let k = 0; k < seconds * TICKS_PER_SECOND; k++) tick(s);
};

describe('new-player pass: on a game', () => {
  it('hides the optional controls at the start, with no notes', () => {
    const s = world();
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    for (const id of ['research', 'army', 'forces', 'diplomacy', 'events', 'alerts', 'legend']) expect(rec.drawers.get(id), id).toBe(false);
    expect(rec.season).toBe(false);
    expect(rec.builds).toEqual(START_BUILDS);
    expect(rec.notes).toEqual([]);
  });

  it('Research appears at 1 min with one New: note, and only once', () => {
    const s = world();
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    run(s, RESEARCH_SECONDS + 1);
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('research')).toBe(true);
    expect(rec.builds).toBeNull();
    expect(rec.notes).toEqual([PASS_NOTES.research]);
    pass.update(s, s.players[1]);
    pass.update(s, s.players[1]);
    expect(rec.notes).toHaveLength(1);
  });

  it('the first City shows Research at once', () => {
    const s = world();
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('research')).toBe(false);
    const id = 9000;
    s.buildings.set(id, { id, type: 'city', owner: 1, tile: 5 * 40 + 5, level: 1, buildLeft: 5, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 });
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('research')).toBe(true);
  });

  it('Army and Forces appear with the first unit', () => {
    const s = world();
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    expect(ownsUnit(s, s.players[1])).toBe(false);
    run(s, 5);
    s.units.push({ id: 7, type: 'warship', owner: 1, x: 1, y: 1, target: -1, home: -1, path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 0 } as never);
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('army')).toBe(true);
    expect(rec.drawers.get('forces')).toBe(true);
    expect(rec.notes.some((n) => n === PASS_NOTES.army)).toBe(true);
  });

  it('Diplomacy appears when a nation borders you, and at once when an offer arrives', () => {
    const s = world();
    const a = rig();
    a.pass.update(s, s.players[1]);
    expect(a.rec.drawers.get('diplomacy')).toBe(false); // a gap of 10 tiles
    // the gap fills: the other nation touches mine
    for (let y = 0; y < 10; y++) for (let x = 10; x < 20; x++) setOwner(s, y * 40 + x, 2);
    simulate(s, 2);
    a.pass.update(s, s.players[1]);
    expect(a.rec.drawers.get('diplomacy')).toBe(true);

    const s2 = world();
    const b = rig();
    b.pass.update(s2, s2.players[1]);
    s2.allianceRequests.push({ from: 2, to: 1, expiresTick: s2.tick + 600 });
    b.pass.update(s2, s2.players[1]);
    expect(b.rec.drawers.get('diplomacy')).toBe(true);
  });

  it('Events and Alerts on the first of each; Map key and the season chip at 2 min', () => {
    const s = world();
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    pass.noteEvent();
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('events')).toBe(true);
    expect(rec.drawers.get('alerts')).toBe(false);
    pass.noteAlert();
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('alerts')).toBe(true);
    expect(rec.season).toBe(false);
    run(s, KEY_SECONDS + 1);
    pass.update(s, s.players[1]);
    expect(rec.season).toBe(true);
    expect(rec.drawers.get('legend')).toBe(true);
  });

  it('never blocks: a revealed control stays, and a hint can reveal one at once', () => {
    const s = world();
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    pass.revealDrawer('diplomacy');
    expect(rec.drawers.get('diplomacy')).toBe(true);
    expect(rec.notes).toEqual([]); // opened on purpose: no note
    pass.revealDrawer('settings'); // not a gated control: ignored
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('diplomacy')).toBe(true);
  });

  it('a saved game or late join: what is already true shows without notes', () => {
    const s = world();
    run(s, 130);
    const { pass, rec } = rig();
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('research')).toBe(true);
    expect(rec.drawers.get('legend')).toBe(true);
    expect(rec.notes).toEqual([]);
  });

  it('with the pass off (switch on, spectator, tutorial) everything shows', () => {
    const s = world();
    const { pass, rec, on } = rig();
    pass.update(s, s.players[1]);
    expect(rec.drawers.get('research')).toBe(false);
    on.v = false;
    pass.update(s, s.players[1]);
    for (const c of PASS_CONTROLS as readonly PassControl[]) if (c !== 'season' && c !== 'moreBuilds') expect(rec.drawers.get(c), c).toBe(true);
    expect(rec.season).toBe(true);
    expect(rec.builds).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ the counter and the switch

describe('new-player pass: finished games and the switch', () => {
  it('is on for a new player and off after 3 finished games, by itself', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ showAllControls: false, gamesFinished: 0 });
    expect(newPlayerPassOn()).toBe(true);
    noteGameFinished();
    noteGameFinished();
    expect(getSettings().gamesFinished).toBe(2);
    expect(newPlayerPassOn()).toBe(true);
    expect(getSettings().showAllControls).toBe(false);
    noteGameFinished();
    expect(PASS_GAMES).toBe(3);
    expect(getSettings()).toMatchObject({ gamesFinished: 3, showAllControls: true });
    expect(newPlayerPassOn()).toBe(false);
  });

  it('the counter is saved in fa.settings.v1 and read back', () => {
    noteGameFinished();
    expect(JSON.parse(mem.getItem(FA_SETTINGS_KEY)!)).toMatchObject({ gamesFinished: 1, showAllControls: false });
    useSettingsStorage(mem);
    expect(getSettings().gamesFinished).toBe(1);
  });

  it('the switch turns the pass off at once, and back on while fewer than 3 games are finished', () => {
    setSetting('showAllControls', true);
    expect(newPlayerPassOn()).toBe(false);
    setSetting('showAllControls', false);
    expect(newPlayerPassOn()).toBe(true);
  });

  it('a player whose settings were saved before the pass existed has played before: the switch turns on once', () => {
    mem.setItem(FA_SETTINGS_KEY, JSON.stringify({ master: 0.4 }));
    useSettingsStorage(mem);
    resetPassMigration();
    expect(newPlayerPassOn()).toBe(false);
    expect(getSettings().showAllControls).toBe(true);
  });

  it('broken counters read as 0', () => {
    mem.setItem(FA_SETTINGS_KEY, JSON.stringify({ gamesFinished: 'x', showAllControls: 5 }));
    useSettingsStorage(mem);
    expect(getSettings()).toMatchObject({ gamesFinished: 0, showAllControls: false });
  });
});
