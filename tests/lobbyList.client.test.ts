// The public game list (src/client/lobby.ts suggestedLobby): which game's Join is the page's one accent button.
// No DOM.
import { describe, expect, it } from 'vitest';
import type { LobbySummary } from '../src/net/protocol';
import { suggestedLobby } from '../src/client/lobby';

function lobby(code: string, kind: LobbySummary['kind'], players: number, startsAt: number | null, maxPlayers = 10): LobbySummary {
  return { code, kind, mode: kind === 'teams' ? 'teams' : 'ffa', map: { kind: 'generated', type: 'continents', size: 'medium' }, rules: 'Standard rules', chips: [], teamCount: 2, players, maxPlayers, startsAt };
}

describe('suggested public game', () => {
  it('is the one whose countdown runs with the most players', () => {
    const list = [lobby('AAAAAA', 'ffa', 1, 5000), lobby('BBBBBB', 'teams', 3, 9000), lobby('CCCCCC', 'special', 0, null)];
    expect(suggestedLobby(list)).toBe('BBBBBB');
  });

  it('is the first free for all while no countdown runs', () => {
    const list = [lobby('BBBBBB', 'teams', 0, null), lobby('AAAAAA', 'ffa', 0, null), lobby('CCCCCC', 'special', 0, null)];
    expect(suggestedLobby(list)).toBe('AAAAAA');
  });

  it('is never a full game, and none at all when nothing can be joined', () => {
    const full = lobby('AAAAAA', 'ffa', 10, 5000);
    expect(suggestedLobby([full, lobby('CCCCCC', 'special', 2, null)])).toBe('CCCCCC');
    expect(suggestedLobby([full])).toBeNull();
    expect(suggestedLobby([])).toBeNull();
  });
});
