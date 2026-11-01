// In-game guide in a normal game (single player and online; client-side only, nothing goes through actions or the
// network): ties the engine (engine.ts) with its steps and tips (steps.ts) to the HUD and draws the bar (bar.ts).
// The HUD makes one per game (none in Tutorial mode chapters, which have their own card), calls update() at its
// ~5 Hz refresh and frame() every frame. While the guide shows something, the advisor line stays hidden.
import { gameSeconds } from '../../sim/state';
import type { GameState, Player } from '../../sim/types';
import type { HudCtx } from '../hud/dom';
import type { StrikeId } from '../strikes';
import { isChapterDone, type TutorialUi } from '../tutorial/engine';
import { GuideBar } from './bar';
import { GuideEngine, type GuideCtx, type GuideView } from './engine';
import { guideTips, openingSteps } from './steps';

export interface GuideHooks {
  /** the open panels etc. for the steps' checks (tutorial/controller.ts tutorialUiFacts) */
  ui: () => TutorialUi;
  /** a strike button's state ('ready', ...), null = none */
  strike: (id: StrikeId) => string | null;
  /** a modal (help page, game over) is up: the bar yields */
  modal: () => boolean;
  /** the strike tip showed for this strike: the advisor's own first-use hint for it is not needed */
  strikeTipShown?: (id: StrikeId) => void;
}

export class GuideController {
  readonly engine: GuideEngine;
  readonly bar: GuideBar;
  private view: GuideView | null = null;
  private last: GuideCtx | null = null;

  constructor(
    private ctx: HudCtx,
    private hooks: GuideHooks,
  ) {
    const cam = ctx.camera;
    const centreTile = (): number => {
      const s = ctx.state();
      if (!s) return -1;
      const x = Math.max(0, Math.min(s.map.width - 1, Math.floor(cam.x)));
      const y = Math.max(0, Math.min(s.map.height - 1, Math.floor(cam.y)));
      return y * s.map.width + x;
    };
    // a player who finished the Basics chapter of Tutorial mode gets the tips only
    this.engine = new GuideEngine(openingSteps({ centreTile }), guideTips(), { skipOpening: isChapterDone('basics') });
    this.engine.onChange = (v) => {
      if (v?.kind === 'tip' && v.id === 'strike' && this.last) {
        for (const id of ['barrage', 'bomb', 'paradrop', 'rocket', 'atomBomb'] as StrikeId[]) {
          if (this.last.strike(id) === 'ready') {
            this.hooks.strikeTipShown?.(id);
            break;
          }
        }
      }
    };
    this.bar = new GuideBar(
      {
        next: () => this.act(() => this.engine.next()),
        skip: () => this.act(() => this.engine.skip()),
        hide: () => {
          this.engine.hide();
          this.view = null;
          this.bar.render(null);
          ctx.toast('Guide off. Menu (Esc) > Guide on brings it back.');
        },
        showMe: () => {
          const t = this.view?.tile ?? -1;
          if (t >= 0) ctx.focusTile(t, true);
        },
      },
      (tile) => {
        const s = ctx.state();
        if (!s || tile < 0 || tile >= s.map.owner.length) return null;
        const canvas = document.querySelector<HTMLCanvasElement>('canvas.map');
        const cr = canvas?.getBoundingClientRect();
        const host = this.bar.el.getBoundingClientRect();
        const w = s.map.width;
        const p = cam.tileToScreen((tile % w) + 0.5, Math.floor(tile / w) + 0.5);
        return { x: p.x + (cr?.left ?? 0) - host.left, y: p.y + (cr?.top ?? 0) - host.top, r: Math.max(12, Math.min(40, cam.zoom * 1.5)) };
      },
    );
  }

  /** true while the bar shows a step or a tip (the advisor line stays hidden then) */
  get showing(): boolean {
    return this.view !== null;
  }
  get on(): boolean {
    return this.engine.on;
  }
  setOn(on: boolean): void {
    this.engine.setOn(on);
    if (!on) {
      this.view = null;
      this.bar.render(null);
    }
  }
  restart(): void {
    this.engine.restart();
  }
  /** this tip will still show (the guide is on and it has not shown yet) */
  due(id: string): boolean {
    return this.engine.on && !this.engine.seen(id);
  }

  /** Checks the steps and tips and redraws the bar (call at the HUD's ~5 Hz refresh). */
  update(s: GameState, me: Player, now: number): void {
    const c: GuideCtx = { s, me, ui: this.hooks.ui(), sec: gameSeconds(s), now, strike: (id) => this.hooks.strike(id as StrikeId) };
    this.last = c;
    this.view = this.engine.update(c);
    this.bar.render(this.view);
  }

  /** Keeps the bar placed and the spotlight on its element or tile (every frame). */
  frame(): void {
    this.bar.setCovered(this.hooks.modal());
    this.bar.frame();
  }

  /** A button: change the step and redraw at once. */
  private act(f: () => void): void {
    f();
    if (this.last) this.update(this.last.s, this.last.me, performance.now());
  }

  destroy(): void {
    this.bar.destroy();
  }
}
