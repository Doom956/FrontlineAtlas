// End-of-game summary data (src/client/summary/history.ts, data.ts): the land sampler (every ~10 s of game time,
// thinned when long), battles won and units built, the key moments from the game's events and attacks, the 5-8
// moments picked for the timeline, and that feeding the history never changes the game state. No DOM.
import { describe, expect, it } from 'vitest';
import { GameHistory, MAX_SAMPLES, SAMPLE_SECONDS, type Moment } from '../src/client/summary/history';
import { buildSummary, MAX_MOMENTS_SHOWN, pickMoments, TABLE_COLUMNS } from '../src/client/summary/data';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { addEvent, gameSeconds } from '../src/sim/state';
import type { Attack, GameState } from '../src/sim/types';
import { makeTestGame } from './helpers';

/** Runs `seconds` of game time, feeding the history every `every` ticks (a frame). */
function play(state: GameState, h: GameHistory, seconds: number, every = 3): void {
  const n = seconds * TICKS_PER_SECOND;
  for (let k = 0; k < n && state.phase !== 'over'; k++) {
    tick(state);
    if (k % every === 0) h.update(state);
  }
  h.update(state);
}

function fakeAttack(state: GameState, attacker: number, target: number, tilesTaken = 0): Attack {
  const a: Attack = {
    id: state.nextId++,
    attacker,
    target,
    troops: { infantry: 100, armor: 0, artillery: 0 },
    focusTile: -1,
    progress: 0,
    startTick: state.tick,
    amphibious: false,
    losses: 0,
    tilesTaken,
  };
  state.attacks.push(a);
  return a;
}

describe('land sampler', () => {
  it('samples every nation about every 10 s of game time', () => {
    const s = makeTestGame();
    const h = new GameHistory();
    play(s, h, 65);
    expect(h.samples.length).toBeGreaterThanOrEqual(7);
    expect(h.samples.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < h.samples.length; i++) {
      const dt = h.samples[i].t - h.samples[i - 1].t;
      expect(dt).toBeGreaterThan(SAMPLE_SECONDS - 1);
      expect(dt).toBeLessThan(SAMPLE_SECONDS + 1);
    }
    h.update(s); // the same tick again: no new sample
    const last = h.samples[h.samples.length - 1];
    expect(last.t).toBeLessThanOrEqual(gameSeconds(s));
    expect(last.tiles[1]).toBeGreaterThan(0);
    expect(last.troops[1]).toBeGreaterThan(0);
    expect(last.tiles[0]).toBe(0);
  });

  it('stays small in a long game: thins to every other sample and samples half as often', () => {
    const s = makeTestGame();
    const h = new GameHistory();
    h.update(s);
    // jump the clock (no sim): 3 hours of game time in 10 s steps
    for (let k = 0; k < 1080; k++) {
      s.tick += SAMPLE_SECONDS * TICKS_PER_SECOND;
      h.update(s);
    }
    expect(h.samples.length).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(h.samples.length).toBeGreaterThan(MAX_SAMPLES / 4);
    expect(h.interval).toBeGreaterThan(SAMPLE_SECONDS);
    expect(h.duration).toBe(gameSeconds(s));
    expect(h.samples[0].t).toBe(0);
  });

  it('takes a last sample when the game ends, and starts over for a new game', () => {
    const s = makeTestGame();
    const h = new GameHistory();
    play(s, h, 12);
    s.tick += 3; // between two sample times
    s.phase = 'over';
    h.update(s);
    expect(h.duration).toBe(gameSeconds(s));
    const s2 = makeTestGame({ seed: 7 });
    h.update(s2);
    expect(h.samples.length).toBe(1);
    expect(h.moments.length).toBe(0);
  });

  it('never changes the game state (hash and lockstep untouched)', () => {
    const a = makeTestGame();
    const b = makeTestGame();
    const h = new GameHistory();
    for (let k = 0; k < 400; k++) {
      tick(a);
      tick(b);
      h.update(a);
    }
    expect(hashState(a)).toBe(hashState(b));
  });
});

