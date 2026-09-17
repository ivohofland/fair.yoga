import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { validateSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { isSafeRelativePath } from '@/lib/schemas';
import type { SessionUser, TeacherSession } from '@/lib/types';

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('fair_yoga_session')?.value;
  if (!token) return null;
  return validateSession(prisma, token);
}

export async function requireTeacherSession(): Promise<TeacherSession> {
  const session = await getSession();
  if (!session?.teacherId) {
    const pathname = (await headers()).get('x-pathname');
    if (pathname && isSafeRelativePath(pathname)) {
      redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
    }
    redirect('/login');
  }
  return { ...session, teacherId: session.teacherId };
}
