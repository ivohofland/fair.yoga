import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

/**
 * The public front door (#385). Deliberately plain: the wordmark the
 * `(public)` layout already renders, one sentence, and the two ways in.
 * `implementation-plan.md` 7.10 is the copy-and-design pass and is filed
 * separately — nothing here is meant to be the finished landing page.
 *
 * A signed-in visitor never sees it. `/` used to be the teacher home, and
 * anyone with it bookmarked lands on their own home instead of a pitch.
 */
export default async function LandingPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session?.studentId) redirect('/bookings');

  return (
    <div className="flex-1 flex flex-col justify-center py-10">
      <h1 className="type-display mb-5">
        A calm toolkit for
        <br />
        independent yoga teachers
      </h1>
      <p className="type-body max-w-[420px] mb-8">
        Scheduling, students and income-based pricing for teachers who run
        their own classes &mdash; free, open source, and never a marketplace.
      </p>

      <div className="flex flex-col gap-3">
        <Link
          href="/signup"
          className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover active:bg-teal-pressed rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
        >
          Start teaching
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center justify-center w-full text-center border-[1.5px] border-teal text-teal hover:bg-teal-tint rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
