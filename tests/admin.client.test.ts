// Owner console, client side (src/client/admin.ts, adminConsole.ts helpers, mpgame.ts): the server-checked code
// (single player over HTTP), the terminal line, the session unlock, the online login through the server, the actions the console sends (valid for the server and the
// sim, deterministic), and continuing a finished online game from the client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_AUTH_TIMEOUT_MS, ADMIN_CHECK_TIMEOUT_MS, adminCheckUrl, checkAdminCode, isUnlocked, requestAdminAuth, setUnlocked, type AdminNet } from '../src/client/admin';
import { adminAction, isConsoleHotkey, QUICK_STEP, RESOURCE_KEYS, TerminalLine } from '../src/client/adminConsole';
import { continueLabel, winnerText } from '../src/client/hud/gameOverContinue';
import { MpGame } from '../src/client/mpgame';
import type { NetClient } from '../src/net/client';
import { HASH_INTERVAL_TURNS } from '../src/net/protocol';
import type { ClientMessage, GameStartMsg } from '../src/net/protocol';
import { applyAction } from '../src/sim/actions';
import { ADMIN_OP_LIST, validateAdmin } from '../src/sim/admin';
import { markBuildingsChanged } from '../src/sim/buildings';
import { hashState } from '../src/sim/hash';
import { newId } from '../src/sim/state';
import type { Action, AdminAction, AdminOp, Building, BuildingType, GameState } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, testSettings } from './helpers';

