// UI review fixes (client, no DOM): big numbers in sim messages read in the HUD's compact form, and no visible text
// or tip names a key (the owner rule: tips name the visible control; keys stay in How to play's Controls section).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactNumbers } from '../src/client/render/common';

/** Every client source file, without the owner console and the art lab (not part of the player's UI). */
function clientFiles(dir = join(__dirname, '../src/client')): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== 'artlab') out.push(...clientFiles(p));
    } else if (n.endsWith('.ts') && !/^admin/.test(n)) out.push(p);
  }
  return out;
}

describe('compact numbers in messages', () => {
  it('shortens four digits and more when a word follows, keeps the unit', () => {
    expect(compactNumbers('Watchtower: an enemy transport (20456 troops) of Valdessa is approaching')).toBe('Watchtower: an enemy transport (20k troops) of Valdessa is approaching');
    expect(compactNumbers('Atlas\'s bombers are supporting the attack: 2090 troops killed')).toBe('Atlas\'s bombers are supporting the attack: 2.1k troops killed');
    expect(compactNumbers('Trade with Aldmere earned 274 gold')).toBe('Trade with Aldmere earned 274 gold');
    expect(compactNumbers('Tank division ready (9000 troops)')).toBe('Tank division ready (9.0k troops)');
    expect(compactNumbers('Year 12345')).toBe('Year 12345');
  });
});

describe('no keys named in visible text', () => {
  // a key in brackets, "Esc to cancel" and friends, "Shift+W", right-click as the only way
  const KEY = /\((?:[A-Z?]|Tab|Esc|Space|Shift\+[A-Z])\)|\bEsc (?:to cancel|cancels|clears|or right-click)|Esc: stop|Shift\+[A-Z]\b|Hold Shift|Right-click[: ]/;
  it('string literals outside comments and the How to play Controls table', () => {
    const hits: string[] = [];
    for (const f of clientFiles()) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        // the Controls table of How to play lists the keys on purpose
        if (f.endsWith('howto.ts') && /^\[\[/.test(t)) return;
        const strings = t.match(/'[^']*'|`[^`]*`|"[^"]*"/g) ?? [];
        if (strings.some((s) => KEY.test(s))) hits.push(`${f.split('src/client/')[1]}:${i + 1}: ${t}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
