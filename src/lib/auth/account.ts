import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export interface ResolvedAccount {
  accountId: string;
  teacherId: string | null;
  studentId: string | null;
}

/**
 * Email → account, for sign-in. When no account exists but an unclaimed
 * CRM-created student carries this email, this is the claim moment: the
 * human just proved they own the address (magic link), so the account is
 * created, linked, and claimedAt stamped. Unknown emails resolve to null.
 */
export async function resolveOrClaimAccount(
  db: PrismaClient,
  email: string,
): Promise<ResolvedAccount | null> {
  const account = await db.account.findUnique({
    where: { email },
    select: {
      id: true,
      teacher: { select: { id: true, deletedAt: true } },
      student: { select: { id: true, deletedAt: true } },
    },
  });
  if (account) {
    // Erased (soft-deleted) profiles never resurface through sign-in.
    return {
      accountId: account.id,
      teacherId: account.teacher && !account.teacher.deletedAt ? account.teacher.id : null,
      studentId: account.student && !account.student.deletedAt ? account.student.id : null,
    };
  }

  const unclaimed = await db.student.findFirst({
    where: { email, claimedAt: null },
    select: { id: true },
  });
  if (!unclaimed) return null;

  try {
    // Account first, then one scalar update: the claim/link CHECK
    // constraint requires claimedAt and accountId to change together,
    // and Prisma splits nested relation writes into separate statements.
    const created = await db.account.create({ data: { email } });
    await db.student.update({
      where: { id: unclaimed.id },
      data: { claimedAt: new Date(), accountId: created.id },
    });
    return { accountId: created.id, teacherId: null, studentId: unclaimed.id };
  } catch (err) {
    // Two verifies racing the same claim: the loser's account create hits
    // the unique email. The account exists now — resolve it and sign the
    // person in instead of failing a legitimate sign-in.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return resolveOrClaimAccount(db, email);
    }
    throw err;
  }
}
