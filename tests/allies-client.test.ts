// Client side of allies, heartland and the online pause (no DOM): the ally status line and target list, the radial
// "Ask allies" entry, and the host-only pause of the lockstep runner.
import { describe, expect, it } from 'vitest';
import { allyStatusOf, attackTargets, alliesOf, forceLimit, warsOf } from '../src/client/allies';
import { MpGame } from '../src/client/mpgame';
import type { ClientMessage, GameStartMsg } from '../src/net/protocol';
import { HASH_INTERVAL_TURNS } from '../src/net/protocol';
import type { NetClient } from '../src/net/client';
import { formAlliance } from '../src/sim/diplomacy';
import type { Attack, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame, testSettings } from './helpers';

/** Four nations side by side: 1 | 2 | 3 | 4 (each 10 x 20). */
function fourNations(): GameState {
  const s = makeFlatGame(40, 20, 4, { human: true });
  for (let id = 1; id <= 4; id++) claimRect(s, id, (id - 1) * 10, 0, id * 10 - 1, 19);
  s.humanId = 1;
  return s;
}
function war(s: GameState, attacker: number, target: number): void {
  s.attacks.push({ id: s.attacks.length + 1000, attacker, target, troops: { infantry: 100, armor: 0, artillery: 0 }, focusTile: 0 } as unknown as Attack);
}

describe('ally helpers', () => {
  it('lists allies, wars and the nations an ally can be asked to attack (enemies first)', () => {
    const s = fourNations();
    formAlliance(s, 1, 3);
    war(s, 1, 2);
    war(s, 4, 3);
    expect(alliesOf(s, 1)).toEqual([3]);
    expect([...warsOf(s, 1)]).toEqual([2]);
    expect([...warsOf(s, 3)]).toEqual([4]);
    // 2 borders us and is at war with us; 4 does not border us: not offered
    expect(attackTargets(s, 1, 3, (id) => id === 2)).toEqual([2]);
    const st = allyStatusOf(s, 1, 3);
    expect(st.text.length).toBeGreaterThan(0);
    expect(forceLimit()).toBeGreaterThan(1);
  });

  it('the radial menu on enemy land asks the best ally to attack there', async () => {
    const { radialSpec } = await import('../src/client/hud/radialSpec');
    const { defaultUiState } = await import('../src/client/uiState');
    const s = fourNations();
    const acts: unknown[] = [];
    const toasts: string[] = [];
    const ctx = {
      ui: defaultUiState(),
      state: () => s,
      me: () => s.players[1],
      act: (a: unknown) => {
        acts.push(a);
        return true;
      },
      confirm: () => {},
      toast: (t: string) => toasts.push(t),
      refreshSoon: () => {},
      openDrawer: () => {},
      closeDrawer: () => {},
      openNation: () => {},
      focusTile: () => {},
      sound: () => {},
    } as unknown as Parameters<typeof radialSpec>[0];
    const enemyTile = 5 * 40 + 15; // nation 2
    const ask = () => radialSpec(ctx, s, s.players[1], enemyTile).slices.find((x) => x.label === 'Ask allies')!;
    s.players[1].allyAskTick = 0;
    expect(ask().disabled).toMatch(/No allies/);
    formAlliance(s, 1, 3);
    formAlliance(s, 1, 4);
    const item = ask();
    expect(item.disabled).toBeUndefined();
    item.run!();
    // one request per cooldown: the ally most likely to say yes
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: 'requestAllyAttack', target: 2 });
    expect([3, 4]).toContain((acts[0] as { ally: number }).ally);
    expect(toasts[0]).toMatch(/^Asked .+ to attack /);
    // while the cooldown runs the entry says so
    s.players[1].allyAskTick = s.tick + 50;
    expect(ask().disabled).toMatch(/again in 5 s/);
  });
});

class FakeNet {
  sent: ClientMessage[] = [];
  online = true;
  send(m: ClientMessage): boolean {
    this.sent.push(m);
    return true;
  }
  reconnectNow(): void {}
}

const settings = testSettings({ seed: 99, aiCount: 1, tribeCount: 0, humans: [
  { name: 'Host', color: [52, 120, 246], team: 0 },
  { name: 'Guest', color: [230, 57, 70], team: 0 },
] });
function start(yourPlayerId: number): GameStartMsg {
  return {
    type: 'gameStart',
    code: 'PAUSED',
    mode: 'ffa',
    settings,
    playerSlots: [
      { playerId: 1, name: 'Host', color: [52, 120, 246], team: 0 },
      { playerId: 2, name: 'Guest', color: [230, 57, 70], team: 0 },
    ],
    teams: null,
    yourPlayerId,
    startTurn: 0,
    turnsPlayed: 0,
    turnMs: 100,
    hashInterval: HASH_INTERVAL_TURNS,
  };
}

describe('online pause (client)', () => {
  it('only the private host sends setPause; pauseState from the server pauses everyone', async () => {
    const hostNet = new FakeNet();
    const host = new MpGame(hostNet as unknown as NetClient, start(1));
    await host.loading;
    expect(host.setPause(true)).toBe(false); // not the host of a private game
    host.canStartNow = true;
    host.isPrivate = true;
    expect(host.canPause).toBe(true);
    expect(host.setPause(true)).toBe(true);
    expect(hostNet.sent).toContainEqual({ type: 'setPause', paused: true });
    expect(host.paused).toBe(true);
    expect(host.pausedByName()).toBe('you');

    const guestNet = new FakeNet();
    const guest = new MpGame(guestNet as unknown as NetClient, start(2));
    await guest.loading;
    guest.isPrivate = true;
    expect(guest.canPause).toBe(false);
    expect(guest.setPause(true)).toBe(false);
    expect(guestNet.sent).toEqual([]);
    guest.handle({ type: 'pauseState', paused: true, by: 1, host: 1 });
    expect(guest.paused).toBe(true);
    expect(guest.pausedByName()).toBe('Host');
    guest.handle({ type: 'pauseState', paused: false, by: 1, host: 1 });
    // the host role passes to the guest (the host stayed away): now it may pause
    guest.handle({ type: 'pauseState', paused: false, by: 0, host: 2 });
    expect(guest.canPause).toBe(true);
    expect(guest.paused).toBe(false);
  });
});
