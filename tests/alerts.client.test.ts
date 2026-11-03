// Alerts (client, no DOM): which sim events become alerts and with what words, the feed that merges repeats and
// keeps a kind from flooding the screen, the watch for what the sim has no event for (capital in danger, land falling
// fast, a warship gone), and that the watch's reads between ticks leave the sim alone (lockstep).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { requestAllyAttack } from '../src/sim/allies';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { addEvent, setOwner } from '../src/sim/state';
import type { GameEvent, GameState, Unit } from '../src/sim/types';
import {
  ALERT_LOG,
  ALERT_MERGE_MS,
  ALERT_RULES,
  AlertFeed,
  AlertWatch,
  CAPITAL_REPEAT_S,
  alertFromEvent,
  capitalThreat,
  isShipLossAlert,
  unreadBadge,
  type AlertSpec,
} from '../src/client/alerts';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

/** 1 (human, "Tester") | 2 | 3, each 10 x 20. */
function threeNations(): GameState {
  const s = makeFlatGame(30, 20, 3, { human: true });
  for (let id = 1; id <= 3; id++) claimRect(s, id, (id - 1) * 10, 0, id * 10 - 1, 19);
  s.humanId = 1;
  s.tick = 30 * TICKS_PER_SECOND;
  return s;
}
const lastEvent = (s: GameState): GameEvent => s.events[s.events.length - 1];
const ev = (s: GameState, kind: GameEvent['kind'], message: string, players: number[], tile = 5): GameEvent => ({ tick: s.tick, kind, message, players, tile });

describe('alerts from sim events', () => {
  it('an attack on you (from the real attack action) names the attacker', () => {
    const s = threeNations();
    const me = s.players[1];
    const r = applyAction(s, 2, { type: 'attack', tile: 9 * 30 + 9, troops: { infantry: 500, armor: 0, artillery: 0 } });
    expect(r.ok).toBe(true);
    const e = s.events.find((x) => x.kind === 'underAttack')!;
    const a = alertFromEvent(s, me, e)!;
    expect(a).toMatchObject({ kind: 'war', text: 'AI 2 attacks you', key: 'war:AI 2' });
    expect(a.tile).toBeGreaterThanOrEqual(0);
    // our own attack is no alert
    applyAction(s, 1, { type: 'attack', tile: 5 * 30 + 10, troops: { infantry: 500, armor: 0, artillery: 0 } });
    for (const x of s.events.filter((x) => x.players.includes(1) && x.kind !== 'underAttack')) expect(alertFromEvent(s, me, x)).toBeNull();
  });

  it('an ally asking for help (real request) is an alert; events for others are not', () => {
    const s = threeNations();
    s.players[2].isHuman = true;
    formAlliance(s, 1, 2);
    expect(requestAllyAttack(s, 2, 1, 3).ok).toBe(true);
    const a = alertFromEvent(s, s.players[1], lastEvent(s))!;
    expect(a).toMatchObject({ kind: 'ally', text: 'AI 2 asks you to attack AI 3' });
    expect(alertFromEvent(s, s.players[3], lastEvent(s))).toBeNull();
  });

  it('bombs, rockets and watchtower sightings on their way to you', () => {
    const s = threeNations();
    const me = s.players[1];
    expect(alertFromEvent(s, me, ev(s, 'missile', 'AI 2 launched an atom bomb at Tester', [2, 1]))).toMatchObject({ kind: 'incoming', text: 'Atom bomb incoming from AI 2', icon: 'atom' });
    expect(alertFromEvent(s, me, ev(s, 'missile', 'AI 3 launched a rocket at Tester', [3, 1]))).toMatchObject({ text: 'Rocket incoming from AI 3', icon: 'rocket' });
    // ours, and the impact report, stay toasts
    expect(alertFromEvent(s, me, ev(s, 'missile', 'Tester launched a rocket at AI 2', [1, 2]))).toBeNull();
    expect(alertFromEvent(s, me, ev(s, 'missile', 'Rocket strike by AI 2: 1 building destroyed, 40 troops killed', [2, 1]))).toBeNull();
    expect(alertFromEvent(s, me, ev(s, 'underAttack', 'Watchtower: an enemy bomber of AI 2 is approaching your land', [1]))).toMatchObject({ kind: 'incoming', text: "AI 2's bomber is heading for your land", icon: 'bomb' });
    expect(alertFromEvent(s, me, ev(s, 'underAttack', 'Watchtower: an enemy transport (1200 troops) of AI 3 is approaching your land', [1]))?.text).toBe("AI 3's landing is on its way: 1200 troops");
    expect(alertFromEvent(s, me, ev(s, 'underAttack', 'Watchtower: an enemy cargo plane (300 paratroopers) of AI 3 is approaching your land', [1]))?.text).toBe("AI 3's paratroopers are on their way: 300");
    // a sighting near (not over) your land is an info event: no alert
    expect(alertFromEvent(s, me, ev(s, 'info', 'Watchtower: an enemy bomber of AI 2 is approaching', [1]))).toBeNull();
  });

  it('ships and tank divisions lost (the sim messages of units.ts, specials.ts and tanks.ts)', () => {
    const s = threeNations();
    const me = s.players[1];
    const sunk = alertFromEvent(s, me, ev(s, 'unitLost', "Tester lost a warship to AI 2's warship", [1, 2]));
    expect(sunk).toMatchObject({ kind: 'ship', text: 'AI 2 sank your warship' });
    expect(isShipLossAlert(sunk)).toBe(true);
    const tr = alertFromEvent(s, me, ev(s, 'unitLost', "Tester lost a transport with 800 troops to AI 2's warship", [1, 2]));
    expect(tr?.text).toBe('AI 2 sank your transport: 800 troops lost');
    expect(isShipLossAlert(tr)).toBe(false); // the watch only counts warships
    expect(alertFromEvent(s, me, ev(s, 'unitLost', "Tester lost a trade ship to AI 2's warship", [1, 2]))).toBeNull();
    expect(alertFromEvent(s, me, ev(s, 'unitLost', "Tester's warship hit a mine off AI 3's coast and sank", [1, 3]))?.text).toBe("Your warship hit a mine off AI 3's coast and sank");
    expect(alertFromEvent(s, me, ev(s, 'unitLost', "Tester's tank division was overrun and fell back", [1]))).toMatchObject({ kind: 'tanks', text: 'Your tank division was overrun' });
    expect(alertFromEvent(s, me, ev(s, 'unitLost', "Tester's tank division was stranded in the water and fell back", [1]))?.text).toBe('Your tank division was stranded in the water');
    expect(alertFromEvent(s, me, ev(s, 'unitLost', 'Tester lost a tank division being built: its factory is gone (the troops went home)', [1]))?.kind).toBe('tanks');
    // the one who sank it gets no alert
    expect(alertFromEvent(s, s.players[2], ev(s, 'unitLost', "Tester lost a warship to AI 2's warship", [1, 2]))).toBeNull();
  });

  it('your capital falling (real event)', () => {
    const s = threeNations();
    const me = s.players[1];
    addEvent(s, 'capitalLost', `${me.name} lost their capital to AI 2`, [1, 2], me.capital);
    expect(alertFromEvent(s, me, lastEvent(s))).toMatchObject({ kind: 'capital', text: 'You lost your capital to AI 2' });
    expect(alertFromEvent(s, s.players[2], lastEvent(s))).toBeNull();
  });
});

