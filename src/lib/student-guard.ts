import { redirect } from 'next/navigation';
import type { SessionUser } from '@/lib/types';

/**
 * Where a session without a student profile belongs. A signed-in teacher
 * goes to their own home rather than a sign-in form they cannot use.
 */
export function redirectNonStudent(session: SessionUser | null): never {
  redirect(session?.teacherId ? '/schedule' : '/login');
}
