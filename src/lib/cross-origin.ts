import type { NextRequest } from 'next/server';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Why a write was refused as cross-origin. */
export type CrossOriginReason =
  | 'sec-fetch-cross-site'
  | 'origin-null'
  | 'origin-unparseable'
  | 'host-missing'
  | 'host-mismatch';

export interface CrossOriginRefusal {
  reason: CrossOriginReason;
  /** The `Origin` header's host and port; null when it has none to read. Never the whole header. */
  originHost: string | null;
  /** The request's own `Host` header, as received. */
  host: string | null;
}

/** The host and port of an `Origin` header value; null for `null`, an absent or an unparseable one. */
function hostOf(origin: string | null): string | null {
  if (origin === null || origin === 'null') return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Why a state-changing request came from another origin, or null when it did
 * not. A browser sends `Origin` or `Sec-Fetch-Site` on every cross-site write;
 * a request with neither is not from a browser page (curl, a server-side
 * client) and passes.
 *
 * Compared against the request's own `Host`, host and port only — behind a
 * TLS-terminating proxy the scheme the app sees is not the one the browser
 * used, and a proxy that drops a non-default port from `Host` makes every
 * write read as cross-origin (DEPLOYMENT.md).
 */
export function crossOriginRefusal(request: NextRequest): CrossOriginRefusal | null {
  if (!MUTATING.has(request.method)) return null;
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const originHost = hostOf(origin);
  const refuse = (reason: CrossOriginReason): CrossOriginRefusal => ({ reason, originHost, host });

  if (request.headers.get('sec-fetch-site') === 'cross-site') return refuse('sec-fetch-cross-site');
  if (origin === null) return null;
  if (origin === 'null') return refuse('origin-null');
  if (host === null) return refuse('host-missing');
  if (originHost === null) return refuse('origin-unparseable');
  return originHost === host.toLowerCase() ? null : refuse('host-mismatch');
}
