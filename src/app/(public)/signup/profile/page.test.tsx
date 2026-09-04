import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
const peekSignupTicket = vi.fn();
const cookieGet = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/auth', () => ({
  SIGNUP_TICKET_COOKIE: 'fair_yoga_signup',
  peekSignupTicket: (...args: unknown[]) => peekSignupTicket(...args),
}));
vi.mock('@/lib/db', () => ({
  prisma: { account: { findUniqueOrThrow: async () => ({ email: 'signed-in@test.local' }) } },
}));

beforeEach(() => {
  getSession.mockReset();
  peekSignupTicket.mockReset();
  cookieGet.mockReset();
});

describe('ProfileSetupPage identity precedence', () => {
  it('uses the SESSION, not the ticket, when the browser carries both', async () => {
    const { default: ProfileSetupPage } = await import('./page');
    getSession.mockResolvedValue({ sessionId: 's1', accountId: 'a1', teacherId: null, studentId: 'st1' });
    cookieGet.mockReturnValue({ value: 'a-live-ticket' });
    peekSignupTicket.mockResolvedValue('someone-else@test.local');

    const tree = await ProfileSetupPage();
    const json = JSON.stringify(tree);

    // The route ignores the ticket while a session cookie exists, so a
    // ticket-mode form here would render another address and 401 on submit.
    expect(json).toContain('signed-in@test.local');
    expect(json).not.toContain('someone-else@test.local');
    expect(json).toContain('"mode":"session"');
  });
});
