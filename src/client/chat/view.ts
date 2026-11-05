// The chat widget: a small Chat button with an unread count (the newest message shows over it for a moment) that
// opens the chat panel: channel tabs (All / Team in teams games), the messages with each sender's name in their
// nation colour, a click on a name to mute or unmute that player (this browser session), quick-chat buttons and the
// input with Send. Used in the game HUD (hud.ts) and the lobby (lobby.ts). Everything players typed is put in the page
// with textContent only: no HTML, no links. Keys typed in the input never reach the game (only key releases do, so a
// pan key held down when the chat opened stops panning).
import { CHAT_MAX_LENGTH } from '../../net/protocol';
import type { ChatEntry, RGB } from '../../net/protocol';
import { button, el, rgbCss, setText } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import './chat.css';
import { chatEnabled, tidyChatInput, type ChatEvent, type ChatStore } from './store';

/** The newest message shows over the closed button this long. */
const PREVIEW_MS = 6000;
/** Messages drawn in the list (older ones stay in the store). */
const DRAWN = 120;

export interface QuickChat {
  label: string;
  /** what is sent (the label unless given) */
  text?: string;
  /** team chat with a map mark at the camera centre */
  ping?: boolean;
}
export const QUICK_CHAT: readonly QuickChat[] = [
  { label: 'Good luck' },
  { label: 'Well played' },
  { label: 'Help!' },
  { label: 'Truce?' },
  { label: 'Thanks' },
  { label: 'Attack here', ping: true },
];

export interface ChatViewOptions {
  /** 'hud': a corner button over the map; 'lobby': a section of the lobby column */
  mode: 'hud' | 'lobby';
  /** in a game: the tile at the camera centre (for "Attack here"), null when there is none */
  cameraTile?: () => number | null;
  /** a message's map mark was clicked: show that tile */
  showTile?: (tile: number) => void;
  /** a teammate's map mark came in: flash it on the map */
  onPing?: (tile: number) => void;
  /** the panel opened or closed, or the message slip appeared: the owner may place the widget again */
  onLayout?: () => void;
}

/** A sender's colour made readable on the dark panels (dark nation colours are lifted toward white). */
export function readableColor(c: RGB): string {
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  if (lum >= 0.42) return rgbCss(c);
  const k = Math.min(0.65, 0.42 - lum + 0.2);
  return rgbCss([0, 1, 2].map((i) => Math.round(c[i] + (255 - c[i]) * k)) as unknown as RGB);
}

function channelLabel(e: ChatEntry): string {
  return e.channel === 'team' ? 'Team' : e.channel === 'spectators' ? 'Spectators' : '';
}

/**
 * One message as DOM: [channel] name: text. The name is a button (mute menu) unless it is ours. User text goes in with
 * textContent only.
 */
export function renderChatEntry(e: ChatEntry, opts: { mine: boolean; onName?: (e: ChatEntry, anchor: HTMLElement) => void; onPing?: (tile: number) => void }): HTMLElement {
  const row = el('div', `chat-msg ch-${e.channel}`);
  row.dataset.id = String(e.id);
  const tag = channelLabel(e);
  if (tag) row.append(el('span', 'chat-tag', tag));
  const clickable = !opts.mine && !!opts.onName;
  const name = clickable ? el('button', 'chat-name') : el('span', 'chat-name');
  if (clickable) {
    (name as HTMLButtonElement).type = 'button';
    name.title = `${e.name}: mute or unmute`;
    name.addEventListener('click', () => opts.onName?.(e, name));
  }
  const sw = el('i', 'chat-sw');
  sw.style.background = rgbCss(e.color);
  name.append(sw, document.createTextNode(e.name));
  name.style.color = readableColor(e.color);
  const text = el('span', 'chat-text');
  text.textContent = e.text;
  row.append(name, text);
  if (e.ping !== undefined && opts.onPing) {
    const tile = e.ping;
    const show = button('Show', 'chat-show', () => opts.onPing?.(tile));
    show.title = 'Show this spot on the map';
    show.dataset.test = 'chat-show';
    row.append(show);
  }
  return row;
}

