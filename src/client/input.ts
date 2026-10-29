// Mouse and keyboard handling on the map canvas.
import { buildingsOf } from '../sim/buildings';
import { BUILDINGS, BUILDING_ORDER } from '../sim/config';
import { areAllied } from '../sim/diplomacy';
import { isWater, TROOP_TYPES } from '../sim/types';
import type { BuildingType, GameState, Player, Troops } from '../sim/types';
import type { Camera } from './camera';
import type { Renderer } from './renderer';
import type { Dispatch, GetState, UiState } from './uiState';

export interface InputDeps {
  canvas: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
  camera: Camera;
  renderer: Renderer;
  ui: UiState;
  getState: GetState;
  dispatch: Dispatch;
  /** HUD callbacks for keys that open panels */
  openResearch: () => void;
  toggleHelp: () => void;
  /** Closes the topmost HUD overlay (modal); returns true if something was closed. */
  closeOverlay?: () => boolean;
}

const DRAG_THRESHOLD = 5; // px before a press becomes a pan
const KEY_PAN_SPEED = 700; // screen px per second
const TOAST_MS = 3000;
export const SPEEDS: readonly (1 | 2 | 4)[] = [1, 2, 4];

// ------------------------------------------------------------------------------------------------ helpers

/** Troops sent by an attack/transport with the attack panel settings (share x army, composition). */
export function troopsToSend(p: Player, ui: UiState): Troops {
  const share = Math.max(0, Math.min(1, ui.attackShare));
  const have = p.troops;
  if (ui.attackMixMode === 'all') {
    return { infantry: have.infantry * share, armor: have.armor * share, artillery: have.artillery * share };
  }
  // Custom: normalised weights applied to the share of the whole army, capped by what each type has.
  const total = (have.infantry + have.armor + have.artillery) * share;
  const w = ui.customMix;
  const sum = Math.max(0, w.infantry) + Math.max(0, w.armor) + Math.max(0, w.artillery);
  const out: Troops = { infantry: 0, armor: 0, artillery: 0 };
  if (sum <= 0) return out;
  for (const k of TROOP_TYPES) out[k] = Math.min(have[k], (total * Math.max(0, w[k])) / sum);
  return out;
}

export function troopSum(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}

/** True if `tile` is land the player may attack (not own, not allied, owner alive). */
export function isAttackable(state: GameState, playerId: number, tile: number): boolean {
  const map = state.map;
  if (tile < 0 || tile >= map.owner.length || isWater(map.terrain[tile])) return false;
  const o = map.owner[tile];
  if (o === playerId) return false;
  return o === 0 || (state.players[o].alive && !areAllied(state, playerId, o));
}

/**
 * Own launch tile for a transport to `to`: the nearest finished Port, else the nearest own coastal tile.
 * One map scan (only on click). -1 if the player has no coast.
 */
export function autoTransportFrom(state: GameState, playerId: number, to: number): number {
  const map = state.map;
  const w = map.width;
  const tx = to % w;
  const ty = (to / w) | 0;
  let best = -1;
  let bestD = Infinity;
  for (const b of buildingsOf(state, playerId, 'port')) {
    if (b.buildLeft > 0) continue;
    const dx = (b.tile % w) - tx;
    const dy = ((b.tile / w) | 0) - ty;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = b.tile;
    }
  }
  if (best >= 0) return best;
  const owner = map.owner;
  const coastal = map.coastal;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== playerId || !coastal[i]) continue;
    const dx = (i % w) - tx;
    const dy = ((i / w) | 0) - ty;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Sends a transport to `to` from `from` (-1 = choose automatically) with the attack panel's troops. */
export function sendTransport(state: GameState, ui: UiState, dispatch: Dispatch, from: number, to: number): boolean {
  const h = state.humanId;
  const src = from >= 0 ? from : autoTransportFrom(state, h, to);
  if (src < 0) {
    ui.toast = { text: 'You have no coast to launch from', until: performance.now() + TOAST_MS };
    return false;
  }
  return dispatch({ type: 'transport', from: src, to, troops: troopsToSend(state.players[h], ui) }).ok;
}

/** Hotkey -> building, from BUILDINGS[].hotkey (upper-case letters and digits). */
const HOTKEYS = new Map<string, BuildingType>(BUILDING_ORDER.map((b) => [BUILDINGS[b].hotkey.toUpperCase(), b]));

