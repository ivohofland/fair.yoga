import { CSP_REPORT_PATH } from './csp-report';

/**
 * The Content-Security-Policy strings: one page policy built per request
 * around a nonce, and static ones for API and service-worker responses
 * (served from src/proxy.ts and next.config.ts).
 *
 * `style-src` keeps 'unsafe-inline' for the app's `style={}` attributes;
 * style injection is not script execution. Development adds 'unsafe-eval'
 * and websockets for Fast Refresh.
 *
 * Violations are reported to `CSP_REPORT_PATH` by `report-uri`, not
 * `report-to` (`docs/technical-architecture.md`, Content Security Policy).
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
    // Without worker-src, workers fall back to script-src, where
    // 'strict-dynamic' disables 'self' and /sw.js would be refused.
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');
}

/** A JSON body is not a document: if a browser renders one, nothing in it loads or runs. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Same-origin only: the worker's own fetches. */
export const SERVICE_WORKER_CSP = "default-src 'self'";
