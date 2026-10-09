import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { ADMIN_SIGN_IN_PATH } from '@/lib/admin-host';
import { resolveAdminAccess, type AdminProof } from '@/lib/admin-access';

/**
 * `resolveAdminAccess` for a page or route handler: `notFound()` and
 * `redirect()` for its refusals. Cached per request, so a layout and its page
 * share one answer. Every admin page calls it itself — a layout's redirect
 * does not stop its page from rendering.
 */
export const requireAdminSession = cache(async (): Promise<AdminProof> => {
  const headerList = await headers();
  const access = await resolveAdminAccess(prisma, {
    host: headerList.get('host'),
    sessionToken: (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null,
  });
  if (access.kind === 'not_found') notFound();
  if (access.kind === 'sign_in') {
    const destination = headerList.get('x-pathname');
    redirect(destination ? `${ADMIN_SIGN_IN_PATH}?redirect=${encodeURIComponent(destination)}` : ADMIN_SIGN_IN_PATH);
  }
  return access.proof;
});
