// Small map previews for the setup screen, drawn from real map data: a generated map of each type (a compact small
// one with a fixed seed: the shape of that type, not the exact map you will get) and every real-world map. Made
// lazily one at a time so the menu stays responsive, and kept for the session as data URLs.
import { TERRAIN } from '../sim/config';
import { generateMap } from '../sim/mapgen';
import { makeRng } from '../sim/rng';
import { cloneSetup, DEFAULT_SETUP } from '../sim/setup';
import type { GameSettings, MapData, MapType, TerrainId } from '../sim/types';
import { loadWorldMap } from '../sim/worldmaps';

export type ThumbKey = `gen:${MapType}` | `world:${string}`;

const THUMB_W = 176;
const THUMB_H = 104;
const done = new Map<ThumbKey, string>();
const waiting = new Map<ThumbKey, ((url: string) => void)[]>();
const queue: ThumbKey[] = [];
let busy = false;

/** Draws a map's terrain into a w x h canvas (nearest sample, water a little darker toward the deep). */
export function drawMapThumb(map: MapData, w: number, h: number): HTMLCanvasElement {
  // Keep the map's aspect inside w x h.
  const scale = Math.min(w / map.width, h / map.height);
  const cw = Math.max(1, Math.round(map.width * scale));
  const ch = Math.max(1, Math.round(map.height * scale));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const g = c.getContext('2d');
  if (!g) return c;
  const img = g.createImageData(cw, ch);
  const d = img.data;
  // Sample a 2 x 2 grid per pixel: a pixel is land when any sample is land (small islands stay visible).
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let t = 0;
      for (let k = 0; k < 4 && t < 2; k++) {
        const mx = Math.min(map.width - 1, Math.floor(((x + ((k & 1) + 0.5) / 2) * map.width) / cw));
        const my = Math.min(map.height - 1, Math.floor(((y + ((k >> 1) + 0.5) / 2) * map.height) / ch));
        const v = map.terrain[my * map.width + mx];
        if (v >= 2 || v > t) t = v; // the first land sample wins; else shallow over deep
      }
      const col = TERRAIN[t as TerrainId]?.color ?? [0, 0, 0];
      const o = (y * cw + x) * 4;
      d[o] = col[0];
      d[o + 1] = col[1];
      d[o + 2] = col[2];
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

async function make(key: ThumbKey): Promise<string> {
  let map: MapData;
  if (key.startsWith('gen:')) {
    const type = key.slice(4) as MapType;
    const settings: GameSettings = {
      ...cloneSetup(DEFAULT_SETUP),
      map: { kind: 'generated', type, size: 'small' },
      modifiers: { ...DEFAULT_SETUP.modifiers, compactMap: true },
      seed: 7,
      playerName: '',
      playerColor: [0, 0, 0],
      humanPlayer: false,
    };
    map = generateMap(settings, makeRng(7).rng);
  } else {
    map = await loadWorldMap(key.slice(6));
  }
  return drawMapThumb(map, THUMB_W, THUMB_H).toDataURL();
}

function pump(): void {
  if (busy) return;
  const key = queue.shift();
  if (!key) return;
  busy = true;
  // A short pause between thumbnails keeps the menu and its background game smooth.
  setTimeout(() => {
    make(key)
      .then((url) => {
        done.set(key, url);
        for (const cb of waiting.get(key) ?? []) cb(url);
      })
      .catch((err) => console.warn('Map preview failed', key, err))
      .finally(() => {
        waiting.delete(key);
        busy = false;
        pump();
      });
  }, 16);
}

/** Calls back with the preview's data URL (at once when it is ready, else when made). */
export function requestThumb(key: ThumbKey, cb: (url: string) => void): void {
  const url = done.get(key);
  if (url) {
    cb(url);
    return;
  }
  const list = waiting.get(key);
  if (list) list.push(cb);
  else {
    waiting.set(key, [cb]);
    queue.push(key);
  }
  pump();
}
