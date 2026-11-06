// Chat for everyone online: text cleaning, the word filter, the rate limit, routing (all / team / spectators),
// history for joiners and the muted refusal. Real WebSocket clients against an in-process server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CHAT_HISTORY, CHAT_MAX_LENGTH, PROTOCOL_VERSION, makeClientId } from '../src/net/protocol';
import type { ServerMessage } from '../src/net/protocol';
import { ChatLimiter, cleanChatText, maskChatText } from '../server/chat';
import { startServer } from '../server/server';
import type { RunningServer } from '../server/server';
import { cleanName, validateClientMessage } from '../server/validate';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ch = (code: number): string => String.fromCharCode(code);

class Client {
  readonly inbox: ServerMessage[] = [];
  private constructor(
    readonly ws: WebSocket,
    readonly clientId: string,
  ) {
    ws.on('message', (data) => this.inbox.push(JSON.parse(data.toString()) as ServerMessage));
  }
  static connect(url: string, clientId = makeClientId()): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new Client(ws, clientId);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  async take<T extends ServerMessage['type']>(type: T, pred: (m: Msg<T>) => boolean = () => true, timeout = 3000): Promise<Msg<T>> {
    const end = Date.now() + timeout;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m as Msg<T>));
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Msg<T>;
      if (Date.now() > end) throw new Error(`timeout waiting for ${type}; inbox: ${JSON.stringify(this.inbox.map((m) => m.type))}`);
      await sleep(5);
    }
  }
  /** Chat texts received so far (removed from the inbox). */
  chats(): string[] {
    const out: string[] = [];
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i];
      if (m.type === 'chat') {
        out.unshift(m.entry.text);
        this.inbox.splice(i, 1);
      }
    }
    return out;
  }
  async hello(name: string): Promise<void> {
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, name, color: [200, 40, 40], clientId: this.clientId, build: 'test' });
    await this.take('welcome');
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

// ------------------------------------------------------------------------------------------------ pure rules

