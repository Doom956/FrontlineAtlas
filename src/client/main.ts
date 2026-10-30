// Boot: main menu -> new game -> loop (fixed-step sim at 10 ticks/s x speed, render every frame). Online games run
// the same sim in lockstep (mpgame.ts): turns from the server drive the ticks, actions go out as intents.
import './styles.css';
import { loadFonts } from './fonts';
import { AudioManager } from './audio';
import { applyAction } from '../sim/actions';
import { TICKS_PER_SECOND, VICTORY_LAND_SHARE } from '../sim/config';
import { tick } from '../sim/sim';
import { createGame } from '../sim/state';
import { cloneSetup, DEFAULT_SETUP } from '../sim/setup';
import type { Action, ActionResult, GameSettings, GameState, MapData } from '../sim/types';
import { loadWorldMap } from '../sim/worldmaps';
import { Camera } from './camera';
import { Hud } from './hud';
import { MpStatus } from './hud/mpStatus';
import { NetClient } from '../net/client';
import type { GameStartMsg, RGB, ServerMessage } from '../net/protocol';
import { hashState } from '../sim/hash';
import { activeLobby, rememberActiveLobby } from './lobby';
import { MpGame } from './mpgame';
import { loadSetupPrefs } from './setupScreen';
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
  /** online game: the lockstep runner (turns from the server, intents out) */
  mp: MpGame | null;
  mpStatus: MpStatus | null;
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
  if (!s || !s.human || !s.state.humanId) return { ok: false, reason: s?.mp?.spectator ? 'You are watching this game' : 'No game running' };
  let r: ActionResult;
  try {
    // online: never applied here; it goes to the server and comes back in a turn for every client
    r = s.mp ? s.mp.dispatch(action) : applyAction(s.state, s.state.humanId, action);
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

// ------------------------------------------------------------------------------------------------ online

/** The multiplayer connection, made on first use (single player never opens it). */
let net: NetClient | null = null;
/** The online game being built or played (messages are routed to it even before its session exists). */
let currentMp: MpGame | null = null;

function identity(): { name: string; color: RGB } {
  const p = loadSetupPrefs();
  return { name: p.playerName.trim() || 'Player', color: (PLAYER_PALETTE[p.color] ?? PLAYER_PALETTE[0]) as RGB };
}

function getNet(): NetClient {
  if (!net) {
    net = new NetClient(identity());
    net.on(onNetMessage);
    // a reconnect tells the server which game we hold and how far, so the catch-up only sends the gap
    net.setResume(() => (currentMp && !currentMp.serverOver ? { code: currentMp.code, haveTurns: currentMp.haveTurns() } : null));
  }
  return net;
}

function onNetMessage(msg: ServerMessage): void {
  if (msg.type === 'gameStart') {
    void startOnline(msg);
    return;
  }
  if (msg.type === 'welcome' && !msg.resumed && currentMp && !currentMp.serverOver) {
    if (currentMp.spectator) {
      // spectators have no seat to resume: watch again (the catchUp fills the gap, or replays all after a Reload)
      getNet().send({ type: 'joinLobby', code: currentMp.code, spectate: true, haveTurns: currentMp.haveTurns() });
      return;
    }
    // the server no longer knows our game (it ended or the server restarted): nothing to continue
    currentMp.serverOver = { type: 'gameOver', reason: 'abandoned', winner: 0, turn: currentMp.nextTurn };
  }
  if (msg.type === 'lobbyState') {
    if (!msg.isPublic && msg.hostMemberId === msg.you) lastLobbyHost = msg.code;
    else if (lastLobbyHost === msg.code) lastLobbyHost = '';
  }
  if (msg.type === 'welcome' && !msg.resumed && !currentMp) rememberActiveLobby(null);
  currentMp?.handle(msg);
  if (msg.type === 'error' && session?.mp && session.human) {
    session.ui.toast = { text: msg.message, until: performance.now() + TOAST_MS };
  }
}

/** gameStart: build the online game (a world map is loaded first), or keep the running one after a reconnect. */
async function startOnline(start: GameStartMsg): Promise<void> {
  const keep = currentMp && currentMp.code === start.code && !currentMp.rebuild && !currentMp.loadError;
  if (keep) {
    currentMp!.resumed(start); // a reconnect: the catchUp that follows fills in the turns we missed
    return;
  }
  rememberActiveLobby(start.code);
  const mp = new MpGame(getNet(), start, {
    onRefused: (reason) => {
      if (session?.mp === mp) session.ui.toast = { text: reason, until: performance.now() + TOAST_MS };
      audio?.play('uiError', { volume: 0.7 });
    },
    onError: () => {
      if (session?.mp === mp) session.ui.toast = { text: 'Simulation error: this client stopped (see console). Reload to rejoin.', until: performance.now() + 15000 };
      mp.desync = mp.desync ?? { turn: mp.nextTurn, details: 'simulation error' };
    },
  });
  mp.canStartNow = lastLobbyHost === start.code;
  currentMp = mp;
  if (!session?.mp) menu.setBusy(start.settings.map.kind === 'world' ? 'Loading map…' : 'Generating map…');
  await new Promise((r) => setTimeout(r, 30)); // let the text paint before the (blocking) map generation
  await mp.loading;
  if (currentMp !== mp) return; // replaced meanwhile
  if (!mp.state) {
    menu.setBusy(`Could not start the online game: ${mp.loadError ?? 'unknown error'}`);
    return;
  }
  const state = mp.state;
  endSession();
  const camera = newCamera(state);
  const ui = defaultUiState();
  const hud = new Hud(app, ui, dispatch, camera, audio, {
    online: true,
    canStartNow: () => mp.canStartNow,
    againLabel: 'Multiplayer',
  });
  hud.setUnitProbe(renderer);
  const status = new MpStatus(() => {
    if (mp.desync || mp.loadError) mp.reload();
    else getNet().reconnectNow();
  });
  hud.addOverlay(status.el);
  hud.onMenu = () => leaveOnline(false);
  hud.onPlayAgain = () => leaveOnline(true);
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
    strike: (id) => hud.strike(id),
  });
  session = { state, camera, ui, hud, cleanupInput, human: true, settings: start.settings, mp, mpStatus: status };
  menu.hide();
  app.classList.remove('in-menu');
}

