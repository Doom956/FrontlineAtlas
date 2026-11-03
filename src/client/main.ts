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
import { button, confirmReplaceSave, el, Menu, PLAYER_PALETTE } from './menu';
import { Renderer } from './renderer';
import { defaultUiState } from './uiState';
import { requestAdminAuth } from './admin';
import { adminPerf } from './adminConsole';
import type { Dispatch, UiState } from './uiState';
import { setupTutorial, tutorialMap, tutorialSettings } from '../sim/tutorialScenario';
import { TutorialController } from './tutorial/controller';
import { QUICK_TUTORIAL } from './tutorial/steps';
import { GameRecorder } from './save/recorder';
import { Replayer } from './save/replay';
import { LoadPage } from './save/saveViews';
import { loadSeconds, type SaveData } from './save/format';
import { clearSave, readSave, writeSave } from './save/store';
import { GameHistory } from './summary/history';
import { gameSeconds } from '../sim/state';

const STEP_MS = 1000 / TICKS_PER_SECOND;
/** Most ticks run in one frame per x1 of speed; beyond that the game slows down instead of spiralling. */
const MAX_TICKS_PER_FRAME = 4;
const MAX_FRAME_MS = 250;
const TOAST_MS = 3000;
/** Menu background: a small AI-only game, restarted after this many game seconds or when it ends. */
const BG_MAX_SECONDS = 600;
/** The background stays cheap: the small map with a few nations and tribes. */
const BG_TRIBES = 20;
/** Single player saves itself this often (ms of real time), and when the page is hidden or left (save/). */
const AUTOSAVE_MS = 30_000;
/** A loading replay works this long (ms) before it lets the page paint its progress bar. */
const LOAD_SLICE_MS = 90;

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
  /** online: ui.paused as the frame left it (a change since then is the host's pause click or Space) */
  mpPauseShown?: boolean;
  /** a tutorial chapter's game (single player only): its steps and overlay */
  tutorial?: TutorialController;
  /** single player outside the tutorial: the actions for the save (save/recorder.ts) */
  recorder?: GameRecorder;
  /** the save was removed because the game ended (a continued game saves again) */
  overCleared?: boolean;
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
    if (s.mp) r = s.mp.dispatch(action);
    else {
      // single player: noted for the save first (a replay applies it at this same tick)
      s.recorder?.record(s.state.tick, action);
      r = applyAction(s.state, s.state.humanId, action);
    }
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
    if (!msg.isPublic) lastPrivateLobby = msg.code;
    else if (lastPrivateLobby === msg.code) lastPrivateLobby = '';
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
  mp.isPrivate = lastPrivateLobby === start.code;
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
    pause: () => ({ mode: mp.canPause ? 'host' : mp.isPrivate && !mp.spectator ? 'guest' : 'none', paused: mp.paused, by: mp.pausedByName() }),
    continueRole: () => mp.continueRole(),
    adminAuth: (code) => requestAdminAuth(getNet(), code),
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
    confirm: (text, label, run) => hud.confirm(text, label, run),
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

/** Code of the private lobby this client hosted last (the host may end the spawn phase early and pause). */
let lastLobbyHost = '';
/** Code of the private lobby this client was in last (its games show the host's pause button, disabled for guests). */
let lastPrivateLobby = '';

const menu = new Menu(app, {
  onStart: (settings) => void startGame(settings),
  net: () => getNet(),
  onTutorial: () => void startTutorial(),
  onContinue: () => void continueSaved(),
});

function endSession(): void {
  if (!session) return;
  session.cleanupInput();
  session.tutorial?.destroy();
  session.hud?.destroy();
  session = null;
}

function newCamera(state: GameState): Camera {
  const cam = new Camera(state.map.width, state.map.height);
  cam.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  cam.fit();
  return cam;
}

/** Starts the tutorial: a small single-player practice game (tutorialScenario.ts) with its steps (tutorial/steps.ts). */
function startTutorial(): Promise<void> {
  return startGame(tutorialSettings(identity()), true);
}

/** The tutorial's Play now: a normal game on the default setup against Easy AIs (asks first if it replaces a save). */
function startEasyGame(): void {
  const me = identity();
  const settings: GameSettings = { ...cloneSetup(DEFAULT_SETUP), difficulty: 'easy', seed: 1 + Math.floor(Math.random() * 1e6), playerName: me.name, playerColor: me.color, humanPlayer: true };
  confirmReplaceSave(app, () => void startGame(settings));
}

