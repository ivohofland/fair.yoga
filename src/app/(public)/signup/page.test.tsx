import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  // The panel's sign-out control reaches this module through the import
  // chain. Never called — these tests build the element tree and never
  // render it — but the binding has to resolve.
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    account: { findUniqueOrThrow: async () => ({ email: 'signed-in@test.local' }) },
  },
}));

beforeEach(() => {
  getSession.mockReset();
});

const TEACHER_SESSION = {
  sessionId: 's1',
  accountId: 'a1',
  teacherId: 't1',
  studentId: null,
  defaultTimezone: 'Europe/Amsterdam',
};
const STUDENT_SESSION = {
  sessionId: 's2',
  accountId: 'a2',
  teacherId: null,
  studentId: 'st1',
};

describe('SignupPage', () => {
  it('answers a signed-in teacher in words rather than moving them somewhere silent', async () => {
    const { default: SignupPage } = await import('./page');
    getSession.mockResolvedValue(TEACHER_SESSION);

    // The absence of a throw IS the assertion — before #431 this line ended
    // the test with REDIRECT:/schedule, and nothing was ever said.
    const tree = await SignupPage();

    expect(JSON.stringify(tree)).toContain('signed-in@test.local');
  });

  it('still sends a signed-in student straight to the profile form', async () => {
    const { default: SignupPage } = await import('./page');
    getSession.mockResolvedValue(STUDENT_SESSION);

    // Unchanged by #431, and the reason is in the page docblock: submitting
    // the email form as a signed-in student mails an ordinary sign-in link
    // that lands back where they started and never creates a teacher.
    await expect(SignupPage()).rejects.toThrow('REDIRECT:/signup/profile');
  });

  it('renders the email form for a browser with no session', async () => {
    const { default: SignupPage } = await import('./page');
    getSession.mockResolvedValue(null);

    const tree = await SignupPage();

    expect(JSON.stringify(tree)).toContain('Start teaching on fair.yoga');
  });
});
