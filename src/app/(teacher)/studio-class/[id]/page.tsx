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
  // the places that matter, so neither may be derived from the other. Both are
  // phrased so that TRUE means what the name says:
  //
  //   REMOVABLE — the hourly sweep cannot undo this removal
  //               (`studio-class-deletion.ts`; manual, or dated before today)
  //   COUNTS    — this row is inside reporting's window: uncancelled AND on or
  //               before today, both conjuncts (the `studioClass.findMany` in
  //               `settings/reporting/page.tsx`)
  //
  // A future-dated MANUAL class is REMOVABLE and counts nothing. A cancelled
  // past class is removable and counts NOTHING either — the `cancelledAt`
  // conjunct is the one this branch's whole correction turns on. A generated
  // class dated today counts and is NOT removable. Collapsing these into one
  // flag gets each of those wrong, which is what
  // `tests/integration/studio-class-page.test.ts` pins.
  //
  // The predicate is handed a fresh literal carrying only the removal facts —
  // never `studioClass` itself. This page fetches the template alongside the
  // row, and passing the whole row is what let a widened predicate read
  // template state HERE while the route's narrower `select` left it undefined:
  // the page offered a Remove button the API answered 409. One projection,
  // `STUDIO_CLASS_REMOVAL_FACTS_SELECT`, now defines what either may see.
  const { deletable } = studioClassDeletability(
    { templateId: studioClass.templateId, date: studioClass.date },
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

          {/*
            KNOWN-OPEN: each button owns its own `confirming` state, so a
            teacher who clicks "Cancel class" and then "Remove this class" gets
            two destructive confirm blocks stacked in this column. Cosmetic, and
            it reads badly at 640px. Coordinating them needs a client wrapper
            holding one "which confirm is open" state, which is more structure
            than issue 279 should introduce and would ship without coverage.
            Raised in PR #295's review and recorded here rather than filed, so
            the next person to touch this section meets it.
          */}
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
