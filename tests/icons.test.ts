// Icon library data checks (no DOM): every id has info and valid path data; building categories as specified.
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS, ICON_DATA, ICON_IDS, ICON_INFO, renderIcon, type IconId } from '../src/client/icons';

const BUILDINGS: Record<string, IconId[]> = {
  economy: ['city', 'farm', 'market', 'mine', 'oilWell', 'lab'],
  production: ['barracks', 'factory', 'arsenal'],
  defence: ['fort', 'watchtower', 'sam'],
  logistics: ['supplyDepot', 'port', 'hospital'],
  advanced: ['airfield', 'silo'],
};
const GROUPS: Record<string, IconId[]> = {
  resource: ['iron', 'oil', 'fertile'],
  terrain: ['plains', 'forest', 'hills', 'mountains', 'desert', 'swamp', 'tundra'],
  unit: ['transport', 'warship', 'tradeShip', 'bomber', 'fighter', 'rocket', 'atomBomb', 'transportPlane'],
  status: ['crown', 'handshake', 'envelope', 'brokenShield', 'target', 'skull'],
  troop: ['infantry', 'armor', 'artillery'],
};

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Checks SVG path syntax (absolute commands) and that points stay near the 64 x 64 icon box. */
function checkPath(d: string): string | null {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  if (tokens.join('').length === 0 || !/^M/.test(tokens[0] ?? '')) return 'must start with M';
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (!(cmd in ARGS)) return `unknown command ${cmd}`;
    const k = ARGS[cmd];
    if (k === 0) continue;
    let groups = 0;
    while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
      const nums = tokens.slice(i, i + k).map(Number);
      if (nums.length < k || nums.some((v) => !Number.isFinite(v))) return `bad args for ${cmd}`;
      const pts = cmd === 'A' ? [nums[5], nums[6]] : cmd === 'H' || cmd === 'V' ? [] : nums;
      if (pts.some((v) => v < -4 || v > 68)) return `point out of box in ${cmd}`;
      i += k;
      groups++;
    }
    if (groups === 0) return `missing args for ${cmd}`;
  }
  return null;
}

describe('icons', () => {
  it('has the 44 listed ids, each with info and path data', () => {
    expect(ICON_IDS.length).toBe(44);
    for (const id of ICON_IDS) {
      expect(ICON_INFO[id].label.length).toBeGreaterThan(0);
      const layers = ICON_DATA[id];
      expect(layers?.length, id).toBeGreaterThan(0);
      expect(layers.some((l) => !l.detail), id).toBe(true);
      for (const l of layers) {
        expect(checkPath(l.d), `${id}: ${l.d.slice(0, 40)}`).toBeNull();
        expect(l.fill || l.stroke, id).toBeTruthy();
        for (const c of [l.fill, l.stroke]) if (c) expect(c, id).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    expect(Object.keys(ICON_DATA).sort()).toEqual([...ICON_IDS].sort());
  });

  it('puts buildings in the listed categories and other icons in their groups', () => {
    const buildings = ICON_IDS.filter((id) => ICON_INFO[id].group === 'building');
    expect(buildings.length).toBe(17);
    for (const [cat, ids] of Object.entries(BUILDINGS)) {
      expect(buildings.filter((id) => ICON_INFO[id].category === cat).sort()).toEqual([...ids].sort());
      expect(CATEGORY_COLORS[cat as keyof typeof CATEGORY_COLORS]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    for (const [group, ids] of Object.entries(GROUPS)) {
      expect(ICON_IDS.filter((id) => ICON_INFO[id].group === group).sort()).toEqual([...ids].sort());
      for (const id of ids) expect(ICON_INFO[id].category).toBeUndefined();
    }
  });

  it('gives every unit a tinted body layer', () => {
    for (const id of GROUPS.unit) expect(ICON_DATA[id].some((l) => l.tint), id).toBe(true);
  });

  it('renders every icon on a mock context at 16 and 48 px, skipping detail when small', () => {
    const g = globalThis as unknown as { Path2D?: unknown };
    const had = g.Path2D;
    g.Path2D = class {
      constructor(public d: string) {}
    };
    try {
      for (const size of [16, 48]) {
        for (const id of ICON_IDS) {
          const drawn: string[] = [];
          const ctx = {
            save() {}, restore() {}, translate() {}, scale() {}, clip() {},
            fill(p: { d: string }) { drawn.push(p.d); },
            stroke(p: { d: string }) { drawn.push(p.d); },
          } as unknown as CanvasRenderingContext2D;
          renderIcon(ctx, id, size, { tint: [200, 40, 40], outline: true });
          for (const l of ICON_DATA[id]) {
            expect(drawn.includes(l.d), `${id} ${size}`).toBe(size >= 22 || !l.detail);
          }
        }
      }
    } finally {
      g.Path2D = had;
    }
  });
});