describe('chat text rules', () => {
  it('cleans text: control characters out, spaces collapsed, 1..160 characters', () => {
    expect(cleanChatText('  hello   world  ')).toBe('hello world');
    expect(cleanChatText(`a${ch(0)}b${ch(10)}c${ch(13)}${ch(9)}d${ch(0x7f)}e${ch(0x9b)}f`)).toBe('a b c d e f');
    // bidi overrides, zero-width spaces and line separators never reach other players
    expect(cleanChatText(`x${ch(0x202e)}y${ch(0x200b)}z${ch(0x2028)}w${ch(0xfeff)}`)).toBe('x y z w');
    expect(cleanChatText('   ')).toBeNull();
    expect(cleanChatText('')).toBeNull();
    expect(cleanChatText(42)).toBeNull();
    expect(cleanChatText('x'.repeat(CHAT_MAX_LENGTH))).toBe('x'.repeat(CHAT_MAX_LENGTH));
    expect(cleanChatText('x'.repeat(CHAT_MAX_LENGTH + 1))).toBeNull();
    // emoji count as one character each (code points), and keep their joiners
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469);
    expect(cleanChatText(family)).toBe(family);
    // piles of combining marks are cut to two
    expect(cleanChatText(`q${ch(0x301).repeat(30)}`)).toBe(`q${ch(0x301).repeat(2)}`);
  });

  it('validates the chat message and rebuilds it without extra fields', () => {
    const ok = validateClientMessage({ type: 'chat', channel: 'all', text: '  gl   hf ', extra: '<b>x</b>' });
    expect(ok).toEqual({ ok: true, value: { type: 'chat', channel: 'all', text: 'gl hf' } });
    expect(validateClientMessage({ type: 'chat', channel: 'team', text: 'here', ping: 1234 })).toEqual({
      ok: true,
      value: { type: 'chat', channel: 'team', text: 'here', ping: 1234 },
    });
    for (const bad of [
      { type: 'chat', channel: 'spectators', text: 'hi' },
      { type: 'chat', channel: 'all' },
      { type: 'chat', channel: 'all', text: '' },
      { type: 'chat', channel: 'all', text: ch(1).repeat(5) },
      { type: 'chat', channel: 'all', text: 'y'.repeat(CHAT_MAX_LENGTH + 1) },
      { type: 'chat', channel: 'all', text: 'y'.repeat(5000) },
      { type: 'chat', channel: 'all', text: ['hi'] },
      { type: 'chat', channel: 'team', text: 'x', ping: -1 },
      { type: 'chat', channel: 'team', text: 'x', ping: 1.5 },
      { type: 'chat', channel: 'team', text: 'x', ping: 1e12 },
    ]) {
      expect(validateClientMessage(bad).ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('masks listed words and leaves normal words alone', () => {
    expect(maskChatText('shit happens')).toBe('*** happens');
    expect(maskChatText('you ASSHOLE!')).toBe('you ***!');
    expect(maskChatText('sh1t and SHIIIIT')).toBe('*** and ***');
    expect(maskChatText('what a f@g')).toBe('what a ***');
    // whole words only: these all pass untouched
    const normal = [
      'assess the class pass, then assassinate the bass player',
      'Niger and Nigeria share a border',
      'spices, scrapbook, cocktail, Scunthorpe, therapist, grape',
      'hello there, shell the shitake? no, shiitake mushrooms',
      'the dike road and the cockpit',
      '455 troops at 1337 gold, 5h left',
      'https://example.com/a?b=c is a link, shown as text',
      "there's a chink in their line, attack the dyke at the river and retard their advance",
    ];
    for (const t of normal) expect(maskChatText(t)).toBe(t);
  });

  it('names follow the chat text rules: no invisible characters, no piles of marks', () => {
    expect(cleanName('Bob\u061c\u2061\u2062\u00ad\u180e')).toBe('Bob');
    expect(cleanName('Aurora\u2060')).toBe('Aurora');
    expect(cleanName('Au\u200brora')).toBe('Aurora');
    expect(cleanName('\u202eArohtua\ufff9')).toBe('Arohtua');
    expect(cleanName('Z' + '\u030d'.repeat(23))).toBe('Z\u030d\u030d');
    expect(cleanName('Ren\u00e9e  du\tNord')).toBe('Ren\u00e9e du Nord');
    expect(cleanName('\u2060\u200b')).toBeNull();
  });

  it('rate limit: 5 per window, then a cooldown', () => {
    const l = new ChatLimiter(5, 10_000, 8000);
    for (let i = 0; i < 5; i++) expect(l.take(1000 + i)).toBe(0);
    expect(l.take(1010)).toBe(8000); // the sixth starts the cooldown
    expect(l.take(5000)).toBe(4010);
    expect(l.take(9010)).toBe(0); // cooldown over
    // spread out messages never trip it
    const s = new ChatLimiter(5, 10_000, 8000);
    for (let i = 0; i < 30; i++) expect(s.take(i * 2100)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ server routing

describe('chat on the relay server', () => {
  let srv: RunningServer;
  const open: Client[] = [];
  const opts = { port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 50, firstTurnDelayMs: 0, sweepMs: 20, maxConnectionsPerIp: 64, maxRoomsPerIp: 50, createLobbyCooldownMs: 0, messagesPerSecond: 1000, chatBurst: 5, chatWindowMs: 2000, chatCooldownMs: 600, log: () => {} };

  beforeAll(async () => {
    srv = await startServer(opts);
  });
  afterAll(async () => {
    for (const c of open) await c.close();
    await srv.close();
  });

  async function client(name: string): Promise<Client> {
    const c = await Client.connect(srv.wsUrl);
    open.push(c);
    await c.hello(name);
    return c;
  }

  /** A private teams lobby with 4 players (teams 1,1,2,2) and nothing started yet. */
  async function teamsLobby(): Promise<{ code: string; p: Client[] }> {
    const p = await Promise.all(['A1', 'A2', 'B1', 'B2'].map((n) => client(n)));
    p[0].send({ type: 'createLobby', settings: { mode: 'teams', teamCount: 2, aiCount: 0, map: { kind: 'generated', type: 'pangaea', size: 'small' } } });
    const { code } = await p[0].take('lobbyState');
    for (const c of p.slice(1)) {
      c.send({ type: 'joinLobby', code });
      await c.take('lobbyState');
    }
    const teams = [1, 1, 2, 2];
    for (let i = 0; i < 4; i++) p[i].send({ type: 'setTeam', team: teams[i] });
    await p[0].take('lobbyState', (m) => m.players.map((x) => x.team).join() === '1,1,2,2');
    return { code, p };
  }

  it('lobby: all chat reaches everyone, team chat waits for the start, history on join', async () => {
    const { code, p } = await teamsLobby();
    const h = await p[0].take('chatHistory');
    expect(h).toMatchObject({ code, spectator: false, team: false, entries: [] });
    p[1].send({ type: 'chat', channel: 'all', text: 'hello   <img src=x onerror=alert(1)>' });
    for (const c of p) {
      const m = await c.take('chat');
      expect(m.entry).toMatchObject({ channel: 'all', name: 'A2', text: 'hello <img src=x onerror=alert(1)>', playerId: 0 });
    }
    p[2].send({ type: 'chat', channel: 'team', text: 'secret plan' });
    const n = await p[2].take('chatNotice');
    expect(n.reason).toBe('notAllowed');
    expect(n.text).toMatch(/game starts/);
    // a late joiner (spectator) sees the lobby's all chat
    const w = await client('Watcher');
    w.send({ type: 'joinLobby', code, spectate: true });
    const wh = await w.take('chatHistory');
    expect(wh.spectator).toBe(true);
    expect(wh.entries.map((e) => e.text)).toEqual(['hello <img src=x onerror=alert(1)>']);
  });

  it('game: team chat only to teammates, spectators in their own channel, all to everyone', async () => {
    const { code, p } = await teamsLobby();
    const spec = await client('Spec');
    spec.send({ type: 'joinLobby', code, spectate: true });
    await spec.take('lobbyState');
    p[0].send({ type: 'startGame' });
    for (const c of [...p, spec]) await c.take('gameStart');
    // everyone gets the channels they may use now
    const hs = await Promise.all([...p, spec].map((c) => c.take('chatHistory', (m) => m.code === code && (m.team || m.spectator))));
    expect(hs.map((h) => h.team)).toEqual([true, true, true, true, false]);
    for (const c of [...p, spec]) c.chats();

    p[0].send({ type: 'chat', channel: 'team', text: 'go north', ping: 500 });
    const north = await p[1].take('chat', (m) => m.entry.text === 'go north');
    expect(north.entry).toMatchObject({ channel: 'team', ping: 500, name: 'A1', playerId: 1 });
    p[3].send({ type: 'chat', channel: 'team', text: 'red plan' });
    spec.send({ type: 'chat', channel: 'all', text: 'nice game to watch', ping: 9 });
    const sm = await spec.take('chat', (m) => m.entry.text === 'nice game to watch');
    expect(sm.entry).toMatchObject({ channel: 'spectators', playerId: 0 });
    expect(sm.entry.ping).toBeUndefined();
    p[2].send({ type: 'chat', channel: 'all', text: 'gl hf all', ping: 77 });
    const all = await spec.take('chat', (x) => x.entry.text === 'gl hf all');
    expect(all.entry.ping).toBeUndefined(); // map marks are for team chat only
    expect(all.entry.playerId).toBe(3);
    await sleep(150);
    // each one got exactly what is theirs, in order
    expect(p[0].chats()).toEqual(['go north', 'gl hf all']);
    expect(p[1].chats()).toEqual(['gl hf all']);
    expect(p[2].chats()).toEqual(['red plan', 'gl hf all']);
    expect(p[3].chats()).toEqual(['red plan', 'gl hf all']);
    expect(spec.chats()).toEqual([]);
    // a reconnect gets the history it may read
    await p[2].close();
    const again = await Client.connect(srv.wsUrl, p[2].clientId);
    open.push(again);
    await again.hello('B1');
    const rh = await again.take('chatHistory');
    expect(rh.team).toBe(true);
    expect(rh.entries.map((e) => e.text)).toEqual(['red plan', 'gl hf all']);
    // a spectator joining later: all chat and spectator chat, no team chat
    const late = await client('Late');
    late.send({ type: 'joinLobby', code, spectate: true });
    const lh = await late.take('chatHistory');
    expect(lh.entries.map((e) => `${e.channel}:${e.text}`)).toEqual(['spectators:nice game to watch', 'all:gl hf all']);
  });

  it('rate limit: the sixth message in the window is refused with a notice, chat works again after the cooldown', async () => {
    const a = await client('Fast');
    const b = await client('Reader');
    a.send({ type: 'createLobby' });
    const { code } = await a.take('lobbyState');
    b.send({ type: 'joinLobby', code });
    await b.take('chatHistory');
    for (let i = 0; i < 7; i++) a.send({ type: 'chat', channel: 'all', text: `m${i}` });
    const n = await a.take('chatNotice');
    expect(n.reason).toBe('rateLimit');
    expect(n.retryMs).toBeGreaterThan(0);
    await sleep(150);
    expect(b.chats()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    await sleep(opts.chatCooldownMs + 50);
    a.send({ type: 'chat', channel: 'all', text: 'back' });
    await b.take('chat', (m) => m.entry.text === 'back');
  });

  it('leaving and joining again keeps the rate limit; new clientIds from one address share a budget', async () => {
    const host = await client('Host');
    const spam = await client('Spammer');
    host.send({ type: 'createLobby' });
    const { code } = await host.take('lobbyState');
    let sent = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      spam.send({ type: 'joinLobby', code });
      await spam.take('chatHistory');
      for (let i = 0; i < 5; i++) spam.send({ type: 'chat', channel: 'all', text: `s${sent++}` });
      spam.send({ type: 'leaveLobby' });
      await spam.take('lobbyList');
    }
    await sleep(150);
    // one budget of 5 for the whole window, however often it left and came back
    expect(host.chats()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(spam.inbox.some((m) => m.type === 'chatNotice' && m.reason === 'rateLimit')).toBe(true);

    // fresh clientIds (a new socket each) from the same address: CHAT_BURST each, but the address's budget is shared
    await sleep(opts.chatWindowMs + opts.chatCooldownMs);
    host.chats();
    const burst = srv.hub.opts.chatAddressBurst;
    let n = 0;
    for (let k = 0; n < burst + 5; k++) {
      const c = await client(`Fresh${k}`);
      c.send({ type: 'joinLobby', code });
      await c.take('chatHistory');
      for (let i = 0; i < 5; i++) c.send({ type: 'chat', channel: 'all', text: `f${n++}` });
      await sleep(20);
    }
    await sleep(150);
    expect(host.chats().length).toBe(burst);
  });

  it('masks rude words for everyone and keeps only the last messages', async () => {
    const a = await client('Talker');
    const b = await client('Other');
    a.send({ type: 'createLobby' });
    const { code } = await a.take('lobbyState');
    b.send({ type: 'joinLobby', code });
    await b.take('chatHistory');
    a.send({ type: 'chat', channel: 'all', text: 'well shit, assess the map' });
    expect((await b.take('chat')).entry.text).toBe('well ***, assess the map');
    const room = srv.hub.rooms.get(code)!;
    const member = room.members.find((m) => m.name === 'Talker')!;
    // lift the rate limit for this check
    member.chatLimit = { take: () => 0 } as unknown as typeof member.chatLimit;
    member.addrLimit = member.chatLimit;
    for (let i = 0; i < CHAT_HISTORY + 10; i++) a.send({ type: 'chat', channel: 'all', text: `n${i}` });
    await b.take('chat', (m) => m.entry.text === `n${CHAT_HISTORY + 9}`);
    const c = await client('Joiner');
    c.send({ type: 'joinLobby', code });
    const h = await c.take('chatHistory');
    expect(h.entries.length).toBe(CHAT_HISTORY);
    expect(h.entries[0].text).toBe('n10');
    expect(h.entries.at(-1)!.text).toBe(`n${CHAT_HISTORY + 9}`);
  });

  it('a muted member is refused with a notice only they see', async () => {
    const a = await client('Loud');
    const b = await client('Quiet');
    a.send({ type: 'createLobby' });
    const { code } = await a.take('lobbyState');
    b.send({ type: 'joinLobby', code });
    await b.take('chatHistory');
    const room = srv.hub.rooms.get(code)!;
    const loud = room.members.find((m) => m.name === 'Loud')!.memberId;
    // the owner's mute (Room.muteMember, what adminMute calls)
    expect(room.muteMember(loud, 2)).toBeNull();
    expect(room.isMuted(loud)).toBe(true);
    a.send({ type: 'chat', channel: 'all', text: 'can anyone hear me' });
    const n = await a.take('chatNotice');
    expect(n.reason).toBe('muted');
    expect(n.text).toBe("You can't send messages in this game for 2 more minutes.");
    expect(n.retryMs).toBeGreaterThan(60_000);
    b.send({ type: 'chat', channel: 'all', text: 'only me' });
    await a.take('chat', (m) => m.entry.text === 'only me');
    await sleep(80);
    expect(b.inbox.some((m) => m.type === 'chatNotice')).toBe(false);
    expect(b.chats()).toEqual(['only me']);
  });

  it('chat outside a lobby is refused like any lobby message', async () => {
    const a = await client('Alone');
    a.send({ type: 'chat', channel: 'all', text: 'anyone?' });
    expect((await a.take('error')).code).toBe('notInLobby');
  });
});
