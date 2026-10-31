import { describe, expect, it } from 'vitest';
import { matchesQuery } from '../src/client/howto';

describe('how to play search', () => {
  it('matches every word, ignoring case', () => {
    expect(matchesQuery('Fort: attackers lose double', 'FORT')).toBe(true);
    expect(matchesQuery('Fort: attackers lose double', 'fort double')).toBe(true);
    expect(matchesQuery('Fort: attackers lose double', 'fort tank')).toBe(false);
  });
  it('an empty query matches everything', () => {
    expect(matchesQuery('anything', '   ')).toBe(true);
  });
});
