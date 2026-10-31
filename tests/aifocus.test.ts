// Benchmark override (aifocus.ts, scripts/batch.ts --specialist): a forced specialisation steers the AI's existing
// pillar decisions and nothing else.
import { describe, expect, it } from 'vitest';
import { aiFocus, FOCUS_PILLARS, FOCUS_SPEC, setAIFocus } from '../src/sim/aifocus';
import { aiBranchPick, aiTechOrder } from '../src/sim/aispending';
import { aiCommittedPillar, aiForkPick } from '../src/sim/variantsAI';
import { groupMembers } from '../src/sim/techtree';
import { makeTestGame } from './helpers';

describe('aifocus', () => {
  it('forces the committed pillar, the fork when asked, and puts the fork early in the research order', () => {
    const s = makeTestGame({ seed: 7 });
    const ai = s.players.find((p) => p.id > 0 && !p.isHuman && p.personality !== 'tribe')!;
    for (const pillar of FOCUS_PILLARS) {
      const spec = FOCUS_SPEC[pillar];
      const before = aiCommittedPillar(s, ai.id);
      setAIFocus(s, ai.id, { pillar });
      expect(aiFocus(s, ai.id)?.pillar).toBe(pillar);
      expect(aiCommittedPillar(s, ai.id)).toBe(spec.arms ?? before);
      // Without --fork the pick is the AI's own (the map's for arsenal forks).
      const own = aiForkPick(s, ai.id, spec.group);
      if (own) expect(aiBranchPick(s, ai.id, ai.personality, spec.group)).toBe(own);
      for (const fork of groupMembers(spec.group)) {
        setAIFocus(s, ai.id, { pillar, fork });
        expect(aiBranchPick(s, ai.id, ai.personality, spec.group)).toBe(fork);
        const order = aiTechOrder(s, ai.id, ai.personality, ['agriculture', 'metallurgy', 'logistics', 'navigation', 'mechanization', 'banking', 'flight', 'fortification', 'ballistics', 'medicine', 'industrialization', 'radar', 'rocketry', 'combinedArms', 'nuclearFission']);
        const at = order.indexOf(fork);
        expect(at, `${pillar} ${fork}`).toBeGreaterThanOrEqual(0);
        expect(at, `${pillar} ${fork}`).toBeLessThan(12); // right after its prerequisites, not after 10 profile techs
        for (const other of groupMembers(spec.group)) if (other !== fork) expect(order).not.toContain(other);
      }
      setAIFocus(s, ai.id, null);
      expect(aiFocus(s, ai.id)).toBeUndefined();
      expect(aiCommittedPillar(s, ai.id)).toBe(before);
    }
  });
});
