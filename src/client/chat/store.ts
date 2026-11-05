// Chat for online lobbies and games (docs/MULTIPLAYER.md, protocol `chat`). One store per connection: it keeps the
// recent messages of the room this client is in (the server's `chatHistory` replaces them on every join), counts
// unread ones, remembers who you muted (this browser session) and whether chat is switched off (this browser).
// Chat is social only: it never touches the game state. Text is plain text and is shown with textContent only.
import type { NetClient } from '../../net/client';
import { CHAT_MAX_LENGTH } from '../../net/protocol';
import type { ChatEntry, ChatNoticeMsg, ChatSendMsg, ServerMessage } from '../../net/protocol';

export const CHAT_OFF_KEY = 'borderfall.chat.v1';
export const CHAT_MUTES_KEY = 'borderfall.chat.mutes';
/** Messages kept on the client (the server keeps fewer; a long game adds more while you watch). */
const KEEP = 200;

let chatOn: boolean | null = null;

/** Whether chat is shown at all (the "Chat off" switch; saved per browser). */
export function chatEnabled(): boolean {
  if (chatOn === null) {
    try {
      chatOn = typeof localStorage === 'undefined' || localStorage.getItem(CHAT_OFF_KEY) !== 'off';
    } catch {
      chatOn = true;
    }
  }
  return chatOn;
}

export function setChatEnabled(on: boolean): void {
  chatOn = !!on;
  try {
    localStorage.setItem(CHAT_OFF_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: not remembered */
  }
  for (const s of stores) s.emit({ kind: 'enabled' });
}

/** Message text as the user typed it, made ready to send: spaces collapsed, ends trimmed, at most the limit. */
export function tidyChatInput(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, CHAT_MAX_LENGTH).join('');
}

export type ChatEvent =
  | { kind: 'entry'; entry: ChatEntry }
  | { kind: 'reset' }
  | { kind: 'notice'; notice: ChatNoticeMsg }
  | { kind: 'mutes' }
  | { kind: 'enabled' };

const stores = new Set<ChatStore>();
const byNet = new WeakMap<NetClient, ChatStore>();

/** The chat store of a connection (made on first use). */
export function chatFor(net: NetClient): ChatStore {
  let s = byNet.get(net);
  if (!s) {
    s = new ChatStore(net);
    byNet.set(net, s);
  }
  return s;
}

export class ChatStore {
  /** room the messages belong to; null = not in a lobby or game */
  code: string | null = null;
  /** our memberId in that room */
  you = 0;
  spectator = false;
  /** team chat is open to us */
  team = false;
  entries: ChatEntry[] = [];
  /** messages that came in since the panel was last open (not ours, not muted) */
  unread = 0;
  private mutes: Set<string>;
  private listeners = new Set<(e: ChatEvent) => void>();

  constructor(private net: Pick<NetClient, 'on' | 'send'>) {
    this.mutes = loadMutes();
    net.on((m) => this.handle(m));
    stores.add(this);
  }

  get active(): boolean {
    return this.code !== null;
  }

  on(fn: (e: ChatEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ChatEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error('chat listener failed', err);
      }
    }
  }

  handle(m: ServerMessage): void {
    switch (m.type) {
      case 'chatHistory': {
        const sameRoom = m.code === this.code;
        const known = new Set(this.entries.map((e) => e.id));
        this.code = m.code;
        this.you = m.you;
        this.spectator = m.spectator;
        this.team = m.team;
        if (sameRoom) {
          // a reconnect or the game start: keep what we have, add what we missed
          for (const e of m.entries) {
            if (known.has(e.id)) continue;
            this.entries.push(e);
            if (this.counts(e)) this.unread++;
          }
          this.entries.sort((a, b) => a.id - b.id);
        } else {
          this.entries = m.entries.slice();
          this.unread = 0;
        }
        this.trim();
        this.emit({ kind: 'reset' });
        break;
      }
      case 'chat':
        if (!this.code) return;
        this.entries.push(m.entry);
        this.trim();
        if (this.counts(m.entry)) this.unread++;
        this.emit({ kind: 'entry', entry: m.entry });
        break;
      case 'chatNotice':
        this.emit({ kind: 'notice', notice: m });
        break;
      case 'lobbyList':
      case 'kicked':
        // the server sends the lobby list only to clients outside a room
        if (this.code !== null) {
          this.code = null;
          this.entries = [];
          this.unread = 0;
          this.team = false;
          this.emit({ kind: 'reset' });
        }
        break;
      default:
        break;
    }
  }

  private trim(): void {
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
  }

  /** A message that adds to the unread count: someone else's, not muted. */
  private counts(e: ChatEntry): boolean {
    return e.from !== this.you && !this.isMuted(e.from);
  }

  /** Messages to show: muted players' are left out. */
  visible(): ChatEntry[] {
    return this.entries.filter((e) => e.from === this.you || !this.isMuted(e.from));
  }

  markRead(): void {
    this.unread = 0;
  }

  private muteKey(memberId: number): string {
    return `${this.code ?? ''}:${memberId}`;
  }
  isMuted(memberId: number): boolean {
    return this.mutes.has(this.muteKey(memberId));
  }
  setMuted(memberId: number, muted: boolean): void {
    if (memberId === this.you) return;
    const k = this.muteKey(memberId);
    if (muted) this.mutes.add(k);
    else this.mutes.delete(k);
    saveMutes(this.mutes);
    this.emit({ kind: 'mutes' });
  }

  /**
   * Sends a message (spectators always reach the spectators' channel). Returns '' when it went out, else a short reason
   * to show next to the input.
   */
  send(channel: 'all' | 'team', text: string, ping?: number): string {
    const t = tidyChatInput(text);
    if (!t) return 'Type a message first.';
    if (!this.code) return 'Chat works in online lobbies and games.';
    const to = this.spectator ? 'all' : channel;
    const msg: ChatSendMsg = { type: 'chat', channel: to, text: t };
    if (ping !== undefined && to === 'team' && Number.isInteger(ping) && ping >= 0) msg.ping = ping;
    return this.net.send(msg) ? '' : 'Not connected. Try again in a moment.';
  }
}

function loadMutes(): Set<string> {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(CHAT_MUTES_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 500) : []);
  } catch {
    return new Set();
  }
}
function saveMutes(m: Set<string>): void {
  try {
    sessionStorage.setItem(CHAT_MUTES_KEY, JSON.stringify([...m].slice(-500)));
  } catch {
    /* not remembered */
  }
}
