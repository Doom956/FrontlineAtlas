// Music (client only): which mood plays (a pure state machine) and the player that streams and crossfades the tracks.
//
// Moods: menu (title screen), peace, war (your nation is at war) and battle (heavy fighting near you, or your land
// under attack). The game's tension (AudioManager.effectiveTension: setTension, attacks on you, recent alarms and the
// fighting on screen) drives war and battle. Rising is quick (the mood must hold ESCALATE_MS), calming down is slow
// (CALM_MS, and only after MIN_DWELL_MS in the mood), and battle has a lower bar to stay than to start, so the music
// does not flip back and forth.
//
// The player streams each track with an <audio> element through a MediaElementAudioSourceNode (no decoded minutes of
// music in memory), on two decks: a new track fades in on one while the other fades out (CROSSFADE_S). Tracks are
// long but not seamless loops: near a track's end the next one of the mood starts and crossfades. Within a mood the
// tracks rotate and the last one never plays again right away. A track only loads when it is about to play.

import { audioUrl, musicTracks, type AudioFormat, type MusicMood } from './library';

export type { MusicMood } from './library';

export const BATTLE_ON = 0.6;
export const BATTLE_OFF = 0.35;
export const WAR_ON = 0.2;
export const ESCALATE_MS = 2500;
export const CALM_MS = 25_000;
export const MIN_DWELL_MS = 30_000;
export const CROSSFADE_S = 3.5;
const MAX_FAILS = 3;

export interface MusicInput {
  /** a game of yours is on screen (false: the title screen, or watching) */
  inGame: boolean;
  /** your nation is at war with another nation (an attack either way, or one that ended recently) */
  atWar: boolean;
  /** 0..1 */
  tension: number;
}

export interface MoodState {
  mood: MusicMood;
  /** ms when the current mood started */
  since: number;
  /** the mood the input asks for, and since when (ms) */
  want: MusicMood;
  wantSince: number;
}

export function initialMood(now: number, mood: MusicMood = 'menu'): MoodState {
  return { mood, since: now, want: mood, wantSince: now };
}

const RANK: Record<MusicMood, number> = { menu: 0, peace: 1, war: 2, battle: 3 };

/** The mood the input asks for right now, given the current mood (battle's hysteresis). */
export function wantedMood(cur: MusicMood, input: MusicInput): MusicMood {
  if (!input.inGame) return 'menu';
  const t = Number.isFinite(input.tension) ? input.tension : 0;
  if (t >= BATTLE_ON || (cur === 'battle' && t >= BATTLE_OFF)) return 'battle';
  if (input.atWar || t >= WAR_ON) return 'war';
  return 'peace';
}

/** One step of the mood machine at time `now` (ms). Pure: returns the same object when nothing changes. */
export function stepMood(s: MoodState, input: MusicInput, now: number): MoodState {
  const want = wantedMood(s.mood, input);
  let st = s;
  if (want !== s.want) st = { ...s, want, wantSince: now };
  if (want === st.mood) return st;
  const held = now - st.wantSince;
  // to and from the title screen at once; up quickly; down slowly, never right after a change
  const menu = want === 'menu' || st.mood === 'menu';
  const up = RANK[want] > RANK[st.mood];
  const ok = menu || (up ? held >= ESCALATE_MS : held >= CALM_MS && now - st.since >= MIN_DWELL_MS);
  return ok ? { mood: want, since: now, want, wantSince: st.wantSince } : st;
}

/** The next track of `pool`: random, never `last` when there are others. */
export function nextTrack(pool: readonly string[], last: string | null, rand: number): string | null {
  if (!pool.length) return null;
  const others = pool.length > 1 && last ? pool.filter((t) => t !== last) : pool;
  const r = Math.min(0.999999, Math.max(0, Number.isFinite(rand) ? rand : 0));
  return others[Math.floor(r * others.length)];
}

// ================================================================================================ player

interface Deck {
  el: HTMLAudioElement;
  node: MediaElementAudioSourceNode | null;
  gain: GainNode;
  track: string | null;
  /** the format being tried; on an error the next one is tried */
  fmt: number;
  failed: boolean;
  /** played once in a gesture (iOS) */
  primed: boolean;
}

/** A 0.05 s silent WAV, to make a deck playable inside a gesture before it has a track. */
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

