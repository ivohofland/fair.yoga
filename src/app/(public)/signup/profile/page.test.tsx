import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
const peekSignupTicket = vi.fn();
const cookieGet = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/auth', async (importOriginal) => {
  // `ticketTokenFrom` runs for real — its presence-vs-validity rule is the
  // thing under test here, not something to stub out from under the page.
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, peekSignupTicket: (...args: unknown[]) => peekSignupTicket(...args) };
});
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

    // A valid session never reaches the ticket branch at all — `peekSignupTicket`
    // stays unconsulted, and the rendered identity is the session's own.
    expect(json).toContain('signed-in@test.local');
    expect(json).not.toContain('someone-else@test.local');
    expect(json).toContain('"mode":"session"');
    expect(peekSignupTicket).not.toHaveBeenCalled();
  });

  it('falls to the fresh-link form, not a ticket-mode form, when the session cookie is present but invalid', async () => {
    // getSession() returning null is not the same fact as "no session
    // cookie": it also covers a present cookie that failed to validate.
    // This page must not treat that as "no session" either, or it renders
    // a form for an address the caller has no way to actually submit under.
    const { default: ProfileSetupPage } = await import('./page');
    getSession.mockResolvedValue(null);
    cookieGet.mockImplementation((name: string) =>
      name === 'fair_yoga_session' ? { value: 'present-but-invalid' } : { value: 'a-live-ticket' },
    );
    peekSignupTicket.mockResolvedValue('ticket-holder@test.local');

    const tree = await ProfileSetupPage();
    const json = JSON.stringify(tree);

    // Neither identity renders: the shared precedence rule (`ticketTokenFrom`)
    // blocks the ticket the moment a session cookie is present, so it falls to the
    // same "get a fresh link" form `/signup` itself uses.
    expect(json).not.toContain('ticket-holder@test.local');
    expect(json).not.toContain('signed-in@test.local');
    expect(json).toContain('fresh link');
    expect(peekSignupTicket).not.toHaveBeenCalled();
  });

  it('still honours a live ticket when no session cookie is present at all', async () => {
    const { default: ProfileSetupPage } = await import('./page');
    getSession.mockResolvedValue(null);
    cookieGet.mockImplementation((name: string) =>
      name === 'fair_yoga_signup' ? { value: 'a-live-ticket' } : undefined,
    );
    peekSignupTicket.mockResolvedValue('ticket-holder@test.local');

    const tree = await ProfileSetupPage();
    const json = JSON.stringify(tree);

    expect(json).toContain('ticket-holder@test.local');
    expect(json).toContain('"mode":"ticket"');
  });
});
