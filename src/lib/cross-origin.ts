import type { NextRequest } from 'next/server';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * True when a state-changing request came from another site. A browser sends
 * `Origin` or `Sec-Fetch-Site` on every cross-site write; a request with
 * neither is not from a browser page (curl, the integration suite) and passes.
 *
 * Compared against the request's own `Host`, host and port only: nginx
 * forwards `Host` unchanged and terminates TLS, so the scheme the app sees
 * is not the one the browser used.
 */
export function isCrossOrigin(request: NextRequest): boolean {
  if (!MUTATING.has(request.method)) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return true;

  const origin = request.headers.get('origin');
  if (origin === null) return false;
  const host = request.headers.get('host');
  if (origin === 'null' || host === null) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  return originHost !== host.toLowerCase();
}