/** Leaves the online game (the seat stays on the server until it ends) and goes to the menu or the lobby list. */
function leaveOnline(toMultiplayer: boolean): void {
  net?.send({ type: 'leaveLobby' });
  rememberActiveLobby(null);
  currentMp = null;
  toMenu();
  if (toMultiplayer) menu.show('multiplayer');
}

/** Code of the private lobby this client hosted last (the host may end the spawn phase early). */
let lastLobbyHost = '';

const menu = new Menu(app, { onStart: (settings) => void startGame(settings), net: () => getNet() });

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

/** Starts a game: a real-world map is loaded first (createGame is synchronous), a generated one is made from the seed. */
async function startGame(settings: GameSettings): Promise<void> {
  const world = settings.map.kind === 'world' ? settings.map.id : null;
  menu.setBusy(world ? 'Loading map…' : 'Generating map…');
  let preloaded: MapData | null = null;
  if (world) {
    try {
      preloaded = await loadWorldMap(world);
    } catch (err) {
      console.error(err);
      menu.setBusy('Could not load the map (see console)');
      return;
    }
  }
  // Let the "generating" text paint before the (blocking) map generation.
  setTimeout(() => {
    let state: GameState;
    try {
      state = createGame(settings, preloaded);
    } catch (err) {
      console.error(err);
      menu.setBusy('Could not create the game (see console)');
      return;
    }
    endSession();
    const camera = newCamera(state);
    const ui = defaultUiState();
    const hud = new Hud(app, ui, dispatch, camera, audio);
    hud.setUnitProbe(renderer);
    hud.onMenu = () => toMenu();
    hud.onPlayAgain = () => void startGame({ ...settings, seed: menu.replaySettings().seed });
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
      strike: (id) => hud.strike(id),
    });
    session = { state, camera, ui, hud, cleanupInput, human: true, settings, mp: null, mpStatus: null };
    if (currentMp) {
      // a single-player game ends any online one
      net?.send({ type: 'leaveLobby' });
      rememberActiveLobby(null);
      currentMp = null;
    }
    acc = 0;
    menu.hide();
    app.classList.remove('in-menu');
  }, 30);
}

