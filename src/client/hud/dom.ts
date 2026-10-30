// DOM helpers shared by the HUD parts.
import { el, setText } from '../menu';
import type { Dispatch, UiState } from '../uiState';
import type { Camera } from '../camera';
import type { GameState, Player } from '../../sim/types';
import { iconSpan, lineIcon } from './glyph';

export { el, setText };

export function setVisible(e: HTMLElement, v: boolean): void {
  if (e.classList.contains('hidden') === v) e.classList.toggle('hidden', !v);
}
export function setDisabled(b: HTMLButtonElement | HTMLInputElement, d: boolean): void {
  if (b.disabled !== d) b.disabled = d;
}
export function setTip(e: HTMLElement, tip: string): void {
  if (e.dataset.tip !== tip) e.dataset.tip = tip;
}
export function setClass(e: HTMLElement, cls: string, on: boolean): void {
  if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on);
}

/** A HUD button: `cls` adds variants (primary, danger, ghost, icon). */
export function btn(label: string, cls: string, onClick: (e: MouseEvent) => void, icon?: string): HTMLButtonElement {
  const b = el('button', 'wr-btn ' + cls);
  b.type = 'button';
  if (icon) b.append(iconSpan(lineIcon(icon, 16)));
  if (label) b.append(el('span', 'wr-btn-l', label));
  b.addEventListener('click', onClick);
  return b;
}

/** Small keycap showing a hotkey. */
export function keycap(k: string): HTMLElement {
  return el('kbd', 'kc', k);
}

/** A section title in the command-table style ("FORCES"). */
export function sectionTitle(text: string): HTMLElement {
  return el('div', 'wr-sec', text);
}

export function slider(min: number, max: number, step: number, cls = 'wr-range'): HTMLInputElement {
  const r = el('input', cls);
  r.type = 'range';
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  return r;
}
/** Sets a slider's value from state unless the user is dragging it. */
export function syncSlider(r: HTMLInputElement, v: number): void {
  if (document.activeElement === r) return;
  const s = String(v);
  if (r.value !== s) r.value = s;
}

/** Restarts a CSS animation class (value flash). */
export function flash(e: HTMLElement, cls: string): void {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(r).padStart(2, '0');
}
export function fmtRate(v: number, digits = 1): string {
  const a = Math.abs(v);
  const s = a < 10 ? a.toFixed(digits) : a < 1000 ? String(Math.round(a)) : a < 1e6 ? (a / 1000).toFixed(a < 1e4 ? 1 : 0) + 'k' : (a / 1e6).toFixed(2) + 'M';
  return (v < -0.05 ? '-' : '+') + s;
}
export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export type DrawerId = 'army' | 'research' | 'diplomacy' | 'events' | 'legend' | 'building' | 'settings';

/** What every HUD part can reach. */
export interface HudCtx {
  ui: UiState;
  dispatch: Dispatch;
  camera: Camera;
  state(): GameState | null;
  me(): Player | null;
  /** dispatches and refreshes the HUD soon; true when it worked */
  act(action: Parameters<Dispatch>[0]): boolean;
  refreshSoon(): void;
  openDrawer(id: DrawerId, toggle?: boolean): void;
  closeDrawer(): void;
  openNation(id: number): void;
  focusTile(tile: number, zoomIn?: boolean): void;
  toast(text: string, kind?: 'info' | 'good' | 'bad'): void;
  /** plays a UI sound when audio is wired in */
  sound(id: 'uiClick' | 'uiError'): void;
}
