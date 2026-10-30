// Local fonts (bundled, no network): Barlow Condensed for labels, headings and the logo, IBM Plex Sans for values
// and text (tabular numbers). No heavy display weights: the type stays clean. Registered through the FontFace API so
// only the woff2 files we use end up in the build (the single-file build inlines them as data URLs).
import barlow500 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-500-normal.woff2?url';
import barlow600 from '@fontsource/barlow-condensed/files/barlow-condensed-latin-600-normal.woff2?url';
import plex400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url';
import plex500 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2?url';
import plex600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?url';

const FACES: [string, string, string][] = [
  ['Barlow Condensed', barlow500, '500'],
  ['Barlow Condensed', barlow600, '600'],
  ['IBM Plex Sans', plex400, '400'],
  ['IBM Plex Sans', plex500, '500'],
  ['IBM Plex Sans', plex600, '600'],
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
