// The game's active modifiers as small chips under the top-right cluster (hover for what each one does). Peace time
// counts down live and disappears when it is over.
import { activeModifiers, mapLabel, PRESETS } from '../../sim/setup';
import { peaceSecondsLeft } from '../../sim/rules';
import type { GameSettings, GameState } from '../../sim/types';
import { el, setClass, setText, setTip } from './dom';

export class ModChips {
  readonly el: HTMLElement;
  private settings: GameSettings | null = null;
  private peace: HTMLElement | null = null;

  constructor() {
    this.el = el('div', 'mod-chips');
    this.el.dataset.test = 'mod-chips';
  }

  private build(s: GameSettings): void {
    this.settings = s;
    this.peace = null;
    this.el.replaceChildren();
    const preset = PRESETS.find((p) => p.id === s.preset && p.id !== 'custom' && p.id !== 'classic');
    for (const m of activeModifiers(s)) {
      const c = el('span', 'mod-chip', m.label);
      setTip(c, `${m.label}\n${m.detail}${preset ? `\nPreset: ${preset.name}` : ''}`);
      c.setAttribute('aria-label', `${m.label}: ${m.detail}`);
      if (m.id === 'peaceMinutes') {
        c.classList.add('live');
        this.peace = c;
      }
      this.el.append(c);
    }
    this.el.setAttribute('aria-label', `Game rules on ${mapLabel(s.map)}`);
  }

  update(state: GameState): void {
    if (state.settings !== this.settings) this.build(state.settings);
    if (this.peace) {
      const left = peaceSecondsLeft(state);
      const m = state.settings.modifiers.peaceMinutes;
      if (left > 0 && state.phase === 'playing') {
        const t = Math.ceil(left);
        setText(this.peace, `Peace ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
      } else setText(this.peace, `Peace ${m} min`);
      setClass(this.peace, 'hidden', state.phase === 'playing' && left <= 0);
    }
  }
}
