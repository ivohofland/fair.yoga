import type { PrismaClient } from '@prisma/client';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import { maskPaymentLink, parsePaymentLink, type PaymentLinkFailure } from '@/lib/payment-link';

/**
 * A teacher's payment link (#785), saved and removed, each change recorded as
 * a `PayoutChangeEvent` with the links masked (#786). Framework-agnostic: the
 * caller validates the body's shape and maps the outcome to a response.
 *
 * Each write takes `lockTeacherForNoKeyUpdate` as its transaction's first
 * statement and reads the stored link under it, so the link it records as
 * "before" is the one it replaces, and a write that waited behind an erasure
 * finds the row erased and writes nothing: `docs/lock-order.md`, "The
 * `Teacher` row is the first lock".
 */

/** `saved` and `removed` carry the `PayoutChangeEvent` they recorded. */
export type SavePaymentLinkOutcome =
  | { kind: 'saved'; paymentLink: string; eventId: string }
  | { kind: 'unchanged'; paymentLink: string }
  | { kind: 'invalid'; error: PaymentLinkFailure }
  | { kind: 'teacher_gone' };

export type RemovePaymentLinkOutcome =
  | { kind: 'removed'; eventId: string }
  | { kind: 'absent' }
  | { kind: 'teacher_gone' };

/** Parses `raw` and stores the link it names, unless that link is already stored. */
export async function savePaymentLink(db: PrismaClient, teacherId: string, raw: string): Promise<SavePaymentLinkOutcome> {
  const parsed = parsePaymentLink(raw);
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error };
  return db.$transaction(async (tx): Promise<SavePaymentLinkOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, teacherId))) return { kind: 'teacher_gone' };
    const { paymentLink: current } = await tx.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { paymentLink: true } });
    if (current === parsed.url) return { kind: 'unchanged', paymentLink: parsed.url };
    await tx.teacher.update({ where: { id: teacherId }, data: { paymentLink: parsed.url } });
    const event = await tx.payoutChangeEvent.create({
      data: {
        teacherId,
        kind: current === null ? 'payment_link_added' : 'payment_link_changed',
        before: current === null ? null : maskPaymentLink(current),
        after: maskPaymentLink(parsed.url),
        // Decided from the full links: two different ones can mask alike.
        identifierChanged: current === null ? null : current !== parsed.url,
      },
      select: { id: true },
    });
    return { kind: 'saved', paymentLink: parsed.url, eventId: event.id };
  });
}

/** Clears the teacher's link. */
export async function removePaymentLink(db: PrismaClient, teacherId: string): Promise<RemovePaymentLinkOutcome> {
  return db.$transaction(async (tx): Promise<RemovePaymentLinkOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, teacherId))) return { kind: 'teacher_gone' };
    const { paymentLink: current } = await tx.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { paymentLink: true } });
    if (current === null) return { kind: 'absent' };
    await tx.teacher.update({ where: { id: teacherId }, data: { paymentLink: null } });
    const event = await tx.payoutChangeEvent.create({
      data: { teacherId, kind: 'payment_link_removed', before: maskPaymentLink(current), after: null },
      select: { id: true },
    });
    return { kind: 'removed', eventId: event.id };
  });
}
