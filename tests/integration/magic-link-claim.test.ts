import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, uniqueSuffix, freshIp, teardownStudent } from '../helpers';
import { generateMagicLinkToken } from '@/lib/auth/magic-link';
import { hashNonce } from '@/lib/auth/origin-nonce';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const email = `claim-http-${suffix}@test.local`;
const redirect = `/class/http-claim-${suffix}`;

let studentId: string;
let accountId: string;

beforeAll(async () => {
  const student = await prisma.student.create({
    data: {
      firstName: 'Claim', lastName: 'Student', email,
      claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  studentId = student.id;
  accountId = student.accountId ?? '';
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email } });
  await teardownStudent(prisma, studentId, accountId);
  await prisma.$disconnect();
});

/**
 * The full device-handoff loop over HTTP: the requesting browser's cookie
 * jar mints an origin nonce via /send, the link is opened from a browser
 * that never had that cookie (so it gets a code instead of a session), and
 * the code is then traded back on the ORIGINAL browser at /claim.
 */
describe('POST /api/auth/magic-link/claim — device handoff over HTTP', () => {
  it('signs in the requesting browser and preserves the redirect', async () => {
    // The requesting browser: establish its origin-nonce cookie jar.
    const sendRes = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email, redirect }),
    });
    expect(sendRes.status).toBe(200);
    const originCookie = /fair_yoga_origin=([^;]+)/.exec(
      sendRes.headers.get('set-cookie') ?? '',
    )?.[1];
    expect(originCookie).toBeTruthy();

    // /send never echoes the raw token (that's the point — it's emailed).
    // Mint the token the same way deliverSignInLink would have, bound to the
    // nonce this cookie jar just established.
    const token = await generateMagicLinkToken(prisma, email, {
      redirectTo: redirect,
      originBrowserHash: hashNonce(originCookie!),
    });

    // Opened on a DIFFERENT browser: no fair_yoga_origin cookie at all.
    const verifyRes = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ token }),
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as { data: { handoffCode: string } };
    const code = verifyBody.data.handoffCode;
    expect(code).toMatch(/^\d{6}$/);
    // Nothing consumed yet — the requesting browser must still be able to claim.
    expect(await prisma.magicLinkToken.findFirst({ where: { email } })).not.toBeNull();

    // Claimed back on the requesting browser, using its own origin cookie.
    const claimRes = await fetch(`${BASE_URL}/api/auth/magic-link/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_origin=${originCookie}`,
        ...freshIp(),
      },
      body: JSON.stringify({ code }),
    });
    expect(claimRes.status).toBe(200);
    expect(claimRes.headers.get('set-cookie')).toContain('fair_yoga_session=');
    // Rotation (§5): a successful claim also clears the origin-nonce cookie
    // alongside the session cookie, so this browser's stable, year-long nonce
    // does not survive indefinitely across sign-ins.
    expect(claimRes.headers.get('set-cookie')).toContain('fair_yoga_origin=;');
    const claimBody = (await claimRes.json()) as { data: { redirectTo: string } };
    expect(claimBody.data.redirectTo).toBe(redirect);

    // Consumed now — no token left for this address.
    expect(await prisma.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('refuses a wrong code without a session', async () => {
    const wrongEmail = `claim-http-wrong-${suffix}@test.local`;
    const sendRes = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: wrongEmail }),
    });
    const originCookie = /fair_yoga_origin=([^;]+)/.exec(
      sendRes.headers.get('set-cookie') ?? '',
    )?.[1];

    const token = await generateMagicLinkToken(prisma, wrongEmail, {
      originBrowserHash: hashNonce(originCookie!),
    });
    await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ token }),
    });

    const claimRes = await fetch(`${BASE_URL}/api/auth/magic-link/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_origin=${originCookie}`,
        ...freshIp(),
      },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(claimRes.status).toBe(400);
    expect(claimRes.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');

    await prisma.magicLinkToken.deleteMany({ where: { email: wrongEmail } });
  });
});
