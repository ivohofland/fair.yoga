import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlreadyTeachingPanel } from '@/components/signup/already-teaching-panel';

const getSession = vi.fn();
const findUniqueOrThrow = vi.fn(async (_args: unknown) => ({ email: 'signed-in@test.local' }));

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
    account: { findUniqueOrThrow: (args: unknown) => findUniqueOrThrow(args) },
  },
}));

beforeEach(() => {
  getSession.mockReset();
  findUniqueOrThrow.mockClear();
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

    // Not just that an account was looked up — that it was looked up by the
    // SESSION's account id. A mock ignoring its `where` argument would not
    // notice a swap for `session.teacherId`.
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'a1' },
      select: { email: true },
    });
    expect(JSON.stringify(tree)).toContain('signed-in@test.local');
    // Not just that the email string appears somewhere — that
    // AlreadyTeachingPanel is the component that rendered it. A page that
    // swapped this for a bare `<div>{account.email}</div>` would still pass
    // the assertion above.
    expect(tree.type).toBe(AlreadyTeachingPanel);
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
