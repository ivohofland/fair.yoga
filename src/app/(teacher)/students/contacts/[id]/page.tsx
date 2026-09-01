import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatStudentName, timeAgo } from '@/lib/format';
import { canRemoveContact, invitationDeliveryStatus } from '@/lib/contacts';
import { PageHeader } from '@/components/layout/page-header';
import { ContactForm, ArchiveContactButton, ResendInvitationButton } from '@/components/students/contact-form';
import { RemoveStudentButton } from '@/components/students/remove-student-button';

const STATUS_LABEL: Record<'pending' | 'declined', string> = {
  pending: 'Invited',
  declined: 'Declined',
};

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  // `findFirst` with `teacherId` in the `where`, matching the ownership
  // preamble in `api/invitations/[id]/route.ts` — the same reasoning applies
  // here: the check belongs in the query, not as a follow-up read.
  const invitation = await prisma.invitation.findFirst({
    where: { id, teacherId: session.teacherId },
    select: {
      id: true, firstName: true, lastName: true, email: true,
      status: true, isArchived: true,
      lastNotifiedAt: true, lastNotifiedEmail: true,
    },
  });

  // 404-shaped, not 403-shaped: same reasoning as the API route this page
  // reads from — an invitation id is never handed to anyone but the teacher
  // who created it, so a redirect gives nothing away.
  if (!invitation || invitation.status === 'accepted') redirect('/students');

  const displayName = formatStudentName(invitation.firstName, invitation.lastName, true);
  const delivery = invitation.status === 'pending' ? invitationDeliveryStatus(invitation) : null;

  return (
    <>
      <PageHeader title={displayName} backHref="/students" backLabel="Students" />

      <div className="mb-6">
        <p className="type-caption">{STATUS_LABEL[invitation.status]}</p>
        {delivery && (
          <p className="type-caption">
            {delivery.sent ? `Last invited ${timeAgo(delivery.at)}` : 'Not yet sent to this address'}
          </p>
        )}
      </div>

      <section className="mb-8">
        <ContactForm
          invitationId={invitation.id}
          initialFirstName={invitation.firstName}
          initialLastName={invitation.lastName}
          initialEmail={invitation.email}
        />
      </section>

      <section className="pt-6 border-t border-border flex flex-col items-start gap-4">
        <ArchiveContactButton invitationId={invitation.id} isArchived={invitation.isArchived} />
        {invitation.status === 'pending' && (
          <ResendInvitationButton invitationId={invitation.id} />
        )}
        {/*
          Absent, not present-and-failing: the PUT/DELETE routes both 409
          DECLINED_IS_PERMANENT on a declined row, but this page shouldn't
          make a teacher discover that by clicking. Archiving stays available
          — that's the declined row's actual escape hatch. `canRemoveContact`
          (lib/contacts.ts) is the decision itself, pulled out and unit-tested
          because this server component is otherwise untestable ground.
        */}
        {canRemoveContact(invitation.status) && (
          <RemoveStudentButton invitationId={invitation.id} studentName={displayName} />
        )}
      </section>
    </>
  );
}