describe('console code (single player asks the server)', () => {
  const URL_OK = 'https://srv.example/api/admin-check';
  afterEach(() => vi.unstubAllGlobals());
  const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Partial<Response>>) => {
    const f = vi.fn(impl as unknown as typeof fetch);
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('the check address comes from the server URL of the multiplayer client', () => {
    expect(adminCheckUrl('wss://frontline-atlas.onrender.com/ws')).toBe('https://frontline-atlas.onrender.com/api/admin-check');
    expect(adminCheckUrl('ws://localhost:8097/ws?x=1')).toBe('http://localhost:8097/api/admin-check');
    expect(adminCheckUrl(null)).toBeNull();
    expect(adminCheckUrl('ftp://x/ws')).toBeNull();
  });
  it('posts the code as JSON and unlocks only on {ok:true}', async () => {
    const f = stubFetch(async (_u, init) => ({ ok: true, json: async () => ({ ok: JSON.parse(String(init.body)).code === 'test-code' }) }));
    expect(await checkAdminCode('test-code', URL_OK)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'test-code' });
    for (const c of ['', 'test', 'test-code ', 'TEST-CODE']) expect(await checkAdminCode(c, URL_OK)).toBe(false);
    expect(f).toHaveBeenCalledTimes(4); // the empty code never leaves the page
  });
  it('wrong answers, http errors, bad bodies and network failures are all just false', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ok: false }) }));
    expect(await checkAdminCode('x', URL_OK)).toBe(false);
    stubFetch(async () => ({ ok: true, json: async () => ({ ok: 'true' }) }));
    expect(await checkAdminCode('x', URL_OK)).toBe(false);
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({ ok: true }) }));
    expect(await checkAdminCode('x', URL_OK)).toBe(false);
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await checkAdminCode('x', URL_OK)).toBe(false);
    stubFetch(async () => ({ ok: true, json: async () => Promise.reject(new Error('bad json')) }));
    expect(await checkAdminCode('x', URL_OK)).toBe(false);
    expect(await checkAdminCode('x', null)).toBe(false);
  });
  it('waits for a sleeping server (75 s) and gives up after that', async () => {
    expect(ADMIN_CHECK_TIMEOUT_MS).toBe(75_000);
    vi.useFakeTimers();
    try {
      stubFetch((_u, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
      const p = checkAdminCode('x', URL_OK);
      let settled = false;
      void p.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(74_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Just enough DOM for el() and TerminalLine (the test environment is node). */
function fakeDom() {
  type Handler = (e: Record<string, unknown>) => void;
  class FakeEl {
    className = '';
    textContent = '';
    value = '';
    type = 'text';
    readOnly = false;
    name = '';
    maxLength = -1;
    autocomplete = '';
    spellcheck = true;
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    children: FakeEl[] = [];
    handlers = new Map<string, Handler[]>();
    focused = false;
    classList = {
      contains: (c: string) => this.className.split(' ').includes(c),
      add: (c: string) => void (this.classList.contains(c) || (this.className = `${this.className} ${c}`.trim())),
      remove: (c: string) => void (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
      toggle: (c: string, on?: boolean) => void ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
    };
    constructor(public tag: string) {}
    append(...k: FakeEl[]) {
      this.children.push(...k);
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    addEventListener(t: string, h: Handler) {
      this.handlers.set(t, [...(this.handlers.get(t) ?? []), h]);
    }
    focus() {
      fake.active = this;
      this.focused = true;
    }
    blur() {
      if (fake.active === this) fake.active = null;
      this.focused = false;
    }
    fire(t: string, e: Record<string, unknown> = {}) {
      const ev = { stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...e };
      for (const h of this.handlers.get(t) ?? []) h(ev);
      return ev as typeof ev & { stopped: boolean; prevented: boolean };
    }
  }
  const fake = {
    active: null as FakeEl | null,
    Cls: FakeEl,
    install() {
      vi.stubGlobal('document', {
        createElement: (tag: string) => new FakeEl(tag),
        get activeElement() {
          return fake.active;
        },
      });
    },
  };
  return fake;
}

describe('terminal line (what the owner sees while typing)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const make = () => {
    const dom = fakeDom();
    dom.install();
    const calls = { submit: 0, escape: 0 };
    const line = new TerminalLine({ submit: () => calls.submit++, escape: () => calls.escape++ });
    const input = line.input as unknown as InstanceType<typeof dom.Cls>;
    return { dom, line, input, root: line.el as unknown as InstanceType<typeof dom.Cls>, calls };
  };

  it('the input is a password field (masked dots, readable colour) with the bare label and no other hints', () => {
    const { input, root } = make();
    expect(input.type).toBe('password');
    expect(input.attrs['aria-label']).toBe('terminal line');
    expect(input.autocomplete).toBe('off');
    const label = root.children.find((c) => c.className === 'adm-lbl');
    expect(label?.textContent).toBe('terminal line');
    expect(root.children.map((c) => c.textContent).filter((t) => t && t !== '…' && t !== 'terminal line')).toEqual([]);
  });
  it('opens with the caret in the input, even if the focus was elsewhere (clicked the map)', () => {
    const { dom, line, input, root } = make();
    const other = new dom.Cls('canvas');
    other.focus();
    expect(root.classList.contains('hidden')).toBe(true);
    line.open();
    expect(root.classList.contains('hidden')).toBe(false);
    expect(dom.active).toBe(input);
    expect(line.isOpen).toBe(true);
    line.close();
    expect(dom.active).toBeNull();
    expect(line.isOpen).toBe(false);
  });
  it('re-takes focus on the next frame when the click that came with the hotkey stole it', () => {
    const { dom, line, input } = make();
    let frame: (() => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => void (frame = f));
    line.open();
    new dom.Cls('canvas').focus();
    frame!();
    expect(dom.active).toBe(input);
  });
  it('clicking the line puts the caret back in the input', () => {
    const { dom, line, root, input } = make();
    line.open();
    new dom.Cls('canvas').focus();
    const ev = root.fire('pointerdown', { target: root });
    expect(ev.prevented).toBe(true);
    expect(dom.active).toBe(input);
  });
  it('keys typed in the line never reach the game; Enter submits, Esc closes', () => {
    const { input, calls } = make();
    for (const t of ['keydown', 'keyup', 'keypress']) expect(input.fire(t, { key: 'w' }).stopped).toBe(true);
    input.fire('keydown', { key: 'Enter' });
    input.fire('keydown', { key: 'Escape' });
    expect(calls).toEqual({ submit: 1, escape: 1 });
  });
  it('waiting shows "…", clears the dots, keeps the focus; a wrong answer leaves an empty line', () => {
    const { dom, line, input, root } = make();
    line.open();
    input.value = 'secret';
    line.setBusy(true);
    const wait = root.children.find((c) => c.textContent === '…')!;
    expect(wait.classList.contains('hidden')).toBe(false);
    expect(input.value).toBe('');
    expect(input.readOnly).toBe(true);
    expect(dom.active).toBe(input);
    line.setBusy(false);
    expect(wait.classList.contains('hidden')).toBe(true);
    expect(input.readOnly).toBe(false);
  });
});

describe('session unlock', () => {
  const g = globalThis as unknown as { sessionStorage?: unknown };
  afterEach(() => {
    delete g.sessionStorage;
  });
  it('lasts for the browser session, single player and online apart', () => {
    const data = new Map<string, string>();
    g.sessionStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
    expect(isUnlocked('local')).toBe(false);
    setUnlocked('local', true);
    expect(isUnlocked('local')).toBe(true);
    expect(isUnlocked('online')).toBe(false);
    setUnlocked('online', true);
    setUnlocked('local', false);
    expect(isUnlocked('local')).toBe(false);
    expect(isUnlocked('online')).toBe(true);
  });
  it('blocked or missing storage just forgets (no throw)', () => {
    expect(isUnlocked('local')).toBe(false);
    g.sessionStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => setUnlocked('local', true)).not.toThrow();
    expect(isUnlocked('local')).toBe(false);
  });
});

/** A network stand-in: records what was sent; `answer` decides the server's reply (undefined = silent). */
function fakeNet(answer: ((code: string) => boolean | undefined) | null, online = true) {
  const sent: { type: 'adminAuth'; code: string }[] = [];
  const listeners = new Set<(m: { type: string; ok?: boolean }) => void>();
  const net: AdminNet = {
    send: (m) => {
      if (!online) return false;
      sent.push(m);
      const ok = answer?.(m.code);
      if (ok !== undefined) setTimeout(() => listeners.forEach((f) => f({ type: 'adminAuth', ok })), 1);
      return true;
    },
    on: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  };
  return { net, sent, listeners };
}

describe('console login online (the server decides)', () => {
  it('sends adminAuth and unlocks only on the server ok', async () => {
    const { net, sent, listeners } = fakeNet((c) => c === 'right');
    expect(await requestAdminAuth(net, 'right')).toBe(true);
    expect(await requestAdminAuth(net, 'wrong')).toBe(false);
    expect(sent).toEqual([
      { type: 'adminAuth', code: 'right' },
      { type: 'adminAuth', code: 'wrong' },
    ]);
    expect(listeners.size).toBe(0); // listeners removed after the answer
  });
  it('a silent server (rate limit) or no connection counts as wrong', async () => {
    const silent = fakeNet(() => undefined);
    expect(await requestAdminAuth(silent.net, 'x', 20)).toBe(false);
    expect(silent.listeners.size).toBe(0);
    const off = fakeNet(() => true, false);
    expect(await requestAdminAuth(off.net, 'x')).toBe(false);
    expect(await requestAdminAuth(off.net, '')).toBe(false);
    expect(ADMIN_AUTH_TIMEOUT_MS).toBeGreaterThan(1000);
  });
});

describe('console hotkey', () => {
  it('is the pipe key on any layout', () => {
    expect(isConsoleHotkey({ key: '|', code: 'Backslash', shiftKey: true })).toBe(true);
    expect(isConsoleHotkey({ key: '|', code: 'IntlBackslash', shiftKey: false })).toBe(true); // e.g. a layout with | on its own key
    expect(isConsoleHotkey({ key: "'", code: 'Backslash', shiftKey: true })).toBe(true); // Shift+Backslash where it prints something else
    expect(isConsoleHotkey({ key: '\\', code: 'Backslash', shiftKey: false })).toBe(false);
    expect(isConsoleHotkey({ key: '|', code: 'Backslash', shiftKey: true, ctrlKey: true })).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ the console's actions

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** 60 x 30: player 1 (human) x 0..19, player 2 x 20..39, player 3 x 40..59; a factory and an airfield of player 1. */
function world(): GameState {
  const s = makeFlatGame(60, 30, 3, { human: true, seed: 11 });
  claimRect(s, 1, 0, 0, 19, 29);
  claimRect(s, 2, 20, 0, 39, 29);
  claimRect(s, 3, 40, 0, 59, 29);
  s.humanId = 1;
  addBuilding(s, 'factory', 1, at(s, 5, 5));
  addBuilding(s, 'airfield', 1, at(s, 8, 8));
  return s;
}

/** One console action per op, with the fields the console sends (adminConsole.ts). */
function consoleActions(s: GameState): Action[] {
  const t = (x: number, y: number) => at(s, x, y);
  const list: [AdminOp, Parameters<typeof adminAction>[1]][] = [
    ['setResource', { player: 2, key: 'gold', amount: 12345 }],
    ['addResource', { player: 1, key: 'science', amount: QUICK_STEP.science }],
    ['setTroops', { player: 2, troops: { infantry: 1000, armor: 500, artillery: 100 } }],
    ['addTroops', { player: 1, troops: { infantry: 50000, armor: 0, artillery: 0 } }],
    ['fillTroops', { player: 1 }],
    ['unlockAllTechs', { player: 3 }],
    ['unlockTech', { player: 1, key: 'navigation' }],
    ['removeTech', { player: 3, key: 'navigation' }],
    ['finishResearch', { player: 1 }],
    ['finishConstructions', { player: 1 }],
    ['placeBuilding', { player: 1, key: 'city', tile: t(3, 20), amount: 4 }],
    ['deleteBuilding', { tile: t(5, 5) }],
    ['setBuildingLevel', { tile: t(8, 8), amount: 3 }],
    ['giveWarships', { tile: t(3, 20), amount: 2 }],
    ['giveAircraft', { tile: t(8, 8), key: 'bomber', amount: 3 }],
    ['giveCharges', { tile: t(8, 8) }],
    ['spawnWarship', { player: 1, tile: t(3, 20) }],
    ['spawnTankDivision', { player: 1, tile: t(10, 10) }],
    ['paintTiles', { player: 1, tile: t(22, 10), amount: 3 }],
    ['neutralizeTiles', { tile: t(45, 10), amount: 2 }],
    ['moveCapital', { player: 1, tile: t(12, 12) }],
    ['forceAlliance', { player: 1, other: 2 }],
    ['breakAlliance', { player: 1, other: 2 }],
    ['declareWar', { player: 3, other: 2 }],
    ['setOpinion', { player: 2, other: 1, amount: 75 }],
    ['aiPassive', { player: 1, flag: true }],
    ['freezeAI', { flag: true }],
    ['setDifficulty', { key: 'hard' }],
    ['godMode', { player: 1, flag: true }],
    ['setDoctrine', { player: 1, key: 'blitz', amount: 2 }],
    ['eliminate', { player: 3 }],
    ['revive', { player: 3, tile: t(50, 20), amount: 50000 }],
    ['setPeace', { amount: 300 }],
    ['revealIntel', { player: 1, flag: true }],
  ];
  // every op the sim knows is covered
  expect(new Set(list.map(([op]) => op))).toEqual(new Set(ADMIN_OP_LIST));
  return list.map(([op, f]) => adminAction(op, f));
}

describe('console actions', () => {
  it('drops undefined fields and keeps the shape the sim expects', () => {
    expect(adminAction('fillTroops', { player: undefined })).toEqual({ type: 'admin', op: 'fillTroops' });
    expect(adminAction('setResource', { player: 2, key: 'gold', amount: 5 })).toEqual({ type: 'admin', op: 'setResource', player: 2, key: 'gold', amount: 5 });
    expect(RESOURCE_KEYS).toEqual(['gold', 'iron', 'oil', 'science']);
  });

  it('every op the console sends passes the server check and the sim check', () => {
    const s = world();
    for (const a of consoleActions(s)) {
      const v = validateAction(a);
      expect(v.ok, `${(a as AdminAction).op}: ${v.ok ? '' : v.error}`).toBe(true);
      if (v.ok) expect(v.value).toEqual(a); // nothing dropped on the way
      expect(validateAdmin(s, a as AdminAction), (a as AdminAction).op).toBeNull();
    }
  });

  it('applied in order on two clients, they give the same state', () => {
    const a = world();
    const b = world();
    const results: boolean[] = [];
    for (const s of [a, b]) {
      for (const act of consoleActions(s)) results.push(applyAction(s, 1, act).ok);
    }
    expect(results.slice(0, results.length / 2)).toEqual(results.slice(results.length / 2));
    expect(results.filter(Boolean).length).toBeGreaterThan(25);
    expect(hashState(a)).toBe(hashState(b));
    // and the effects are there
    expect(a.players[2].gold).toBe(12345);
    expect(a.settings.difficulty).toBe('hard');
    expect(a.admin?.godMode).toContain(1);
  });
});

// ------------------------------------------------------------------------------------------------ online client

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
    code: 'CONT',
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

describe('continue and console online (client)', () => {
  it('only the private host may continue once the server confirmed the end; gameContinued clears it', async () => {
    const hostNet = new FakeNet();
    const host = new MpGame(hostNet as unknown as NetClient, start(1));
    await host.loading;
    host.canStartNow = true;
    host.isPrivate = true;
    expect(host.continueRole()).toBe('none'); // still playing
    host.state!.phase = 'over';
    expect(host.continueRole()).toBe('pending');
    host.handle({ type: 'gameOver', reason: 'finished', winner: 1, turn: 10, continuable: true });
    expect(host.continueRole()).toBe('host');
    expect(host.dispatch({ type: 'attack', tile: 0, troops: { infantry: 1, armor: 0, artillery: 0 } }).ok).toBe(false);
    expect(host.dispatch({ type: 'continueGame' }).ok).toBe(true);
    expect(hostNet.sent).toContainEqual({ type: 'intent', action: { type: 'continueGame' } });
    host.handle({ type: 'gameContinued', by: 1, turn: 10 });
    expect(host.serverOver).toBeNull();

    const guest = new MpGame(new FakeNet() as unknown as NetClient, start(2));
    await guest.loading;
    guest.isPrivate = true;
    guest.state!.phase = 'over';
    guest.handle({ type: 'pauseState', paused: false, by: 0, host: 1 });
    guest.handle({ type: 'gameOver', reason: 'finished', winner: 1, turn: 10, continuable: true });
    expect(guest.continueRole()).toBe('guest');
    guest.handle({ type: 'gameOver', reason: 'finished', winner: 1, turn: 10 });
    expect(guest.continueRole()).toBe('none'); // public / not continuable
  });

  it('console actions go out as intents even for an eliminated player (the server decides who may)', async () => {
    const net = new FakeNet();
    const mp = new MpGame(net as unknown as NetClient, start(2));
    await mp.loading;
    mp.state!.phase = 'playing';
    mp.state!.players[2].alive = false;
    const a = adminAction('addResource', { player: 2, key: 'gold', amount: 100 });
    expect(mp.dispatch(a).ok).toBe(true);
    expect(net.sent).toContainEqual({ type: 'intent', action: a });
    mp.state!.phase = 'over';
    expect(mp.dispatch(a).ok).toBe(false);
  });
});

describe('game-over continue texts', () => {
  it('Keep watching when your nation is gone; the chip names the recorded winner', () => {
    const s = world();
    expect(continueLabel(s.players[1])).toBe('Continue playing');
    s.players[1].alive = false;
    expect(continueLabel(s.players[1])).toBe('Keep watching');
    expect(winnerText(s)).toBe('');
    s.winner = 2;
    expect(winnerText(s)).toBe(s.players[2].name);
  });
});