function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return true;
  return t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'button';
}

const PAN_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// ------------------------------------------------------------------------------------------------ setup

export function setupInput(deps: InputDeps): () => void {
  const { canvas, minimap, camera, renderer, ui, getState, dispatch } = deps;
  const ac = new AbortController();
  const opts = { signal: ac.signal };

  // ---- pointer on the map ----
  let press: { id: number; button: number; x0: number; y0: number; x: number; y: number; dragging: boolean } | null = null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const tileAt = (sx: number, sy: number): number => {
    const s = getState();
    if (!s) return -1;
    const t = camera.screenToTile(sx, sy);
    const x = Math.floor(t.x);
    const y = Math.floor(t.y);
    if (x < 0 || y < 0 || x >= s.map.width || y >= s.map.height) return -1;
    return y * s.map.width + x;
  };

  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (press) return;
      ui.contextMenu = null;
      const p = local(e);
      // Middle button pans right away; left and right become a pan only after moving DRAG_THRESHOLD px.
      press = { id: e.pointerId, button: e.button, x0: p.x, y0: p.y, x: p.x, y: p.y, dragging: e.button === 1 };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (e.button === 1) e.preventDefault();
    },
    opts,
  );
  canvas.addEventListener(
    'pointermove',
    (e) => {
      const p = local(e);
      ui.hoverTile = tileAt(p.x, p.y);
      if (!press || press.id !== e.pointerId) return;
      if (!press.dragging && Math.hypot(p.x - press.x0, p.y - press.y0) > DRAG_THRESHOLD) press.dragging = true;
      if (press.dragging) {
        camera.pan(p.x - press.x, p.y - press.y);
        canvas.classList.add('dragging');
      }
      press.x = p.x;
      press.y = p.y;
    },
    opts,
  );
  const endPress = (e: PointerEvent, cancelled: boolean) => {
    if (!press || press.id !== e.pointerId) return;
    const pr = press;
    press = null;
    canvas.classList.remove('dragging');
    if (cancelled || pr.dragging) return;
    const p = local(e);
    const tile = tileAt(p.x, p.y);
    if (pr.button === 0) leftClick(tile, e.shiftKey);
    else if (pr.button === 2 && tile >= 0) {
      const s = getState();
      if (s && s.humanId && s.phase === 'playing') ui.contextMenu = { x: e.clientX, y: e.clientY, tile };
    }
  };
  canvas.addEventListener('pointerup', (e) => endPress(e, false), opts);
  canvas.addEventListener('pointercancel', (e) => endPress(e, true), opts);
  canvas.addEventListener(
    'pointerleave',
    () => {
      if (!press) ui.hoverTile = -1;
    },
    opts,
  );
  canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // deltaMode 1 = lines
      camera.zoomAt(p.x, p.y, Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0015));
    },
    { signal: ac.signal, passive: false },
  );

  function leftClick(tile: number, shift: boolean): void {
    const s = getState();
    if (!s || tile < 0 || !s.humanId) return;
    const h = s.humanId;
    if (s.phase === 'spawn') {
      dispatch({ type: 'spawn', tile });
      return;
    }
    if (s.phase !== 'playing') return;
    const me = s.players[h];
    const mode = ui.mode;
    // Target modes: the click is the target; stay in the mode while Shift is held.
    let ok: boolean | null = null;
    switch (mode.kind) {
      case 'build':
        ok = dispatch({ type: 'build', building: mode.building, tile }).ok;
        break;
      case 'transport':
        ok = sendTransport(s, ui, dispatch, mode.from, tile);
        break;
      case 'bomb':
        ok = dispatch({ type: 'bomb', airfield: mode.airfield, tile }).ok;
        break;
      case 'missile':
        ok = dispatch({ type: 'launchMissile', silo: mode.silo, kind: mode.missile, tile }).ok;
        break;
      case 'moveWarship':
        ok = dispatch({ type: 'moveWarship', unitId: mode.unitId, tile }).ok;
        break;
      case 'none':
        break;
    }
    if (ok !== null) {
      if (ok && !shift) ui.mode = { kind: 'none' };
      return;
    }
    if (isWater(s.map.terrain[tile])) return;
    if (s.map.owner[tile] === h) {
      ui.selectedTile = ui.selectedTile === tile ? -1 : tile;
      return;
    }
    dispatch({ type: 'attack', tile, troops: troopsToSend(me, ui) });
  }

  // ---- minimap: click or drag centres the camera ----
  let mmDown = false;
  const mmCentre = (e: PointerEvent) => {
    const r = minimap.getBoundingClientRect();
    const t = renderer.minimapToTile(e.clientX - r.left, e.clientY - r.top);
    if (t) camera.centerOn(t.x, t.y);
  };
  minimap.addEventListener(
    'pointerdown',
    (e) => {
      mmDown = true;
      ui.contextMenu = null;
      try {
        minimap.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      mmCentre(e);
    },
    opts,
  );
  minimap.addEventListener('pointermove', (e) => mmDown && mmCentre(e), opts);
  minimap.addEventListener('pointerup', () => (mmDown = false), opts);
  minimap.addEventListener('pointercancel', () => (mmDown = false), opts);
  minimap.addEventListener('contextmenu', (e) => e.preventDefault(), opts);

  // ---- keyboard ----
  const held = new Set<string>();
  window.addEventListener(
    'keydown',
    (e) => {
      if (isTextInput(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = getState();
      if (!s || !s.humanId) return;
      const k = e.key;
      const code = e.code;
      // Panning keys are tracked by physical position so they work on any keyboard layout.
      if (PAN_CODES.has(code)) {
        held.add(code);
        e.preventDefault();
        return;
      }
      if (e.repeat && k !== '[' && k !== ']') return;
      if (k === 'Escape') {
        if (ui.contextMenu) ui.contextMenu = null;
        else if (deps.closeOverlay?.()) return;
        else if (ui.mode.kind !== 'none') ui.mode = { kind: 'none' };
        else ui.selectedTile = -1;
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        ui.paused = !ui.paused;
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      if (k === '+' || k === '=') {
        ui.speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(ui.speed) + 1)];
        return;
      }
      if (k === '-' || k === '_') {
        ui.speed = SPEEDS[Math.max(0, SPEEDS.indexOf(ui.speed) - 1)];
        return;
      }
      if (k === '[' || k === ']') {
        const v = Math.round((ui.attackShare + (k === '[' ? -0.1 : 0.1)) * 20) / 20;
        ui.attackShare = Math.max(0.05, Math.min(1, v));
        return;
      }
      if (k === '?' || code === 'F1') {
        e.preventDefault();
        deps.toggleHelp();
        return;
      }
      const up = k.length === 1 ? k.toUpperCase() : '';
      if (up === 'T') return deps.openResearch();
      if (up === 'V') {
        ui.showResources = !ui.showResources;
        return;
      }
      if (up === 'B') {
        ui.showSupply = !ui.showSupply;
        return;
      }
      if (up === 'C') {
        const me = s.players[s.humanId];
        if (me && me.capital >= 0) camera.centerOn((me.capital % s.map.width) + 0.5, ((me.capital / s.map.width) | 0) + 0.5);
        return;
      }
      // Digits by physical key, so Shift+1 still means the City hotkey.
      const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
      const b = HOTKEYS.get(digit ? digit[1] : up);
      if (b && s.phase === 'playing') {
        ui.contextMenu = null;
        ui.mode = ui.mode.kind === 'build' && ui.mode.building === b ? { kind: 'none' } : { kind: 'build', building: b };
      }
    },
    opts,
  );
  window.addEventListener('keyup', (e) => held.delete(e.code), opts);
  window.addEventListener('blur', () => held.clear(), opts);

  // Range sliders keep focus after a drag; drop it so arrow keys pan instead of nudging the slider.
  document.addEventListener(
    'change',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type === 'range') t.blur();
    },
    opts,
  );

  // Smooth key panning.
  let raf = 0;
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (held.size) {
      let dx = 0;
      let dy = 0;
      if (held.has('KeyA') || held.has('ArrowLeft')) dx += 1;
      if (held.has('KeyD') || held.has('ArrowRight')) dx -= 1;
      if (held.has('KeyW') || held.has('ArrowUp')) dy += 1;
      if (held.has('KeyS') || held.has('ArrowDown')) dy -= 1;
      if (dx || dy) camera.pan(dx * KEY_PAN_SPEED * dt, dy * KEY_PAN_SPEED * dt);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return () => {
    ac.abort();
    cancelAnimationFrame(raf);
    held.clear();
  };
}
