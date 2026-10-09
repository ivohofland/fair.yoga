import type { PrismaClient } from '@prisma/client';
import { BASE_URL, seedSession, hashToken, uniqueSuffix } from './helpers';

/** The host the unit tests stub `ADMIN_HOST` to. */
export const TEST_ADMIN_HOST = `admin.${new URL(BASE_URL).host}`;

export interface AdminFixture {
  accountId: string;
  credentialId: string;
  email: string;
}

/** A student-profile account holding a passkey and, unless `grant: false`, an active admin grant. */
export async function createAdminFixture(
  db: PrismaClient,
  label: string,
  opts: { grant?: boolean } = {},
): Promise<AdminFixture> {
  const email = `admin-fx-${label}-${uniqueSuffix()}@test.local`;
  const student = await db.student.create({
    data: { firstName: 'Admin', lastName: label, email, account: { create: { email } }, claimedAt: new Date(), incomeTier: 3 },
    select: { accountId: true },
  });
  const accountId = student.accountId!;
  const credentialId = `admin-fx-cred-${label}-${uniqueSuffix()}`;
  await db.passkeyCredential.create({
    data: { id: credentialId, accountId, publicKey: Buffer.from([1]), counter: 0, transports: [] },
  });
  if (opts.grant !== false) {
    await db.adminGrant.create({ data: { accountId, grantedBy: 'fixture' } });
  }
  return { accountId, credentialId, email };
}

/** A session that signed in with the fixture's passkey, created `ageMs` ago. */
export async function seedPasskeySession(db: PrismaClient, f: AdminFixture, ageMs = 0): Promise<string> {
  const token = await seedSession(db, f.accountId);
  await db.session.update({
    where: { id: hashToken(token) },
    data: { passkeyCredentialId: f.credentialId, createdAt: new Date(Date.now() - ageMs) },
  });
  return token;
}

export async function cleanupAdminFixtures(db: PrismaClient, accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.adminGrant.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}
