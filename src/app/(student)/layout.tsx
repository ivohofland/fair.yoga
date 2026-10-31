import type { Metadata } from 'next';
import { NOINDEX } from '@/lib/seo';
import { headers } from 'next/headers';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { LiveUpdates } from '@/components/layout/live-updates';
import { ContentColumn } from '@/components/layout/content-column';

export const metadata: Metadata = NOINDEX;

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
    <ContentColumn>
      <LiveUpdates />
      {children}
    </ContentColumn>
  );
}
