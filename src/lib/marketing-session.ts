import type { SessionUser } from '@/lib/types';

/** Signed in, for a marketing page, means an account holding either profile. */
export function isSignedIn(session: SessionUser | null): boolean {
  return Boolean(session?.teacherId || session?.studentId);
}
