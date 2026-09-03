import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hashNonce } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp, hashToken } from '../helpers';
import crypto from 'crypto';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const freshEmail = `student-verify-fresh-${suffix}@test.local`;
const crmEmail = `student-verify-crm-${suffix}@test.local`;
const REDIRECT = '/some-teacher/book/some-class-id';

let crmStudentId: string;

/** A `student_signup` token bound to `nonce`, minted the way
 *  `POST /api/auth/student-signup` mints one. Seeded here because the route
 *  hashes the raw token and persists nothing else, so a token minted
 *  through the UI cannot be recovered. */
async function seedSignupToken(email: string, nonce: string, redirectTo: string | null) {
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: hashToken(raw),
      email,
      purpose: 'student_signup',
      redirectTo,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      originBrowserHash: hashNonce(nonce),
    },
  });
  return raw;
}

beforeAll(async () => {
  await prisma.$connect();
  const crm = await prisma.student.create({
    data: { firstName: 'CRM', lastName: 'Contact', email: crmEmail },
  });
  crmStudentId = crm.id;
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  // `Session` carries a bare `accountId`, no `@relation` back to `Account` —
  // a nested `{ account: { email: ... } }` filter isn't a valid Prisma
  // query on this schema, so the matching accounts are looked up first, the
  // same shape `invitations-api.test.ts` and `waitlist-display.test.ts` use.
  const accountIds = (
    await prisma.account.findMany({ where: { email: { contains: suffix } }, select: { id: true } })
  ).map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { id: crmStudentId } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

async function verify(token: string, nonce: string) {
  return fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_origin=${nonce}`,
      ...freshIp(),
    },
    body: JSON.stringify({ token }),
  });
}

describe('POST /api/auth/magic-link/verify — student_signup tokens', () => {
  it('hands back a ticket and the booking redirect, with no session', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(freshEmail, nonce, REDIRECT);

    const res = await verify(token, nonce);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.redirectTo).toBe(REDIRECT);
    // No session: the client reads the absence of accountId as "not signed in".
    expect(body.data.accountId).toBeUndefined();
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_signup=');

    // The invariant: verification alone still creates nothing.
    expect(await prisma.student.findUnique({ where: { email: freshEmail } })).toBeNull();
    expect(await prisma.account.findUnique({ where: { email: freshEmail } })).toBeNull();
  });

  it('refuses a token whose redirect is absent rather than minting a homeless ticket', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(`student-verify-noredir-${suffix}@test.local`, nonce, null);

    const res = await verify(token, nonce);
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_signup=');
  });

  it('refuses a token whose redirect is absolute rather than minting a homeless ticket', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(
      `student-verify-abs-${suffix}@test.local`,
      nonce,
      'https://evil.example/steal',
    );

    const res = await verify(token, nonce);
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_signup=');
  });

  it('claims an unclaimed CRM row and signs in instead, keeping the contact name', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(crmEmail, nonce, REDIRECT);

    const res = await verify(token, nonce);
    expect(res.status).toBe(200);
    const body = await res.json();
    // A session, not a ticket: resolveOrClaimAccount claimed the row.
    expect(body.data.accountId).toBeTruthy();
    expect(body.data.redirectTo).toBe(REDIRECT);
    // PR #427 review, C1: the session-issuing branch now unconditionally
    // clears any stray ticket cookie, so it's named here too — as a clear
    // (`Max-Age=0`), not a live value.
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');

    const claimed = await prisma.student.findUniqueOrThrow({ where: { id: crmStudentId } });
    expect(claimed.firstName).toBe('CRM');
    expect(claimed.claimedAt).not.toBeNull();
  });
});
