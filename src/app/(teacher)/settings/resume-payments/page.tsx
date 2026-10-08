import Link from 'next/link';
import type { Currency } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { SignOutButton } from '@/components/account/sign-out-button';
import { ResumePaymentsForm } from '@/components/settings/resume-payments-form';
import { PAYOUT_CHANGE_PHRASES } from '@/lib/email-templates';
import { formatClassContext, formatDateWithYear, formatMoney, paymentStateInlineText } from '@/lib/format';
import type { BankAccountData } from '@/lib/payment-methods';
import { startOfLocalDay } from '@/lib/timezone';
import { readResumeReview, type ReviewPayment } from '@/services/payout-resume';

export const dynamic = 'force-dynamic';

/** Each detail column an account can hold, as the screen labels it. */
const DETAIL_LABELS = {
  holderName: 'Account holder',
  iban: 'IBAN',
  bic: 'BIC',
  sortCode: 'Sort code',
  accountNumber: 'Account number',
  routingNumber: 'Routing number',
} as const satisfies Record<Exclude<keyof BankAccountData, 'currency'>, string>;

const DETAIL_KEYS = Object.keys(DETAIL_LABELS) as (keyof typeof DETAIL_LABELS)[];

const linkClass =
  'text-teal underline decoration-[0.5px] underline-offset-[3px] rounded-field focus:outline-none focus-visible:shadow-focus';

/** `20 Jul 2026, 14:05` in the teacher's own zone. */
function when(instant: Date, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  return `${formatDateWithYear(startOfLocalDay(instant, timeZone))}, ${time}`;
}

function PaymentRow({ payment, timeZone }: { payment: ReviewPayment; timeZone: string }) {
  const state = paymentStateInlineText(payment.status);
  const settledAt = payment.paidAt ?? payment.notChargedAt;
  return (
    <li className="py-3 border-b border-border last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="type-body">{payment.studentName}</span>
        <span className="type-number">{formatMoney(payment.amount, payment.currency)}</span>
      </div>
      <p className="type-caption">
        {formatClassContext(payment.classType, payment.classDate, payment.startTime)}
        <span className={state.className}>{state.label}</span>
        {settledAt !== null && <> · {when(settledAt, timeZone)}</>}
      </p>
    </li>
  );
}

function AccountDetails({ account }: { account: BankAccountData }) {
  return (
    <div className="bg-sand-soft border border-border rounded-card p-5">
      <h3 className="type-label mb-2">{account.currency} account</h3>
      <dl className="flex flex-col gap-2">
        {DETAIL_KEYS.flatMap((key) => {
          const value = account[key];
          if (value === null) return [];
          return [
            <div key={key}>
              <dt className="type-caption">{DETAIL_LABELS[key]}</dt>
              <dd className="type-body break-all">{value}</dd>
            </div>,
          ];
        })}
      </dl>
    </div>
  );
}

function currencyNote(currency: Currency | null): string {
  return currency === null ? '' : ` (${currency})`;
}

/**
 * Where a teacher whose payments are paused checks what changed and resumes
 * (`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`, "4 ·
 * Resuming"). The payout details are shown in full: the page is the signed-in
 * teacher's own.
 */
export default async function ResumePaymentsPage() {
  const session = await requireTeacherSession();
  const timeZone = session.defaultTimezone;
  const [review, passkeys] = await Promise.all([
    readResumeReview(prisma, session.teacherId, session.sessionId),
    prisma.passkeyCredential.count({ where: { accountId: session.accountId } }),
  ]);

  if (review === null) {
    return (
      <div>
        <PageHeader title="Resume payments" backHref="/schedule" backLabel="Schedule" />
        <p className="type-body">
          Payments aren&rsquo;t paused. <Link href="/schedule" className={linkClass}>Back to your schedule</Link>
        </p>
      </div>
    );
  }

  const blocked = review.passkeyRequired && !review.sessionSatisfiesPasskey;
  const { details } = review;

  return (
    <div>
      <PageHeader title="Resume payments" backHref="/schedule" backLabel="Schedule" />

      <p className="type-body mb-8">
        You paused payments on {when(review.pausedAt, timeZone)}. Check what changed and the details below, then
        resume. Students with an outstanding payment will be told they can pay.
      </p>

      <section className="mb-8">
        <h2 className="type-subtitle mb-1">Changes to your payment details</h2>
        {review.events.length === 0 ? (
          <p className="type-body">No changes recorded since {when(review.windowStart, timeZone)}.</p>
        ) : (
          <ul>
            {review.events.map((e) => (
              <li key={e.id} className="py-3 border-b border-border last:border-b-0">
                <p className="type-body">
                  {PAYOUT_CHANGE_PHRASES[e.kind]}
                  {currencyNote(e.accountCurrency)}
                </p>
                <p className="type-caption">
                  {e.before ?? '—'} → {e.after ?? '—'} · {when(e.createdAt, timeZone)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="type-subtitle mb-1">Unpaid from before the pause</h2>
        <p className="type-caption mb-2">
          These students may have paid to details you didn&rsquo;t set. Check your bank before marking any as paid.
        </p>
        {review.outstanding.length === 0 ? (
          <p className="type-body">None.</p>
        ) : (
          <ul>
            {review.outstanding.map((p) => <PaymentRow key={p.id} payment={p} timeZone={timeZone} />)}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="type-subtitle mb-1">Marked paid or not charged before the pause</h2>
        <p className="type-caption mb-2">Since {when(review.windowStart, timeZone)}. Check you made these yourself.</p>
        {review.settled.length === 0 ? (
          <p className="type-body">None.</p>
        ) : (
          <ul>
            {review.settled.map((p) => <PaymentRow key={p.id} payment={p} timeZone={timeZone} />)}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <h2 className="type-subtitle mb-3">Your payment details now</h2>
        <div className="flex flex-col gap-3">
          {details.bankAccounts.map((account) => <AccountDetails key={account.currency} account={account} />)}
          <div className="bg-sand-soft border border-border rounded-card p-5">
            <h3 className="type-label mb-2">Payment link</h3>
            <p className="type-body break-all">{details.paymentLink ?? 'None'}</p>
          </div>
        </div>
        {details.bankAccounts.length === 0 && <p className="type-body mt-3">No bank accounts.</p>}
        <p className="type-caption mt-3">
          Not right? <Link href="/settings/profile" className={linkClass}>Change your payment details</Link> first.
        </p>
      </section>

      {blocked ? (
        <section className="flex flex-col gap-3">
          <h2 className="type-subtitle">Sign in with your passkey to resume</h2>
          <p className="type-body">
            Your account had a passkey before these changes, so resuming needs it: sign out, then sign in again with
            your passkey.
            {review.fallbackOpensAt !== null && (
              <> If you no longer have it, you can resume without it from {when(review.fallbackOpensAt, timeZone)}.</>
            )}
          </p>
          <SignOutButton accountId={session.accountId} />
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          {passkeys === 0 && (
            <p className="type-body">
              After resuming, <Link href="/settings/profile" className={linkClass}>add a passkey</Link>. It makes a
              future pause harder for anyone else to lift.
            </p>
          )}
          <ResumePaymentsForm teacherId={session.teacherId} fingerprint={review.fingerprint} />
        </section>
      )}
    </div>
  );
}
