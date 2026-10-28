import { describe, expect, it } from 'vitest';
import { formatFollowName } from './follow-names.js';

describe('formatFollowName', () => {
  it('FULL keeps the name (whitespace normalised)', () => {
    expect(formatFollowName('  Alex   Rivera ', 'FULL')).toBe('Alex Rivera');
  });

  it('FIRST keeps the first word', () => {
    expect(formatFollowName('Alex Rivera', 'FIRST')).toBe('Alex');
    expect(formatFollowName('Cher', 'FIRST')).toBe('Cher');
  });

  it('INITIALS gives "A. R." style, one initial per word', () => {
    expect(formatFollowName('Alex Rivera', 'INITIALS')).toBe('A. R.');
    expect(formatFollowName('alex van der Berg', 'INITIALS')).toBe('A. V. D. B.');
    expect(formatFollowName('Émile Zola', 'INITIALS')).toBe('É. Z.');
  });

  it('returns null for blank / missing names', () => {
    expect(formatFollowName(null, 'FULL')).toBeNull();
    expect(formatFollowName(undefined, 'FIRST')).toBeNull();
    expect(formatFollowName('   ', 'INITIALS')).toBeNull();
  });

  it('falls back to the most private mode for an unknown stored value', () => {
    expect(formatFollowName('Alex Rivera', 'WHATEVER')).toBe('A. R.');
  });
});