export class ChatView {
  readonly el: HTMLElement;
  private btn: HTMLButtonElement;
  private badge: HTMLElement;
  private preview: HTMLElement;
  private panel: HTMLElement;
  private tabs: HTMLElement;
  private tabAll: HTMLButtonElement;
  private tabTeam: HTMLButtonElement;
  private specNote: HTMLElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private menu: HTMLElement;
  private quick: HTMLElement;
  private quickPing: HTMLButtonElement | null = null;
  private input: HTMLInputElement;
  private note: HTMLElement;
  private tab: 'all' | 'team' = 'all';
  private isOpen = false;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private off: () => void;

  constructor(
    private store: ChatStore,
    private opts: ChatViewOptions,
  ) {
    this.el = el('div', `chat chat-${opts.mode}`);
    this.el.dataset.test = 'chat';

    this.btn = el('button', 'chat-btn');
    this.btn.type = 'button';
    this.btn.dataset.test = 'chat-btn';
    this.btn.setAttribute('aria-expanded', 'false');
    this.badge = el('span', 'chat-badge hidden');
    this.badge.dataset.test = 'chat-unread';
    this.btn.append(iconSpan(lineIcon('chat', 16), 'ico'), el('span', 'chat-btn-l', 'Chat'), this.badge);
    this.btn.addEventListener('click', () => this.setOpen(!this.isOpen));

    this.preview = el('div', 'chat-preview hidden');
    this.preview.dataset.test = 'chat-preview';
    this.preview.addEventListener('click', () => this.setOpen(true));

    // ---- panel
    this.panel = el('section', 'chat-panel hidden');
    this.panel.setAttribute('aria-label', 'Chat');
    this.panel.dataset.test = 'chat-panel';
    const head = el('div', 'chat-head');
    this.tabs = el('div', 'chat-tabs');
    this.tabs.setAttribute('role', 'tablist');
    this.tabAll = button('All', 'chat-tab', () => this.setTab('all'));
    this.tabTeam = button('Team', 'chat-tab', () => this.setTab('team'));
    this.tabAll.dataset.test = 'chat-tab-all';
    this.tabTeam.dataset.test = 'chat-tab-team';
    for (const t of [this.tabAll, this.tabTeam]) t.setAttribute('role', 'tab');
    this.tabs.append(this.tabAll, this.tabTeam);
    this.specNote = el('div', 'chat-spec hidden', "Spectators only: players don't see these messages.");
    const title = el('span', 'chat-title', 'Chat');
    const close = el('button', 'chat-x');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close chat');
    close.append(iconSpan(lineIcon('close', 14, 2)));
    close.addEventListener('click', () => this.setOpen(false));
    head.append(title, this.tabs, close);

    this.list = el('div', 'chat-list');
    this.list.dataset.test = 'chat-list';
    this.list.setAttribute('role', 'log');
    this.list.setAttribute('aria-live', 'polite');
    this.empty = el('p', 'chat-empty', 'No messages yet. Say hello.');

    this.menu = el('div', 'chat-menu hidden');
    this.menu.dataset.test = 'chat-menu';

    this.quick = el('div', 'chat-quick');
    this.quick.dataset.test = 'chat-quick';
    for (const q of QUICK_CHAT) {
      const b = button(q.label, 'chat-q', () => this.sendQuick(q));
      if (q.ping) {
        b.title = 'Tell your team to attack the middle of your view (marks it on their maps)';
        b.classList.add('chat-q-ping');
        b.dataset.test = 'chat-attack-here';
        this.quickPing = b;
      }
      this.quick.append(b);
    }

    const form = el('form', 'chat-form');
    this.input = el('input', 'chat-in');
    this.input.type = 'text';
    this.input.maxLength = CHAT_MAX_LENGTH;
    this.input.autocomplete = 'off';
    this.input.spellcheck = true;
    this.input.enterKeyHint = 'send';
    this.input.setAttribute('aria-label', 'Message');
    this.input.dataset.test = 'chat-input';
    // typing is never a game key: the input keeps its keys to itself (Esc closes the panel)
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.setOpen(false);
      }
    });
    // keyup still reaches the page: a pan key held when the input took focus must be let go (input.ts)
    this.input.addEventListener('keypress', (e) => e.stopPropagation());
    const send = el('button', 'chat-send');
    send.type = 'submit';
    send.dataset.test = 'chat-send';
    send.append(iconSpan(lineIcon('send', 15)), el('span', '', 'Send'));
    form.append(this.input, send);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendTyped();
    });
    this.note = el('div', 'chat-note hidden');
    this.note.dataset.test = 'chat-note';
    this.note.setAttribute('role', 'status');

    this.panel.append(head, this.specNote, this.list, this.menu, this.quick, form, this.note);
    this.el.append(this.preview, this.btn, this.panel);
    // a click outside the mute menu closes it
    this.panel.addEventListener('pointerdown', (e) => {
      if (!this.menu.contains(e.target as Node)) this.closeMenu();
    });

    this.off = store.on((e) => this.onEvent(e));
    this.renderAll();
  }

  destroy(): void {
    this.off();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.el.remove();
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Height of the open panel (0 when closed). */
  panelHeight(): number {
    return this.isOpen ? this.panel.offsetHeight : 0;
  }

  setOpen(open: boolean): void {
    this.isOpen = open && chatEnabled() && this.store.active;
    this.panel.classList.toggle('hidden', !this.isOpen);
    this.el.classList.toggle('open', this.isOpen);
    this.btn.setAttribute('aria-expanded', String(this.isOpen));
    this.closeMenu();
    if (this.isOpen) {
      this.store.markRead();
      this.hidePreview();
      this.renderList();
      this.renderBadge();
      this.input.focus({ preventScroll: true });
      // the lobby column scrolls: bring the whole panel into view (its scroll margin keeps it clear of Start / Leave)
      if (this.opts.mode === 'lobby') this.panel.scrollIntoView?.({ block: 'nearest' });
    } else if (this.panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    this.opts.onLayout?.();
  }

  /** Called by the owner (HUD each slow frame, lobby on its state): whether the quick map mark can be used now. */
  refresh(): void {
    this.renderChrome();
  }

  // ---------------------------------------------------------------------------------------------- events

  private onEvent(e: ChatEvent): void {
    switch (e.kind) {
      case 'entry': {
        const en = e.entry;
        const mine = en.from === this.store.you;
        const muted = !mine && this.store.isMuted(en.from);
        if (en.ping !== undefined && !muted && !mine && chatEnabled()) this.opts.onPing?.(en.ping);
        if (muted) return;
        if (this.isOpen) {
          this.store.markRead();
          if (this.shows(en)) this.appendEntry(en);
        } else if (!mine && chatEnabled()) {
          this.showPreview(en);
        }
        this.renderBadge();
        break;
      }
      case 'notice':
        this.say(e.notice.text);
        break;
      case 'reset':
      case 'mutes':
      case 'enabled':
        if (!this.store.team && this.tab === 'team') this.tab = 'all';
        if (!chatEnabled() || !this.store.active) this.setOpen(false);
        this.renderAll();
        break;
    }
  }

  private renderAll(): void {
    this.renderChrome();
    this.renderList();
    this.renderBadge();
  }

  private renderChrome(): void {
    const s = this.store;
    this.el.classList.toggle('hidden', !chatEnabled() || !s.active);
    const team = s.team && !s.spectator;
    this.tabs.classList.toggle('hidden', !team);
    this.specNote.classList.toggle('hidden', !s.spectator);
    this.tabAll.classList.toggle('on', this.tab === 'all');
    this.tabTeam.classList.toggle('on', this.tab === 'team');
    this.tabAll.setAttribute('aria-selected', String(this.tab === 'all'));
    this.tabTeam.setAttribute('aria-selected', String(this.tab === 'team'));
    if (this.quickPing) this.quickPing.classList.toggle('hidden', !team || !this.opts.cameraTile);
    this.input.placeholder = s.spectator ? 'Message spectators' : this.tab === 'team' ? 'Message your team' : 'Message everyone';
  }

  private renderBadge(): void {
    const n = this.store.unread;
    this.badge.classList.toggle('hidden', n === 0 || this.isOpen);
    setText(this.badge, n > 9 ? '9+' : String(n));
    this.btn.setAttribute('aria-label', n > 0 && !this.isOpen ? `Chat, ${n} new` : 'Chat');
  }

  private shows(e: ChatEntry): boolean {
    return this.tab === 'all' || e.channel === 'team';
  }

  private renderList(): void {
    if (!this.isOpen) return;
    const rows = this.store
      .visible()
      .filter((e) => this.shows(e))
      .slice(-DRAWN)
      .map((e) => this.entryEl(e));
    this.list.replaceChildren(...(rows.length ? rows : [this.empty]));
    this.list.scrollTop = this.list.scrollHeight;
  }

  private entryEl(e: ChatEntry): HTMLElement {
    return renderChatEntry(e, {
      mine: e.from === this.store.you,
      onName: (en, anchor) => this.openMenu(en, anchor),
      onPing: this.opts.showTile,
    });
  }

  private appendEntry(e: ChatEntry): void {
    const nearEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    if (this.empty.parentElement) this.empty.remove();
    this.list.append(this.entryEl(e));
    while (this.list.childElementCount > DRAWN) this.list.firstElementChild?.remove();
    if (nearEnd || e.from === this.store.you) this.list.scrollTop = this.list.scrollHeight;
  }

  private setTab(t: 'all' | 'team'): void {
    if (t === 'team' && !this.store.team) return;
    this.tab = t;
    this.renderChrome();
    this.renderList();
    this.input.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------------------------- preview

  private showPreview(e: ChatEntry): void {
    const name = el('b', 'chat-pv-name');
    name.textContent = e.name;
    name.style.color = readableColor(e.color);
    const text = el('span', 'chat-pv-text');
    text.textContent = e.text;
    const tag = channelLabel(e);
    this.preview.replaceChildren(...(tag ? [el('span', 'chat-tag', tag)] : []), name, text);
    this.preview.classList.remove('hidden');
    this.opts.onLayout?.();
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.hidePreview(), PREVIEW_MS);
  }

  private hidePreview(): void {
    this.preview.classList.add('hidden');
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  // ---------------------------------------------------------------------------------------------- mute menu

  private openMenu(e: ChatEntry, anchor: HTMLElement): void {
    const muted = this.store.isMuted(e.from);
    const who = el('div', 'chat-menu-who');
    const sw = el('i', 'chat-sw');
    sw.style.background = rgbCss(e.color);
    who.append(sw, document.createTextNode(e.name));
    const act = button(muted ? 'Unmute' : 'Mute', muted ? 'chat-menu-btn' : 'chat-menu-btn danger', () => {
      this.store.setMuted(e.from, !muted);
      this.closeMenu();
      this.say(muted ? `${e.name} unmuted.` : `${e.name} muted. You won't see their messages.`);
    });
    act.dataset.test = 'chat-mute';
    const hint = el('div', 'chat-menu-hint', muted ? "You don't see their messages." : 'Hide their messages for this visit.');
    this.menu.replaceChildren(who, hint, act);
    this.menu.classList.remove('hidden');
    // under the name, inside the panel
    const pr = this.panel.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const top = Math.min(ar.bottom - pr.top + 4, pr.height - 120);
    this.menu.style.top = `${Math.max(36, top)}px`;
    act.focus({ preventScroll: true });
  }

  private closeMenu(): void {
    this.menu.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------------------------- sending

  private sendTyped(): void {
    const text = tidyChatInput(this.input.value);
    if (!text) return;
    const err = this.store.send(this.tab, text);
    if (err) this.say(err);
    else this.input.value = '';
    this.keepTyping();
  }

  /** After a send by mouse or touch the caret goes back to the message box, so the next letters are not game keys. */
  private keepTyping(): void {
    if (this.isOpen) this.input.focus({ preventScroll: true });
  }

  private sendQuick(q: QuickChat): void {
    const text = q.text ?? q.label;
    if (q.ping) {
      const tile = this.opts.cameraTile?.() ?? null;
      if (tile === null) {
        this.say('Move the map over the spot first.');
        return;
      }
      const err = this.store.send('team', text, tile);
      if (err) this.say(err);
      this.keepTyping();
      return;
    }
    const err = this.store.send(this.tab, text);
    if (err) this.say(err);
    this.keepTyping();
  }

  private say(text: string): void {
    setText(this.note, text);
    this.note.classList.remove('hidden');
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => this.note.classList.add('hidden'), 5000);
    // a notice while the panel is closed: show it over the button instead
    if (!this.isOpen) {
      const t = el('span', 'chat-pv-text', text);
      this.preview.replaceChildren(t);
      this.preview.classList.remove('hidden');
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => this.hidePreview(), PREVIEW_MS);
    }
  }
}
