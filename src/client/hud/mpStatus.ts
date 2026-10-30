// Online games: a small status line (connection, ping, players connected, watching) and banners for what needs
// attention (reconnecting, catching up, out of sync with a Reload button, the server ended the game).
import type { NetClient } from '../../net/client';
import type { GameState } from '../../sim/types';
import { statusText } from '../lobby';
import type { MpGame } from '../mpgame';
import { button, el, setText } from '../dom';
import { lineIcon } from './glyph';

const SERVER_END: Record<string, string> = {
  abandoned: 'The game ended: every player left.',
  maxDuration: 'The game ended: it reached the time limit of the server.',
  finished: 'The game is over.',
};

export class MpStatus {
  readonly el: HTMLElement;
  private line: HTMLElement;
  private lineText: HTMLElement;
  private banner: HTMLElement;
  private bannerText: HTMLElement;
  private reload: HTMLButtonElement;
  private last = 0;

  constructor(onReload: () => void) {
    this.el = el('div', 'mp-hud');
    this.line = el('div', 'mp-line');
    this.line.dataset.test = 'mp-line';
    const ic = el('span', 'ico');
    ic.innerHTML = lineIcon('signal', 14);
    this.lineText = el('span', 'mp-line-t');
    this.line.append(ic, this.lineText);
    this.banner = el('div', 'mp-banner hidden');
    this.banner.setAttribute('role', 'alert');
    this.banner.dataset.test = 'mp-banner';
    this.bannerText = el('span', 'mp-banner-t');
    this.reload = button('Reload', 'primary', onReload);
    this.reload.dataset.test = 'mp-reload';
    this.banner.append(this.bannerText, this.reload);
    this.el.append(this.line, this.banner);
  }

  /** Called every frame; refreshes about 4 times a second. */
  update(mp: MpGame, net: NetClient, state: GameState | null, watching: boolean): void {
    const now = performance.now();
    if (now - this.last < 250) return;
    this.last = now;
    const st = statusText(net);
    const parts = [st.text];
    if (mp.presence) {
      const on = mp.presence.players.filter((p) => p.connected).length;
      parts.push(`${on}/${mp.presence.players.length} players`);
      if (mp.presence.spectators > 0) parts.push(`${mp.presence.spectators} watching`);
    }
    if (mp.spectator) parts.push('Spectator');
    else if (watching && state?.phase !== 'over') parts.push('Eliminated: watching');
    setText(this.lineText, parts.join(' · '));
    this.line.className = `mp-line ${st.cls}`;

    let text = '';
    let showReload = false;
    let tone = 'warn';
    if (mp.desync) {
      text = `Out of sync with the other players (turn ${mp.desync.turn}). Reload to replay the game from the server.`;
      showReload = true;
      tone = 'bad';
    } else if (mp.disagree && now - mp.disagree.at < 20_000) {
      text = `The players' games disagree (turn ${mp.disagree.turn}) and there is no majority: yours may be fine. Reload if the map looks wrong.`;
      showReload = true;
    } else if (mp.loadError) {
      text = `Could not build the game: ${mp.loadError}`;
      showReload = true;
      tone = 'bad';
    } else if (net.status !== 'online') {
      text = st.text;
      tone = st.cls === 'bad' ? 'bad' : 'warn';
      showReload = st.cls === 'bad' && net.status !== 'outdated';
    } else if (!state) {
      text = 'Loading the map…';
    } else if (mp.behind > 20) {
      const pct = mp.knownTurns > 0 ? Math.floor((mp.nextTurn / mp.knownTurns) * 100) : 0;
      text = `Catching up with the game… ${pct}%`;
    } else if (mp.serverOver && state.phase !== 'over') {
      text = SERVER_END[mp.serverOver.reason] ?? 'The game ended.';
      tone = 'info';
    }
    setText(this.bannerText, text);
    this.banner.className = `mp-banner ${tone}${text ? '' : ' hidden'}`;
    this.reload.classList.toggle('hidden', !showReload);
  }
}
