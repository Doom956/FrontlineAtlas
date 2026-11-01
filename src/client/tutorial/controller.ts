// Tutorial mode in a running game: ties the tutorial's step runner (engine.ts) to the HUD and the overlay (overlay.ts).
// Single player only: the scenario helpers (src/sim/tutorialScenario.ts) are called directly between ticks; nothing
// goes through actions or the network. main.ts makes one per tutorial game and calls update() / frame() every frame.
import { tutorialEnemyAttack, tutorialFinish, tutorialFreeze, tutorialGrant, tutorialPlayer, tutorialStart, tutorialTile, tutorialWake, tutorialWeaken } from '../../sim/tutorialScenario';
import type { GameState, Player } from '../../sim/types';
import type { Hud } from '../hud';
import { strikeOfMode } from '../strikes';
import type { UiState } from '../uiState';
import { markChapterDone, stepTarget, TutorialRunner, type TutorialApi, type TutorialChapter, type TutorialUi } from './engine';
import { TutorialOverlay } from './overlay';

/** Steps are checked this often (ms). */
const CHECK_MS = 200;

export interface TutorialHooks {
  /** leave the tutorial for the title screen */
  exit: () => void;
  /** leave the tutorial for a normal Easy game */
  playNow: () => void;
}

/** The UI facts a step can check, read from the HUD and the shared UI state. */
export function tutorialUiFacts(ui: UiState, view: ReturnType<Hud['tutorialView']>): TutorialUi {
  const m = ui.mode;
  const openPanel = view.buildMenu ? 'build' : view.drawer === 'research' && view.researchTab === 'arsenal' ? 'arsenal' : view.drawer;
  return {
    attackShare: ui.attackShare,
    openPanel,
    researchTab: view.researchTab,
    selectedUnits: ui.selection.length,
    buildMode: m.kind === 'build' ? m.building : null,
    mode: m.kind,
    aiming: strikeOfMode(m),
    selectedBuildings: ui.buildingSel.ids.length,
    selectedTile: ui.selectedTile,
    nationCard: view.nationCard,
    buildCount: ui.buildCount,
    paused: ui.paused,
    speed: ui.speed,
  };
}

export class TutorialController {
  readonly runner: TutorialRunner;
  private overlay: TutorialOverlay;
  private last = -Infinity;
  private recorded = false;

  constructor(
    readonly chapter: TutorialChapter,
    private hud: Hud,
    private ui: UiState,
    private getState: () => GameState | null,
    private hooks: TutorialHooks,
  ) {
    const self = this;
    const api: TutorialApi = {
      state: () => self.state(),
      me: () => self.me(),
      grant: (g) => tutorialGrant(self.state(), self.state().humanId, g),
      wake: (ids, opts) => tutorialWake(self.state(), ids, opts),
      freeze: (ids) => tutorialFreeze(self.state(), ids),
      tile: (key) => tutorialTile(self.state(), key),
      player: (role) => tutorialPlayer(self.state(), role),
      weaken: (id, troops) => tutorialWeaken(self.state(), id, troops),
      enemyAttack: (id) => tutorialEnemyAttack(self.state(), id),
      finish: () => tutorialFinish(self.state(), self.state().humanId),
      startNow: () => tutorialStart(self.state()),
      openPanel: (name) => hud.openTutorialPanel(name),
      centre: (tile) => {
        if (tile >= 0) hud.centreOn(tile);
      },
    };
    this.runner = new TutorialRunner(chapter, api);
    this.runner.onChange = () => {
      this.last = -Infinity; // redraw at once
    };
    this.overlay = new TutorialOverlay({
      showMe: () => {
        const t = this.showTile();
        if (t >= 0) hud.centreOn(t);
      },
      next: () => this.runner.next(),
      exit: () => hooks.exit(),
      playNow: () => hooks.playNow(),
    });
    hud.addOverlay(this.overlay.el);
  }

  private state(): GameState {
    const s = this.getState();
    if (!s) throw new Error('No tutorial game running');
    return s;
  }
  private me(): Player {
    const s = this.state();
    return s.players[s.humanId];
  }
  private showTile(): number {
    const st = this.runner.step;
    const s = this.getState();
    if (!st?.tile || !s) return -1;
    try {
      return st.tile(s);
    } catch {
      return -1;
    }
  }

  /** Checks the step (~5 Hz) and redraws the card; call every frame after the HUD's update. */
  update(now: number): void {
    const s = this.getState();
    if (!s) return;
    const view = this.hud.tutorialView();
    this.overlay.setCovered(view.modal);
    if (now - this.last < CHECK_MS) return;
    this.last = now;
    const me = s.players[s.humanId];
    if (me && s.phase !== 'over') this.runner.update(s, me, tutorialUiFacts(this.ui, view));
    if (this.runner.finished && !this.recorded) {
      this.recorded = true;
      markChapterDone(this.chapter.id);
    }
    const rv = this.runner.view();
    this.overlay.render(rv, { showMe: this.showTile() >= 0, target: stepTarget(rv.step, s) });
  }

  /** Keeps the spotlight on its element (every frame). */
  frame(): void {
    this.overlay.frame();
  }

  destroy(): void {
    this.overlay.destroy();
  }
}
