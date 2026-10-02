/**
 * The operator's digest (#157): emails the degradation events that are new, or
 * that have fired again since the operator was last told. Runs inside the
 * `daily-cleanup` job; the mechanism is `docs/technical-architecture.md`
 * (Cron Jobs → Degradation events).
 *
 * CLAIM BEFORE SEND, the shape `email-fallback.ts` and `payment-reminders.ts`
 * use against a manual `/api/cron/daily-cleanup` overlapping a scheduled tick:
 * each row is claimed with a conditional `updateMany` keyed on the
 * `lastSeenAt` this run read, and a claim count other than 1 means another run
 * or a newer event got there first.
 *
 * The claim stamps `lastNotifiedAt` with the `lastSeenAt` it read, never with
 * the clock. An event landing after the stamp leaves `lastSeenAt` ahead of it,
 * so that row is due again next run instead of being swallowed.
 *
 * A failed send puts every claim back and throws, which flips the job unhealthy
 * on the verdict `/api/health` already publishes.
 */

import type { PrismaClient } from '@prisma/client';
import { DEGRADATION_CODES } from '@/lib/degradation-codes';
import { sendHtmlEmail } from '@/lib/email';
import { renderDegradationDigestEmail, type DegradationDigestEntry } from '@/lib/email-templates';
import { log } from '@/lib/log';

export interface DegradationDigestSummary {
  /** Events included in the email this run sent. */
  readonly emailed: number;
}

/** The digest could not reach the operator. The job reports unhealthy until it can. */
export class DegradationDigestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DegradationDigestError';
  }
}

const UNREGISTERED_DESCRIPTION = 'This code is no longer registered; see the code history in git.';

function describeCode(code: string): string {
  return code in DEGRADATION_CODES
    ? DEGRADATION_CODES[code as keyof typeof DEGRADATION_CODES].description
    : UNREGISTERED_DESCRIPTION;
}

export async function notifyOperatorOfDegradations(
  db: PrismaClient,
  operatorEmail: string | undefined = process.env.OPERATOR_EMAIL,
): Promise<DegradationDigestSummary> {
  const rows = await db.degradationEvent.findMany();
  const due = rows.filter((r) => r.lastNotifiedAt === null || r.lastNotifiedAt < r.lastSeenAt);
  if (due.length === 0) return { emailed: 0 };

  if (!operatorEmail) {
    log.error(
      { codes: due.map((r) => r.code) },
      'degradation events are due but OPERATOR_EMAIL is not set; nobody is being told',
    );
    throw new DegradationDigestError(
      'degradation events are due but OPERATOR_EMAIL is not set',
    );
  }

  const claimed: typeof due = [];
  for (const row of due) {
    const { count } = await db.degradationEvent.updateMany({
      where: {
        code: row.code,
        lastSeenAt: row.lastSeenAt,
        OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: row.lastSeenAt } }],
      },
      data: { lastNotifiedAt: row.lastSeenAt },
    });
    if (count === 1) claimed.push(row);
  }
  if (claimed.length === 0) return { emailed: 0 };

  const entries: DegradationDigestEntry[] = claimed.map((r) => ({
    code: r.code,
    description: describeCode(r.code),
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    occurrences: r.occurrences,
    sample: (r.sample ?? {}) as Record<string, unknown>,
  }));
  const { subject, html } = renderDegradationDigestEmail(entries);

  let failure: unknown = null;
  try {
    const sent = await sendHtmlEmail({ to: operatorEmail, subject, html });
    if (!sent.ok) failure = new Error(sent.reason);
  } catch (err) {
    failure = err;
  }
  if (failure === null) return { emailed: claimed.length };

  let stranded = 0;
  for (const row of claimed) {
    try {
      await db.degradationEvent.updateMany({
        where: { code: row.code, lastNotifiedAt: row.lastSeenAt },
        data: { lastNotifiedAt: row.lastNotifiedAt },
      });
    } catch (err) {
      stranded += 1;
      log.error({ err, code: row.code }, 'could not release a degradation digest claim');
    }
  }
  const reason = failure instanceof Error ? failure.message : String(failure);
  throw new DegradationDigestError(
    `degradation digest not delivered: ${reason}${stranded > 0 ? ` (${stranded} claim(s) could not be released)` : ''}`,
    { cause: failure },
  );
}
