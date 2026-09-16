/**
 * Extracts the server's error message from a failed API response.
 * API errors arrive as `{ error: string }` or `{ error: { message } }`;
 * anything unparseable falls back to the caller's generic copy — the
 * user should see *why* it failed whenever the server said so.
 */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const json = (await res.json()) as { error?: { message?: string } | string };
    const message = typeof json.error === 'string' ? json.error : json.error?.message;
    return message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Both halves of a failed response in one read: the server's `code`
 * discriminator and the message to show. A body can be read only once, so a
 * caller that must branch on the code AND display the message gets them
 * together rather than calling two helpers.
 *
 * `code` is `undefined` when the server did not name the case —
 * `classifyApiError` omits it for anything it did not classify deliberately,
 * including a unique-constraint violation that escaped a route's own catch.
 * A caller treating one outcome as success must therefore compare against the
 * code, never the status: two responses can share a status and mean opposite
 * things.
 */
export async function readError(
  res: Response,
  fallback: string,
): Promise<{ code?: string; message: string }> {
  try {
    const json = (await res.json()) as { error?: { code?: string; message?: string } | string };
    if (typeof json.error === 'string') return { message: json.error || fallback };
    return { code: json.error?.code, message: json.error?.message ?? fallback };
  } catch {
    return { message: fallback };
  }
}
