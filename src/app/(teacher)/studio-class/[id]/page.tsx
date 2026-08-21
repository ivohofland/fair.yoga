import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { StudentCountEditor } from '@/components/studio-class/student-count-editor';
import { CancelStudioClassButton } from '@/components/studio-class/cancel-studio-class-button';
import { DeleteStudioClassButton } from '@/components/studio-class/delete-studio-class-button';
import { studioClassDeletability } from '@/services/studio-class-deletion';
import { startOfLocalDay } from '@/lib/timezone';
import { formatDateWithYear } from '@/lib/format';

export default async function StudioClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: { template: true },
  });

  if (!studioClass || studioClass.teacherId !== session.teacherId) {
    redirect('/');
  }

  // TWO PREDICATES, ON PURPOSE. They overlap almost everywhere and disagree in
  // the two places that matter, so neither may be derived from the other:
  //
  //   REMOVABLE      — can the hourly sweep undo this removal
  //                    (`studio-class-deletion.ts`, start-instant based)
  //   COUNTS         — is this row inside reporting's window
  //                    (`settings/reporting/page.tsx:36`, calendar-date based)
  //
  // A future-dated MANUAL class is removable and counts nothing. A class dated
  // TODAY whose start has passed is removable and counts. Collapsing these into
  // one flag gets both of those wrong, which is what
  // `tests/integration/studio-class-page.test.ts` pins.
  const { deletable } = studioClassDeletability(
    studioClass,
    new Date(),
    session.defaultTimezone,
  );

  const endOfToday = startOfLocalDay(new Date(), session.defaultTimezone);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const countsTowardEarnings =
    studioClass.cancelledAt === null && studioClass.date <= endOfToday;
  const earningsAtRisk = countsTowardEarnings
    ? (Number(studioClass.hourlyRate) * studioClass.durationMinutes) / 60
    : null;

  return (
    <>
      <PageHeader title={studioClass.location} backHref="/" backLabel="Schedule" />

      <div className="mb-6">
        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Date</span>
          <p className="text-base text-ink">{formatDateWithYear(studioClass.date)}</p>
        </div>

        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Time</span>
          <p className="text-base text-ink">{studioClass.startTime} &middot; {studioClass.durationMinutes} min</p>
        </div>

        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Hourly rate</span>
          <p className="text-base text-ink">&euro;{Number(studioClass.hourlyRate).toFixed(2)}</p>
        </div>

        {studioClass.template && (
          <div className="min-h-14 py-2 border-b border-border">
            <span className="type-label">Template</span>
            <p>
              <Link href={`/settings/studio-classes/${studioClass.template.id}`} className="text-teal text-sm">
                {studioClass.template.location}
                <span className="inline-block ml-1.5">&rarr;</span>
              </Link>
            </p>
          </div>
        )}
      </div>

      {studioClass.cancelledAt ? (
        <>
          <div className="py-8 text-center type-body">
            This class was cancelled.
          </div>

          {deletable && (
            <section className="mt-2 pt-6 border-t border-border">
              <DeleteStudioClassButton
                studioClassId={studioClass.id}
                earningsAtRisk={earningsAtRisk}
              />
            </section>
          )}
        </>
      ) : (
        <>
          <section>
            <StudentCountEditor
              studioClassId={studioClass.id}
              initialCount={studioClass.studentCount}
            />
          </section>

          <section className="mt-8 pt-6 border-t border-border flex flex-col items-start gap-3">
            <CancelStudioClassButton studioClassId={studioClass.id} />
            {deletable && (
              <DeleteStudioClassButton
                studioClassId={studioClass.id}
                earningsAtRisk={earningsAtRisk}
              />
            )}
          </section>
        </>
      )}
    </>
  );
}
