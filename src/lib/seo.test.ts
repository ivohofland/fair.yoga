import { describe, it, expect, vi, afterEach } from 'vitest';
import { siteUrl, snippet, NOINDEX } from './seo';

describe('siteUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    expect(siteUrl().href).toBe('https://fair.yoga/');
  });

  it('falls back to localhost when unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(siteUrl().href).toBe('http://localhost:3000/');
  });

  it('falls back to localhost when it does not parse, rather than failing every page', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a url');
    expect(siteUrl().href).toBe('http://localhost:3000/');
  });
});

describe('snippet', () => {
  it('returns short text unchanged, whitespace collapsed', () => {
    expect(snippet('  Hatha and\n\nyin   in Utrecht. ')).toBe('Hatha and yin in Utrecht.');
  });

  it('cuts long text at a word boundary within the limit, with an ellipsis', () => {
    const text = 'word '.repeat(60).trim();
    const out = snippet(text, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('word…')).toBe(true);
  });

  it('cuts a single over-long word hard rather than returning nothing', () => {
    const out = snippet('a'.repeat(100), 20);
    expect(out).toBe(`${'a'.repeat(19)}…`);
  });
});

describe('NOINDEX', () => {
  it('asks search engines not to index, in the shape the private-class page already ships', () => {
    expect(NOINDEX).toEqual({ robots: { index: false } });
  });
});
