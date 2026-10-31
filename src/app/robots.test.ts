import { describe, it, expect, vi, afterEach } from 'vitest';
import robots from './robots';

describe('robots.txt', () => {
  afterEach(() => vi.unstubAllEnvs());

  // The file is public: a Disallow line would advertise the path it names.
  // Pages that must stay out of search carry noindex themselves.
  it('allows everything, names no path, and points at the sitemap', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    expect(robots()).toEqual({
      rules: { userAgent: '*', allow: '/' },
      sitemap: 'https://fair.yoga/sitemap.xml',
    });
  });
});
