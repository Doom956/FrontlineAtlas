// The recorded effects, decoded into Web Audio buffers (client only). Loading starts after the first click or key (the
// AudioContext needs it anyway), in the background, a few files at a time, most used first; the game never waits for
// it. A file that fails in the browser's best format is tried in the other one (Ogg Opus / AAC); one that fails in
// both stays missing, and its sound keeps the synthesized version.

import { audioUrl, SFX, type AudioFormat, type SampleKey } from './library';

/** Files loading at once. */
const PARALLEL = 3;

/** Load order: what plays most and first (UI, combat), then notices, then the big and long ones. */
const ORDER: readonly SampleKey[] = [
  'uiClick', 'uiError', 'buildPlaced', 'shot', 'explosion', 'tankShot', 'bombard', 'countdown', 'tankDestroyed', 'unitLost',
  'missileLaunch', 'planeCrash', 'sonarPing', 'explosionBig', 'cityTaken', 'cityLost', 'capitalLost', 'capitalTaken',
  'allianceRequest', 'allianceBroken', 'allianceExpired', 'tradeCoin', 'shipHorn', 'frontGunfire', 'atomBomb', 'victory', 'defeat',
];

export type Fetcher = (url: string) => Promise<ArrayBuffer>;

function defaultFetch(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.arrayBuffer();
  });
}

/** decodeAudioData in its promise form, or the callback form of older Safari. */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

export interface BankStats {
  /** files decoded */
  loaded: number;
  /** files that failed in every format */
  failed: number;
  /** bytes fetched */
  bytes: number;
  /** files asked for */
  total: number;
}

export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();
  private started = false;
  private queue: string[] = [];
  readonly stats: BankStats = { loaded: 0, failed: 0, bytes: 0, total: 0 };
  /** called after each file (tests, the debug log) */
  onLoad: ((id: string, ok: boolean, fmt: AudioFormat | null) => void) | null = null;

  constructor(
    private ctx: BaseAudioContext,
    private formats: readonly AudioFormat[],
    private fetcher: Fetcher = defaultFetch,
  ) {}

  /** The decoded file, or null while it loads or when it failed. */
  get(id: string): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  /** Starts loading every effect file in the background (once). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const seen = new Set<string>();
    const keys = [...ORDER, ...(Object.keys(SFX) as SampleKey[])];
    for (const k of keys) for (const f of SFX[k]?.files ?? []) if (!seen.has(f)) {
      seen.add(f);
      this.queue.push(f);
    }
    this.stats.total = this.queue.length;
    for (let i = 0; i < PARALLEL; i++) void this.pump();
  }

  private async pump(): Promise<void> {
    for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
      let ok = false;
      let used: AudioFormat | null = null;
      for (const fmt of this.formats) {
        try {
          const data = await this.fetcher(audioUrl('sfx', id, fmt));
          this.stats.bytes += data.byteLength;
          const buf = await decode(this.ctx, data);
          this.buffers.set(id, buf);
          ok = true;
          used = fmt;
          break;
        } catch {
          /* try the other format */
        }
      }
      if (ok) this.stats.loaded++;
      else this.stats.failed++;
      // no audio files at all (a single-file copy of the page, offline): stop asking, the synth plays
      if (!this.stats.loaded && this.stats.failed >= 3) this.queue.length = 0;
      try {
        this.onLoad?.(id, ok, used);
      } catch {
        /* ignore */
      }
    }
  }
}
