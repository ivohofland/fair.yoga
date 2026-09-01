import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { StudentCountEditor } from '@/components/studio-class/student-count-editor';
import { CancelStudioClassButton } from '@/components/studio-class/cancel-studio-class-button';
import { DeleteStudioClassButton } from '@/components/studio-class/delete-studio-class-button';
import { RestoreStudioClassButton } from '@/components/studio-class/restore-studio-class-button';
import { studioClassDeletability } from '@/services/studio-class-deletion';
import { studioClassEditability } from '@/services/studio-class-editability';
import { startOfLocalDay } from '@/lib/timezone';
import { formatDateWithYear } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';

export default async function StudioClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  // The template is reached through the entry's rule since #327 — a rule
  // carries at most one template per family, which is why the array below is
  // read at `[0]`.
  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: {
      calendarEntry: {
        include: { scheduleRule: { include: { studioClassTemplates: true } } },
      },
    },
  });

  if (!studioClass || studioClass.calendarEntry.teacherId !== session.teacherId) {
    redirect('/schedule');
  }

  const entry = studioClass.calendarEntry;
  const template = entry.scheduleRule?.studioClassTemplates[0] ?? null;

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
  // The predicate is handed a FRESH LITERAL carrying only the removal facts —
  // never `studioClass` itself, and that is the whole protection. This page's
  // query is legitimately wider than the route's: it renders the template's name
  // and link below, so it fetches the template and cannot use the route's
  // `STUDIO_CLASS_REMOVAL_FACTS_SELECT`. Passing the whole row is what once let
  // a widened predicate read template state HERE while the route's narrower
  // `select` left it undefined — the page offered a Remove button the API
  // answered 409. Two queries of different widths, one two-field literal.
  //
  // Both predicates read exactly those two fields, so they share one object.
  // ANNOTATED, not inferred, and that is load-bearing: excess-property
  // checking applies to a fresh literal passed directly at a call site, and
  // hoisting to a `const` turns it off. The annotation moves the check onto
  // the initialiser, so an extra field here is TS2353 again — which is the
  // check that would have caught this page handing the predicate its whole
  // row in the first place.
  //
  // A speed bump, not a wall, either way: a REQUIRED new field on either
  // signature breaks this call, an OPTIONAL one compiles silently at every
  // call site in the repo (measured). The alarms are the `@ts-expect-error`
  // cases in both predicates' test files. (issue 276 added EDITABLE: not an
  // income record ⇒ the whole schedule may change, cancelled included.)
  const editFacts: Parameters<typeof studioClassEditability>[0] = {
    scheduleRuleId: entry.scheduleRuleId,
    date: entry.date,
  };
  const now = new Date();
  const { deletable } = studioClassDeletability(editFacts, now, session.defaultTimezone);
  const { scheduleEditable } = studioClassEditability(editFacts, now, session.defaultTimezone);

  const endOfToday = startOfLocalDay(new Date(), session.defaultTimezone);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const countsTowardEarnings = entry.cancelledAt === null && entry.date <= endOfToday;
  const earningsAtRisk = countsTowardEarnings
    ? (Number(studioClass.hourlyRate) * entry.durationMinutes) / 60
    : null;

  return (
    <>
      <PageHeader
        title={entry.classType || studioClass.location}
        backHref="/"
        backLabel="Schedule"
      />

      <div className="mb-6">
        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Date</span>
          <p className="text-base text-ink">{formatDateWithYear(entry.date)}</p>
        </div>

        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Time</span>
          <p className="text-base text-ink">{timeToHHmm(entry.startTime)} &middot; {entry.durationMinutes} min</p>
        </div>

        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Location</span>
          <p className="text-base text-ink">{studioClass.location}</p>
        </div>

        <div className="min-h-14 py-2 border-b border-border">
          <span className="type-label">Hourly rate</span>
          <p className="text-base text-ink">&euro;{Number(studioClass.hourlyRate).toFixed(2)}</p>
        </div>

        {template && (
          <div className="min-h-14 py-2 border-b border-border">
            <span className="type-label">Template</span>
            <p>
              <Link href={`/settings/studio-classes/${template.id}`} className="text-teal text-sm">
                {entry.scheduleRule?.classType || template.location}
                <span className="inline-block ml-1.5">&rarr;</span>
              </Link>
            </p>
          </div>
        )}
      </div>

      {entry.cancelledAt ? (
        <>
          <div className="py-8 text-center type-body">
            This class was cancelled.
          </div>

          <section className="mt-8 pt-6 border-t border-border flex flex-col items-start gap-3">
            <RestoreStudioClassButton studioClassId={studioClass.id} />
            {/* D4 (issue 276): the edit link stays on cancelled NON-past rows.
                A cancellation is recoverable and gates nothing — hiding the door
                here while the API still accepts would re-create this issue's own
                defect shape one state over. */}
            {scheduleEditable && (
              <Link
                href={`/studio-class/${studioClass.id}/edit`}
                className="text-teal text-sm no-underline"
              >
                Edit class<span className="inline-block ml-1.5">&rarr;</span>
              </Link>
            )}
            {deletable && (
              <DeleteStudioClassButton
                studioClassId={studioClass.id}
                earningsAtRisk={earningsAtRisk}
              />
            )}
          </section>
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
            {scheduleEditable && (
              <Link
                href={`/studio-class/${studioClass.id}/edit`}
                className="text-teal text-sm no-underline"
              >
                Edit class<span className="inline-block ml-1.5">&rarr;</span>
              </Link>
            )}
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
