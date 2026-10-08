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

function directive(csp: string, name: string): string {
  return csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
}

function scriptSrc(csp: string): string {
  return directive(csp, 'script-src');
}

/** An unmatched multi-segment path: the global not-found, not the `[slug]` page's own `notFound()`. */
const NOT_FOUND_PATH = '/csp-404/none';

/** `next dev` names its HMR client chunk in every page; a production build never does. */
async function isDevServer(): Promise<boolean> {
  const html = await (await fetch(`${BASE_URL}/login`, { headers: freshIp() })).text();
  return html.includes('hmr-client');
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
    [NOT_FOUND_PATH, false],
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
      if (path === NOT_FOUND_PATH) expect(res.status).toBe(404);
    });
  }

  it('carries no development source outside a dev server', async () => {
    const dev = await isDevServer();
    // CI serves a production build, so there this assertion always runs; a
    // dev server on CI would make it vacuous, and fails instead.
    if (process.env.CI) expect(dev).toBe(false);
    const csp = (await page('/login')).headers.get('content-security-policy') ?? '';
    if (dev) {
      // The detection agrees with the policy it gates.
      expect(scriptSrc(csp)).toContain("'unsafe-eval'");
      return;
    }
    expect(scriptSrc(csp)).not.toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).not.toContain('ws:');
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
  });

  for (const path of ['/login', NOT_FOUND_PATH]) {
    it(`${path} stamps the header's nonce on its scripts, fresh per request`, async () => {
      const first = await page(path);
      const nonce = (first.headers.get('content-security-policy') ?? '').match(NONCE)?.[1];
      expect(nonce).toBeDefined();
      const html = await first.text();
      expect(html).toContain(`nonce="${nonce}"`);
      expect(html).not.toMatch(/<script(?![^>]*\bnonce=)[^>]*>/);

      const second = await page(path);
      const secondNonce = (second.headers.get('content-security-policy') ?? '').match(NONCE)?.[1];
      expect(secondNonce).toBeDefined();
      expect(secondNonce).not.toBe(nonce);
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

describe('API CSP scope', () => {
  it('does not reach a static asset outside the API', async () => {
    const res = await fetch(`${BASE_URL}/manifest.webmanifest`, { headers: freshIp() });
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('service worker CSP', () => {
  it('/sw.js carries exactly the same-origin policy', async () => {
    const res = await fetch(`${BASE_URL}/sw.js`, { headers: freshIp() });
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
  });
});
