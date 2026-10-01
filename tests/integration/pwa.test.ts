import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';

describe('GET /manifest.webmanifest', () => {
  it('serves the install manifest', async () => {
    const res = await fetch(`${BASE_URL}/manifest.webmanifest`, { headers: freshIp() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    const body: unknown = await res.json();
    expect(body).toMatchObject({ start_url: '/start', display: 'standalone', theme_color: '#F7F4EF' });
  });
});

describe('the document head', () => {
  it('links the manifest and carries the theme colour', async () => {
    const res = await fetch(`${BASE_URL}/login`, { headers: freshIp() });
    const html = await res.text();
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toMatch(/<meta name="theme-color" content="#F7F4EF"/);
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="fair.yoga"/);
  });
});
