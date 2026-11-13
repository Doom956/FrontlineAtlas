// The art lab gate (client only). main.ts imports this first. In an art lab build (VITE_ART_LAB=1, vite.config.ts
// turns it into __ART_LAB__) a page opened at #artlab shows the art lab instead of the game, and the game never
// starts there (the module waits forever, so main.ts never runs its body); any other page plays the game, with the
// lab's picks when the owner pressed "Try my picks in the game". In a normal build __ART_LAB__ is false: this whole
// block and the lab are dropped from the bundle.
import { applyStoredPicks, startArtLab } from './lab';

if (__ART_LAB__) {
  if (typeof location !== 'undefined' && location.hash === '#artlab') {
    startArtLab();
    await new Promise<never>(() => undefined);
  } else applyStoredPicks();
}

export {};
