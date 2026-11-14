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
  atomBomb: { files: ['sfx-atom-fs741175'], gain: 1, pitch: 0.04 }, // placeholder: the owner wants a better one
  explosionBig: { files: ['sfx-explosion-big-fs741173'], gain: 0.72 },
  victory: { files: ['sting-victory-fs470083'], gain: 0.85, pitch: 0, sting: true },
  defeat: { files: ['sting-defeat-oga-the-fallen'], gain: 0.85, pitch: 0, sting: true },
  capitalLost: { files: ['capital-lost-fs374271'], gain: 0.6, pitch: 0.03 },
  cityLost: { files: ['capital-lost-fs374271'], gain: 0.48, pitch: 0.03 },
  capitalTaken: { files: ['city-taken-fs592096-short'], gain: 0.6, pitch: 0.03 },
  cityTaken: { files: ['city-taken-fs592096-short'], gain: 0.5, pitch: 0.03 },
  allianceRequest: { files: ['alliance-request-fs198874'], gain: 0.45, pitch: 0.03 },
  allianceBroken: { files: ['alliance-broken-fs790253'], gain: 0.5, pitch: 0.03 },
  allianceExpired: { files: ['alliance-broken-fs790253'], gain: 0.38, pitch: 0.03 },
  missileLaunch: { files: ['sfx-missile-fs854476'], gain: 0.55 },
  shipHorn: { files: ['sfx-ship-horn-fs261846'], gain: 0.42, pitch: 0.04 },
  tankDestroyed: { files: ['sfx-tank-destroyed-fs209772'], gain: 0.55, pitch: 0.06 },
  unitLost: { files: ['sfx-tank-destroyed-fs209772'], gain: 0.5, pitch: 0.06 },
  planeCrash: { files: ['sfx-plane-crash-fs861876'], gain: 0.6 },
  explosion: { files: ['sfx-explosion-fs182429'], gain: 0.5, pitch: 0.07 },
  bombard: { files: ['sfx-artillery-fs239137'], gain: 0.5, pitch: 0.06 },
  shot: { files: ['sfx-artillery-fs239137'], gain: 0.4, pitch: 0.07 },
  tankShot: { files: ['sfx-tank-shot-fs127845'], gain: 0.42, pitch: 0.07 },
  sonarPing: { files: ['sfx-sonar-fs12677'], gain: 0.32, pitch: 0.04 },
  frontGunfire: { files: ['sfx-front-gunfire-fs840492'], gain: 0.3, pitch: 0.04 },
  buildPlaced: { files: ['build-placed-fs449955'], gain: 0.32, pitch: 0.06 },
  tradeCoin: { files: ['trade-coin-fs223344'], gain: 0.4, pitch: 0.05 },
  countdown: { files: ['countdown-fs361783'], gain: 0.42, pitch: 0.02 },
  uiError: { files: ['ui-error-kenney-error-008'], gain: 0.4, pitch: 0.04 },
  uiClick: { files: ['ui-click-kenney-click3'], gain: 0.42, pitch: 0.05 },
  // No pick yet (they keep the synth): shipSunk, buildingDone, researchDone, allianceFormed, underAttack, countdownGo.
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
