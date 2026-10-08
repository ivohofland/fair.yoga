import Link from 'next/link';

/** On the schedule while the teacher's payments are paused: the way to the resume screen. */
export function PaymentsPausedCard() {
  return (
    <section className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle mb-1">Payments are paused</h2>
      <p className="type-body mb-3">
        Your students are being asked to hold off paying until you&rsquo;ve checked your payment details.
      </p>
      <Link
        href="/settings/resume-payments"
        className="inline-flex items-center min-h-11 type-label text-teal hover:text-teal-hover no-underline rounded-field focus:outline-none focus-visible:shadow-focus"
      >
        Check and resume
      </Link>
    </section>
  );
}
