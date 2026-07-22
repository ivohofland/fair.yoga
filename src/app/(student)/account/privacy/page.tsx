import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import {
  TeacherPrivacyCard,
  type TeacherPrivacyValues,
} from '@/components/student/teacher-privacy-card';

export const dynamic = 'force-dynamic';

const MAX_PRIVACY: TeacherPrivacyValues = {
  shareFullName: false,
  shareEmail: false,
  sharePhone: false,
  shareBirthday: false,
  shareAddress: false,
  receiveComms: true,
};

export default async function PrivacySettingsPage() {
  const session = await getSession();
  if (!session?.studentId) redirect(session?.teacherId ? '/' : '/login');

  const [links, privacyRows] = await Promise.all([
    prisma.teacherStudent.findMany({
      where: { studentId: session.studentId, isArchived: false },
      select: { teacher: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { teacher: { firstName: 'asc' } },
    }),
    prisma.studentPrivacy.findMany({
      where: { studentId: session.studentId },
    }),
  ]);

  const privacyByTeacher = new Map(privacyRows.map((row) => [row.teacherId, row]));

  return (
    <div>
      <Link
        href="/account"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Settings
      </Link>
      <h1 className="type-title mb-2">Privacy</h1>
      <p className="type-caption mb-6 max-w-[420px]">
        Each teacher sees only the details you switch on here — new teachers
        start with nothing shared. Turning announcements off stops that
        teacher&apos;s announcements, in-app and email; essential messages
        about your bookings still come through, and the email switch under
        Notifications is global.
      </p>

      {links.length === 0 ? (
        <EmptyState title="No teachers yet." body="Book a class first — teachers appear here once you're connected." />
      ) : (
        <div className="flex flex-col gap-4">
          {links.map(({ teacher }) => {
            const row = privacyByTeacher.get(teacher.id);
            const initial: TeacherPrivacyValues = row
              ? {
                  shareFullName: row.shareFullName,
                  shareEmail: row.shareEmail,
                  sharePhone: row.sharePhone,
                  shareBirthday: row.shareBirthday,
                  shareAddress: row.shareAddress,
                  receiveComms: row.receiveComms,
                }
              : MAX_PRIVACY;
            return (
              <TeacherPrivacyCard
                key={teacher.id}
                studentId={session.studentId!}
                teacherId={teacher.id}
                teacherName={`${teacher.firstName} ${teacher.lastName}`}
                initial={initial}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
