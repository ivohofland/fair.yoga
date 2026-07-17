import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || session.userType !== 'student') {
    redirect('/login');
  }

  return <>{children}</>;
}
