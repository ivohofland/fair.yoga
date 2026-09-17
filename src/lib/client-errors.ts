import { isApiErrorCode, type ApiErrorCode } from './api-error-codes';

/**
 * Both halves of a failed response in one read: the server's `code` and the
 * message to show. A body can be read only once, so a caller that must branch
 * on the code AND display the message gets them together.
 *
 * `code` is `undefined` when the server named no case or named one the
 * registry does not know — a caller treating one outcome as success compares
 * against the code, never the status, because two responses can share a
 * status and mean opposite things.
 *
 * A body that is not JSON — a proxy's HTML error page, a truncated response —
 * answers the caller's fallback, and is logged with its status and URL first:
 * otherwise nothing, client or server, records which failure the user saw.
 */
export async function readError(
  res: Response,
  fallback: string,
): Promise<{ code?: ApiErrorCode; message: string }> {
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    console.error('API error response body could not be read', {
      status: res.status,
      url: res.url,
      err,
    });
    return { message: fallback };
  }

  const error = typeof json === 'object' && json !== null ? (json as { error?: unknown }).error : undefined;
  if (typeof error === 'string') return { message: error || fallback };
  if (typeof error !== 'object' || error === null) return { message: fallback };

  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: isApiErrorCode(code) ? code : undefined,
    message: typeof message === 'string' && message !== '' ? message : fallback,
  };
}

/** The message half of `readError`, for a caller that branches on nothing. */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  return (await readError(res, fallback)).message;
}
