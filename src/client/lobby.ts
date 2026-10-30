// The Multiplayer pages of the main menu: the public lobby list (FFA, Teams, Special with their modifier chips,
// player counts and countdowns), join by code, create a private lobby, and the lobby itself. The lobby reuses the
// single-player setup screen (setupScreen.ts in lobby mode): the host edits the same GameSetup, the server checks
// and relays it, everyone else sees it read-only. A third column holds the code, the players, teams and Start.
import type { NetClient, NetStatus } from '../net/client';
import { LOBBY_CODE_LENGTH, MAX_LOBBY_PLAYERS, normalizeLobbyCode, TEAM_NAMES } from '../net/protocol';
import type { LobbyChip, LobbyStateMsg, LobbySummary, RGB, ServerMessage } from '../net/protocol';
import { cloneSetup, DEFAULT_SETUP, mapLabel, MULTIPLAYER_NATIONS } from '../sim/setup';
import { TEAM_COLORS } from '../sim/state';
import type { GameSetup } from '../sim/types';
import { button, el, rgbCss, setText } from './dom';
import { lineIcon } from './hud/glyph';
import { PLAYER_PALETTE, saveSetupPrefs, SetupScreen, type SetupPrefs } from './setupScreen';

/** Settings edits are sent at most this often (sliders fire many input events). */
const SEND_DELAY_MS = 180;
/** Lobby the client is in (or its game), so a reload can come back to it. */
export const MP_ACTIVE_KEY = 'borderfall.mp.active';

