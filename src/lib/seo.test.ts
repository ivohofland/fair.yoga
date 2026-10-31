import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/lib/log', () => ({ log: { error } }));

import { siteUrl, snippet, NOINDEX } from './seo';

describe('siteUrl', () => {
  beforeEach(() => error.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it('is NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    expect(siteUrl().href).toBe('https://fair.yoga/');
    expect(error).not.toHaveBeenCalled();
  });

  it('falls back to localhost quietly in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(siteUrl().href).toBe('http://localhost:3000/');
    expect(error).not.toHaveBeenCalled();
  });

  // The build never sees the variable, by design (DEPLOYMENT.md).
  it('falls back quietly while `next build` runs', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(siteUrl().href).toBe('http://localhost:3000/');
    expect(error).not.toHaveBeenCalled();
  });

  it('says so when a running production server has no value', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(siteUrl().href).toBe('http://localhost:3000/');
    expect(error).toHaveBeenCalledTimes(1);
  });

  // `fair.yoga` throws in `new URL`; `localhost:3000` parses, as scheme `localhost:`.
  it.each(['fair.yoga', 'localhost:3000', 'not a url'])(
    'falls back, and says so, for %s, which is not an http(s) URL',
    (value) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_APP_URL', value);
      expect(siteUrl().href).toBe('http://localhost:3000/');
      expect(error).toHaveBeenCalledTimes(1);
    },
  );
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
  it('asks search engines not to index the page', () => {
    expect(NOINDEX).toEqual({ robots: { index: false } });
  });
});