/** Streams the music of a mood on two crossfading decks into `out`. Every method is safe to call at any time. */
export class MusicPlayer {
  private decks: Deck[] = [];
  private cur = 0;
  private mood: MusicMood | null = null;
  private last = new Map<MusicMood, string>();
  private stopped = true;
  private broken = false;
  /** tracks in a row that failed to load (no files, offline): the music gives up after MAX_FAILS */
  private fails = 0;
  private blocked = false;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private formats: readonly AudioFormat[],
    private rand: () => number = Math.random,
  ) {}

  /** The track playing (tests, the log). */
  get track(): string | null {
    return this.stopped ? null : (this.decks[this.cur]?.track ?? null);
  }

  get playing(): boolean {
    return !this.stopped;
  }

  /** True once the files could not be loaded (the music stays off; effects fall back to the synth by themselves). */
  get unavailable(): boolean {
    return this.broken;
  }

  /** Plays `mood` (crossfades when it changes); null fades the music out. */
  setMood(mood: MusicMood | null): void {
    if (this.broken) return;
    if (mood === null) {
      this.stop();
      return;
    }
    if (mood === this.mood && !this.stopped) return;
    const prevPool = this.mood ? musicTracks(this.mood) : [];
    this.mood = mood;
    // menu and peace share their tracks: keep the one playing
    const playing = this.decks[this.cur]?.track;
    if (!this.stopped && playing && musicTracks(mood).includes(playing) && prevPool.includes(playing)) return;
    this.next();
  }

  /** Fades out and pauses (the decks stay for the next mood). */
  stop(fadeS = 1.5): void {
    this.stopped = true;
    const t = this.ctx.currentTime;
    for (const d of this.decks) this.fade(d, 0, t, fadeS, true);
  }

  /** Pauses at once (the tab is hidden: the context is suspended, so a fade would not run). */
  pauseNow(): void {
    this.stopped = true;
    for (const d of this.decks) {
      try {
        d.gain.gain.cancelScheduledValues(0);
        d.gain.gain.value = 0;
        d.el.pause();
      } catch {
        /* ignore */
      }
    }
  }

  /** Per frame or so: starts the next track when the current one nears its end. */
  tick(): void {
    if (this.stopped || this.broken || this.blocked) return;
    const d = this.decks[this.cur];
    if (!d) return;
    if (d.failed) {
      if (++this.fails >= MAX_FAILS) {
        this.broken = true;
        this.stop(0.1);
        return;
      }
      this.next();
      return;
    }
    const el = d.el;
    const dur = el.duration;
    if (Number.isFinite(dur) && dur > 0 && (el.ended || dur - el.currentTime <= CROSSFADE_S + 0.2)) this.next();
  }

  dispose(): void {
    this.stopped = true;
    for (const d of this.decks) {
      try {
        d.el.pause();
        d.el.removeAttribute('src');
        d.el.load();
        d.node?.disconnect();
        d.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.decks = [];
  }

  private deck(i: number): Deck | null {
    if (this.decks[i]) return this.decks[i];
    try {
      const el = new Audio();
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.out);
      let node: MediaElementAudioSourceNode | null = null;
      try {
        node = this.ctx.createMediaElementSource(el);
        node.connect(gain);
      } catch {
        node = null;
      }
      const d: Deck = { el, node, gain, track: null, fmt: 0, failed: false, primed: false };
      el.addEventListener('error', () => {
        // this format failed: try the other one, else skip the track
        if (d.track && d.fmt + 1 < this.formats.length) {
          d.fmt++;
          d.el.src = audioUrl('music', d.track, this.formats[d.fmt]);
          if (!this.stopped && this.decks[this.cur] === d) this.start(d);
        } else if (d.track) d.failed = true;
      });
      el.addEventListener('playing', () => {
        this.fails = 0;
      });
      this.decks[i] = d;
      return d;
    } catch {
      this.broken = true;
      return null;
    }
  }

  private next(): void {
    const mood = this.mood;
    if (!mood) return;
    const pool = musicTracks(mood);
    const key: MusicMood = mood === 'menu' ? 'peace' : mood;
    const track = nextTrack(pool, this.last.get(key) ?? null, this.rand());
    if (!track) return;
    this.last.set(key, track);
    const t = this.ctx.currentTime;
    const old = this.decks[this.cur];
    const ni = old && !this.stopped ? 1 - this.cur : this.cur;
    if (old && ni !== this.cur) this.fade(old, 0, t, CROSSFADE_S, true);
    const d = this.deck(ni);
    if (!d) return;
    this.cur = ni;
    this.stopped = false;
    d.failed = false;
    if (d.track !== track) {
      d.track = track;
      d.fmt = 0;
      d.el.src = audioUrl('music', track, this.formats[0]);
    } else {
      try {
        d.el.currentTime = 0;
      } catch {
        /* not seekable yet */
      }
    }
    d.gain.gain.cancelScheduledValues(t);
    d.gain.gain.setValueAtTime(d.gain.gain.value, t);
    d.gain.gain.linearRampToValueAtTime(1, t + CROSSFADE_S);
    this.start(d);
  }

  private start(d: Deck): void {
    d.el.play().catch((err: unknown) => {
      // the autoplay policy: wait for the next click (gesture()); anything else is a failed track
      if ((err as { name?: string } | null)?.name === 'NotAllowedError') this.blocked = true;
      else if ((err as { name?: string } | null)?.name !== 'AbortError') d.failed = true;
    });
  }

  /** True while the browser holds the music back until the next click or key. */
  get needsGesture(): boolean {
    return this.blocked && !this.stopped && !this.broken;
  }

  /**
   * Call inside a click or key handler: makes both decks playable (iOS lets an element play later only once it has
   * played in a gesture) and restarts music the autoplay policy held back.
   */
  gesture(): void {
    if (this.broken) return;
    for (let i = 0; i < 2; i++) {
      const d = this.deck(i);
      if (!d || d.track || d.primed) continue;
      d.primed = true;
      try {
        d.el.src = SILENCE;
        d.el.play().then(() => d.el.pause()).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    if (this.blocked) {
      this.blocked = false;
      const d = this.decks[this.cur];
      if (d && d.track && !this.stopped) this.start(d);
    }
  }

  private fade(d: Deck, to: number, t: number, s: number, pauseAfter: boolean): void {
    try {
      const g = d.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(to, t + s);
      if (pauseAfter) {
        const el = d.el;
        const track = d.track;
        setTimeout(() => {
          // still the faded deck (not restarted meanwhile)
          if (d.track === track && d.gain.gain.value < 0.02 && (this.stopped || this.decks[this.cur] !== d)) el.pause();
        }, s * 1000 + 150);
      }
    } catch {
      /* ignore */
    }
  }
}
