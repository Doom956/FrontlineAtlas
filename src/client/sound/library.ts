// Which recorded file plays for each sound, and the music tracks of each mood. Data only: adding a variant take or
// swapping a file is a one-line change here (then `npx vite-node scripts/audio/import.ts <sound-candidates dir>`
// copies the files into public/audio/ and rebuilds the credits). Ids are the candidate ids of the sound-candidates
// branch (its manifest.json); a file is served as audio/sfx/<id>.ogg (Ogg Opus) with an AAC copy audio/sfx/<id>.m4a
// for browsers without Ogg (Safari before 18.4), and music as audio/music/<id>.ogg / .m4a.
//
// A sound with no entry, or whose files are not loaded (yet, or at all), plays its synthesized version (audio.ts).

import type { SoundId } from '../audio';

/** The looping bed of gunfire under a front on screen (not a one-shot sound). */
export type BedId = 'frontGunfire';
export type SampleKey = SoundId | BedId;

export interface SampleSet {
  /** variant takes; one is picked at random on each play (never the same twice in a row) */
  files: readonly string[];
  /** linear gain on the effects bus (the files are levelled to about -16 LUFS); the mix lives here */
  gain: number;
  /** playback-rate spread each way (0.05 = up to 5 % faster or slower, so the pitch moves); default 0.05 */
  pitch?: number;
  /** music stings: played on the music side (they stop the music) */
  sting?: boolean;
}

/**
 * The mix, loudest first: the atom bomb, then big blasts and alerts, then combat (it sits under the music when zoomed
 * out: the zoom fade in sound/spatial.ts does that), then notices, then the UI, which is soft.
 */
export const SFX: Readonly<Partial<Record<SampleKey, SampleSet>>> = {
  atomBomb: { files: ['sfx-atom-r2-windy'], gain: 1, pitch: 0.04 },
  shipSunk: { files: ['sfx-ship-sinking-r2-thimras'], gain: 0.6 },
  explosionBig: { files: ['sfx-explosion-big-fs741173', 'sfx-explosion-big-fs741173-v2', 'sfx-explosion-big-fs741173-v3', 'sfx-explosion-big-fs741173-v4'], gain: 0.72 },
  victory: { files: ['sting-victory-fs470083'], gain: 0.85, pitch: 0, sting: true },
  defeat: { files: ['sting-defeat-oga-the-fallen'], gain: 0.85, pitch: 0, sting: true },
  capitalLost: { files: ['capital-lost-fs374271', 'capital-lost-fs374271-v2', 'capital-lost-fs374271-v3', 'capital-lost-fs374271-v4'], gain: 0.6, pitch: 0.03 },
  cityLost: { files: ['capital-lost-fs374271', 'capital-lost-fs374271-v2', 'capital-lost-fs374271-v3', 'capital-lost-fs374271-v4'], gain: 0.48, pitch: 0.03 },
  capitalTaken: { files: ['city-taken-fs592096-short', 'city-taken-fs592096-short-v2', 'city-taken-fs592096-short-v3'], gain: 0.6, pitch: 0.03 },
  cityTaken: { files: ['city-taken-fs592096-short', 'city-taken-fs592096-short-v2', 'city-taken-fs592096-short-v3'], gain: 0.5, pitch: 0.03 },
  underAttack: { files: ['under-attack-r2-air-raid-test'], gain: 0.42, pitch: 0.03 },
  researchDone: { files: ['research-done-r2-triumphal-fanfare'], gain: 0.42, pitch: 0.03 },
  allianceFormed: { files: ['alliance-formed-r2-trumpet-fanfare-2'], gain: 0.45, pitch: 0.03 },
  countdownGo: { files: ['countdown-go-r2-salute-cannon'], gain: 0.55, pitch: 0.04 },
  allianceRequest: { files: ['alliance-request-fs198874', 'alliance-request-fs198874-v2', 'alliance-request-fs198874-v3'], gain: 0.45, pitch: 0.03 },
  allianceBroken: { files: ['alliance-broken-fs790253', 'alliance-broken-fs790253-v2', 'alliance-broken-fs790253-v3'], gain: 0.5, pitch: 0.03 },
  allianceExpired: { files: ['alliance-broken-fs790253', 'alliance-broken-fs790253-v2', 'alliance-broken-fs790253-v3'], gain: 0.38, pitch: 0.03 },
  missileLaunch: { files: ['sfx-missile-fs854476', 'sfx-missile-fs854476-v2', 'sfx-missile-fs854476-v3', 'sfx-missile-fs854476-v4'], gain: 0.55 },
  shipHorn: { files: ['sfx-ship-horn-fs261846', 'sfx-ship-horn-fs261846-v2', 'sfx-ship-horn-fs261846-v3', 'sfx-ship-horn-fs261846-v4'], gain: 0.42, pitch: 0.04 },
  tankDestroyed: { files: ['sfx-tank-destroyed-fs209772', 'sfx-tank-destroyed-fs209772-v2', 'sfx-tank-destroyed-fs209772-v3', 'sfx-tank-destroyed-fs209772-v4'], gain: 0.55, pitch: 0.06 },
  unitLost: { files: ['sfx-tank-destroyed-fs209772', 'sfx-tank-destroyed-fs209772-v2', 'sfx-tank-destroyed-fs209772-v3', 'sfx-tank-destroyed-fs209772-v4'], gain: 0.5, pitch: 0.06 },
  planeCrash: { files: ['sfx-plane-crash-fs861876', 'sfx-plane-crash-fs861876-v2', 'sfx-plane-crash-fs861876-v3', 'sfx-plane-crash-fs861876-v4'], gain: 0.6 },
  explosion: { files: ['sfx-explosion-fs182429', 'sfx-explosion-fs182429-v2', 'sfx-explosion-fs182429-v3', 'sfx-explosion-fs182429-v4', 'sfx-explosion-fs182429-v5'], gain: 0.5, pitch: 0.07 },
  bombard: { files: ['sfx-artillery-fs239137', 'sfx-artillery-fs239137-v2', 'sfx-artillery-fs239137-v3', 'sfx-artillery-fs239137-v4', 'sfx-artillery-fs239137-v5'], gain: 0.5, pitch: 0.06 },
  shot: { files: ['sfx-artillery-fs239137', 'sfx-artillery-fs239137-v2', 'sfx-artillery-fs239137-v3', 'sfx-artillery-fs239137-v4', 'sfx-artillery-fs239137-v5'], gain: 0.4, pitch: 0.07 },
  tankShot: { files: ['sfx-tank-shot-fs127845', 'sfx-tank-shot-fs127845-v2', 'sfx-tank-shot-fs127845-v3', 'sfx-tank-shot-fs127845-v4', 'sfx-tank-shot-fs127845-v5'], gain: 0.42, pitch: 0.07 },
  sonarPing: { files: ['sfx-sonar-fs12677', 'sfx-sonar-fs12677-v2', 'sfx-sonar-fs12677-v3', 'sfx-sonar-fs12677-v4', 'sfx-sonar-fs12677-v5'], gain: 0.32, pitch: 0.04 },
  frontGunfire: { files: ['sfx-front-gunfire-fs840492', 'sfx-front-gunfire-fs840492-v2', 'sfx-front-gunfire-fs840492-v3', 'sfx-front-gunfire-fs840492-v4'], gain: 0.3, pitch: 0.04 },
  buildingDone: { files: ['building-done-r2-hand-bell'], gain: 0.28, pitch: 0.03 },
  buildPlaced: { files: ['build-placed-fs449955', 'build-placed-fs449955-v2', 'build-placed-fs449955-v3', 'build-placed-fs449955-v4'], gain: 0.32, pitch: 0.06 },
  tradeCoin: { files: ['trade-coin-fs223344', 'trade-coin-fs223344-v2', 'trade-coin-fs223344-v3', 'trade-coin-fs223344-v4', 'trade-coin-fs223344-v5'], gain: 0.4, pitch: 0.05 },
  countdown: { files: ['countdown-fs361783', 'countdown-fs361783-v2', 'countdown-fs361783-v3', 'countdown-fs361783-v4'], gain: 0.42, pitch: 0.02 },
  uiError: { files: ['ui-error-kenney-error-008', 'ui-error-kenney-error-008-v2', 'ui-error-kenney-error-008-v3'], gain: 0.4, pitch: 0.04 },
  uiClick: { files: ['ui-click-kenney-click3', 'ui-click-kenney-click3-v2', 'ui-click-kenney-click3-v3', 'ui-click-kenney-click3-v4'], gain: 0.42, pitch: 0.05 },
};