function startBackground(): void {
  endSession();
  const settings: GameSettings = {
    ...cloneSetup(DEFAULT_SETUP),
    seed: 1 + Math.floor(Math.random() * 1e6),
    map: { kind: 'generated', type: (['continents', 'pangaea', 'archipelago', 'highlands'] as const)[Math.floor(Math.random() * 4)], size: 'small' },
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
    session = { state, camera: newCamera(state), ui: defaultUiState(), hud: null, cleanupInput: () => {}, human: false, settings, mp: null, mpStatus: null };
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
    if (s.mp) {
      // the server's clock drives an online game: no pause, no speed
      s.ui.paused = false;
      s.ui.speed = 1;
      s.mp.pump();
      if (net && s.mpStatus) s.mpStatus.update(s.mp, net, s.state, s.hud?.watching ?? false);
      if (s.mp.replaying) {
        // replaying turns the game had before we (re)joined: their events are history, not news
        s.hud?.skipEvents(s.state);
        audio?.skipTo(s.state);
      }
    } else runTicks(s, dt);
    if (s.human && audio && !s.mp?.replaying) {
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
        cur.camera.step(now);
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
      /** Starts a game from the setup screen's settings with these overrides (a new seed unless given). */
      startGame: (settings?: Partial<GameSettings>) => Promise<void>;
      /** Runs n ticks synchronously (tests). */
      advance: (n: number) => void;
      toMenu: () => void;
      /** Average ms per frame spent in the sim, renderer and HUD since the last call (resets the counters). */
      perf: () => { sim: number; render: number; hud: number; frames: number };
      /** The renderer's per-frame counters (ms per layer, tiles applied, things drawn). */
      renderStats: () => Renderer['stats'];
      /** hashState of the game shown now (online and offline) */
      hash: () => number;
      /** turns run (= state.tick) of the game shown now */
      turn: () => number;
      /** online: the hashes sent to the server, by turn (the last ~120) */
      hashes: () => Record<number, number>;
      /** online: runner and connection details */
      mp: () => { code: string; playerId: number; nextTurn: number; behind: number; desync: boolean; status: string; latency: number | null; spectator: boolean } | null;
      /** online: drops the socket like a network failure (the client reconnects by itself) */
      dropConnection: () => void;
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
  hash: () => (session && session.human ? hashState(session.state) : 0),
  turn: () => (session && session.human ? session.state.tick : -1),
  hashes: () => Object.fromEntries(session?.mp?.hashes ?? []),
  mp: () => {
    const m = session?.mp;
    if (!m) return null;
    return { code: m.code, playerId: m.playerId, nextTurn: m.nextTurn, behind: m.behind, desync: !!m.desync, status: net?.status ?? 'idle', latency: net?.latencyMs ?? null, spectator: m.spectator };
  },
  dropConnection: () => net?.dropForTest(),
};

startBackground();
requestAnimationFrame(frame);

// ?lobby=CODE opens the multiplayer page and joins; a page reload during an online game or lobby goes back to it
// (the server knows us by the clientId in localStorage).
{
  let code: string | null = null;
  try {
    code = new URLSearchParams(location.search).get('lobby');
  } catch {
    code = null;
  }
  if (code) menu.openMultiplayer(code);
  else if (activeLobby()) menu.openMultiplayer();
}
