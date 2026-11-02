// The setup screen's footer briefing (src/client/setupScreen.ts setupBriefing): the game in plain words, and the rule
// changes. The title screen's "Play again" row shows the same first line. No DOM.
import { describe, expect, it } from 'vitest';
import { applyPreset, cloneSetup, DEFAULT_SETUP } from '../src/sim/setup';
import { setupBriefing } from '../src/client/setupScreen';

describe('setup briefing', () => {
  it('says the map, the opponents, the difficulty and the mode in one sentence', () => {
    const s = cloneSetup(DEFAULT_SETUP);
    s.map = { kind: 'generated', type: 'continents', size: 'medium' };
    s.aiCount = 8;
    s.difficulty = 'normal';
    const b = setupBriefing(s);
    expect(b.main).toBe('Medium continents map. You against 8 AI nations on Normal, free for all.');
    expect(b.rules).toBe('Standard rules');
    expect(b.changes).toBe(0);
  });

  it('lists rule changes (teams are in the sentence, not the list) and words the lobby for every player', () => {
    const s = applyPreset('quickConquest', cloneSetup(DEFAULT_SETUP));
    s.mode = 'teams';
    s.teamCount = 3;
    s.modifiers.noNukes = true;
    const b = setupBriefing(s);
    expect(b.main).toMatch(/^Small continents map\. You against 4 AI nations on \w+, in 3 teams \(you lead team 1\)\.$/);
    expect(b.rules).toBe('Rules: No atom bombs, Fast game');
    expect(b.changes).toBe(2);
    expect(setupBriefing(s, true).main).toMatch(/The players and 4 AI nations .*, in 3 teams\.$/);
  });

  it('names real-world maps and games without AI nations', () => {
    const s = cloneSetup(DEFAULT_SETUP);
    s.map = { kind: 'world', id: 'europe' };
    s.aiCount = 0;
    s.modifiers.compactMap = true;
    expect(setupBriefing(s).main).toBe('Europe map (compact). You alone with the tribes, free for all.');
  });
});
