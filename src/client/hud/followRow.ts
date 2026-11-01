// One slim line under a mission / stance / mode selector (hud/airPanel.ts, hud/ordersBar.ts): what "Follow my war"
// follows now ("Following: your attack on Azuria"), or the manual target ("Fixed: Azuria's coast") with the
// "Follow my war" button to switch back. Lit while following (the default). Texts: client/follow.ts.
import { el, setClass, setText, setTip, setVisible } from './dom';
import { iconSpan, lineIcon } from './glyph';

export class FollowRow {
  readonly el: HTMLElement;
  readonly line = el('span', 'fw-line');
  readonly btn: HTMLButtonElement;
  private on: boolean | null = null;

  constructor(test: string, onFollow: () => void) {
    this.el = el('div', 'fw-row hidden');
    this.el.dataset.test = test;
    this.line.dataset.test = `${test}-line`;
    this.btn = el('button', 'wr-btn mini ghost fw-b');
    this.btn.type = 'button';
    this.btn.dataset.test = `${test}-btn`;
    this.btn.append(iconSpan(lineIcon('signal', 13, 2)), el('span', 'wr-btn-l', 'Follow my war'));
    this.btn.addEventListener('click', () => {
      if (this.on) return; // already following
      onFollow();
    });
    this.el.append(this.line, this.btn);
  }

  /** visible = the choice follows a war at all; following = lit; text = the status line. */
  set(visible: boolean, following: boolean, text: string): void {
    setVisible(this.el, visible);
    if (!visible) return;
    setText(this.line, text);
    if (this.on !== following) {
      this.on = following;
      setClass(this.btn, 'on', following);
      setClass(this.el, 'fixed', !following);
      this.btn.setAttribute('aria-pressed', String(following));
      setTip(this.btn, following ? 'On: retargets by itself to the nation you are attacking' : 'Fixed on your pick. Click to follow your war again');
    }
  }
}