export type MusicMood = 'menu' | 'peace' | 'war' | 'battle';

/** Tracks of each mood, rotated (never the last one again). The menu plays the peace tracks. */
export const MUSIC: Readonly<Record<Exclude<MusicMood, 'menu'>, readonly string[]>> = {
  peace: ['music-peace-km-americana', 'music-peace-oga-heroes-theme', 'music-peace-oga-the-fall-of-arcana'],
  war: ['music-war-km-crusade', 'music-war-oga-battle-theme'],
  battle: ['music-battle-km-black-vortex', 'music-battle-km-five-armies', 'music-battle-oga-battle-theme-a', 'music-battle-oga-heroic-demise'],
};

export function musicTracks(mood: MusicMood): readonly string[] {
  return MUSIC[mood === 'menu' ? 'peace' : mood];
}

/** Every effect file id (each once). */
export function sfxFileIds(): string[] {
  const out = new Set<string>();
  for (const s of Object.values(SFX)) if (s) for (const f of s.files) out.add(f);
  return [...out];
}

/** Every music file id (each once). */
export function musicFileIds(): string[] {
  return [...new Set(Object.values(MUSIC).flat())];
}

export type AudioFormat = 'ogg' | 'm4a';

/** Formats to try for this browser, best first: Ogg Opus where the browser says it plays it, AAC otherwise. */
export function audioFormats(canPlay: ((type: string) => string) | null): AudioFormat[] {
  let ogg = '';
  try {
    ogg = canPlay ? canPlay('audio/ogg; codecs="opus"') : '';
  } catch {
    ogg = '';
  }
  return ogg === 'probably' || ogg === 'maybe' ? ['ogg', 'm4a'] : ['m4a', 'ogg'];
}

/** Relative URL of a file (works with vite base './' on the Pages subpath and at the root on the server). */
export function audioUrl(kind: 'sfx' | 'music', id: string, fmt: AudioFormat): string {
  return `audio/${kind}/${id}.${fmt}`;
}
