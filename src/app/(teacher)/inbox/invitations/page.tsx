import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { listPendingInvitations } from '@/services/invitations';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { SetUpStudentSide } from '@/components/account/set-up-student-side';
import { STUDENT_INVITATION_PATH } from '@/lib/notification-links';

export const dynamic = 'force-dynamic';

export default async function TeacherInvitationsPage() {
  const session = await requireTeacherSession();
  // With a student side, invitations are answered on the student page — an
  // account holding both profiles, or one that added its student side after
  // the notification that led here.
  if (session.studentId) redirect(STUDENT_INVITATION_PATH);

  // Read on every load, not taken from the notification: since it was sent
  // the contact may have been removed or the invitation answered.
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });
  const invitations = await listPendingInvitations(prisma, { accountEmail: account.email });

  return (
    <div>
      <PageHeader title="Invitations" backHref="/inbox" backLabel="Inbox" />
      {invitations.length === 0 ? (
        <EmptyState
          title="No open invitations"
          body="An invitation you were sent is no longer waiting for an answer."
          action={<Link href="/inbox" className="type-label text-teal no-underline">Back to Inbox</Link>}
        />
      ) : (
        <section className="bg-sand-soft border border-border rounded-card p-5 max-w-[420px]">
          <ul className="flex flex-col gap-2 mb-4">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="type-body text-ink">
                {`${invitation.teacher.firstName} ${invitation.teacher.lastName} would like to connect with you as a student.`}
              </li>
            ))}
          </ul>
          <p className="type-body mb-4">
            Connecting adds a student side to your account, on the same sign-in. You choose whether
            to connect, and what each teacher can see.
          </p>
          <SetUpStudentSide />
        </section>
      )}
    </div>
  );
}