describe('alert feed', () => {
  const spec = (kind: AlertSpec['kind'], key: string, text = key, tile = 1): AlertSpec => ({ kind, key, text, tile });

  it('merges a repeat into one entry with a count, the latest text and spot', () => {
    const f = new AlertFeed();
    const a = f.push(spec('war', 'war:A', 'A attacks you', 10), 0, 1);
    expect(a.fresh).toBe(true);
    const b = f.push(spec('war', 'war:A', 'A attacks you', 20), 10_000, 2);
    expect(b.fresh).toBe(false);
    expect(b.entry).toBe(a.entry);
    expect(b.entry).toMatchObject({ count: 2, tile: 20, tick: 2 });
    expect(f.log.length).toBe(1);
    expect(f.unread).toBe(1);
    // long after: a new entry
    expect(f.push(spec('war', 'war:A'), 10_000 + ALERT_MERGE_MS + 1, 3).fresh).toBe(true);
    expect(f.log.length).toBe(2);
  });

  it('rate limit: another story of a kind right after the last one joins it under the kind\'s summary', () => {
    const f = new AlertFeed();
    f.push(spec('war', 'war:A', 'A attacks you'), 0, 1);
    const b = f.push(spec('war', 'war:B', 'B attacks you'), ALERT_RULES.war.gapMs - 1, 2);
    expect(b.fresh).toBe(false);
    expect(b.entry).toMatchObject({ count: 2, text: ALERT_RULES.war.group });
    const c = f.push(spec('war', 'war:C', 'C attacks you'), ALERT_RULES.war.gapMs + 100, 3);
    expect(c.entry.count).toBe(3); // still within the gap after the joined one
    // after the gap: its own entry again
    expect(f.push(spec('war', 'war:D', 'D attacks you'), 3 * ALERT_RULES.war.gapMs, 4).entry.text).toBe('D attacks you');
    // other kinds never join
    expect(f.push(spec('ship', 'ship:A'), 3 * ALERT_RULES.war.gapMs, 5).fresh).toBe(true);
  });

  it('keeps the last ALERT_LOG, newest first; counts unread until the log is opened', () => {
    const f = new AlertFeed();
    for (let k = 0; k < ALERT_LOG + 5; k++) f.push(spec('capital', `c${k}`), k * 100_000, k);
    expect(f.log.length).toBe(ALERT_LOG);
    expect(f.log[0].key).toBe(`c${ALERT_LOG + 4}`);
    expect(f.unread).toBe(ALERT_LOG); // entries with news, not pushes
    expect(unreadBadge(f.unread)).toBe('9+');
    const v = f.version;
    f.markRead();
    expect(f.unread).toBe(0);
    expect(f.version).toBeGreaterThan(v);
    expect(unreadBadge(0)).toBe('');
    expect(unreadBadge(3)).toBe('3');
  });
});

