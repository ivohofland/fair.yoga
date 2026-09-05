import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { log } from '@/lib/log';

/**
 * What `POST /api/auth/magic-link/verify` LOGS when the token verifies —
 * real, unexpired, right browser — but the address behind it has no account.
 *
 * Reaching that branch means `resolveOrClaimAccount` found nothing for an
 * email a magic link just proved ownership of, and consuming the token has
 * already deleted every other live token for that address (`consumeTokenRow`,
 * `magic-link.ts`). The reader is stranded behind a burned link, and
 * re-requesting one burns identically if the cause persists — a GDPR erasure
 * rewriting `Account.email` while the profile keeps its real address is one
 * concrete path there, an invariant violation is the other. `respondError` is
 * a bare `NextResponse.json` that never reaches the logger, and the client
 * deliberately silences every 400 here (`/verify`'s outer `.catch`, #452) —
 * so without this line, nothing on either side ever recorded it.
 *
 * WHY THIS IS MOCKED, following `api/registrations/[id]/promote-after-cancel.test.ts`
 * (which names `api/class-templates/[id]/unknown-slot-holder.test.ts` and
 * `api/cron/daily-cleanup/route.test.ts` for the same reasoning): the
 * integration tier drives the app over HTTP in a separate `next dev` process,
 * so it can neither inject a fault into that process's `resolveOrClaimAccount`
 * nor observe its `log` calls. Two auth calls are mocked to reach the branch
 * directly instead of seeding a real token and a real erasure; the handler
 * underneath them is real — `withErrorHandler`, `parseBody`, `signupTicketFor`
 * and the response all run.
 *
 * WHY IT ASSERTS AN ABSENCE. The line exists so an operator can see the
 * fault, but the one thing it must never hand that operator is the address —
 * `signupTicketFor`'s own refusal one layer down (`signup-ticket.ts:183`)
 * logs `purpose` and a boolean for the same reason and never the email. A
 * docblock promising "never the address" is exactly the kind of claim that
 * survives being violated: nothing here fails if `email` gets added to the
 * context object for convenience, unless the test says so.
 */

const verifyWithHandoff = vi.fn();
const resolveOrClaimAccount = vi.fn();

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  // Everything but these two stays real — `signupTicketFor` especially, since
  // this file relies on its `sign_in` arm returning `null` without logging of
  // its own.
  return {
    ...actual,
    verifyWithHandoff: (...args: unknown[]) => verifyWithHandoff(...args),
    resolveOrClaimAccount: (...args: unknown[]) => resolveOrClaimAccount(...args),
  };
});
// The route reads `prisma` only to pass it opaquely into the two mocked
// functions above and into `liveSignupTicketEmail`, which this file never
// reaches (no signup-ticket cookie on the request) — stubbed to keep this
// file from opening a connection, matching `api/cron/daily-cleanup/route.test.ts`.
vi.mock('@/lib/db', () => ({ prisma: {} }));

const { POST } = await import('./route');

/** The address a real reader would have. Never expected to appear in a log
 *  call — that is the whole assertion below. */
const STRANDED_EMAIL = 'stranded-reader@example.com';

function verify(): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/magic-link/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'a-real-token' }),
  });
}

describe('POST /api/auth/magic-link/verify — a verified token behind no account', () => {
  it('still answers 400 with "Account not found", and logs the fault without the address', async () => {
    // `sign_in` rather than one of the signup purposes: `signupTicketFor`
    // returns `null` for it directly, with no `redirectTo` needed and no log
    // of its own — the plainest way to reach the `!resolved` branch this file
    // is about, from a purpose an ordinary "your session expired, sign in
    // again" link would actually carry.
    verifyWithHandoff.mockResolvedValue({
      kind: 'verified',
      email: STRANDED_EMAIL,
      redirectTo: null,
      purpose: 'sign_in',
    });
    resolveOrClaimAccount.mockResolvedValue(null);

    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => error.mockRestore());

    const res = await POST(verify());

    // The reader-facing behaviour must not change: this is a diagnosability
    // fix, not a UX one.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Account not found');

    expect(error).toHaveBeenCalledTimes(1);
    const [context, message] = error.mock.calls[0] ?? [];
    expect(context).toMatchObject({ purpose: 'sign_in' });
    expect(message).toBe(
      'a magic link verified but its address has no account; the link is spent and the reader is stranded',
    );

    // The point of this test as much as the line's presence: no argument to
    // the call may carry the email fed to the mock, in the context object or
    // the message. A future edit adding `{ email }` for convenience fails
    // here rather than shipping.
    expect(JSON.stringify(context)).not.toContain(STRANDED_EMAIL);
    expect(message).not.toContain(STRANDED_EMAIL);
  });
});
