// Chat, client side (src/client/chat/): names and text from other players can never become HTML (textContent only),
// typing in the chat input never reaches the game's keys, and the store's unread count, mutes, channels and history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatStore, tidyChatInput } from '../src/client/chat/store';
import { ChatView, QUICK_CHAT, readableColor, renderChatEntry } from '../src/client/chat/view';
import { CHAT_MAX_LENGTH } from '../src/net/protocol';
import type { ChatEntry, ClientMessage, ServerMessage } from '../src/net/protocol';

// ------------------------------------------------------------------------------------------------ a tiny fake DOM

type Handler = (e: Record<string, unknown>) => void;
/** every innerHTML write, anywhere */
const htmlWrites: string[] = [];
let active: FakeEl | null = null;

class FakeText {
  parentElement: FakeEl | null = null;
  constructor(public textContent: string) {}
}
class FakeEl {
  className = '';
  private text = '';
  value = '';
  type = '';
  title = '';
  placeholder = '';
  maxLength = -1;
  autocomplete = '';
  spellcheck = false;
  enterKeyHint = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  children: (FakeEl | FakeText)[] = [];
  parentElement: FakeEl | null = null;
  handlers = new Map<string, Handler[]>();
  classList = {
    contains: (c: string) => this.className.split(' ').includes(c),
    add: (c: string) => void (this.classList.contains(c) || (this.className = `${this.className} ${c}`.trim())),
    remove: (c: string) => void (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
    toggle: (c: string, on?: boolean) => void ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
  };
  constructor(public tag: string) {}
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  set innerHTML(v: string) {
    htmlWrites.push(v);
    this.children = [];
    this.text = '';
  }
  get childElementCount(): number {
    return this.children.filter((c) => c instanceof FakeEl).length;
  }
  get firstElementChild(): FakeEl | null {
    return (this.children.find((c) => c instanceof FakeEl) as FakeEl | undefined) ?? null;
  }
  append(...k: (FakeEl | FakeText)[]) {
    for (const c of k) {
      c.parentElement?.children.splice(c.parentElement.children.indexOf(c), 1);
      c.parentElement = this;
      this.children.push(c);
    }
  }
  replaceChildren(...k: (FakeEl | FakeText)[]) {
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    this.append(...k);
  }
  remove() {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c === n || (c instanceof FakeEl && c.contains(n)));
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(t: string, h: Handler) {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), h]);
  }
  focus() {
    active = this;
  }
  blur() {
    if (active === this) active = null;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 300 };
  }
  fire(t: string, e: Record<string, unknown> = {}) {
    const ev = {
      stopped: false,
      prevented: false,
      target: this,
      stopPropagation() {
        this.stopped = true;
      },
      preventDefault() {
        this.prevented = true;
      },
      ...e,
    };
    for (const h of this.handlers.get(t) ?? []) h(ev);
    return ev;
  }
  /** every element below (and including) this one */
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => (c instanceof FakeEl ? c.all() : []))];
  }
  find(cls: string): FakeEl | undefined {
    return this.all().find((x) => x.classList.contains(cls));
  }
  findTest(t: string): FakeEl | undefined {
    return this.all().find((x) => x.dataset.test === t);
  }
}

