// Applies the settings (settings/store.ts) to the parts that do not read them on their own, at startup and after every
// change, so nothing needs a reload. The map look, map effects, reduce motion and graphics quality are read where
// they are used (render/mapStyle.ts, fx/settings.ts, render/glmap.ts liteWanted).
import type { AudioManager } from '../audio';
import { resetArtPicks, setArtStyle, setMotionPreset } from '../art/artStyle';
import { prefersReducedMotion } from '../fx/settings';
import { getSettings, onSettingsChange, type SettingKey } from './store';

function applyAudio(audio: AudioManager | null): void {
  if (!audio) return;
  const s = getSettings();
  audio.setVolume(s.master, s.sfx, s.music);
  audio.setMuted(s.muted);
}

function applyArt(): void {
  const s = getSettings();
  resetArtPicks();
  if (s.art) setArtStyle('all', s.art);
  if (s.motion) setMotionPreset('all', s.motion);
}

/** The page's CSS animations follow reduce motion too (styles.css html.reduce-motion). */
function applyMotionClass(): void {
  try {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('reduce-motion', prefersReducedMotion());
  } catch {
    /* no page */
  }
}

let tester: (() => boolean) | null = null;
let probe: (() => { software: boolean; lite: boolean } | null) | null = null;

/** Plays a short sound at the effects volume (Settings' Test sound); false when there is no sound at all. */
export function testSound(): boolean {
  return tester ? tester() : false;
}
/** How the map is drawn: software = no graphics card in use (Auto then means Low); null before the map exists. */
export function qualityInfo(): { software: boolean; lite: boolean } | null {
  return probe ? probe() : null;
}
/** main.ts hands over the sound and the map. */
export function setSettingsProbes(p: { testSound?: () => boolean; quality?: () => { software: boolean; lite: boolean } | null }): void {
  if (p.testSound) tester = p.testSound;
  if (p.quality) probe = p.quality;
}

/** Applies the settings now and keeps applying them. Returns a remover. */
export function wireSettings(audio: AudioManager | null): () => void {
  const s = getSettings();
  applyAudio(audio);
  // the art keeps the build's picks (and any the art lab hands over) until a pick is made in Settings
  if (s.art || s.motion) applyArt();
  applyMotionClass();
  return onSettingsChange((keys: readonly SettingKey[]) => {
    if (keys.some((k) => k === 'master' || k === 'sfx' || k === 'music' || k === 'muted')) applyAudio(audio);
    if (keys.includes('art') || keys.includes('motion')) applyArt();
    if (keys.includes('reduceMotion')) applyMotionClass();
  });
}
