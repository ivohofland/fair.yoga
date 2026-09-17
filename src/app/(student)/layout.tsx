import { headers } from 'next/headers';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { LiveUpdates } from '@/components/layout/live-updates';

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  // Non-students belong elsewhere: teachers go to their schedule,
  // unauthenticated visitors go to login with destination preserved.
  if (!session?.studentId) {
    const pathname = (await headers()).get('x-pathname');
    redirectNonStudent(session, pathname);
  }

  return (
    <>
      <LiveUpdates />
      {children}
    </>
  );
}
