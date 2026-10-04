import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enqueueAttendance, getOutbox, resetOutboxForTests } from './attendance-outbox';
import { clearOfflinePages, OFFLINE_PAGES_CACHE, registerOfflineWorker, warmOfflinePages } from './offline-client';

describe('the cache name', () => {
  it('is the one public/sw.js declares', () => {
    const worker = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
    expect(worker).toContain(`const PAGES = '${OFFLINE_PAGES_CACHE}';`);
  });
});

describe('the worker client', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  describe('clearOfflinePages', () => {
    it('posts clear to the active worker and deletes the cache', async () => {
      const postMessage = vi.fn();
      const getRegistration = vi.fn(async () => ({ active: { postMessage } }));
      const deleteCache = vi.fn(async () => true);
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration } });
      vi.stubGlobal('caches', { delete: deleteCache });
      await clearOfflinePages();
      expect(getRegistration).toHaveBeenCalledWith('/');
      expect(postMessage).toHaveBeenCalledWith({ type: 'clear' });
      expect(deleteCache).toHaveBeenCalledWith(OFFLINE_PAGES_CACHE);
    });

    it('leaves a queued attendance entry alone', async () => {
      resetOutboxForTests();
      await enqueueAttendance({
        ownerId: 'owner-1',
        registrationId: 'reg-1',
        classId: 'class-1',
        studentName: 'Student',
        status: 'attended',
      });
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('caches', { delete: vi.fn(async () => true) });
      await clearOfflinePages();
      expect(Object.keys(getOutbox().pending)).toEqual(['reg-1']);
      resetOutboxForTests();
    });

    it('resolves when neither serviceWorker nor caches exists', async () => {
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('caches', undefined);
      await expect(clearOfflinePages()).resolves.toBeUndefined();
    });

    it('still deletes the cache, and logs, when getRegistration rejects', async () => {
      const deleteCache = vi.fn(async () => true);
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn(async () => { throw new Error('denied'); }) } });
      vi.stubGlobal('caches', { delete: deleteCache });
      await expect(clearOfflinePages()).resolves.toBeUndefined();
      expect(deleteCache).toHaveBeenCalledWith(OFFLINE_PAGES_CACHE);
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe('warmOfflinePages', () => {
    it('posts the paths to the active worker once ready', async () => {
      const postMessage = vi.fn();
      vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ active: { postMessage } }) } });
      await warmOfflinePages(['/schedule', '/class/a']);
      expect(postMessage).toHaveBeenCalledWith({ type: 'warm', paths: ['/schedule', '/class/a'] });
    });

    it('resolves after 10 s when ready never settles', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('navigator', { serviceWorker: { ready: new Promise(() => {}) } });
      let settled = false;
      const done = warmOfflinePages(['/schedule']).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(settled).toBe(true);
    });

    it('resolves, and logs, when ready rejects', async () => {
      vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.reject(new Error('boom')) } });
      await expect(warmOfflinePages(['/schedule'])).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe('registerOfflineWorker', () => {
    it('registers /sw.js at the root scope', async () => {
      const register = vi.fn(async () => ({}));
      vi.stubGlobal('navigator', { serviceWorker: { register } });
      await registerOfflineWorker();
      expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });

    it('swallows and logs a rejection', async () => {
      const register = vi.fn(async () => { throw new Error('insecure context'); });
      vi.stubGlobal('navigator', { serviceWorker: { register } });
      await expect(registerOfflineWorker()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    });

    it('does nothing where service workers are unsupported', async () => {
      vi.stubGlobal('navigator', {});
      await expect(registerOfflineWorker()).resolves.toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
    });
  });
});
