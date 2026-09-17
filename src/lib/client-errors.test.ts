import { describe, it, expect, vi, afterEach } from 'vitest';
import { readError, readErrorMessage } from './client-errors';
import type { ApiErrorCode } from './api-error-codes';
import type { Assert, Equals } from './type-pins';

type _codeIsRegistered = Assert<
  Equals<Awaited<ReturnType<typeof readError>>['code'], ApiErrorCode | undefined>
>;
void 0 as unknown as [_codeIsRegistered];

function jsonResponse(body: unknown, status = 409): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withUrl(res: Response, url: string): Response {
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readError', () => {
  it('passes a registered code and the server message through', async () => {
    const res = jsonResponse({ error: { code: 'NOT_FOUND', message: 'This class no longer exists.' } }, 404);
    expect(await readError(res, 'fallback')).toEqual({
      code: 'NOT_FOUND',
      message: 'This class no longer exists.',
    });
  });

  it('drops a code the registry does not know', async () => {
    const res = jsonResponse({ error: { code: 'RETIRED_CODE', message: 'Server words.' } });
    expect(await readError(res, 'fallback')).toEqual({ code: undefined, message: 'Server words.' });
  });

  it('reads a string-shaped error body', async () => {
    const res = jsonResponse({ error: 'Plain words.' });
    expect(await readError(res, 'fallback')).toEqual({ message: 'Plain words.' });
  });

  it('falls back when the body has no usable message', async () => {
    expect(await readError(jsonResponse({ error: { code: 'NOT_FOUND' } }, 404), 'fallback')).toEqual({
      code: 'NOT_FOUND',
      message: 'fallback',
    });
    expect(await readError(jsonResponse({ error: '' }), 'fallback')).toEqual({ message: 'fallback' });
    expect(await readError(jsonResponse(null), 'fallback')).toEqual({ message: 'fallback' });
  });

  it('treats an empty server message as absent', async () => {
    expect(await readError(jsonResponse({ error: { message: '' } }), 'fallback')).toEqual({
      code: undefined,
      message: 'fallback',
    });
    expect(
      await readError(jsonResponse({ error: { code: 'NOT_FOUND', message: '' } }, 404), 'fallback'),
    ).toEqual({ code: 'NOT_FOUND', message: 'fallback' });
  });

  it('logs an unreadable body with its status and URL, then falls back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = withUrl(new Response('<html>502 Bad Gateway</html>', { status: 502 }), 'https://fair.yoga/api/rooms/r1');

    expect(await readError(res, 'fallback')).toEqual({ message: 'fallback' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 502, url: 'https://fair.yoga/api/rooms/r1' }),
    );
  });

  it('does not log a readable body', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await readError(jsonResponse({ error: { message: 'Words.' } }), 'fallback');
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('readErrorMessage', () => {
  it('returns the server message', async () => {
    const res = jsonResponse({ error: { code: 'NOT_FOUND', message: 'Gone.' } }, 404);
    expect(await readErrorMessage(res, 'fallback')).toBe('Gone.');
  });

  it('returns a string-shaped error', async () => {
    expect(await readErrorMessage(jsonResponse({ error: 'Plain.' }), 'fallback')).toBe('Plain.');
  });

  it('falls back on a body with no message', async () => {
    expect(await readErrorMessage(jsonResponse({}), 'fallback')).toBe('fallback');
  });

  it('falls back on an empty server message', async () => {
    expect(await readErrorMessage(jsonResponse({ error: { message: '' } }), 'fallback')).toBe(
      'fallback',
    );
  });

  it('logs an unreadable body and falls back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = withUrl(new Response('not json', { status: 500 }), 'https://fair.yoga/api/x');
    expect(await readErrorMessage(res, 'fallback')).toBe('fallback');
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 500, url: 'https://fair.yoga/api/x' }),
    );
  });
});
