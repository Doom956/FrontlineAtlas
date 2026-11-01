// Playing on after the end (Action continueGame):
//   - the game-over card gets "Continue playing" ("Keep watching" when your nation is gone) next to Play again and
//     Main menu; online only the host of a private game may continue (the others read "Waiting for the host…")
//   - after continuing, a small chip "Victory: <winner>" stays in the top-right cluster (the result stays recorded);
//     clicking it opens the game summary again
import { teamName } from '../../sim/victory';
import type { GameState, Player } from '../../sim/types';
import { swatchCss } from './swatch';
import { el, setText } from './dom';

/**
 * Who may continue: 'host' (single player, or the private game's host online), 'guest' (online, someone else
 * decides), 'pending' (online, the server hasn't confirmed the end yet), 'none' (this game can't be continued).
 */
export type ContinueRole = 'host' | 'guest' | 'pending' | 'none';

/** Button label for this player: an eliminated nation keeps watching. */
export function continueLabel(me: Player): string {
  return me.id > 0 && !me.alive ? 'Keep watching' : 'Continue playing';
}

/** The continue control on the game-over card (a button, or the waiting line); update() follows the role. */
export class ContinueRow {
  readonly el: HTMLElement;
  private btn: HTMLButtonElement;
  private wait: HTMLElement;

  constructor(
    me: Player,
    private role: () => ContinueRole,
    run: () => void,
  ) {
    this.el = el('span', 'over-cont');
    this.btn = el('button', 'wr-btn big');
    this.btn.type = 'button';
    this.btn.dataset.test = 'continue-game';
    this.btn.append(el('span', 'wr-btn-l', continueLabel(me)));
    this.btn.addEventListener('click', () => {
      if (this.role() !== 'host') return;
      this.btn.disabled = true;
      run();
    });
    this.wait = el('span', 'over-wait', 'Waiting for the host…');
    this.wait.dataset.test = 'continue-wait';
    this.el.append(this.btn, this.wait);
    this.update();
  }

  update(): void {
    const r = this.role();
    this.el.classList.toggle('hidden', r === 'none');
    this.btn.classList.toggle('hidden', r !== 'host' && r !== 'pending');
    this.wait.classList.toggle('hidden', r !== 'guest');
    if (r === 'pending') {
      this.btn.disabled = true;
      this.btn.dataset.tip = 'Waiting for the server to confirm the end…';
    } else if (r === 'host' && this.btn.dataset.tip) {
      this.btn.disabled = false;
      delete this.btn.dataset.tip;
    }
  }
}

/** The winner as the chip names it ("Azuria", "Team 2 (Azuria)"), '' when nobody won. */
export function winnerText(state: GameState): string {
  const w = state.players[state.winner];
  if (!w || !state.winner) return '';
  return state.winnerTeam > 0 ? `${teamName(state.winnerTeam)} (${w.name})` : w.name;
}

/** "Victory: <winner>" in the top-right cluster once a finished game was continued. */
export class VictoryChip {
  readonly el: HTMLElement;
  private dot: HTMLElement;
  private text: HTMLElement;
  private shown = '';
  /** set by the HUD: opens the game summary */
  onOpen: () => void = () => {};

  constructor() {
    this.el = el('div', 'cl-group vchip hidden');
    this.el.dataset.test = 'victory-chip';
    this.el.setAttribute('role', 'button');
    this.el.tabIndex = 0;
    this.el.addEventListener('click', () => this.onOpen());
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.onOpen();
    });
    this.dot = el('i', 'sw');
    this.text = el('span', 'vc-t');
    this.el.append(this.dot, this.text);
  }

  update(state: GameState): void {
    const w = state.continued ? winnerText(state) : '';
    const key = w ? `${w}:${state.winner}` : '';
    if (key === this.shown) return;
    this.shown = key;
    this.el.classList.toggle('hidden', !w);
    if (!w) return;
    setText(this.text, `Victory: ${w}`);
    const p = state.players[state.winner];
    this.dot.style.background = p ? swatchCss(p, state.humanId) : '';
    this.el.dataset.tip = `${w} won this game. You chose to play on: the result stays recorded. Click for the game summary.`;
  }
}
