/**
 * What a browser drops from a URL before resolving it, so every guard decides
 * on the string the browser will actually use — not the one it was handed.
 */
export const URL_STRIPPED_CHARS = /[\t\r\n]/g;

/**
 * Rejects protocol-relative URLs (`//evil.com`), their backslash variants
 * (`/\evil.com` — browsers normalize `\` to `/` before resolving), and
 * WHATWG control-whitespace stripping (`/\t/evil.com`).
 */
export function isSafeRelativePath(path: string): boolean {
  const stripped = path.replace(URL_STRIPPED_CHARS, '');
  return stripped.startsWith('/') && !stripped.startsWith('//') && !stripped.includes('\\');
}

/** The longest redirect target the sign-in schemas accept. */
export const REDIRECT_MAX_LENGTH = 200;
