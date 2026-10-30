// Boot: main menu -> new game -> loop (fixed-step sim at 10 ticks/s x speed, render every frame).
import './styles.css';
import { loadFonts } from './fonts';
import { AudioManager } from './audio';
import { applyAction } from '../sim/actions';
import { TICKS_PER_SECOND, VICTORY_LAND_SHARE } from '../sim/config';
import { tick } from '../sim/sim';
import { createGame } from '../sim/state';
import type { Action, ActionResult, GameSettings, GameState } from '../sim/types';
import { Camera } from './camera';
import { Hud } from './hud';
import { setupInput } from './input';
import { el, Menu, PLAYER_PALETTE } from './menu';
import { Renderer } from './renderer';
import { defaultUiState } from './uiState';
import type { Dispatch, UiState } from './uiState';

const STEP_MS = 1000 / TICKS_PER_SECOND;
/** Most ticks run in one frame per x1 of speed; beyond that the game slows down instead of spiralling. */
const MAX_TICKS_PER_FRAME = 4;
const MAX_FRAME_MS = 250;
const TOAST_MS = 3000;
/** Menu background: a small AI-only game, restarted after this many game seconds or when it ends. */
const BG_MAX_SECONDS = 600;
/** The background stays cheap: the small map with a few nations and tribes. */
const BG_TRIBES = 20;

interface Session {
  state: GameState;
  camera: Camera;
  ui: UiState;
  hud: Hud | null;
  cleanupInput: () => void;
  /** false for the AI-only menu background */
  human: boolean;
  settings: GameSettings;
}

// ------------------------------------------------------------------------------------------------ DOM

const app = document.getElementById('app') ?? document.body.appendChild(el('div'));
app.classList.add('app', 'in-menu');
const canvas = el('canvas', 'map');
const mmWrap = el('div', 'minimap-wrap');
const minimap = el('canvas', 'minimap');
mmWrap.append(minimap);
app.append(canvas, mmWrap);
const renderer = new Renderer(canvas, minimap);
void loadFonts();

// Sound: procedural, quiet by default, unlocked by the first click or key (autoplay policy). See docs/AUDIO.md.
let audio: AudioManager | null = null;
try {
  audio = new AudioManager();
  audio.unlockOnGesture(window);
} catch (err) {
  console.warn('Audio unavailable', err);
  audio = null;
}

let session: Session | null = null;

const dispatch: Dispatch = (action: Action): ActionResult => {
  const s = session;
  if (!s || !s.human || !s.state.humanId) return { ok: false, reason: 'No game running' };
  let r: ActionResult;
  try {
    r = applyAction(s.state, s.state.humanId, action);
  } catch (err) {
    console.error('Action failed', action, err);
    r = { ok: false, reason: 'Something went wrong (see console)' };
  }
  if (r.ok) {
    if (action.type === 'build') audio?.play('buildPlaced');
    else if (action.type === 'launchMissile') audio?.play('missileLaunch');
  } else {
    s.ui.toast = { text: r.reason ?? 'Not possible', until: performance.now() + TOAST_MS };
    audio?.play('uiError', { volume: 0.7 });
  }
  return r;
};

const menu = new Menu(app, { onStart: (settings) => startGame(settings) });

function endSession(): void {
  if (!session) return;
  session.cleanupInput();
  session.hud?.destroy();
  session = null;
}

function newCamera(state: GameState): Camera {
  const cam = new Camera(state.map.width, state.map.height);
  cam.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  cam.fit();
  return cam;
}

function startGame(settings: GameSettings): void {
  menu.setBusy('Generating map…');
  // Let the "generating" text paint before the (blocking) map generation.
  setTimeout(() => {
    let state: GameState;
    try {
      state = createGame(settings);
    } catch (err) {
      console.error(err);
      menu.setBusy('Could not create the game (see console)');
      return;
    }
    endSession();
    const camera = newCamera(state);
    const ui = defaultUiState();
    const hud = new Hud(app, ui, dispatch, camera, audio);
    hud.onMenu = () => toMenu();
    hud.onPlayAgain = () => startGame({ ...settings, seed: menu.replaySettings().seed });
    const cleanupInput = setupInput({
      canvas,
      minimap,
      camera,
      renderer,
      ui,
      getState: () => (session && session.human ? session.state : null),
      dispatch,
      openResearch: () => hud.openResearch(),
      toggleHelp: () => hud.toggleHelp(),
      closeOverlay: () => hud.closeOverlay(),
      toggleDrawer: (id) => hud.toggleDrawer(id),
    });
    session = { state, camera, ui, hud, cleanupInput, human: true, settings };
    acc = 0;
    menu.hide();
    app.classList.remove('in-menu');
  }, 30);
}

