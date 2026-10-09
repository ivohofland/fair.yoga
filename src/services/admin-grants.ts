import { Prisma, type PrismaClient } from '@prisma/client';

export type GrantRefusal = 'no_account' | 'no_passkey' | 'no_operator';
export type GrantOutcome = { kind: 'granted' } | { kind: 'unchanged' } | { kind: 'refused'; reason: GrantRefusal };
export type RevokeRefusal = Exclude<GrantRefusal, 'no_passkey'>;
export type RevokeOutcome =
  | { kind: 'revoked' }
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: RevokeRefusal };

export interface AdminListing {
  accountId: string;
  email: string;
  grantedAt: Date;
  grantedBy: string;
  /** No live teacher or student profile, so no session of this account validates. Derived on read. */
  dormant: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Grants admin to the account at `email`. Refuses an address with no account
 * (this never creates one) and an account with no passkey, which could never
 * pass the admin gate.
 */
export async function grantAdmin(db: PrismaClient, input: { email: string; by: string }): Promise<GrantOutcome> {
  const by = input.by.trim();
  if (by === '') return { kind: 'refused', reason: 'no_operator' };

  const account = await db.account.findUnique({ where: { email: normalizeEmail(input.email) }, select: { id: true } });
  if (!account) return { kind: 'refused', reason: 'no_account' };
  // `PasskeyCredential` carries `accountId` without a Prisma relation, so this is a count, not a `_count`.
  if ((await db.passkeyCredential.count({ where: { accountId: account.id } })) === 0) {
    return { kind: 'refused', reason: 'no_passkey' };
  }

  const active = await db.adminGrant.findFirst({ where: { accountId: account.id, revokedAt: null }, select: { id: true } });
  if (active) return { kind: 'unchanged' };

  try {
    await db.adminGrant.create({ data: { accountId: account.id, grantedBy: by } });
    return { kind: 'granted' };
  } catch (err) {
    // A concurrent grant won `AdminGrant_account_active_unique` between the read above and this insert.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { kind: 'unchanged' };
    throw err;
  }
}

export async function revokeAdmin(db: PrismaClient, input: { email: string; by: string }): Promise<RevokeOutcome> {
  const by = input.by.trim();
  if (by === '') return { kind: 'refused', reason: 'no_operator' };

  const account = await db.account.findUnique({ where: { email: normalizeEmail(input.email) }, select: { id: true } });
  if (!account) return { kind: 'refused', reason: 'no_account' };

  const { count } = await db.adminGrant.updateMany({
    where: { accountId: account.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: by },
  });
  return count === 0 ? { kind: 'unchanged' } : { kind: 'revoked' };
}

export async function listAdmins(db: PrismaClient): Promise<AdminListing[]> {
  const grants = await db.adminGrant.findMany({
    where: { revokedAt: null },
    orderBy: { grantedAt: 'asc' },
    select: {
      accountId: true,
      grantedAt: true,
      grantedBy: true,
      account: {
        select: {
          email: true,
          teachers: { where: { deletedAt: null }, select: { id: true } },
          students: { where: { deletedAt: null }, select: { id: true } },
        },
      },
    },
  });
  return grants.map((g) => ({
    accountId: g.accountId,
    email: g.account.email,
    grantedAt: g.grantedAt,
    grantedBy: g.grantedBy,
    dormant: g.account.teachers.length === 0 && g.account.students.length === 0,
  }));
}
