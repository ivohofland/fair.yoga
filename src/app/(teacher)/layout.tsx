import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || session.userType !== 'teacher') {
    redirect('/login');
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-6">
      {children}
    </div>
  );
}
