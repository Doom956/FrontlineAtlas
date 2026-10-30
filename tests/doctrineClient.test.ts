// Client doctrine helpers (no DOM): what the picker, the top-right button and the nation card read from the sim.
import { describe, expect, it } from 'vitest';
import { DOCTRINES, DOCTRINE_UNLOCK_SECONDS, TICKS_PER_SECOND } from '../src/sim/config';
import { applyAction } from '../src/sim/actions';
import { choiceInfo, doctrineIcon, doctrineStatus, fmtDuration, knownDoctrine, levelUpText, DOCTRINE_ORDER } from '../src/client/doctrineView';
import { hasLineIcon } from '../src/client/hud/glyph';
import { claimRect, makeFlatGame } from './helpers';

function game() {
  const s = makeFlatGame(40, 20, 3, { human: true });
  claimRect(s, 1, 0, 0, 9, 9);
  claimRect(s, 2, 10, 0, 19, 9); // borders player 1
  claimRect(s, 3, 30, 10, 39, 19); // far away
  return s;
}
const toUnlock = (s: ReturnType<typeof game>) => {
  s.tick = s.playStartTick + DOCTRINE_UNLOCK_SECONDS * TICKS_PER_SECOND;
};

describe('doctrine view', () => {
  it('has a line icon for every doctrine', () => {
    for (const id of DOCTRINE_ORDER) expect(hasLineIcon(doctrineIcon(id))).toBe(true);
  });

  it('is locked before the unlock and says when it opens', () => {
    const s = game();
    const me = s.players[1];
    expect(doctrineStatus(s, me).phase).toBe('locked');
    const c = choiceInfo(s, me, 'blitz');
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('Doctrines unlock at 5:00');
  });

  it('first choice is free; a switch shows its price, the adapt time and the cooldown', () => {
    const s = game();
    const me = s.players[1];
    toUnlock(s);
    expect(doctrineStatus(s, me).phase).toBe('none');
    const first = choiceInfo(s, me, 'blitz');
    expect(first).toMatchObject({ ok: true, switching: false, cost: 0, label: 'Choose Blitz' });
    expect(applyAction(s, 1, { type: 'chooseDoctrine', doctrine: 'blitz' }).ok).toBe(true);
    const st = doctrineStatus(s, me);
    expect(st).toMatchObject({ phase: 'active', id: 'blitz', level: 1 });
    expect(st.nextLevelIn).toBeCloseTo(360);
    expect(choiceInfo(s, me, 'blitz').reason).toBe('This is your doctrine');
    // cooldown first, then the price
    expect(choiceInfo(s, me, 'siege').reason).toMatch(/^You can switch again in /);
    s.tick += 121 * TICKS_PER_SECOND;
    me.gold = 0;
    const sw = choiceInfo(s, me, 'siege');
    expect(sw.switching).toBe(true);
    expect(sw.label).toBe('Switch to Siege');
    expect(sw.line).toMatch(/^Switch: .+ gold, 45 s without a doctrine; then 2 min cooldown$/);
    expect(sw.reason).toMatch(/^Needs .+ gold, you have 0$/);
    me.gold = sw.cost;
    expect(choiceInfo(s, me, 'siege').ok).toBe(true);
    expect(applyAction(s, 1, { type: 'chooseDoctrine', doctrine: 'siege' }).ok).toBe(true);
    const ad = doctrineStatus(s, me);
    expect(ad.phase).toBe('adapting');
    expect(ad.adaptLeft).toBeCloseTo(45);
    expect(ad.adaptDone).toBeCloseTo(0);
  });

  it('shows another nation’s doctrine only to neighbours (or with intel)', () => {
    const s = game();
    toUnlock(s);
    for (const id of [2, 3]) s.players[id].doctrine = { id: 'naval', level: 2, chosenTick: 0, adaptUntilTick: 0, lastSwitchTick: 0 };
    expect(knownDoctrine(s, 1, 2)).toMatchObject({ id: 'naval', level: 2, adapting: false });
    expect(knownDoctrine(s, 1, 3)).toBeNull();
  });

  it('writes plain texts', () => {
    expect(fmtDuration(45)).toBe('45 s');
    expect(fmtDuration(120)).toBe('2 min');
    expect(fmtDuration(479)).toBe('7:59');
    const t = levelUpText('blitz', 3);
    expect(t.startsWith('Blitz level 3: ')).toBe(true);
    expect(t.endsWith('.')).toBe(false);
    expect(DOCTRINES.blitz.levels).toHaveLength(3);
  });
});
