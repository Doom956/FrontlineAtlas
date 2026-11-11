// Local fonts (bundled, no network): Source Serif 4 for titles, big numbers and map place names (italic for land
// names), IBM Plex Sans for all body text and labels (tabular numbers). No heavy display weights: the type stays clean. Registered through the FontFace API so
// only the woff2 files we use end up in the build (the single-file build inlines them as data URLs).
import serif400 from '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2?url';
import serif600 from '@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff2?url';
import serif400i from '@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff2?url';
import plex400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url';
import plex500 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2?url';
import plex600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?url';

const FACES: [string, string, string, string?][] = [
  ['Source Serif 4', serif400, '400'],
  ['Source Serif 4', serif600, '600'],
  ['Source Serif 4', serif400i, '400', 'italic'],
  ['IBM Plex Sans', plex400, '400'],
  ['IBM Plex Sans', plex500, '500'],
  ['IBM Plex Sans', plex600, '600'],
];

/** Registers the fonts; resolves when they are loaded (or failed: the CSS falls back to system fonts). */
export function loadFonts(): Promise<void> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const all = FACES.map(([family, url, weight, style]) => {
    try {
      const f = new FontFace(family, `url(${url}) format('woff2')`, { weight, style: style ?? 'normal', display: 'swap' });
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
