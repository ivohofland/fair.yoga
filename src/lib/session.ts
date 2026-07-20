import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { validateSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/types';

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('fair_yoga_session')?.value;
  if (!token) return null;
  return validateSession(prisma, token);
}

export async function requireTeacherSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.teacherId) {
    redirect('/login');
  }
  return session;
}
