// Chat text rules on the server: cleaning (validate.ts calls cleanChatText), the word filter and the per-member rate
// limit (room.ts). The server is the authority: whatever a client sends, others only ever get the cleaned, filtered
// text, and clients show it with textContent (never as HTML).
import { CHAT_MAX_LENGTH } from '../src/net/protocol';
import { CHAT_BLOCKED_WORDS } from './chatWords';

/** Longest raw text accepted before cleaning (spaces and control characters may shrink it). */
export const CHAT_RAW_MAX = CHAT_MAX_LENGTH * 4;

// C0/C1 control characters, line and paragraph separators, and invisible characters that change how text reads
// (bidi overrides and isolates, zero-width spaces, BOM, soft hyphen, Mongolian vowel separator). U+200D (zero-width
// joiner) stays: emoji sequences use it.
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
/** More than two combining marks on one letter ("zalgo" text spilling over other lines): cut to two. */
export const MARK_PILES = /(\p{M}{2})\p{M}+/gu;

/**
 * Cleans a chat message: control and invisible characters become spaces, runs of white space become one space, the
 * ends are trimmed and piles of combining marks are cut. Returns null when nothing is left or it is longer than
 * CHAT_MAX_LENGTH characters (code points).
 */
export function cleanChatText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > CHAT_RAW_MAX) return null;
  const text = raw.normalize('NFC').replace(CONTROL, ' ').replace(MARK_PILES, '$1').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let n = 0;
  for (const _ of text) if (++n > CHAT_MAX_LENGTH) return null;
  return text;
}

// ------------------------------------------------------------------------------------------------ word filter

const BLOCKED = new Set(CHAT_BLOCKED_WORDS.map((w) => w.toLowerCase()));
const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
/** A word: letters and digits, plus @ and $ (look-alikes for a and s). */
const WORD = /[\p{L}\p{N}@$]+/gu;

function isBlocked(word: string): boolean {
  const low = word.toLowerCase();
  if (BLOCKED.has(low)) return true;
  // look-alike digits only inside a word that has letters ("sh1t"), so plain numbers ("455") are never touched
  const plain = /\p{L}/u.test(low) ? low.replace(/[013457@$]/g, (c) => LOOKALIKE[c] ?? c) : low;
  if (BLOCKED.has(plain)) return true;
  // stretched letters ("shiiit", "asss"): squeeze runs of three or more to one and to two
  if (!/(.)\1\1/u.test(plain)) return false;
  return BLOCKED.has(plain.replace(/(.)\1{2,}/gu, '$1')) || BLOCKED.has(plain.replace(/(.)\1{2,}/gu, '$1$1'));
}

/** Masks every blocked word with ***; everything else is left exactly as it was. */
export function maskChatText(text: string): string {
  return text.replace(WORD, (w) => (isBlocked(w) ? '***' : w));
}

// ------------------------------------------------------------------------------------------------ rate limit

/** At most `burst` messages per `windowMs`; one more starts a cooldown of `cooldownMs` (every message refused). */
export class ChatLimiter {
  private times: number[] = [];
  private quietUntil = 0;

  constructor(
    private readonly burst: number,
    private readonly windowMs: number,
    private readonly cooldownMs: number,
  ) {}

  /** 0 = the message may go (and is counted), else ms until the member may chat again. */
  take(now: number): number {
    if (now < this.quietUntil) return this.quietUntil - now;
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.burst) {
      this.quietUntil = now + this.cooldownMs;
      this.times = [];
      return this.cooldownMs;
    }
    this.times.push(now);
    return 0;
  }

  /** Nothing counted in the window and no cooldown running: forgetting this limiter changes nothing. */
  idle(now: number): boolean {
    return now >= this.quietUntil && this.times.every((t) => now - t >= this.windowMs);
  }
}