/**
 * Starts a game: a real-world map is loaded first (createGame is synchronous), a generated one is made from the seed.
 * tutorial: a tutorial chapter's game (setupTutorial runs after createGame; the overlay comes with the HUD).
 */
async function startGame(settings: GameSettings, tutorial = false): Promise<void> {
  const world = settings.map.kind === 'world' && !tutorial ? settings.map.id : null;
  menu.setBusy(world ? 'Loading map…' : 'Generating map…');
  // the tutorial plays on its own hand-made map
  let preloaded: MapData | null = tutorial ? tutorialMap() : null;
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
    // the recorder copies the settings before createGame sees them (tutorial and online games are never saved)
    const recorder = tutorial ? undefined : new GameRecorder(settings);
    try {
      state = createGame(settings, preloaded);
      if (tutorial) setupTutorial(state);
    } catch (err) {
      console.error(err);
      menu.setBusy('Could not create the game (see console)');
      return;
    }
    // a new game replaces the saved one (the menu asked first)
    if (recorder) clearSave();
    beginSession(state, settings, { tutorial, recorder });
  }, 30);
}

/** Shows a single-player game that was just made (startGame) or loaded (continueSaved): HUD, input, the loop. */
function beginSession(state: GameState, settings: GameSettings, opts: { tutorial?: boolean; recorder?: GameRecorder; history?: GameHistory }): void {
  const tutorial = !!opts.tutorial;
  endSession();
  const camera = newCamera(state);
  const ui = defaultUiState();
  const hud = new Hud(app, ui, dispatch, camera, audio, { tutorial, saves: !!opts.recorder });
  hud.setUnitProbe(renderer);
  if (opts.history) hud.adoptHistory(opts.history);
  hud.onMenu = () => toMenu();
  hud.onPlayAgain = () => void (tutorial ? startTutorial() : startGame({ ...settings, seed: menu.replaySettings().seed }));
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
    confirm: (text, label, run) => hud.confirm(text, label, run),
  });
  session = { state, camera, ui, hud, cleanupInput, human: true, settings, mp: null, mpStatus: null, recorder: opts.recorder };
  lastAutosave = performance.now();
  if (tutorial) {
    session.tutorial = new TutorialController(QUICK_TUTORIAL, hud, ui, () => (session?.human ? session.state : null), {
      exit: () => toMenu(),
      playNow: () => startEasyGame(),
    });
  }
  if (currentMp) {
    // a single-player game ends any online one
    net?.send({ type: 'leaveLobby' });
    rememberActiveLobby(null);
    currentMp = null;
  }
  acc = 0;
  menu.hide();
  app.classList.remove('in-menu');
}

// ------------------------------------------------------------------------------------------------ save and continue

let lastAutosave = 0;

/**
 * Saves the single-player game (never the tutorial or an online game). A finished game removes its save instead; a
 * game that is continued after the end saves again.
 */
function autosave(): void {
  const s = session;
  const rec = s?.recorder;
  if (!s || !s.human || s.mp || s.tutorial || !rec || rec.disabled) return;
  const state = s.state;
  if (state.phase === 'over') {
    if (!s.overCleared) clearSave();
    s.overCleared = true;
    return;
  }
  s.overCleared = false;
  if (state.tick === 0 && rec.log.length === 0) return;
  if (!rec.changedSince(state)) return;
  let result: ReturnType<typeof writeSave>;
  try {
    result = writeSave(rec.snapshot(state, adminPerf.tickMs, Date.now()));
  } catch (err) {
    console.error('Save failed', err);
    result = 'failed';
  }
  if (result === 'ok') return;
  rec.disabled = true; // told once: this game is not saved from now on
  const text = result === 'tooBig' ? 'This game is too long to keep in the browser. It is no longer saved.' : 'The browser blocked saving (storage full or off). This game is not saved.';
  s.ui.toast = { text, until: performance.now() + 8000 };
}

// the page going away or into the background: save now (the next 30 s may never come)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') autosave();
});
window.addEventListener('pagehide', () => autosave());

