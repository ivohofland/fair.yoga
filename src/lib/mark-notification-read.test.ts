import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMarkRead } from './mark-notification-read';

afterEach(() => { vi.unstubAllGlobals(); });

describe('postMarkRead (#670)', () => {
  it('POSTs to the read route and answers marked on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(postMarkRead('n-1')).resolves.toBe('marked');
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n-1/read', { method: 'POST' });
  });

  it('answers session-expired on 401 and only on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(postMarkRead('n-1')).resolves.toBe('session-expired');
    for (const status of [403, 404, 500]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
      await expect(postMarkRead('n-1')).resolves.toBe('failed');
    }
  });

  it('answers failed, and does not reject, when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(postMarkRead('n-1')).resolves.toBe('failed');
  });
});
