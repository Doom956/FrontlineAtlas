// Owner console, online tabs (adminConsole.ts shows them after the server accepted the code):
//   Games    every room on the server (adminRooms), Watch a running game as a spectator, pick a game as the target,
//            its people with Message / Mute / Remove
//   Announce a banner for one game or for every screen on the server, and a short message for one player
//   Effects  a ring on a tile with a label, a countdown, confetti, fireworks, a screen shake
// Everything here is a server message (protocol: admin*), never a game action: none of it changes the game, so it can't
// desync. The server checks the session for every one and answers adminAck; the status line shows the answer.
import {
  ANNOUNCE_STYLES,
  BROADCAST_LABEL_MAX,
  BROADCAST_TEXT_MAX,
  BROADCAST_TITLE_MAX,
  COUNTDOWN_SECONDS,
  cleanBroadcastText,
} from '../net/protocol';
import type { AdminRoomInfo, AnnounceStyle, ClientMessage, ServerMessage, SpectacleKind } from '../net/protocol';
import type { GameState } from '../sim/types';
import { setUnlocked } from './admin';
import { el, setText } from './dom';

export type OnlineTab = 'games' | 'announce' | 'effects';
export const ONLINE_TABS: [OnlineTab, string][] = [
  ['games', 'Games'],
  ['announce', 'Announce'],
  ['effects', 'Effects'],
];

/** The bits of the network client the tabs need (NetClient fits). */
export interface PowersNet {
  readonly online: boolean;
  send(msg: ClientMessage): boolean;
  on(fn: (msg: ServerMessage) => void): () => void;
  connect(): void;
}

export interface OnlinePowersDeps {
  net: () => PowersNet | null;
  /** the online lobby or game this client is in now, null = none */
  roomCode: () => string | null;
  /** the game on screen (tile picks), null in the menu */
  state: () => GameState | null;
  /** map pick (one click); null when there is no map */
  pickTile: ((label: string, pick: (tile: number) => void) => void) | null;
  endPick: () => void;
  /** the console's status line */
  say: (text: string, bad?: boolean) => void;
  /** shows an announcement on this screen only */
  preview: (msg: { title: string; text: string; style: AnnounceStyle; seconds: number }) => void;
  /** the console re-renders the tab (fresh room list) */
  rerender: () => void;
  /** which tab is open now (null = console closed or another tab) */
  openTab: () => OnlineTab | null;
  /** go to another tab */
  goTab: (tab: OnlineTab) => void;
}

const STYLE_LABEL: Record<AnnounceStyle, string> = { info: 'Info', warning: 'Warning', celebration: 'Celebration' };
const SECONDS = [5, 8, 12, 20, 30, 60];
const MUTES: [number, string][] = [
  [5, '5 min'],
  [15, '15 min'],
  [60, '1 hour'],
  [1440, '1 day'],
];
const PHASE_LABEL: Record<AdminRoomInfo['phase'], string> = { running: 'Running', lobby: 'Lobby', over: 'Ended' };
/** A second click within this long confirms Remove. */
const CONFIRM_MS = 5000;
/** Refresh the list this often while the Games tab is open. */
const AUTO_REFRESH_MS = 5000;
/** An owner power refused as "not allowed" this soon after sending: the server forgot the unlock (it restarted). */
const STALE_MS = 3000;

function typingNow(): boolean {
  if (typeof document === 'undefined') return false;
  const a = document.activeElement;
  return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && (a as HTMLInputElement).type === 'text'));
}

/** 'here' = the game the owner is in, 'sel' = the game picked in Games, 'all' = every screen on the server. */
type Where = 'here' | 'sel' | 'all';

/** The announcement the form would send (exported for tests); null with a reason when it can't be sent. */
export function announceMessage(f: { where: Where; here: string | null; sel: string | null; title: string; text: string; style: AnnounceStyle; seconds: number }): ClientMessage | string {
  const text = cleanBroadcastText(f.text, BROADCAST_TEXT_MAX);
  if (!text) return f.text.trim() ? `At most ${BROADCAST_TEXT_MAX} characters` : 'Write the announcement first';
  const title = cleanBroadcastText(f.title, BROADCAST_TITLE_MAX);
  if (title === null) return `A title has at most ${BROADCAST_TITLE_MAX} characters`;
  if (f.where === 'all') return { type: 'adminAnnounce', scope: 'all', title, text, style: f.style, seconds: f.seconds };
  const code = f.where === 'sel' ? f.sel : f.here;
  if (!code) return f.where === 'sel' ? 'Pick a game in Games first' : 'You are not in a game: pick one in Games';
  return { type: 'adminAnnounce', scope: 'room', code, title, text, style: f.style, seconds: f.seconds };
}

