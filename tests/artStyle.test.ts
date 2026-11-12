// The art switch (client/art/): style and motion picks per category, the copied picks line, the registry, every style
// module covering every category, and the three style folders staying apart.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPicks, ART_CATEGORIES, ART_STYLES, artStyleOf, CATEGORY_LABEL, defaultMotionPicks, defaultStylePicks, MOTION_CATEGORIES, MOTION_PRESETS, motionCategoryOf, motionPresetFor, parseMotionPicks, parseStylePicks, picksLine, setArtStyle, setMotionPreset } from '../src/client/art/artStyle';
import { motionParams } from '../src/client/art/motion';
import { artFor, motionFor, styleModule } from '../src/client/art/registry';
import { refined } from '../src/client/art/refined';
import { SPRITE_KEYS, spriteKey, unitCategoryOf, unitTypeOf, variantOf } from '../src/client/art/shared/keys';
import { BLAST_KINDS } from '../src/client/art/types';

afterEach(() => {
  setArtStyle('all', 'refined');
  setMotionPreset('all', 'lively');
});

describe('art switch', () => {
  it('starts with the refined style and lively motion everywhere', () => {
    for (const c of ART_CATEGORIES) expect(artStyleOf(c)).toBe('refined');
    for (const c of ART_CATEGORIES) expect(motionPresetFor(c)).toBe('lively');
  });

  it('reads one style, a list of pairs, or the copied picks line, and ignores unknown words', () => {
    expect(parseStylePicks('realistic')).toEqual(defaultStylePicks('realistic'));
    const p = parseStylePicks('ships: realistic, land:detailed, nonsense: refined, air: shiny');
    expect(p.ships).toBe('realistic');
    expect(p.land).toBe('detailed');
    expect(p.air).toBe('refined');
    expect(parseStylePicks('')).toEqual(defaultStylePicks());
    expect(parseMotionPicks('cinematic')).toEqual(defaultMotionPicks('cinematic'));
    const styles = { ...defaultStylePicks(), ships: 'realistic', wakes: 'detailed', troopIcons: 'detailed' } as const;
    const motions = { ...defaultMotionPicks(), ships: 'subtle', explosions: 'cinematic' } as const;
    const line = picksLine(styles, motions);
    expect(line).toContain('ships: realistic (subtle motion)');
    expect(line).toContain('wakes: detailed (subtle motion)');
    expect(line).toContain('troopIcons: detailed,');
    expect(line).not.toMatch(/troopIcons: detailed \(/);
    expect(parseStylePicks(line)).toEqual(styles);
    expect(parseMotionPicks(line)).toEqual(motions);
  });

  it('has a paradrop category that moves with the planes and round-trips through the picks line', () => {
    expect(ART_CATEGORIES).toContain('paradrop');
    expect(CATEGORY_LABEL.paradrop).toBe('Paratroopers');
    expect(motionCategoryOf('paradrop')).toBe('air');
    expect(parseStylePicks('paradrop: realistic').paradrop).toBe('realistic');
    const styles = { ...defaultStylePicks(), paradrop: 'detailed', air: 'realistic' } as const;
    const motions = { ...defaultMotionPicks(), air: 'cinematic' } as const;
    const line = picksLine(styles, motions);
    expect(line).toContain('paradrop: detailed (cinematic motion)');
    expect(parseStylePicks(line)).toEqual(styles);
    expect(parseMotionPicks(line)).toEqual(motions);
    // alone, a paradrop entry sets the planes' motion; next to an air entry the air entry wins
    expect(parseMotionPicks('paradrop: refined (subtle motion)').air).toBe('subtle');
    expect(parseMotionPicks('paradrop: refined (subtle motion), air: refined (cinematic motion)').air).toBe('cinematic');
    setArtStyle('paradrop', 'realistic');
    expect(artFor('paradrop')).toBe(styleModule('realistic').paradrop);
    expect(motionPresetFor('paradrop')).toBe('lively');
    setMotionPreset('air', 'subtle');
    expect(motionPresetFor('paradrop')).toBe('subtle');
  });

  it('draws the refined paratroopers in the owner colour, over at the end of the drop', () => {
    const strokes: string[] = [];
    const ctx = new Proxy({ globalAlpha: 1, strokeStyle: '', stroke: () => strokes.push(String(ctx.strokeStyle)) } as Record<string, unknown>, {
      get: (o, k) => (k in o ? o[k as string] : () => undefined),
      set: (o, k, v) => ((o[k as string] = v), true),
    }) as unknown as CanvasRenderingContext2D;
    const m = motionParams('lively', false);
    const dur = refined.paradrop.durationMs(m);
    const d = { x: 50, y: 50, owner: [64, 160, 255] as [number, number, number], ageMs: dur / 2, durMs: dur, t: 0.5, count: 6, zoom: 14, scale: 2, seed: 0.3, dpr: 1 };
    refined.paradrop.draw(ctx, d, m);
    expect(strokes).toContain('rgb(64,160,255)');
    expect(ctx.globalAlpha).toBe(1);
    strokes.length = 0;
    refined.paradrop.draw(ctx, { ...d, ageMs: dur, t: 1 }, m);
    expect(strokes).toEqual([]);
    refined.paradrop.drawMark(ctx, { x: 10, y: 10, half: 12, owner: [226, 74, 60], zoom: 6, dpr: 1 }, m);
    expect(strokes).toContain('rgb(226,74,60)');
  });

  it('switches what draws a category at run time', () => {
    setArtStyle('ships', 'realistic');
    expect(artFor('ships')).toBe(styleModule('realistic').ships);
    expect(artStyleOf('land')).toBe('refined');
    setMotionPreset('explosions', 'cinematic');
    expect(motionFor('explosions').preset).toBe('cinematic');
    expect(motionFor('craters').preset).toBe('lively');
    applyPicks({ land: 'detailed' }, { land: 'subtle' });
    expect(artStyleOf('land')).toBe('detailed');
    expect(motionFor('land').preset).toBe('subtle');
  });

  it('keeps the lively preset at the defaults and orders the presets from calm to big', () => {
    const [s, l, c] = MOTION_PRESETS.map((p) => motionParams(p, false));
    for (const k of ['wakeLength', 'foamLife', 'wakeSpread', 'contrailLife', 'missileTrailLife', 'blastTime', 'smokeLinger', 'craterLife', 'flashSize', 'flashTime', 'shellArc', 'muzzleSmoke', 'debris', 'shockwave'] as const) {
      expect(l[k], k).toBe(1);
      expect(s[k], k).toBeLessThan(1);
      expect(c[k], k).toBeGreaterThan(1);
    }
    expect(s.bankMax).toBeLessThan(l.bankMax);
    expect(c.bankMax).toBeGreaterThan(l.bankMax);
    expect(motionParams('lively', true).reduced).toBe(true);
    for (const st of ART_STYLES) for (const k of BLAST_KINDS) expect(styleModule(st).explosions.durationMs(k, s)).toBeLessThan(styleModule(st).explosions.durationMs(k, c));
  });

  it('gives every style every category, and the stubs draw the refined art for now', () => {
    for (const st of ART_STYLES) {
      const m = styleModule(st);
      expect(m.id).toBe(st);
      for (const c of ART_CATEGORIES) expect(m[c], `${st} ${c}`).toBeTruthy();
      for (const key of SPRITE_KEYS) expect(m[unitCategoryOf(key)].lengthPx(key, 0, 1), `${st} ${key}`).toBeGreaterThan(4);
      expect(typeof m.wakes.createLayer().frame).toBe('function');
      expect(m.paradrop.durationMs(motionParams('lively', false)), `${st} paradrop`).toBeGreaterThan(0);
      expect(m.paradrop.reachPx(6), `${st} paradrop`).toBeGreaterThan(0);
      expect(typeof m.paradrop.draw).toBe('function');
      expect(typeof m.paradrop.drawMark).toBe('function');
    }
    expect(styleModule('detailed').paradrop).toBe(refined.paradrop);
    expect(styleModule('detailed').ships).toBe(refined.ships);
    expect(styleModule('realistic').explosions).toBe(refined.explosions);
    expect(MOTION_CATEGORIES.length).toBe(7);
  });

  it('maps every unit type and variant to a sprite key and back', () => {
    for (const key of SPRITE_KEYS) expect(spriteKey(unitTypeOf(key), variantOf(key))).toBe(key);
    expect(unitCategoryOf('carrier')).toBe('ships');
    expect(unitCategoryOf('heavyTank')).toBe('land');
    expect(unitCategoryOf('reconPlane')).toBe('air');
    expect(unitCategoryOf('atomBomb')).toBe('missiles');
  });

  it('keeps the three style folders apart (only the stubs may reach the refined style)', () => {
    const root = join(__dirname, '../src/client/art');
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    for (const style of ART_STYLES) {
      for (const file of walk(join(root, style))) {
        const src = readFileSync(file, 'utf8');
        const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        for (const other of ART_STYLES) {
          if (other === style) continue;
          const hits = imports.filter((p) => p.includes(`/${other}`) || p === `../${other}`);
          const allowed = other === 'refined' && file.endsWith(join(style, 'index.ts')) && hits.every((p) => p === '../refined');
          if (!allowed) expect(hits, `${file} imports ${other}`).toEqual([]);
        }
      }
    }
    // the shared helpers belong to no style
    for (const file of walk(join(root, 'shared'))) expect(readFileSync(file, 'utf8')).not.toMatch(/from '\.\.\/(refined|detailed|realistic)/);
  });
});
