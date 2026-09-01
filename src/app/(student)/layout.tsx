import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { LiveUpdates } from '@/components/layout/live-updates';

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  // A signed-in teacher-only account belongs on its own home, not a
  // sign-in form it cannot use.
  if (!session?.studentId) {
    redirectNonStudent(session);
  }

  return (
    <>
      <LiveUpdates />
      {children}
    </>
  );
}
