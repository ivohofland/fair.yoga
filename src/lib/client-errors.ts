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
