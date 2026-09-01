import { describe, it, expect } from 'vitest';
import { slugFromName } from './page-address-field';

describe('slugFromName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugFromName('Anna', 'de Vries')).toBe('anna-devries');
  });

  it('strips punctuation', () => {
    expect(slugFromName('Siobhán', "O'Malley")).toBe('siobhan-omalley');
  });

  // CLAUDE.md commits to international from day one. A name that derives
  // to nothing must leave the field empty for the teacher to fill — never
  // block, never emit a placeholder.
  it('returns empty for a name with no Latin characters', () => {
    expect(slugFromName('小林', '綾')).toBe('');
  });
});
