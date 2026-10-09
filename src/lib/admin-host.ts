import { isSafeRelativePath } from '@/lib/safe-path';

/**
 * Where the admin surface lives (#60). Pure: read by the proxy, which stays
 * off the database. docs/technical-architecture.md (Admin surface).
 */
export const ADMIN_ROOT_PATH = '/admin';
export const ADMIN_SIGN_IN_PATH = '/admin/sign-in';

/** `ADMIN_HOST`, trimmed and lowercased; null when unset or blank, which turns the surface off. */
export function adminHost(): string | null {
  const raw = process.env.ADMIN_HOST?.trim().toLowerCase();
  return raw ? raw : null;
}

/** True when a request's `Host` header names the admin host. */
export function isAdminHost(host: string | null): boolean {
  const admin = adminHost();
  return admin !== null && host !== null && host.toLowerCase() === admin;
}

/** The admin origin, with the scheme `NEXT_PUBLIC_APP_URL` uses; null when the surface is off. */
export function adminOrigin(): string | null {
  const admin = adminHost();
  if (admin === null) return null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${new URL(appUrl).protocol}//${admin}`;
}

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_ROOT_PATH || pathname.startsWith(`${ADMIN_ROOT_PATH}/`);
}

/** Where sign-in lands: `raw` when it is a safe path inside the admin tree other than sign-in itself, else the root. */
export function adminReturnPath(raw: string | undefined): string {
  if (!raw || !isSafeRelativePath(raw)) return ADMIN_ROOT_PATH;
  const pathname = raw.split('?')[0] ?? '';
  if (!isAdminPath(pathname) || pathname === ADMIN_SIGN_IN_PATH) return ADMIN_ROOT_PATH;
  return raw;
}