function startBackground(): void {
  endSession();
  const settings: GameSettings = {
    seed: 1 + Math.floor(Math.random() * 1e6),
    mapType: (['continents', 'pangaea', 'archipelago', 'highlands'] as const)[Math.floor(Math.random() * 4)],
    mapSize: 'small',
    aiCount: 8,
    difficulty: 'normal',
    playerName: 'Nobody',
    playerColor: PLAYER_PALETTE[0],
    humanPlayer: false,
    timeLimit: 0,
    victoryLandShare: VICTORY_LAND_SHARE,
    tribeCount: BG_TRIBES,
  };
  try {
    const state = createGame(settings);
    session = { state, camera: newCamera(state), ui: defaultUiState(), hud: null, cleanupInput: () => {}, human: false, settings };
  } catch (err) {
    console.error('Background game failed', err);
  }
}

function toMenu(): void {
  startBackground();
  app.classList.add('in-menu');
  menu.show('title');
}

// ------------------------------------------------------------------------------------------------ loop

let acc = 0;
let last = performance.now();

function runTicks(s: Session, dt: number): void {
  if (s.ui.paused || s.state.phase === 'over') {
    acc = 0;
    return;
  }
  acc += dt * s.ui.speed;
  const max = MAX_TICKS_PER_FRAME * s.ui.speed;
  let n = 0;
  while (acc >= STEP_MS && n < max) {
    try {
      tick(s.state);
    } catch (err) {
      console.error('Simulation error', err);
      s.ui.paused = true;
      s.ui.toast = { text: 'Simulation error: game paused (see console)', until: performance.now() + 10000 };
      acc = 0;
      return;
    }
    acc -= STEP_MS;
    n++;
  }
  if (n >= max) acc = Math.min(acc, STEP_MS); // fell behind: drop the backlog
}

/** Rolling frame cost (ms) for the test hook: sim ticks, renderer, HUD. */
const perf = { sim: 0, render: 0, hud: 0, frames: 0 };

function frame(now: number): void {
  const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
  last = now;
  const s = session;
  if (s) {
    const t0 = performance.now();
    runTicks(s, dt);
    if (s.human && audio) {
      try {
        audio.update(s.state, s.camera);
      } catch (err) {
        console.error('Audio error', err);
      }
    }
    const t1 = performance.now();
    perf.sim += t1 - t0;
    // A background game that hit a sim error stays paused (static) instead of being regenerated every frame.
    if (!s.human && (s.state.phase === 'over' || s.state.tick > BG_MAX_SECONDS * TICKS_PER_SECOND)) {
      startBackground();
    }
    const cur = session;
    if (cur) {
      try {
        const t2 = performance.now();
        renderer.render(cur.state, cur.camera, cur.ui, now);
        const t3 = performance.now();
        cur.hud?.update(cur.state);
        perf.render += t3 - t2;
        perf.hud += performance.now() - t3;
        perf.frames++;
      } catch (err) {
        console.error('Render error', err);
      }
    }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------------------------------------ test hook

declare global {
  interface Window {
    __borderfall?: {
      getState: () => GameState | null;
      dispatch: Dispatch;
      ui: () => UiState | null;
      camera: () => Camera | null;
      startGame: (settings?: Partial<GameSettings>) => void;
      /** Runs n ticks synchronously (tests). */
      advance: (n: number) => void;
      toMenu: () => void;
      /** Average ms per frame spent in the sim, renderer and HUD since the last call (resets the counters). */
      perf: () => { sim: number; render: number; hud: number; frames: number };
      /** The renderer's per-frame counters (ms per layer, tiles applied, things drawn). */
      renderStats: () => Renderer['stats'];
    };
  }
}

window.__borderfall = {
  getState: () => (session && session.human ? session.state : null),
  dispatch,
  ui: () => (session && session.human ? session.ui : null),
  camera: () => session?.camera ?? null,
  startGame: (partial = {}) => startGame({ ...menu.replaySettings(), ...partial, humanPlayer: true }),
  advance: (n: number) => {
    const s = session;
    if (!s) return;
    for (let k = 0; k < n && s.state.phase !== 'over'; k++) tick(s.state);
  },
  toMenu,
  perf: () => {
    const n = Math.max(1, perf.frames);
    const out = { sim: perf.sim / n, render: perf.render / n, hud: perf.hud / n, frames: perf.frames };
    perf.sim = perf.render = perf.hud = perf.frames = 0;
    return out;
  },
  renderStats: () => ({ ...renderer.stats }),
};

startBackground();
requestAnimationFrame(frame);
