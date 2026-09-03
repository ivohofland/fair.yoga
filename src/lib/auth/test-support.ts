import type { BrowserNonce } from './origin-nonce';

/** Casts a plain test string to the branded nonce type. Test-only — never
 *  import this outside a *.test.ts file. */
export function asBrowserNonce(raw: string): BrowserNonce {
  return raw as BrowserNonce;
}