describe('alert watch', () => {
  const warOn = (s: GameState, attacker: number, target: number): void => {
    s.attacks.push({ id: 900 + attacker, attacker, target, troops: { infantry: 500, armor: 0, artillery: 0 }, focusTile: 9, progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 });
  };

  it('capital: once when an attacker gets close, again after CAPITAL_REPEAT_S while it lasts', () => {
    const s = threeNations();
    const me = s.players[1];
    const w = new AlertWatch();
    expect(w.look(s, me)).toEqual([]); // first look: stock only
    warOn(s, 2, 1);
    expect(capitalThreat(s, me)).toBe(false); // the front is far away
    const cx = me.capital % 30;
    const cy = (me.capital / 30) | 0;
    setOwner(s, cy * 30 + cx + 3, 2);
    expect(capitalThreat(s, me)).toBe(true);
    s.tick++;
    const a = w.look(s, me);
    expect(a).toEqual([expect.objectContaining({ kind: 'capital', text: 'Your capital is under attack', tile: me.capital })]);
    s.tick += TICKS_PER_SECOND;
    expect(w.look(s, me).filter((x) => x.kind === 'capital')).toEqual([]);
    s.tick += CAPITAL_REPEAT_S * TICKS_PER_SECOND;
    expect(w.look(s, me).filter((x) => x.kind === 'capital').length).toBe(1);
    // a nation not at war with us next to the capital is no alarm
    s.attacks.length = 0;
    expect(capitalThreat(s, me)).toBe(false);
  });

  it('land falling fast, then quiet for a while', () => {
    const s = threeNations();
    const me = s.players[1];
    const w = new AlertWatch();
    w.look(s, me);
    warOn(s, 2, 1);
    s.tick += TICKS_PER_SECOND;
    // small losses: nothing
    for (let x = 9; x >= 8; x--) setOwner(s, 0 * 30 + x, 2);
    expect(w.look(s, me).filter((a) => a.kind === 'land')).toEqual([]);
    // 40 more tiles within a few seconds
    for (let y = 0; y < 20; y++) for (const x of [7, 6]) setOwner(s, y * 30 + x, 2);
    s.tick += 3 * TICKS_PER_SECOND;
    const a = w.look(s, me).filter((x) => x.kind === 'land');
    expect(a.length).toBe(1);
    expect(a[0].text).toMatch(/^You lost 4\d tiles in 10 s$/);
    expect(a[0].tile).toBe(9); // the attack's anchor
    for (let y = 0; y < 20; y++) for (const x of [5, 4]) setOwner(s, y * 30 + x, 2);
    s.tick += TICKS_PER_SECOND;
    expect(w.look(s, me).filter((x) => x.kind === 'land')).toEqual([]);
  });

  it('a warship gone: an alert unless an event already said so', () => {
    const s = threeNations();
    const me = s.players[1];
    const ship = (id: number): Unit => ({ id, type: 'warship', owner: 1, x: 3, y: 4, hp: 10 }) as unknown as Unit;
    s.units.push(ship(1), ship(2));
    const w = new AlertWatch();
    w.look(s, me);
    s.units = s.units.filter((u) => u.id !== 1);
    w.noteShipEvent(); // "AI 2 sank your warship" was shown
    expect(w.look(s, me)).toEqual([]);
    s.units = [];
    const a = w.look(s, me);
    expect(a).toEqual([expect.objectContaining({ kind: 'ship', text: 'You lost a warship', tile: 4 * 30 + 3 })]);
  });

  it('lockstep: looking between ticks does not change the sim', async () => {
    const make = (): GameState =>
      makeTestGame({ seed: 91, aiCount: 5, mapType: 'continents', mapSize: 'small', mods: { research: 'allUnlocked', startingGold: 'veryHigh', fastGame: true } });
    const quiet = make();
    const watched = make();
    const w = new AlertWatch();
    let diverged = -1;
    let alerts = 0;
    for (let k = 0; k < 1500 && diverged < 0; k++) {
      if (k % 200 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // the HUD looks with the next tick's number, before that tick runs
      for (const p of watched.players) if (p.id > 0 && p.alive) alerts += (p.id === 1 ? w.look(watched, p) : new AlertWatch().look(watched, p)).length;
      tick(quiet);
      tick(watched);
      if (hashState(quiet) !== hashState(watched)) diverged = quiet.tick;
    }
    expect(diverged).toBe(-1);
    expect(alerts).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
