import { describe, it, expect, vi, afterEach } from 'vitest';
import sitemap from './sitemap';

describe('sitemap.xml', () => {
  afterEach(() => vi.unstubAllEnvs());

  // Platform pages only: a teacher's page is found when they share it, never
  // because fair.yoga listed it.
  it('lists the platform pages and no teacher page', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    expect(sitemap().map((entry) => entry.url)).toEqual(['https://fair.yoga/']);
  });
});