describe('key moments', () => {
  it('first contact, later wars, battles won and units built', () => {
    const s = makeTestGame();
    const h = new GameHistory();
    h.update(s);
    const first = fakeAttack(s, 2, 1);
    h.update(s);
    const second = fakeAttack(s, 1, 3);
    fakeAttack(s, 2, 3); // not yours: no moment
    h.update(s);
    const kinds = h.moments.map((m) => m.kind);
    expect(kinds).toEqual(['contact', 'war']);
    expect(h.moments[0].text).toBe(`First contact: ${s.players[2].name} attacks you`);
    expect(h.moments[1].text).toBe(`War: You attack ${s.players[3].name}`);
    // the attack on 3 ends after taking land: a battle won; the one that took nothing is not
    second.tilesTaken = 12;
    h.update(s);
    s.attacks = s.attacks.filter((a) => a !== second && a !== first);
    h.update(s);
    expect(h.battlesWon[1]).toBe(1);
    expect(h.battlesWon[2]).toBe(0);
    // a second attack between the same two nations is no new war
    fakeAttack(s, 1, 3);
    h.update(s);
    expect(h.moments.length).toBe(2);
    // units: a new warship counts, a trade ship doesn't
    const base = { x: 0, y: 0, target: 0, from: 0, path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 0 };
    s.units.push({ ...base, id: s.nextId++, type: 'warship', owner: 1 } as never, { ...base, id: s.nextId++, type: 'tradeShip', owner: 1 } as never);
    h.update(s);
    h.update(s);
    expect(h.unitsBuilt[1]).toBe(1);
  });

  it('capitals, eliminations, cities and alliances from the game events, in your words', () => {
    const s = makeTestGame();
    const h = new GameHistory();
    h.update(s);
    const [me, a, b] = [s.players[1], s.players[2], s.players[3]];
    addEvent(s, 'capitalLost', `${me.name} lost their capital to ${a.name}`, [1, 2], -1);
    addEvent(s, 'capitalLost', `${b.name} lost their capital to ${me.name}`, [3, 1], -1);
    addEvent(s, 'eliminated', `${b.name} has been eliminated by ${a.name}`, [], -1);
    addEvent(s, 'buildingCaptured', `${a.name} captured a City of ${me.name}`, [2, 1], -1);
    addEvent(s, 'buildingCaptured', `${a.name} captured a Farm of ${me.name}`, [2, 1], -1);
    addEvent(s, 'allianceFormed', `${me.name} and ${b.name} are now allies`, [1, 3], -1);
    addEvent(s, 'allianceFormed', `${me.name} and ${b.name} renewed their alliance`, [1, 3], -1);
    addEvent(s, 'researchDone', 'Something researched', [1], -1);
    h.update(s);
    h.update(s); // events count once
    // a capital taken without an attack seen (tanks, landings) still starts the war: first contact comes first
    expect(h.moments.filter((m) => m.kind === 'contact' || m.kind === 'war').map((m) => m.text)).toEqual([`First contact: ${a.name} attacks you`, `War: You attack ${b.name}`]);
    expect(h.moments.filter((m) => m.kind !== 'contact' && m.kind !== 'war').map((m) => m.text)).toEqual([
      `Your capital falls to ${a.name}`,
      `You take the capital of ${b.name}`,
      `${b.name} is eliminated by ${a.name}`,
      `${a.name} captures one of your cities`,
      `You ally with ${b.name}`,
    ]);
  });

  it('events from before the history started are not news', () => {
    const s = makeTestGame();
    addEvent(s, 'capitalLost', `${s.players[2].name} lost their capital`, [2], -1);
    const h = new GameHistory();
    h.update(s);
    expect(h.moments.length).toBe(0);
  });
});

describe('picking the moments for the timeline', () => {
  const m = (t: number, kind: Moment['kind'], players: number[]): Moment => ({ t, kind, text: `${kind} ${t}`, players });

  it('at most 8, in time order, yours first, never two crowded together', () => {
    const all: Moment[] = [];
    for (let i = 0; i < 30; i++) all.push(m(i * 20, 'war', [5, 6]));
    all.push(m(301, 'capital', [1]), m(302, 'alliance', [7, 8]), m(900, 'eliminated', [1]));
    const out = pickMoments(all, 1000, 1, 5, [5, 6]);
    expect(out.length).toBe(MAX_MOMENTS_SHOWN);
    expect(out.map((x) => x.t)).toEqual([...out.map((x) => x.t)].sort((p, q) => p - q));
    expect(out.some((x) => x.t === 301)).toBe(true); // your capital beats the others' alliance next to it
    expect(out.some((x) => x.t === 302)).toBe(false);
    expect(out.some((x) => x.t === 900)).toBe(true);
    for (let i = 1; i < out.length; i++) expect(out[i].t - out[i - 1].t).toBeGreaterThanOrEqual(1000 / 40);
  });

  it('summary of a played game: your line, the top nations, the table columns', () => {
    const s = makeTestGame({ aiCount: 7 });
    const h = new GameHistory();
    play(s, h, 40);
    s.winner = 2;
    s.phase = 'over';
    h.update(s);
    const d = buildSummary(s, h);
    expect(d.series.filter((x) => x.role === 'me').map((x) => x.id)).toEqual([1]);
    expect(d.series.filter((x) => x.role === 'top').length).toBe(5);
    expect(d.series[d.series.length - 1].role).toBe('me'); // drawn last, on top
    expect(d.columns.length).toBe(TABLE_COLUMNS);
    expect(d.columns[0]).toMatchObject({ id: 1, tag: 'You' });
    expect(d.columns[1]).toMatchObject({ id: 2, tag: 'Winner' });
    expect(d.duration).toBe(gameSeconds(s));
    expect(d.moments.length).toBeLessThanOrEqual(MAX_MOMENTS_SHOWN);
  });

  it('a spectator (no nation of its own) gets the top nations and the winner first', () => {
    const s = makeTestGame({ aiCount: 7 });
    s.humanId = 0;
    const h = new GameHistory();
    play(s, h, 30);
    s.winner = 3;
    s.phase = 'over';
    h.update(s);
    const d = buildSummary(s, h);
    expect(d.series.some((x) => x.role === 'me')).toBe(false);
    expect(d.columns[0]).toMatchObject({ id: 3, tag: 'Winner' });
    expect(d.columns.length).toBe(TABLE_COLUMNS);
  });
});
