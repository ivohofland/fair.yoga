/**
 * The operator's digest (#157): emails the degradation events that are new, or
 * that have fired again since the operator was last told. Runs inside the
 * `daily-cleanup` job; the mechanism is `docs/technical-architecture.md`
 * (Cron Jobs → Degradation events).
 *
 * CLAIM BEFORE SEND, against a manual `/api/cron/daily-cleanup` overlapping a
 * scheduled tick (the precedent is `docs/technical-architecture.md`, Cron Jobs
 * → Overlapping triggers): each row is claimed with a conditional `updateMany`
 * keyed on the `lastSeenAt` this run read, and a claim count other than 1 means
 * another run or a newer event got there first.
 *
 * The claim stamps `lastNotifiedAt` with the `lastSeenAt` it read, never with
 * the clock. An event landing after the stamp leaves `lastSeenAt` ahead of it,
 * so that row is due again next run instead of being swallowed.
 *
 * Any failure from the first claim through the send (a claim, the render, the
 * send) puts back every claim made so far and throws, which flips the job
 * unhealthy on the verdict `/api/health` already reports.
 */

import type { PrismaClient } from '@prisma/client';
import { DEGRADATION_CODES, isDegradationCode } from '@/lib/degradation-codes';
import { sendEmail } from '@/lib/email';
import { renderDegradationDigestEmail, type DegradationDigestEntry } from '@/lib/email-templates';
import { log } from '@/lib/log';
import { serializeErr, type SerializedErr } from '@/lib/log-serializers';

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
  return isDegradationCode(code) ? DEGRADATION_CODES[code].description : UNREGISTERED_DESCRIPTION;
}

/** A stored `sample` is JSON; only a non-array object reads as context keys. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  let failure: unknown = null;
  try {
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
      sample: isPlainObject(r.sample) ? r.sample : {},
    }));
    const sent = await sendEmail({ to: operatorEmail, audience: 'platform', content: renderDegradationDigestEmail(entries), unsubscribe: null });
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
      log.error(
        { err, code: row.code },
        'could not release a degradation digest claim; the event is now marked told without an email (DEPLOYMENT.md §7 makes it due again)',
      );
    }
  }
  // Redacted, because the copy becomes this error's own message, which is
  // logged as written.
  const reason = failure instanceof Error ? describeFailure(serializeErr(failure)) : String(failure);
  const outcome =
    stranded > 0
      ? `${stranded} claim(s) could not be released, so those events are marked told without an email`
      : 'the events stay due; the next daily run retries';
  throw new DegradationDigestError(`degradation digest not delivered: ${reason}; ${outcome}`, {
    cause: failure,
  });
}

/** A serialized failure's message, with its code and SQLSTATE when it has them. */
function describeFailure(failure: SerializedErr): string {
  const ids = [failure.code, failure.sqlState].filter((id) => id !== undefined);
  return ids.length > 0 ? `${failure.message} [${ids.join('/')}]` : failure.message;
}
