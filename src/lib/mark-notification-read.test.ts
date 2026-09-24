import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMarkRead } from './mark-notification-read';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('postMarkRead (#670)', () => {
  it('POSTs to the read route and answers marked on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(postMarkRead('n-1')).resolves.toBe('marked');
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n-1/read', { method: 'POST' });
  });

  it('answers unauthorized on 401 and only on 401', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(postMarkRead('n-1')).resolves.toBe('unauthorized');
    for (const status of [403, 404, 500]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
      await expect(postMarkRead('n-1')).resolves.toBe('failed');
    }
  });

  it('answers failed, and does not reject, when fetch rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(postMarkRead('n-1')).resolves.toBe('failed');
  });

  describe('logging', () => {
    it('logs the id and status once on a refusal', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      await postMarkRead('n-1');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('[mark-read] refused', { id: 'n-1', status: 500 });
    });

    it('logs the id and the error once when fetch rejects', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = new TypeError('Failed to fetch');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

      await postMarkRead('n-1');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('[mark-read] request failed', { id: 'n-1', err });
    });

    it('logs nothing on success', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

      await postMarkRead('n-1');

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs nothing on a 401, the ordinary expired-session path', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      await postMarkRead('n-1');

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
