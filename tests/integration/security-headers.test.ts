import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, freshIp, cookie, seedSession, uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const email = `csp-teacher-${suffix}@test.local`;
const slug = `csp-t-${suffix}`;
let token = '';

beforeAll(async () => {
  const account = await prisma.account.create({
    data: {
      email,
      teachers: { create: { firstName: 'Csp', lastName: 'Teacher', email, bio: '', pageSlug: slug } },
    },
  });
  token = await seedSession(prisma, account.id);
});

afterAll(async () => {
  // Keyed by the literal address, never by an id beforeAll assigns.
  const accounts = await prisma.account.findMany({ where: { email }, select: { id: true } });
  await prisma.session.deleteMany({ where: { accountId: { in: accounts.map((a) => a.id) } } });
  await prisma.teacher.deleteMany({ where: { email } });
  await prisma.account.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

const NONCE = /'nonce-([A-Za-z0-9+/]+={0,2})'/;

function scriptSrc(csp: string): string {
  return csp.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
}

async function page(path: string, signedIn = false): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { ...freshIp(), ...(signedIn ? cookie(token) : {}) },
    redirect: 'manual',
  });
}

describe('page CSP', () => {
  const cases: Array<[string, boolean]> = [
    ['/', false],
    ['/login', false],
    ['/verify', false],
    ['/start', false],
    ['/schedule', true],
    [`/${slug}`, false],
    ['/no-such-teacher-csp-404', false],
  ];

  for (const [path, signedIn] of cases) {
    it(`${path} carries one nonce policy with strict-dynamic and no unsafe-inline scripts`, async () => {
      const res = await page(path, signedIn);
      const csp = res.headers.get('content-security-policy') ?? '';
      // Headers.get joins repeated headers with ", " — one policy means one default-src.
      expect(csp.split('default-src').length).toBe(2);
      expect(scriptSrc(csp)).toMatch(NONCE);
      expect(scriptSrc(csp)).toContain("'strict-dynamic'");
      expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
    });
  }

  for (const path of ['/login', '/no-such-teacher-csp-404']) {
    it(`${path} stamps the header's nonce on its scripts, fresh per request`, async () => {
      const first = await page(path);
      const nonce = (first.headers.get('content-security-policy') ?? '').match(NONCE)?.[1];
      expect(nonce).toBeDefined();
      const html = await first.text();
      expect(html).toContain(`nonce="${nonce}"`);
      expect(html).not.toMatch(/<script(?![^>]*\bnonce=)(?![^>]*\bsrc=)[^>]*>/);

      const second = await page(path);
      expect((second.headers.get('content-security-policy') ?? '').match(NONCE)?.[1]).not.toBe(nonce);
    });
  }

  it('keeps the other security headers on pages', async () => {
    const res = await page('/login');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });
});

describe('API CSP', () => {
  it('is exactly the static deny-all policy, once', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, { headers: freshIp() });
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
