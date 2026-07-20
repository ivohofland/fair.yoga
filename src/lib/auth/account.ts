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
      teacher: { select: { id: true } },
      student: { select: { id: true } },
    },
  });
  if (account) {
    return {
      accountId: account.id,
      teacherId: account.teacher?.id ?? null,
      studentId: account.student?.id ?? null,
    };
  }

  const unclaimed = await db.student.findFirst({
    where: { email, claimedAt: null },
    select: { id: true },
  });
  if (!unclaimed) return null;

  const claimed = await db.student.update({
    where: { id: unclaimed.id },
    data: {
      claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });

  return { accountId: claimed.accountId!, teacherId: null, studentId: claimed.id };
}
