import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { LiveUpdates } from '@/components/layout/live-updates';

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || session.userType !== 'student') {
    redirect('/login');
  }

  return (
    <>
      <LiveUpdates />
      {children}
    </>
  );
}
