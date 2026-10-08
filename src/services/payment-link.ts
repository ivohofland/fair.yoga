import type { PrismaClient } from '@prisma/client';
import { parsePaymentLink, type PaymentLinkFailure } from '@/lib/payment-link';

/**
 * A teacher's payment link (#785), saved and removed. Framework-agnostic: the
 * caller validates the body's shape and maps the outcome to a response.
 *
 * Each write is scoped to the live row. A write that waited behind an erasure
 * re-checks `deletedAt` once the erasure commits and matches nothing, so it
 * never lands on the anonymised row: `docs/lock-order.md`, "The `Teacher` row
 * is the first lock (#758)".
 */

export type SavePaymentLinkOutcome =
  | { kind: 'saved'; paymentLink: string }
  | { kind: 'unchanged'; paymentLink: string }
  | { kind: 'invalid'; error: PaymentLinkFailure }
  | { kind: 'teacher_gone' };

export type RemovePaymentLinkOutcome = { kind: 'removed' } | { kind: 'absent' } | { kind: 'teacher_gone' };

/** The live teacher's stored link, or null when the teacher is absent or erased. */
async function liveLink(db: PrismaClient, teacherId: string): Promise<{ paymentLink: string | null } | null> {
  return db.teacher.findFirst({ where: { id: teacherId, deletedAt: null }, select: { paymentLink: true } });
}

/** Parses `raw` and stores the link it names, unless that link is already stored. */
export async function savePaymentLink(db: PrismaClient, teacherId: string, raw: string): Promise<SavePaymentLinkOutcome> {
  const parsed = parsePaymentLink(raw);
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error };
  const current = await liveLink(db, teacherId);
  if (current === null) return { kind: 'teacher_gone' };
  if (current.paymentLink === parsed.url) return { kind: 'unchanged', paymentLink: parsed.url };
  const { count } = await db.teacher.updateMany({
    where: { id: teacherId, deletedAt: null },
    data: { paymentLink: parsed.url },
  });
  return count === 0 ? { kind: 'teacher_gone' } : { kind: 'saved', paymentLink: parsed.url };
}

/** Clears the teacher's link. */
export async function removePaymentLink(db: PrismaClient, teacherId: string): Promise<RemovePaymentLinkOutcome> {
  const current = await liveLink(db, teacherId);
  if (current === null) return { kind: 'teacher_gone' };
  if (current.paymentLink === null) return { kind: 'absent' };
  const { count } = await db.teacher.updateMany({
    where: { id: teacherId, deletedAt: null },
    data: { paymentLink: null },
  });
  return count === 0 ? { kind: 'teacher_gone' } : { kind: 'removed' };
}
