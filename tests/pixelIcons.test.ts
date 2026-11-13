// Pixel HUD icons (src/client/hud/pixelIcons.ts) on the research and arsenal cards: the 12 px price and state marks
// are hand-made pixel art (no canvas needed), and the prices are built from them, never from the old line icons.
import { describe, expect, it } from 'vitest';
import { pixelIcon } from '../src/client/hud/pixelIcons';
import { priceHtml } from '../src/client/hud/arsenalPage';
import type { ArsenalCard } from '../src/client/hud/procure';

/** The set cells of a pixel icon's SVG: every "M x y h w" run, as "x,y" keys. */
function cells(svg: string): Set<string> {
  const out = new Set<string>();
  for (const m of svg.matchAll(/M(\d+) (\d+)h(\d+)/g)) for (let k = 0; k < Number(m[3]); k++) out.add(`${Number(m[1]) + k},${m[2]}`);
  return out;
}

describe('pixel icons: research and arsenal card marks', () => {
  it('the coin, clock, check and cross are 12 x 12 pixel pictures, one cell per CSS pixel', () => {
    for (const name of ['gold', 'clock', 'accept', 'close', 'iron', 'oil']) {
      const svg = pixelIcon(name, 12);
      expect(svg, name).toMatch(/^<svg class="pi" viewBox="0 0 12 12" width="12" height="12" shape-rendering="crispEdges"/);
      expect(svg, name).not.toContain('class="li"');
      const c = cells(svg);
      expect(c.size, name).toBeGreaterThan(12);
      for (const k of c) {
        const [x, y] = k.split(',').map(Number);
        expect(x >= 0 && x < 12 && y >= 0 && y < 12, `${name} ${k}`).toBe(true);
      }
    }
  });

  it('the coin is a full disc with a shaded groove inside its rim; the cross is mirror-symmetric', () => {
    const coin = pixelIcon('gold', 12);
    expect(coin).toContain('opacity=".5"');
    const c = cells(coin);
    // a solid disc: every cell within the rim is set (full or shaded), nothing outside it
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++) expect(c.has(`${x},${y}`), `${x},${y}`).toBe(Math.hypot(x + 0.5 - 6, y + 0.5 - 6) <= 5.3);
    // the shaded tone is its own path (opacity .5): a ring of cells between the rim and the face
    const shaded = cells(/<path d="([^"]+)"[^>]*opacity=".5"/.exec(coin)?.[1] ?? '');
    expect(shaded.size).toBeGreaterThan(8);
    expect(shaded.has('6,6')).toBe(false);
    const x = cells(pixelIcon('close', 12));
    for (const k of x) {
      const [cx, cy] = k.split(',').map(Number);
      expect(x.has(`${11 - cx},${cy}`), k).toBe(true);
    }
  });

  it('arsenal prices show pixel icons next to each resource, the short one marked', () => {
    const card = { price: { gold: 1500, iron: 80, oil: 40, seconds: 30 }, short: { gold: false, iron: true, oil: false } } as unknown as ArsenalCard;
    const html = priceHtml(card);
    expect(html.match(/<svg class="pi"/g)?.length).toBe(3);
    expect(html).not.toContain('class="li"');
    expect(html).toContain('rp-p p-iron short');
    expect(html).toContain('30 s');
  });
});
