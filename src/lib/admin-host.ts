import { isSafeRelativePath, REDIRECT_MAX_LENGTH } from '@/lib/safe-path';

/**
 * Where the admin surface lives (#60). Dependency-free (imports only
 * safe-path), so the proxy can read it without the database. docs/technical-architecture.md (Admin surface).
 */
export const ADMIN_ROOT_PATH = '/admin';
export const ADMIN_SIGN_IN_PATH = '/admin/sign-in';

const HOST_SHAPE = /^[a-z0-9.-]+(:[0-9]+)?$/;

/** The host (with port) of `NEXT_PUBLIC_APP_URL`, or null when it does not parse. */
function appUrl(): URL | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');
  } catch {
    return null;
  }
}

/**
 * `ADMIN_HOST`, trimmed and lowercased. Null, which turns the surface off,
 * when it is unset, is not a bare `host` or `host:port`, or names the app's
 * own host (which would send every main-site page to `/admin`).
 */
export function adminHost(): string | null {
  const raw = process.env.ADMIN_HOST?.trim().toLowerCase();
  if (!raw || !HOST_SHAPE.test(raw)) return null;
  if (raw === appUrl()?.host.toLowerCase()) return null;
  return raw;
}

/** True when a request's `Host` header names the admin host. */
export function isAdminHost(host: string | null): boolean {
  const admin = adminHost();
  return admin !== null && host !== null && host.toLowerCase() === admin;
}

/** The admin origin, with the scheme `NEXT_PUBLIC_APP_URL` uses; null when the surface is off or that URL does not parse. */
export function adminOrigin(): string | null {
  const admin = adminHost();
  const app = appUrl();
  if (admin === null || app === null) return null;
  return `${app.protocol}//${admin}`;
}

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_ROOT_PATH || pathname.startsWith(`${ADMIN_ROOT_PATH}/`);
}

/**
 * Where sign-in lands: `raw` when it is a safe path inside the admin tree other
 * than sign-in itself and short enough for the verify schema, else the root.
 * A repeated query parameter arrives as an array; its first value counts.
 */
export function adminReturnPath(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > REDIRECT_MAX_LENGTH || !isSafeRelativePath(value)) return ADMIN_ROOT_PATH;
  const pathname = value.split('?')[0] ?? '';
  if (!isAdminPath(pathname) || pathname === ADMIN_SIGN_IN_PATH) return ADMIN_ROOT_PATH;
  return value;
}