beforeEach(() => {
  htmlWrites.length = 0;
  active = null;
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => new FakeText(t),
    get activeElement() {
      return active;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------ helpers

const EVIL_NAME = '<img src=x onerror=alert(1)>';
const EVIL_TEXT = '<script>alert(1)</script><a href="javascript:alert(2)">click</a> https://evil.example';

function entry(id: number, over: Partial<ChatEntry> = {}): ChatEntry {
  return { id, channel: 'all', from: 2, name: 'Bob', color: [40, 40, 160], playerId: 2, text: `hello ${id}`, at: id, ...over };
}

function fakeNet() {
  const listeners: ((m: ServerMessage) => void)[] = [];
  const sent: ClientMessage[] = [];
  return {
    sent,
    on: (fn: (m: ServerMessage) => void) => {
      listeners.push(fn);
      return () => {};
    },
    send: (m: ClientMessage) => {
      sent.push(m);
      return true;
    },
    push: (m: ServerMessage) => listeners.forEach((f) => f(m)),
  };
}

function setup(opts: { team?: boolean; spectator?: boolean } = {}) {
  const net = fakeNet();
  const store = new ChatStore(net);
  net.push({ type: 'chatHistory', code: 'ABCDEF', you: 1, spectator: !!opts.spectator, team: !!opts.team, entries: [] });
  return { net, store };
}

/** Only the static line icons may ever go through innerHTML. */
function expectNoUserHtml(): void {
  for (const h of htmlWrites) {
    expect(h.startsWith('<svg class="li"')).toBe(true);
    expect(h).not.toMatch(/onerror|script|javascript|evil/i);
  }
}

// ------------------------------------------------------------------------------------------------ tests

describe('chat rendering: text only, never HTML', () => {
  it('a message with HTML in the name and the text shows it as plain text', () => {
    const row = renderChatEntry(entry(1, { name: EVIL_NAME, text: EVIL_TEXT, channel: 'team', ping: 42 }), {
      mine: false,
      onName: () => {},
      onPing: () => {},
    }) as unknown as FakeEl;
    expect(htmlWrites).toEqual([]);
    expect(row.find('chat-name')!.textContent).toBe(EVIL_NAME);
    expect(row.find('chat-text')!.textContent).toBe(EVIL_TEXT);
    // no element made from the text: just the row, tag, name (button), swatch, text and the Show button
    expect(row.all().map((x) => x.tag).sort()).toEqual(['button', 'button', 'div', 'i', 'span', 'span']);
    expect(row.all().some((x) => x.tag === 'a' || x.tag === 'img' || x.tag === 'script')).toBe(false);
  });

  it('the whole panel, the preview and the mute menu put players\' words in with textContent only', () => {
    const { net, store } = setup({ team: true });
    const view = new ChatView(store, { mode: 'hud', cameraTile: () => 7 });
    const root = view.el as unknown as FakeEl;
    net.push({ type: 'chat', entry: entry(5, { name: EVIL_NAME, text: EVIL_TEXT }) });
    const preview = root.findTest('chat-preview')!;
    expect(preview.classList.contains('hidden')).toBe(false);
    expect(preview.textContent).toBe(EVIL_NAME + EVIL_TEXT);
    view.setOpen(true);
    const list = root.findTest('chat-list')!;
    expect(list.find('chat-text')!.textContent).toBe(EVIL_TEXT);
    // the mute menu names the player, as text
    list.find('chat-name')!.fire('click');
    expect(root.findTest('chat-menu')!.textContent).toContain(EVIL_NAME);
    expectNoUserHtml();
    view.destroy();
  });
});

describe('chat input: typing is not a game key', () => {
  it('keys in the input stop there; Enter sends through the form; Esc closes the panel', () => {
    const { net, store } = setup();
    const view = new ChatView(store, { mode: 'hud' });
    const root = view.el as unknown as FakeEl;
    view.setOpen(true);
    const input = root.findTest('chat-input')!;
    expect(active).toBe(input);
    for (const key of ['w', 'a', 's', 'd', ' ', 'm', 'Tab', '1']) {
      expect(input.fire('keydown', { key }).stopped, key).toBe(true);
      expect(input.fire('keyup', { key }).stopped).toBe(true);
      expect(input.fire('keypress', { key }).stopped).toBe(true);
    }
    input.value = '   attack   at dawn  ';
    const form = root.find('chat-form')!;
    expect(form.fire('submit').prevented).toBe(true);
    expect(net.sent).toEqual([{ type: 'chat', channel: 'all', text: 'attack at dawn' }]);
    expect(input.value).toBe('');
    // an empty message is not sent
    input.value = '    ';
    form.fire('submit');
    expect(net.sent.length).toBe(1);
    const esc = input.fire('keydown', { key: 'Escape' });
    expect(esc.stopped && esc.prevented).toBe(true);
    expect(view.open).toBe(false);
    view.destroy();
  });

  it('quick chat: presets send on the open tab; Attack here goes to the team with the camera tile', () => {
    const { net, store } = setup({ team: true });
    const view = new ChatView(store, { mode: 'hud', cameraTile: () => 1234 });
    const root = view.el as unknown as FakeEl;
    view.setOpen(true);
    const quick = root.findTest('chat-quick')!.children as FakeEl[];
    expect(quick.map((b) => b.textContent)).toEqual(QUICK_CHAT.map((q) => q.label));
    quick[0].fire('click');
    root.findTest('chat-attack-here')!.fire('click');
    expect(net.sent).toEqual([
      { type: 'chat', channel: 'all', text: 'Good luck' },
      { type: 'chat', channel: 'team', text: 'Attack here', ping: 1234 },
    ]);
    // without team chat (FFA, lobby) the map mark button is hidden
    const ffa = setup();
    const v2 = new ChatView(ffa.store, { mode: 'hud', cameraTile: () => 1 });
    expect((v2.el as unknown as FakeEl).findTest('chat-attack-here')!.classList.contains('hidden')).toBe(true);
    view.destroy();
    v2.destroy();
  });
});

describe('chat store', () => {
  it('counts unread messages from others, hides muted players, and keeps mutes per room', () => {
    const { net, store } = setup();
    net.push({ type: 'chat', entry: entry(1) });
    net.push({ type: 'chat', entry: entry(2, { from: 1, name: 'Me' }) }); // ours: not unread
    net.push({ type: 'chat', entry: entry(3, { from: 3, name: 'Cy' }) });
    expect(store.unread).toBe(2);
    store.markRead();
    store.setMuted(3, true);
    store.setMuted(1, true); // never yourself
    expect(store.isMuted(1)).toBe(false);
    net.push({ type: 'chat', entry: entry(4, { from: 3, name: 'Cy' }) });
    expect(store.unread).toBe(0);
    expect(store.visible().map((e) => e.id)).toEqual([1, 2]);
    store.setMuted(3, false);
    expect(store.visible().map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it('history replaces another room, merges the same room, and leaving clears it', () => {
    const { net, store } = setup();
    net.push({ type: 'chat', entry: entry(1) });
    net.push({ type: 'chatHistory', code: 'ABCDEF', you: 1, spectator: false, team: true, entries: [entry(1), entry(2)] });
    expect(store.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(store.team).toBe(true);
    net.push({ type: 'chatHistory', code: 'ZZZZZZ', you: 4, spectator: true, team: false, entries: [entry(9)] });
    expect(store.entries.map((e) => e.id)).toEqual([9]);
    expect(store.spectator).toBe(true);
    net.push({ type: 'lobbyList', serverTime: 0, lobbies: [] });
    expect(store.active).toBe(false);
    expect(store.entries).toEqual([]);
    // no room: nothing is sent
    expect(store.send('all', 'hi')).not.toBe('');
  });

  it('sends tidy text; a map mark only with team chat; spectators always send', () => {
    const { net, store } = setup({ spectator: true });
    expect(store.send('team', 'x'.repeat(CHAT_MAX_LENGTH + 40), 5)).toBe('');
    expect(net.sent[0]).toEqual({ type: 'chat', channel: 'all', text: 'x'.repeat(CHAT_MAX_LENGTH) });
    expect(store.send('all', '   ')).not.toBe('');
    expect(tidyChatInput(' a \n\t b ')).toBe('a b');
  });

  it('dark nation colours are lifted so names stay readable', () => {
    expect(readableColor([255, 200, 0])).toBe('rgb(255,200,0)');
    const lifted = readableColor([20, 20, 120]);
    const [r, g, b] = lifted.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(20);
    expect(b).toBeGreaterThan(120);
    expect(g).toBeGreaterThan(20);
  });
});