export class OnlinePowers {
  private rooms: AdminRoomInfo[] = [];
  private roomsKey = '';
  /** the owner clicked Refresh: show the answer even when nothing changed */
  private loudRefresh = false;
  private total = 0;
  private listedAt = 0;
  private selected: string | null = null;
  private expanded = new Set<string>();
  private where: Where = 'here';
  private form = { title: '', text: '', style: 'info' as AnnounceStyle, seconds: 8 };
  private noteFor: { code: string; memberId: number } | null = null;
  private noteText = '';
  private noteStyle: AnnounceStyle = 'info';
  private countLabel = '';
  private countSeconds = 10;
  private pingLabel = 'Look here';
  private lastSent = -Infinity;
  private off: (() => void) | null = null;
  private offNet: PowersNet | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private armed = new Map<string, number>();

  constructor(private deps: OnlinePowersDeps) {}

  destroy(): void {
    this.off?.();
    this.off = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Subscribes to the connection (again after it was made) and keeps the list fresh while Games is open. */
  private listen(): PowersNet | null {
    const net = this.deps.net();
    if (net && net !== this.offNet) {
      this.off?.();
      this.offNet = net;
      this.off = net.on((m) => this.onMessage(m));
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.deps.openTab() === 'games') this.refresh(false);
      }, AUTO_REFRESH_MS);
    }
    return net;
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'adminRooms': {
        // the same list again (the 5 s refresh): leave the page alone, so a click in progress isn't lost
        // (turns, minutes and mute minutes tick on their own: they show on the next change or Refresh)
        const key = JSON.stringify(m.rooms.map((r) => ({ ...r, turn: 0, minutes: 0, members: r.members.map((x) => ({ ...x, mutedMinutes: x.mutedMinutes > 0 })) }))) + m.total;
        const same = key === this.roomsKey && this.listedAt > 0 && !this.loudRefresh;
        this.loudRefresh = false;
        this.roomsKey = key;
        this.rooms = m.rooms;
        this.total = m.total;
        this.listedAt = performance.now();
        if (this.selected && !m.rooms.some((r) => r.code === this.selected)) this.selected = null;
        // (not while the owner is typing in a form: the caret would be lost)
        if (!same && (this.deps.openTab() === 'games' || (this.deps.openTab() === 'announce' && !typingNow()))) this.deps.rerender();
        break;
      }
      case 'adminAck':
        this.deps.say(m.message, !m.ok);
        if (m.ok && (m.what === 'adminMute' || m.what === 'adminKick')) this.refresh(false);
        break;
      case 'error':
        if (performance.now() - this.lastSent > STALE_MS) break;
        if (m.code === 'notAllowed') {
          // the server no longer knows this console (it restarted): the code has to be typed again
          setUnlocked('online', false);
          this.deps.say('The server forgot this console. Close it, press | and type the code again.', true);
        } else if (m.code === 'rateLimit') this.deps.say(m.message, true);
        break;
      default:
        break;
    }
  }

  /** Sends an owner power; connects first when needed. */
  private send(msg: ClientMessage, quiet = false): boolean {
    const net = this.listen();
    if (!net) {
      this.deps.say('No server to talk to', true);
      return false;
    }
    if (!net.online) {
      net.connect();
      if (!quiet) this.deps.say('Connecting to the server, try again in a moment', true);
      return false;
    }
    if (!net.send(msg)) {
      if (!quiet) this.deps.say('Not connected', true);
      return false;
    }
    this.lastSent = performance.now();
    if (!quiet) this.deps.say('Sending…');
    return true;
  }

  /** Asks for the room list (loud: says so when the server can't be reached; the list itself is the answer). */
  private refresh(loud: boolean, button = false): void {
    if (this.send({ type: 'adminRooms' }, !loud) && loud) {
      // only the Refresh button redraws an unchanged list (new minutes): a redraw can swallow a click in progress
      this.loudRefresh = button;
      this.deps.say('');
    }
  }

  // ---------------------------------------------------------------------------------------------- widgets

  private btn(label: string, run: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', `adm-btn ${cls}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }
  private row(label: string, ...parts: HTMLElement[]): HTMLElement {
    const r = el('div', 'adm-row');
    r.append(el('span', 'adm-k', label), ...parts);
    return r;
  }
  private sec(body: HTMLElement, title: string): void {
    body.append(el('div', 'adm-sec', title));
  }
  private note(body: HTMLElement, text: string): void {
    body.append(el('div', 'adm-note', text));
  }
  private textIn(value: string, max: number, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
    const i = el('input', 'adm-num adm-wide-in');
    i.type = 'text';
    i.value = value;
    i.maxLength = max;
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
  private select<T extends string | number>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
    const s = el('select', 'adm-sel');
    for (const [v, l] of options) {
      const o = el('option', '', l);
      o.value = String(v);
      s.append(o);
    }
    s.value = String(value);
    s.addEventListener('change', () => {
      const hit = options.find(([v]) => String(v) === s.value);
      if (hit) onChange(hit[0]);
    });
    return s;
  }
  private styleSeg(value: AnnounceStyle, onChange: (v: AnnounceStyle) => void): HTMLElement {
    const seg = el('div', 'adm-seg');
    const btns: HTMLButtonElement[] = [];
    for (const st of ANNOUNCE_STYLES) {
      const b = this.btn(STYLE_LABEL[st], () => {
        onChange(st);
        for (const x of btns) x.classList.toggle('on', x === b);
        for (const x of btns) x.setAttribute('aria-pressed', String(x === b));
      });
      b.classList.toggle('on', st === value);
      b.setAttribute('aria-pressed', String(st === value));
      btns.push(b);
      seg.append(b);
    }
    return seg;
  }
  /** A button that needs a second click within CONFIRM_MS (Remove). */
  private confirmBtn(label: string, key: string, run: () => void): HTMLButtonElement {
    const armedNow = (): boolean => performance.now() - (this.armed.get(key) ?? -Infinity) <= CONFIRM_MS;
    const b = this.btn(armedNow() ? 'Sure?' : label, () => {
      if (!armedNow()) {
        this.armed.set(key, performance.now());
        setText(b, 'Sure?');
        this.deps.say(`Click again to ${label.toLowerCase()}`);
        setTimeout(() => {
          if (!armedNow()) setText(b, label);
        }, CONFIRM_MS + 50);
        return;
      }
      this.armed.delete(key);
      run();
    }, 'danger');
    return b;
  }

  /** The target select for Announce and Effects. */
  private whereRow(allowAll = true): HTMLElement {
    const here = this.deps.roomCode();
    const opts: [Where, string][] = [];
    if (here) opts.push(['here', `This game (${here})`]);
    if (this.selected && this.selected !== here) opts.push(['sel', `Game ${this.selected}`]);
    if (allowAll) opts.push(['all', 'Every screen on the server']);
    if (!opts.length) opts.push(['here', 'Pick a game in Games']);
    if (!opts.some(([v]) => v === this.where)) this.where = opts[0][0];
    return this.row('Where', this.select(opts, this.where, (v) => {
      this.where = v;
      this.deps.rerender();
    }));
  }

  private targetCode(): string | null {
    return this.where === 'sel' ? this.selected : this.where === 'here' ? this.deps.roomCode() : null;
  }

  // ---------------------------------------------------------------------------------------------- tabs

  render(tab: OnlineTab, body: HTMLElement): void {
    this.listen();
    if (tab === 'games') this.renderGames(body);
    else if (tab === 'announce') this.renderAnnounce(body);
    else this.renderEffects(body);
  }

  /** Called when a tab opens: a fresh list for Games (and for the player picker in Announce). */
  opened(tab: OnlineTab): void {
    if ((tab === 'games' || tab === 'announce') && performance.now() - this.listedAt > 1500) this.refresh(tab === 'games');
  }

  private renderGames(body: HTMLElement): void {
    this.sec(body, 'Games on the server');
    const here = this.deps.roomCode();
    const count = el('span', 'adm-v', this.listedAt ? `${this.total} ${this.total === 1 ? 'room' : 'rooms'}` : 'Loading…');
    body.append(this.row('', this.btn('Refresh', () => this.refresh(true, true)), count));
    const list = el('div', 'adm-games');
    list.dataset.test = 'adm-games';
    if (this.listedAt && !this.rooms.length) list.append(el('div', 'adm-note', 'No games or lobbies are open right now.'));
    for (const r of this.rooms) list.append(this.gameCard(r, here));
    body.append(list);
    if (this.total > this.rooms.length) this.note(body, `Showing the first ${this.rooms.length} of ${this.total}.`);
    this.note(body, 'Watch joins a running game as a spectator: players see one more spectator in the count, never who it is. From there the console works on that game.');
  }

  private gameCard(r: AdminRoomInfo, here: string | null): HTMLElement {
    const card = el('div', `adm-game ${r.phase}${r.code === this.selected ? ' sel' : ''}`);
    card.dataset.test = `adm-game-${r.code}`;
    const head = el('div', 'adm-game-head');
    head.append(el('span', 'adm-code', r.code), el('span', `adm-chip${r.phase === 'running' ? ' on' : ''}`, PHASE_LABEL[r.phase]), el('span', 'adm-chip', r.isPublic ? 'Public' : 'Private'), el('span', 'adm-chip', r.mode === 'teams' ? 'Teams' : 'Free for all'));
    if (r.paused) head.append(el('span', 'adm-chip warn', 'Paused'));
    if (r.code === here) head.append(el('span', 'adm-chip on', 'You are here'));
    const facts = el('div', 'adm-game-facts');
    const fact = (k: string, v: string): HTMLElement => {
      const f = el('span', '', `${k} `);
      f.append(el('b', '', v));
      return f;
    };
    facts.append(fact('Map', r.map), fact('Players', `${r.connected} of ${r.players} online`), fact('Watching', String(r.spectators)), fact(r.phase === 'lobby' ? 'Open' : 'Playing', `${r.minutes} min`));
    const acts = el('div', 'adm-game-acts');
    if (r.phase === 'running' && r.code !== here) {
      acts.append(this.btn('Watch', () => {
        if (this.send({ type: 'joinLobby', code: r.code, spectate: true })) this.deps.say(`Joining ${r.code} as a spectator…`);
      }, 'go'));
    }
    const sel = this.btn(r.code === this.selected ? 'Target' : 'Make target', () => {
      this.selected = this.selected === r.code ? null : r.code;
      if (this.selected) this.where = 'sel';
      this.deps.rerender();
    }, r.code === this.selected ? 'on' : '');
    sel.setAttribute('aria-pressed', String(r.code === this.selected));
    const open = this.expanded.has(r.code);
    const people = this.btn(open ? 'Hide people' : `People (${r.members.length})`, () => {
      if (open) this.expanded.delete(r.code);
      else this.expanded.add(r.code);
      this.deps.rerender();
    });
    people.setAttribute('aria-expanded', String(open));
    acts.append(sel, people);
    card.append(head, facts, acts);
    if (open) card.append(this.memberList(r));
    return card;
  }

  private memberList(r: AdminRoomInfo): HTMLElement {
    const box = el('div', 'adm-members');
    if (!r.members.length) box.append(el('div', 'adm-note', 'Nobody is in this room.'));
    for (const m of r.members) {
      const row = el('div', 'adm-member');
      row.dataset.test = `adm-member-${m.memberId}`;
      row.append(el('span', 'adm-member-name', m.name));
      row.append(el('span', 'adm-chip', m.spectator ? 'Spectator' : m.playerId ? `Player ${m.playerId}` : 'Player'));
      if (!m.connected) row.append(el('span', 'adm-chip', m.left ? 'Left' : 'Offline'));
      if (m.mutedMinutes > 0) row.append(el('span', 'adm-chip warn', `Muted ${m.mutedMinutes} min`));
      const msgBtn = this.btn('Message', () => {
        this.noteFor = { code: r.code, memberId: m.memberId };
        this.deps.goTab('announce');
      });
      msgBtn.disabled = !m.connected;
      let minutes = MUTES[0][0];
      const muteSel = this.select(MUTES, minutes, (v) => (minutes = v));
      muteSel.setAttribute('aria-label', `Mute ${m.name} for`);
      const mute = this.btn('Mute', () => this.send({ type: 'adminMute', code: r.code, memberId: m.memberId, minutes }));
      row.append(msgBtn, muteSel, mute);
      if (m.mutedMinutes > 0) row.append(this.btn('Unmute', () => this.send({ type: 'adminMute', code: r.code, memberId: m.memberId, minutes: 0 })));
      if (r.phase !== 'over') row.append(this.confirmBtn('Remove', `${r.code}:${m.memberId}`, () => this.send({ type: 'adminKick', code: r.code, memberId: m.memberId })));
      box.append(row);
    }
    return box;
  }

  private renderAnnounce(body: HTMLElement): void {
    this.sec(body, 'Announcement');
    body.append(this.whereRow());
    const title = this.textIn(this.form.title, BROADCAST_TITLE_MAX, 'Announcement', (v) => (this.form.title = v));
    title.setAttribute('aria-label', 'Title');
    body.append(this.row('Title', title));
    const text = el('textarea', 'adm-text');
    text.dataset.test = 'adm-ann-text';
    text.maxLength = BROADCAST_TEXT_MAX;
    text.value = this.form.text;
    text.placeholder = 'What everyone should read';
    text.setAttribute('aria-label', 'Announcement text');
    const left = el('span', 'adm-count');
    const count = (): void => setText(left, `${text.value.length} / ${BROADCAST_TEXT_MAX}`);
    count();
    text.addEventListener('input', () => {
      this.form.text = text.value;
      count();
    });
    const tr = el('div', 'adm-row');
    tr.append(text);
    body.append(tr, this.row('Style', this.styleSeg(this.form.style, (v) => (this.form.style = v)), left));
    body.append(this.row('On screen', this.select(SECONDS.map((s): [number, string] => [s, `${s} s`]), this.form.seconds, (v) => (this.form.seconds = v))));
    const build = (): ClientMessage | string => announceMessage({ where: this.where, here: this.deps.roomCode(), sel: this.selected, ...this.form });
    body.append(
      this.row(
        '',
        this.btn('Preview here', () => {
          const m = build();
          if (typeof m === 'string') this.deps.say(m, true);
          else if (m.type === 'adminAnnounce') {
            this.deps.preview({ title: m.title, text: m.text, style: m.style, seconds: m.seconds });
            this.deps.say('Preview: only you see it');
          }
        }),
        this.btn('Send announcement', () => {
          const m = build();
          if (typeof m === 'string') this.deps.say(m, true);
          else this.send(m);
        }, 'go wide'),
      ),
    );
    this.note(body, 'Players see it under the title you give, or "Announcement".');

    // ---- one player
    this.sec(body, 'Message to one player');
    const code = this.noteFor?.code ?? this.targetCode() ?? this.deps.roomCode() ?? this.selected;
    const room = this.rooms.find((r) => r.code === code) ?? null;
    if (!room) {
      this.note(body, code ? 'Loading the people in that game…' : 'Make a game the target in Games (or join one) to pick a player.');
      if (code && performance.now() - this.listedAt > 1500) this.refresh(false);
      return;
    }
    const people = room.members.filter((m) => m.connected);
    if (!people.length) {
      this.note(body, `Nobody is connected in ${room.code}.`);
      return;
    }
    const cur = this.noteFor && this.noteFor.code === room.code && people.some((p) => p.memberId === this.noteFor!.memberId) ? this.noteFor.memberId : people[0].memberId;
    this.noteFor = { code: room.code, memberId: cur };
    const who = this.select(people.map((p): [number, string] => [p.memberId, `${p.name}${p.spectator ? ' (spectator)' : ''}`]), cur, (v) => (this.noteFor = { code: room.code, memberId: v }));
    who.setAttribute('aria-label', 'Player');
    body.append(this.row('In', el('span', 'adm-v', room.code)), this.row('Player', who));
    const nt = this.textIn(this.noteText, BROADCAST_TEXT_MAX, 'A short message', (v) => (this.noteText = v));
    nt.setAttribute('aria-label', 'Message text');
    body.append(this.row('Text', nt), this.row('Style', this.styleSeg(this.noteStyle, (v) => (this.noteStyle = v))));
    body.append(
      this.row(
        '',
        this.btn('Send message', () => {
          const t = cleanBroadcastText(this.noteText, BROADCAST_TEXT_MAX);
          if (!t) return this.deps.say('Write the message first', true);
          if (this.noteFor) this.send({ type: 'adminNotice', code: this.noteFor.code, memberId: this.noteFor.memberId, text: t, style: this.noteStyle });
        }, 'go wide'),
      ),
    );
  }

  private renderEffects(body: HTMLElement): void {
    this.sec(body, 'Effects');
    body.append(this.whereRow());
    const here = this.deps.roomCode();
    const onMap = !!this.deps.pickTile && !!this.deps.state() && this.where === 'here' && !!here;
    const fx = (kind: SpectacleKind, extra: { tile?: number; label?: string; seconds?: number } = {}): void => {
      const code = this.targetCode();
      if (this.where !== 'all' && !code) return this.deps.say('Pick a game in Games first', true);
      const msg: ClientMessage = this.where === 'all' ? { type: 'adminSpectacle', scope: 'all', kind, ...extra } : { type: 'adminSpectacle', scope: 'room', code: code!, kind, ...extra };
      this.send(msg);
    };
    const onTile = (kind: SpectacleKind, label: string, extra: () => { label?: string } = () => ({})): HTMLButtonElement => {
      const b = this.btn(label, () => {
        if (!onMap || !this.deps.pickTile) return;
        this.deps.pickTile(`Console: click the map for the ${kind === 'ping' ? 'ring' : kind}`, (tile) => {
          this.deps.endPick();
          fx(kind, { tile, ...extra() });
        });
      });
      b.disabled = !onMap;
      return b;
    };

    this.sec(body, 'Look here');
    const pl = this.textIn(this.pingLabel, BROADCAST_LABEL_MAX, 'Look here', (v) => (this.pingLabel = v));
    pl.setAttribute('aria-label', 'Label on the map');
    body.append(this.row('Label', pl), this.row('', onTile('ping', 'Ring a tile', () => {
      const l = cleanBroadcastText(this.pingLabel, BROADCAST_LABEL_MAX);
      return l ? { label: l } : {};
    })));
    if (!onMap) this.note(body, 'Effects on a tile need the map: open the game you are in and choose "This game".');

    this.sec(body, 'Countdown');
    const cl = this.textIn(this.countLabel, BROADCAST_LABEL_MAX, 'Starting in', (v) => (this.countLabel = v));
    cl.setAttribute('aria-label', 'Countdown label');
    const cs = el('input', 'adm-num');
    cs.type = 'number';
    cs.min = String(COUNTDOWN_SECONDS[0]);
    cs.max = String(COUNTDOWN_SECONDS[1]);
    cs.value = String(this.countSeconds);
    cs.style.width = '64px';
    cs.setAttribute('aria-label', 'Seconds');
    cs.addEventListener('input', () => (this.countSeconds = Number(cs.value)));
    body.append(
      this.row('Label', cl),
      this.row('Seconds', cs, this.btn('Start countdown', () => {
        const s = Math.round(this.countSeconds);
        if (!(s >= COUNTDOWN_SECONDS[0] && s <= COUNTDOWN_SECONDS[1])) return this.deps.say(`Seconds: ${COUNTDOWN_SECONDS[0]} to ${COUNTDOWN_SECONDS[1]}`, true);
        const l = cleanBroadcastText(this.countLabel, BROADCAST_LABEL_MAX);
        fx('countdown', l ? { seconds: s, label: l } : { seconds: s });
      }, 'go')),
    );

    this.sec(body, 'Celebrate');
    body.append(
      this.row('Confetti', this.btn('Whole screen', () => fx('confetti')), onTile('confetti', 'On a tile')),
      this.row('Fireworks', this.btn('Whole screen', () => fx('fireworks')), onTile('fireworks', 'On a tile')),
      this.row('Shake', this.btn('Shake screens', () => fx('shake'))),
    );
    this.note(body, 'Players who ask their system for less motion get no shake and fewer particles.');
  }
}