/** The load running now (Cancel sets cancelled; a newer load replaces it). */
let loadJob: { cancelled: boolean } | null = null;
/** the last finished load, for the test hook: the state right after the replay */
let lastLoad: { tick: number; hash: number; checked: number; matched: boolean } | null = null;

/** Lets the browser paint and handle clicks (a message is not throttled like a timer in a background tab). */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

/**
 * Continue: builds the saved game again from its settings and replays its actions to the saved tick (save/replay.ts),
 * with a progress bar. A save that doesn't match this version (a hash differs) is explained and can be loaded anyway
 * or deleted.
 */
async function continueSaved(): Promise<void> {
  const slot = readSave();
  if (slot?.status !== 'ok') {
    menu.show('title');
    return;
  }
  const save: SaveData = slot.save;
  const job = { cancelled: false };
  loadJob = job;
  const cancel = () => {
    job.cancelled = true;
    if (loadJob === job) loadJob = null;
    menu.show('title');
  };
  let page = new LoadPage(save.meta.map, loadSeconds(save), { onCancel: cancel });
  menu.showLoad(page);
  const problem = (title: string, text: string, extra: HTMLButtonElement[] = []) => {
    if (loadJob === job) loadJob = null;
    const del = button('Delete saved game', 'danger', () => {
      clearSave();
      menu.show('title');
    });
    del.dataset.test = 'save-load-delete';
    const back = button('Back', 'ghost', () => menu.show('title'));
    page.problem(title, text, [del, back, ...extra]);
  };

  const settings = save.settings;
  let preloaded: MapData | null = null;
  try {
    if (settings.map.kind === 'world') preloaded = await loadWorldMap(settings.map.id);
    await new Promise((r) => setTimeout(r, 30)); // let the page paint before the (blocking) map generation
  } catch (err) {
    console.error(err);
    problem('Could not load the map', 'The map of this saved game could not be loaded. Check your connection and try again.');
    return;
  }
  if (job.cancelled) return;
  let state: GameState;
  try {
    state = createGame(settings, preloaded);
  } catch (err) {
    console.error(err);
    problem('Could not load this game', 'The saved game could not be rebuilt in this version.');
    return;
  }
  const history = new GameHistory();
  const replay = new Replayer(state, save, (st) => {
    // the end summary samples every ~10 s of game time: feed it as the test hook's fast-forward does
    if (st.tick % 20 === 0) {
      try {
        history.update(st);
      } catch {
        // only the summary would miss it
      }
    }
  });
  const totalMin = Math.floor(save.meta.minutes);
  const started = performance.now();
  const startTick = state.tick;

  const run = async (): Promise<'done' | 'mismatch' | 'cancelled' | 'error'> => {
    for (;;) {
      const t0 = performance.now();
      try {
        while (performance.now() - t0 < LOAD_SLICE_MS) if (replay.run(10)) break;
      } catch (err) {
        console.error('Replay failed', err);
        return 'error';
      }
      if (replay.mismatch) return 'mismatch';
      const elapsed = (performance.now() - started) / 1000;
      const doneTicks = state.tick - startTick;
      const leftTicks = save.tick - state.tick;
      // the measured pace once there is a second of it, the saving machine's pace before
      const left = elapsed >= 1 && doneTicks > 0 ? (leftTicks * elapsed) / doneTicks : loadSeconds({ tick: leftTicks, meta: save.meta });
      const min = Math.floor(gameSeconds(state) / 60);
      page.set(replay.progress, replay.done ? 0 : left, totalMin >= 1 ? `Minute ${Math.min(min, totalMin)} of ${totalMin}` : 'Replaying');
      if (replay.done) return 'done';
      await yieldToBrowser();
      if (job.cancelled) return 'cancelled';
    }
  };

  const result = await run();
  let matched = true;
  if (result === 'mismatch') {
    const go = button('Load anyway', 'primary', () => {
      matched = false;
      replay.keepGoing();
      loadJob = job;
      page = new LoadPage(save.meta.map, loadSeconds({ tick: save.tick - state.tick, meta: save.meta }), { onCancel: cancel });
      menu.showLoad(page);
      void run().then(finish);
    });
    go.dataset.test = 'save-load-anyway';
    problem(
      "This save doesn't match this version",
      'The game changed since this save was made, so it would not play out as you left it. You can load it anyway and keep playing a slightly different game, or delete it.',
      [go],
    );
    return;
  }
  finish(result);

  function finish(r: 'done' | 'mismatch' | 'cancelled' | 'error'): void {
    if (r === 'cancelled' || job.cancelled) return;
    if (r === 'error') {
      problem('Could not load this game', 'Something in the saved game failed to replay in this version.');
      return;
    }
    if (r !== 'done') return;
    if (loadJob === job) loadJob = null;
    // a save loaded anyway starts a fresh list of checks (its old hashes belong to the other version)
    const recorder = new GameRecorder(settings, { log: save.log, checks: matched ? save.checks : [] });
    beginSession(state, settings, { recorder, history });
    // what happened before the save is history, not news
    session?.hud?.skipEvents(state);
    audio?.skipTo(state);
    if (session) session.ui.toast = { text: 'Game loaded', until: performance.now() + TOAST_MS };
    lastLoad = { tick: state.tick, hash: hashState(state), checked: replay.checked, matched };
  }
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
  autosave(); // leaving a single-player game keeps it for Continue
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
      const t0 = performance.now();
      tick(s.state);
      adminPerf.tickMs = adminPerf.tickMs * 0.9 + (performance.now() - t0) * 0.1;
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
      // the server's clock drives an online game: no speed; only the private lobby's host pauses (the server stops
      // sending turns). The pause button, Space and the banner's Resume change ui.paused; that goes to the server.
      if (s.mpPauseShown !== undefined && s.ui.paused !== s.mpPauseShown) s.mp.setPause(s.ui.paused);
      s.ui.paused = s.mp.paused && !s.mp.serverOver;
      s.mpPauseShown = s.ui.paused;
      s.ui.speed = 1;
      s.mp.pump();
      if (net && s.mpStatus) s.mpStatus.update(s.mp, net, s.state, s.hud?.watching ?? false);
      if (s.mp.replaying) {
        // replaying turns the game had before we (re)joined: their events are history, not news
        s.hud?.skipEvents(s.state);
        audio?.skipTo(s.state);
      }
    } else if (s.human || !loadJob) runTicks(s, dt); // the menu's background game rests while a save loads
    if (s.recorder && (now - lastAutosave >= AUTOSAVE_MS || s.state.phase === 'over')) {
      lastAutosave = now;
      autosave();
    }
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
    // while a save loads, the menu's background map stands still (its last frame stays): the replay gets the time
    if (cur && (cur.human || !loadJob)) {
      try {
        const t2 = performance.now();
        if (cur.human) cur.camera.step(now);
        else cur.camera.menuView(); // the menu's background map (kept framed when the window changes size)
        renderer.render(cur.state, cur.camera, cur.ui, now);
        const t3 = performance.now();
        cur.hud?.update(cur.state);
        if (cur.tutorial) {
          cur.tutorial.update(now);
          cur.tutorial.frame();
        }
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
      /** Starts the tutorial (tests). */
      startTutorial: () => Promise<void>;
      /** the tutorial game's id and step, null outside the tutorial */
      tutorial: () => { chapter: string; step: number; stepId: string; finished: boolean } | null;
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
      /** the last loaded save: tick and hash right after its replay, checkpoints compared, whether they matched */
      lastLoad: () => { tick: number; hash: number; checked: number; matched: boolean } | null;
    };
  }
}

window.__borderfall = {
  getState: () => (session && session.human ? session.state : null),
  dispatch,
  ui: () => (session && session.human ? session.ui : null),
  camera: () => session?.camera ?? null,
  startGame: (partial = {}) => startGame({ ...menu.replaySettings(), ...partial, humanPlayer: true }),
  startTutorial: () => startTutorial(),
  tutorial: () => {
    const t = session?.tutorial;
    if (!t) return null;
    return { chapter: t.chapter.id, step: t.runner.index, stepId: t.runner.step?.id ?? '', finished: t.runner.finished };
  },
  advance: (n: number) => {
    const s = session;
    if (!s) return;
    for (let k = 0; k < n && s.state.phase !== 'over'; k++) {
      tick(s.state);
      // the end summary's history samples every ~10 s of game time: feed it as the frames would
      if (k % 20 === 19) s.hud?.feedHistory(s.state);
    }
    s.hud?.feedHistory(s.state);
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
  lastLoad: () => lastLoad,
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
