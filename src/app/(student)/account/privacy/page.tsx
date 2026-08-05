import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { listPendingInvitations } from '@/services/invitations';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import {
  TeacherPrivacyCard,
  type TeacherPrivacyValues,
} from '@/components/student/teacher-privacy-card';
import { PendingInvitationCard } from '@/components/student/pending-invitation-card';

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

  // Invitations match the authenticated account's own email, not
  // Student.email — they agree by construction for a live linked profile,
  // but the account address is what this person actually proved they own
  // at sign-in. See `listPendingInvitations` (services/invitations.ts) for
  // why it does its own lowercasing on top of this.
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });

  const [links, privacyRows, pendingInvitations] = await Promise.all([
    // Existence, not `isArchived: false` — the same choice
    // `students/[id]/privacy/route.ts` makes for the API that reads and
    // writes these settings, and for the same reason: archiving is the
    // TEACHER's filing action on their own CRM view, and it must not strip
    // a student of control over a link that is still live (the registration
    // route does not check it either — a teacher can still book this
    // student into a class after archiving them). That route's own comment
    // previously predicted this exact gap as future-proofing; #166 Task 11
    // review F3 is what made it load-bearing (see that comment for why).
    prisma.teacherStudent.findMany({
      where: { studentId: session.studentId },
      select: { isArchived: true, teacher: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { teacher: { firstName: 'asc' } },
    }),
    prisma.studentPrivacy.findMany({
      where: { studentId: session.studentId },
    }),
    listPendingInvitations(prisma, { accountEmail: account.email }),
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

      {pendingInvitations.length > 0 && (
        <div className="mb-6">
          <h2 className="type-subtitle mb-3">Pending invitations</h2>
          <div className="flex flex-col gap-4">
            {pendingInvitations.map((invitation) => (
              <PendingInvitationCard
                key={invitation.id}
                invitationId={invitation.id}
                teacherName={`${invitation.teacher.firstName} ${invitation.teacher.lastName}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* h2, matching "Pending invitations" above — the two sections were
          otherwise indistinguishable to a screen reader, since the only
          headings on the page were the card titles underneath (review F8). */}
      <h2 className="type-subtitle mb-3">Your teachers</h2>

      {links.length === 0 ? (
        <EmptyState
          title="No teachers yet."
          // Three ways in, not two. Joining a waitlist creates the link as
          // surely as booking does (`addToWaitlist`, services/waitlist.ts,
          // upserts `TeacherStudent` and calls `resolveInvitationOnLink`) —
          // naming only booking made this an incomplete list stated as a
          // complete one, on the page whose whole job is telling a student
          // how their teacher relationships come to exist. Both branches are
          // asserted in `tests/e2e/invitations.spec.ts`; nothing in the
          // Vitest suite can reach them (async server component, prisma).
          body={
            pendingInvitations.length > 0
              ? 'Accept one of the invitations above, or connect with someone new by booking a class or joining a waitlist.'
              : "Book a class or join a waitlist — teachers appear here once you're connected."
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {links.map(({ teacher, isArchived }) => {
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
                archivedByTeacher={isArchived}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
