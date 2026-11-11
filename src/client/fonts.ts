// Local fonts (bundled, no network). Pixel Clean uses DM Sans for all interface text (clean, friendly, tabular
// numbers) and Jersey 15, a pixel face with clear digits, for the display identity only: the logo, the clock and the
// big changing numbers (troops, gold, attack share). Registered through the FontFace API so only the woff2 files we
// use end up in the build (the single-file build inlines them as data URLs). Latin subsets only.
import dm400 from '@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2?url';
import dm500 from '@fontsource/dm-sans/files/dm-sans-latin-500-normal.woff2?url';
import dm600 from '@fontsource/dm-sans/files/dm-sans-latin-600-normal.woff2?url';
import dm700 from '@fontsource/dm-sans/files/dm-sans-latin-700-normal.woff2?url';
import jersey400 from '@fontsource/jersey-15/files/jersey-15-latin-400-normal.woff2?url';

const FACES: [string, string, string][] = [
  ['DM Sans', dm400, '400'],
  ['DM Sans', dm500, '500'],
  ['DM Sans', dm600, '600'],
  ['DM Sans', dm700, '700'],
  ['Jersey 15', jersey400, '400'],
];

/** Registers the fonts; resolves when they are loaded (or failed: the CSS falls back to system fonts). */
export function loadFonts(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const all = FACES.map(([family, url, weight]) => {
    try {
      const f = new FontFace(family, `url(${url}) format('woff2')`, { weight, style: 'normal', display: 'swap' });
      document.fonts.add(f);
      return f.load().then(
        () => undefined,
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  });
  return Promise.all(all).then(() => undefined);
}
