import { redirect } from 'next/navigation';
import { isSafeRelativePath } from '@/lib/schemas';
import type { SessionUser } from '@/lib/types';

/**
 * Where a session without a student profile belongs. A signed-in teacher
 * goes to their own home rather than a sign-in form they cannot use.
 * Preserves the intended destination when sending an unauthenticated visitor to login.
 */
export function redirectNonStudent(
  session: SessionUser | null,
  redirectPath?: string | null,
): never {
  if (session?.teacherId) {
    redirect('/schedule');
  } else if (redirectPath && isSafeRelativePath(redirectPath)) {
    redirect(`/login?redirect=${encodeURIComponent(redirectPath)}`);
  } else {
    redirect('/login');
  }
}
