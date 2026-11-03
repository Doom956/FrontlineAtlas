// The single-player save slot in localStorage (one game: the newest replaces the older one). Every access is wrapped:
// private windows, full storage or blocked site data must never break the game, only the save.
import { parseSave, type SaveData, type SaveSlot } from './format';

export const SAVE_KEY = 'borderfall.save';
/** Largest save written (characters of JSON). Browsers give a site about 5 million characters in all. */
export const MAX_SAVE_CHARS = 3_000_000;

export type WriteResult = 'ok' | 'tooBig' | 'failed';

/** The save slot, or null when there is none (or storage can't be read). */
export function readSave(): SaveSlot | null {
  try {
    return parseSave(localStorage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

/** True when a save of any kind is stored (also one from an older version). */
export function hasSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Writes the save. When storage is full the old save is removed first (only the newest is kept) and the write is
 * tried once more; if that fails too, the old save is put back.
 */
export function writeSave(save: SaveData): WriteResult {
  let text: string;
  try {
    text = JSON.stringify(save);
  } catch {
    return 'failed';
  }
  if (text.length > MAX_SAVE_CHARS) return 'tooBig';
  try {
    localStorage.setItem(SAVE_KEY, text);
    return 'ok';
  } catch {
    let old: string | null = null;
    try {
      old = localStorage.getItem(SAVE_KEY);
      localStorage.removeItem(SAVE_KEY);
      localStorage.setItem(SAVE_KEY, text);
      return 'ok';
    } catch {
      // keep the older save rather than none
      try {
        if (old !== null) localStorage.setItem(SAVE_KEY, old);
      } catch {
        // storage is gone: nothing more to try
      }
      return 'failed';
    }
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // nothing stored, nothing to do
  }
}
