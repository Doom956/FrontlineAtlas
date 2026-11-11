// Pixel Ops fonts (bundled, no network): Silkscreen is the pixel display face for the logo, titles, big numbers and
// map place-names (used only at fixed sizes so the pixels stay crisp); Space Grotesk is the clean sans for body,
// labels, buttons and all dynamic text (tabular numbers on). Registered through the FontFace API so only the woff2
// files we use end up in the build (the single-file build inlines them as data URLs).
import silk400 from '@fontsource/silkscreen/files/silkscreen-latin-400-normal.woff2?url';
import silk700 from '@fontsource/silkscreen/files/silkscreen-latin-700-normal.woff2?url';
import grotesk400 from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2?url';
import grotesk500 from '@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2?url';
import grotesk600 from '@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff2?url';

const FACES: [string, string, string][] = [
  ['Silkscreen', silk400, '400'],
  ['Silkscreen', silk700, '700'],
  ['Space Grotesk', grotesk400, '400'],
  ['Space Grotesk', grotesk500, '500'],
  ['Space Grotesk', grotesk600, '600'],
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
