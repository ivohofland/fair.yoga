/**
 * The Content-Security-Policy strings. `buildPageCsp` is served by
 * `src/proxy.ts`, with a nonce minted per request; Next reads the nonce back
 * off the request's own CSP header and stamps it on its inline scripts.
 * `API_CSP` and `SERVICE_WORKER_CSP` are static and served by `next.config.ts`.
 *
 * `style-src` keeps 'unsafe-inline' for the app's `style={}` attributes;
 * style injection is not script execution. Development adds 'unsafe-eval'
 * and websockets for Fast Refresh.
 */
export function buildPageCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // data: for the inline EPC payment QR codes
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws:' : ''}`,
    // The service worker registers from a bundled script, which
    // 'strict-dynamic' trusts; worker-src names the worker's own origin.
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** A JSON body is not a document: if a browser renders one, nothing in it loads or runs. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** The service worker only fetches same-origin URLs (public/sw.js). */
export const SERVICE_WORKER_CSP = "default-src 'self'";