export function rememberActiveLobby(code: string | null): void {
  try {
    if (code) localStorage.setItem(MP_ACTIVE_KEY, code);
    else localStorage.removeItem(MP_ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}
export function activeLobby(): string | null {
  try {
    return localStorage.getItem(MP_ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** Plain words for the connection state (with the ping when online). */
export function statusText(net: NetClient | null): { text: string; cls: 'ok' | 'warn' | 'bad' } {
  const st: NetStatus = net ? net.status : 'idle';
  switch (st) {
    case 'online':
      return { text: net!.latencyMs !== null ? `Online · ${Math.round(net!.latencyMs)} ms` : 'Online', cls: 'ok' };
    case 'connecting':
    case 'idle':
      return { text: 'Connecting…', cls: 'warn' };
    case 'reconnecting':
      return { text: `Connection lost, retrying${net && net.attempts > 1 ? ` (${net.attempts})` : ''}…`, cls: 'warn' };
    case 'outdated':
      return { text: 'The server runs a newer version: reload the page', cls: 'bad' };
    case 'replaced':
      return { text: 'Opened in another tab', cls: 'bad' };
    case 'noServer':
      return { text: 'No multiplayer server for this page (add ?server=…)', cls: 'bad' };
    default:
      return { text: 'Offline', cls: 'bad' };
  }
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const KIND_LABEL: Record<LobbySummary['kind'], string> = { ffa: 'Free for all', teams: 'Teams', special: 'Special' };

function chipEls(chips: readonly LobbyChip[]): HTMLElement {
  const row = el('div', 'lob-chips');
  for (const c of chips) {
    const ch = el('span', 'mod-chip', c.label);
    ch.title = c.detail;
    row.append(ch);
  }
  return row;
}

export interface MultiplayerHooks {
  /** the net connection (created and connected on first use) */
  net: () => NetClient;
  onBack: () => void;
}

/** The multiplayer pages, drawn into the menu card. One instance per visit; destroy() when leaving. */
export class MultiplayerScreen {
  private view: 'browse' | 'lobby' = 'browse';
  private lobbies: LobbySummary[] = [];
  private lobby: LobbyStateMsg | null = null;
  private setup: SetupScreen | null = null;
  private lobbyPrefs: SetupPrefs;
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval>;
  private message = '';
  private messageBad = false;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSetup: GameSetup | null = null;
  /** a create / join request is on its way */
  private busy = false;

  // browse page parts
  private statusEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private msgEl: HTMLElement | null = null;
  // lobby page parts
  private side: HTMLElement | null = null;
  private lobbyStatus: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;

  constructor(
    private card: HTMLElement,
    private prefs: SetupPrefs,
    private hooks: MultiplayerHooks,
  ) {
    this.lobbyPrefs = { ...prefs, setup: cloneSetup(DEFAULT_SETUP) };
    const net = hooks.net();
    this.offs.push(net.on((m) => this.handle(m)));
    this.offs.push(
      net.onStatus(() => {
        this.refreshStatus();
        if (!this.lobbies.length) this.renderList();
      }),
    );
    this.timer = setInterval(() => this.tick(), 250);
    this.showBrowse();
    net.connect();
  }

  destroy(): void {
    for (const f of this.offs) f();
    this.offs = [];
    clearInterval(this.timer);
    if (this.sendTimer) clearTimeout(this.sendTimer);
  }

  /** Joins a lobby by its code (also used for ?lobby= links). */
  join(code: string, spectate = false): void {
    const c = normalizeLobbyCode(code);
    if (!c) {
      this.say(`A lobby code has ${LOBBY_CODE_LENGTH} letters and digits`, true);
      return;
    }
    if (!this.hooks.net().send({ type: 'joinLobby', code: c, spectate })) {
      this.say('Not connected yet: try again in a moment', true);
      return;
    }
    this.busy = true;
    this.say(spectate ? `Joining ${c} as a spectator…` : `Joining ${c}…`);
  }

  // ---------------------------------------------------------------------------------------------- messages

  private handle(m: ServerMessage): void {
    switch (m.type) {
      case 'welcome':
        if (!m.resumed && this.view === 'lobby') {
          // our lobby is gone (closed while we were away)
          this.lobby = null;
          rememberActiveLobby(null);
          this.showBrowse();
          this.say('The lobby is gone', true);
        }
        break;
      case 'lobbyList':
        this.lobbies = m.lobbies;
        if (this.view === 'lobby' && this.lobby) {
          // the server only sends the list to sessions outside a lobby: we were dropped
          this.lobby = null;
          rememberActiveLobby(null);
          this.showBrowse();
        }
        this.renderList();
        break;
      case 'lobbyState':
        this.busy = false;
        this.lobby = m;
        rememberActiveLobby(m.code);
        if (this.view !== 'lobby') this.showLobby();
        else this.renderLobby();
        break;
      case 'kicked':
        this.lobby = null;
        rememberActiveLobby(null);
        this.showBrowse();
        this.say(m.reason, true);
        break;
      case 'error':
        this.busy = false;
        this.say(m.message, true);
        break;
      default:
        break;
    }
  }

  private say(text: string, bad = false): void {
    this.message = text;
    this.messageBad = bad;
    if (this.msgEl) {
      setText(this.msgEl, text);
      this.msgEl.classList.toggle('bad', bad);
    }
    if (this.lobbyStatus) this.renderLobbyStatus();
  }

  private tick(): void {
    this.refreshStatus();
    const net = this.hooks.net();
    if (this.view === 'browse' && this.listEl) {
      for (const node of this.listEl.querySelectorAll<HTMLElement>('[data-starts]')) {
        const at = Number(node.dataset.starts);
        setText(node, `Starts in ${fmtCountdown(at - net.serverNow())}`);
      }
    }
    if (this.view === 'lobby' && this.countdownEl && this.lobby) {
      const l = this.lobby;
      setText(this.countdownEl, l.startsAt !== null ? `Starts in ${fmtCountdown(l.startsAt - net.serverNow())}` : l.isPublic ? 'Starts when the first player joins' : 'The host starts the game');
    }
  }

  private refreshStatus(): void {
    const net = this.hooks.net();
    const st = statusText(net);
    if (this.statusEl) {
      setText(this.statusEl, st.text);
      this.statusEl.className = `net-status ${st.cls}`;
    }
    if (this.lobbyStatus) this.renderLobbyStatus();
  }

  // ---------------------------------------------------------------------------------------------- browse page

  private showBrowse(): void {
    this.view = 'browse';
    this.setup = null;
    this.side = this.lobbyStatus = this.countdownEl = null;
    const card = this.card;
    card.className = 'menu-card mp';
    card.replaceChildren();

    const top = el('div', 'menu-head');
    this.statusEl = el('span', 'net-status');
    this.statusEl.dataset.test = 'net-status';
    top.append(button('Back', 'ghost', () => this.hooks.onBack()), el('h2', '', 'Multiplayer'), this.statusEl);

    // identity: name and colour
    const you = el('div', 'mp-you');
    const name = el('input', 'input');
    name.type = 'text';
    name.maxLength = 20;
    name.value = this.prefs.playerName;
    name.setAttribute('aria-label', 'Your name');
    name.dataset.test = 'mp-name';
    const applyIdentity = () => {
      saveSetupPrefs(this.prefs);
      this.hooks.net().setIdentity({ name: this.prefs.playerName.trim() || 'Player', color: (PLAYER_PALETTE[this.prefs.color] ?? PLAYER_PALETTE[0]) as RGB }, true);
    };
    name.addEventListener('input', () => (this.prefs.playerName = name.value));
    name.addEventListener('change', applyIdentity);
    const pal = el('div', 'palette');
    pal.setAttribute('role', 'group');
    pal.setAttribute('aria-label', 'Your colour');
    const swatches: HTMLButtonElement[] = [];
    PLAYER_PALETTE.forEach((c, k) => {
      const b = el('button', 'swatch-btn');
      b.type = 'button';
      b.style.background = rgbCss(c);
      b.setAttribute('aria-label', `Colour ${k + 1}`);
      b.addEventListener('click', () => {
        this.prefs.color = k;
        swatches.forEach((x, j) => x.classList.toggle('on', j === k));
        applyIdentity();
      });
      b.classList.toggle('on', this.prefs.color === k);
      swatches.push(b);
      pal.append(b);
    });
    you.append(el('span', 'form-label', 'You'), name, pal);

    const body = el('div', 'mp-body');
    // public lobbies
    const pub = el('section', 'mp-col');
    pub.append(el('h3', 'setup-h', 'Public games'));
    pub.append(el('p', 'mp-note', 'Join a game that starts by itself when its countdown ends. AI nations fill the free places.'));
    this.listEl = el('div', 'lob-list');
    this.listEl.dataset.test = 'lobby-list';
    pub.append(this.listEl);

    // private lobbies
    const priv = el('section', 'mp-col mp-private');
    priv.append(el('h3', 'setup-h', 'Play with friends'));
    priv.append(el('p', 'mp-note', 'Create a private lobby, choose the map and the rules like in single player, and send the code to your friends.'));
    const create = button('Create private lobby', 'primary big', () => {
      if (!this.hooks.net().send({ type: 'createLobby', settings: { ...cloneSetup(this.prefs.setup), aiCount: Math.max(0, MULTIPLAYER_NATIONS - 2) } })) {
        this.say('Not connected yet: try again in a moment', true);
        return;
      }
      this.busy = true;
      this.say('Creating a lobby…');
    });
    create.dataset.test = 'mp-create';
    const joinRow = el('div', 'mp-join');
    const code = el('input', 'input code-in');
    code.type = 'text';
    code.maxLength = 8;
    code.placeholder = 'CODE';
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.setAttribute('aria-label', 'Lobby code');
    code.dataset.test = 'mp-code';
    const joinBtn = button('Join', '', () => this.join(code.value));
    joinBtn.dataset.test = 'mp-join';
    const watchBtn = button('Watch', 'ghost', () => this.join(code.value, true));
    watchBtn.title = 'Join as a spectator: see the whole map, no actions';
    watchBtn.dataset.test = 'mp-watch';
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join(code.value);
    });
    joinRow.append(code, joinBtn, watchBtn);
    priv.append(create, el('span', 'form-label mp-or', 'Have a code?'), joinRow);

    body.append(pub, priv);
    this.msgEl = el('div', 'mp-msg');
    this.msgEl.setAttribute('role', 'status');
    this.msgEl.dataset.test = 'mp-msg';
    setText(this.msgEl, this.message);
    this.msgEl.classList.toggle('bad', this.messageBad);
    const foot = el('div', 'menu-foot mp-foot');
    foot.append(you, this.msgEl);
    card.append(top, body, foot);
    this.renderList();
    this.refreshStatus();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list || this.view !== 'browse') return;
    list.replaceChildren();
    const net = this.hooks.net();
    if (!this.lobbies.length) {
      const text = net.online ? 'No public games right now.' : net.status === 'noServer' ? 'This copy of the game has no multiplayer server: open the game from a server, or add ?server=<address> to the page link.' : 'Waiting for the server…';
      list.append(el('div', 'lob-empty', text));
      return;
    }
    const order: Record<string, number> = { ffa: 0, teams: 1, special: 2 };
    for (const l of [...this.lobbies].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))) {
      const row = el('div', `lob-row kind-${l.kind}`);
      row.dataset.code = l.code;
      row.dataset.kind = l.kind;
      const head = el('div', 'lob-head');
      head.append(el('span', `lob-kind ${l.kind}`, l.kind === 'teams' ? `${l.teamCount} teams` : KIND_LABEL[l.kind]), el('span', 'lob-map', mapLabel(l.map)));
      const meta = el('div', 'lob-meta');
      const players = el('span', 'lob-players', `${l.players} / ${l.maxPlayers} players`);
      const when = el('span', 'lob-when');
      if (l.startsAt !== null) {
        when.dataset.starts = String(l.startsAt);
        when.textContent = `Starts in ${fmtCountdown(l.startsAt - net.serverNow())}`;
      } else when.textContent = 'Waiting for players';
      meta.append(players, when);
      const info = el('div', 'lob-info');
      info.append(head, meta);
      if (l.chips.length) info.append(chipEls(l.chips));
      else info.append(el('div', 'lob-rules', 'Standard rules'));
      const go = button('Join', 'primary', () => this.join(l.code));
      go.dataset.test = `join-${l.kind}`;
      row.append(info, go);
      list.append(row);
    }
  }

  // ---------------------------------------------------------------------------------------------- lobby page

  private isHost(): boolean {
    const l = this.lobby;
    return !!l && !l.isPublic && l.hostMemberId === l.you;
  }

  private showLobby(): void {
    const l = this.lobby;
    if (!l) return;
    this.view = 'lobby';
    this.statusEl = this.listEl = this.msgEl = null;
    this.message = '';
    this.side = el('section', 'setup-col lobby-col');
    this.side.setAttribute('aria-label', 'Lobby');
    this.lobbyStatus = el('div', 'menu-foot lobby-foot');
    this.lobbyPrefs.setup = cloneSetup(l.settings);
    const title = l.isPublic ? `${l.kind ? KIND_LABEL[l.kind] : 'Public'} game` : 'Private lobby';
    this.setup = new SetupScreen(
      this.card,
      this.lobbyPrefs,
      { onBack: () => this.leave(), onStart: () => {} },
      { title, side: this.side, status: this.lobbyStatus, editable: this.isHost(), onChange: (s) => this.queueSettings(s) },
    );
    this.card.classList.add('lobby');
    this.renderLobby();
  }

  private queueSettings(s: GameSetup): void {
    if (!this.isHost()) return;
    this.pendingSetup = s;
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      const next = this.pendingSetup;
      this.pendingSetup = null;
      if (!next) return;
      const { map, aiCount, tribeCount, difficulty, mode, teamCount, timeLimit, victoryLandShare, modifiers, preset } = next;
      this.hooks.net().send({ type: 'updateLobbySettings', settings: { map, aiCount, tribeCount, difficulty, mode, teamCount, timeLimit, victoryLandShare, modifiers, preset } });
    }, SEND_DELAY_MS);
  }

  private leave(): void {
    this.hooks.net().send({ type: 'leaveLobby' });
    this.lobby = null;
    rememberActiveLobby(null);
    this.showBrowse();
  }

  private renderLobby(): void {
    const l = this.lobby;
    const side = this.side;
    if (!l || !side || !this.setup) return;
    const host = this.isHost();
    // the server's settings, unless the host has an edit on its way
    if (!(host && (this.pendingSetup || this.sendTimer))) this.setup.setSetup(l.settings, host);
    else this.setup.setEditable(host);
    side.replaceChildren();

    // code and share
    const head = el('div', 'setup-sec-head');
    head.append(el('h3', 'setup-h', l.isPublic ? 'Public game' : 'Lobby code'));
    side.append(head);
    if (!l.isPublic) {
      const codeRow = el('div', 'lobby-code');
      const code = el('span', 'code-big', l.code);
      code.dataset.test = 'lobby-code';
      const copy = button('', 'icon-btn', () => void this.copy(l.code, 'Code copied'));
      copy.innerHTML = lineIcon('copy', 16);
      copy.title = 'Copy the code';
      copy.setAttribute('aria-label', 'Copy the code');
      copy.dataset.test = 'copy-code';
      const link = button('Copy link', 'ghost mini-btn', () => void this.copy(this.inviteLink(l.code), 'Invite link copied'));
      link.title = 'A link that opens the game and joins this lobby';
      codeRow.append(code, copy, link);
      side.append(codeRow);
    }
    this.countdownEl = el('div', 'lobby-when');
    side.append(this.countdownEl);
    this.tick();

    // players
    const ph = el('div', 'setup-sec-head');
    ph.append(el('h3', 'setup-h', `Players ${l.players.length} / ${l.settings.maxPlayers}`));
    if (host) {
      const seats = el('select', 'input seats-in');
      seats.setAttribute('aria-label', 'Seats');
      for (let n = Math.max(1, l.players.length); n <= MAX_LOBBY_PLAYERS; n++) {
        const o = el('option', '', `${n} seats`);
        o.value = String(n);
        o.selected = n === l.settings.maxPlayers;
        seats.append(o);
      }
      seats.addEventListener('change', () => this.hooks.net().send({ type: 'updateLobbySettings', settings: { maxPlayers: Number(seats.value) } }));
      ph.append(seats);
    }
    side.append(ph);
    const list = el('ul', 'lobby-players');
    list.dataset.test = 'lobby-players';
    const teams = l.settings.mode === 'teams';
    for (const p of l.players) {
      const li = el('li', 'lp');
      if (!p.connected) li.classList.add('away');
      const sw = el('i', 'sw');
      sw.style.background = rgbCss(p.color);
      const nm = el('span', 'lp-name', p.name);
      li.append(sw, nm);
      if (p.memberId === l.you) li.append(el('span', 'lp-tag you', 'you'));
      if (p.isHost) li.append(el('span', 'lp-tag', 'host'));
      if (!p.connected) li.append(el('span', 'lp-tag', 'away'));
      if (teams) {
        const tm = el('span', 'lp-team', p.team > 0 ? TEAM_NAMES[p.team - 1] ?? `Team ${p.team}` : 'Auto');
        if (p.team > 0 && TEAM_COLORS[p.team - 1]) tm.style.color = rgbCss(TEAM_COLORS[p.team - 1]);
        li.append(tm);
      }
      if (host && p.memberId !== l.you) {
        const kick = button('Kick', 'ghost mini-btn danger', () => this.hooks.net().send({ type: 'kick', memberId: p.memberId }));
        kick.dataset.test = 'kick';
        li.append(kick);
      }
      list.append(li);
    }
    side.append(list);
    if (l.spectators > 0) side.append(el('div', 'mp-note', `${l.spectators} watching`));

    // team choice
    if (teams && !l.youAreSpectator) {
      const me = l.players.find((p) => p.memberId === l.you);
      const th = el('div', 'setup-sec-head');
      th.append(el('h3', 'setup-h', 'Your team'));
      const seg = el('div', 'seg setup-seg team-seg');
      const opts = [{ id: 0, label: 'Auto' }, ...Array.from({ length: l.settings.teamCount }, (_, k) => ({ id: k + 1, label: TEAM_NAMES[k] ?? `Team ${k + 1}` }))];
      for (const o of opts) {
        const b = button(o.label, me?.team === o.id ? 'on' : '', () => this.hooks.net().send({ type: 'setTeam', team: o.id }));
        b.setAttribute('aria-pressed', String(me?.team === o.id));
        b.dataset.team = String(o.id);
        if (o.id > 0 && TEAM_COLORS[o.id - 1]) b.style.setProperty('--team', rgbCss(TEAM_COLORS[o.id - 1]));
        seg.append(b);
      }
      side.append(th, seg, el('div', 'mp-note', 'Teammates are allied for the whole game and win together. AI nations fill the teams evenly.'));
    }

    // actions
    const act = el('div', 'lobby-actions');
    if (host) {
      const start = button('Start game', 'primary big', () => this.hooks.net().send({ type: 'startGame' }));
      start.dataset.test = 'mp-start';
      act.append(start);
    }
    const leave = button('Leave', 'ghost', () => this.leave());
    leave.dataset.test = 'mp-leave';
    act.append(leave);
    side.append(act);
    this.renderLobbyStatus();
  }

  private renderLobbyStatus(): void {
    const foot = this.lobbyStatus;
    const l = this.lobby;
    if (!foot || !l) return;
    const st = statusText(this.hooks.net());
    const net = el('span', `net-status ${st.cls}`, st.text);
    net.dataset.test = 'net-status';
    const who = l.youAreSpectator ? 'You are watching this game.' : l.isPublic ? 'The game starts by itself when the countdown ends.' : this.isHost() ? 'You are the host: set up the game, then press Start.' : 'The host sets up the game.';
    const msg = el('span', `mp-msg${this.messageBad ? ' bad' : ''}`, this.message || who);
    msg.dataset.test = 'mp-msg';
    foot.replaceChildren(net, msg);
  }

  private inviteLink(code: string): string {
    const u = new URL(location.href);
    u.search = '';
    const server = new URLSearchParams(location.search).get('server');
    if (server) u.searchParams.set('server', server);
    u.searchParams.set('lobby', code);
    return u.toString();
  }

  private async copy(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.say(done);
    } catch {
      // clipboard blocked (http, permissions): select-and-copy fallback
      const ta = el('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      this.say(ok ? done : `Copy this: ${text}`, !ok);
    }
  }
}
