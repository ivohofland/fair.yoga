import { describe, it, expect } from 'vitest';
import { DEGRADATION_CODES } from './degradation-codes';

const PERSONAL_DATA_KEY = /name|email|phone|address|birth|note|message|text/i;

describe('DEGRADATION_CODES', () => {
  const entries = Object.entries(DEGRADATION_CODES);

  it.each(entries)('%s has a description and a level', (_code, entry) => {
    expect(entry.description.length).toBeGreaterThan(20);
    expect(['warn', 'error']).toContain(entry.level);
  });

  it.each(entries)('%s lists each context key once', (_code, entry) => {
    expect(new Set(entry.contextKeys).size).toBe(entry.contextKeys.length);
  });

  it.each(entries)('%s allowlists no key that could carry personal data', (_code, entry) => {
    for (const key of entry.contextKeys) {
      expect(key, `context key "${key}"`).not.toMatch(PERSONAL_DATA_KEY);
    }
  });
});
