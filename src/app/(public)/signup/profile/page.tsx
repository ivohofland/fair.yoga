import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ProfileSetupForm } from '@/components/signup/profile-setup-form';
import { SignupForm } from '@/components/signup/signup-form';
import { peekSignupTicket, ticketTokenFrom } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

/**
 * Step two of teacher signup (#385). Three ways to arrive, matching the two
 * authorizations `POST /api/account/teacher-profile` accepts plus the case
 * where neither holds:
 *
 *   - SESSION. An account that already exists and has no teacher profile,
 *     adding the second hat. `SessionUser` makes that precisely a
 *     student-only session: a profile-less session is unrepresentable, so
 *     reaching here with a session at all means a student is becoming a
 *     teacher too. `/signup`'s own `if (session) redirect('/signup/profile')`
 *     is the direct route — any signed-in, teacherless visitor to `/signup`
 *     lands here immediately. The unclaimed-CRM-contact case reaches the same
 *     state a second way: `/verify` CLAIMS such a student and issues an
 *     ordinary session rather than a ticket, so the ticket branch never fires
 *     for them either.
 *   - TICKET. The ordinary new signup, reached only when no session cookie is
 *     present: `/verify` left the signup ticket in a cookie and sent the
 *     browser here. `peekSignupTicket` reads the address WITHOUT consuming it —
 *     the profile route is the only thing that spends it, so opening this page
 *     twice costs nothing.
 *   - NEITHER. A dead or missing ticket and no session — including a live
 *     ticket blocked by a session cookie that is present but failed to
 *     validate, since that state has no readable identity either. Not a
 *     dead end: it renders the same email form `/signup` does, so the way
 *     out is one field rather than a back button and a guess about which
 *     page to start from.
 */
export default async function ProfileSetupPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');

  let identity: { email: string; mode: 'ticket' | 'session' } | null = null;
  if (session) {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    identity = { email: account.email, mode: 'session' };
  } else {
    // `getSession()` returning falsy is not the same fact as "no session
    // cookie" — it also covers a present cookie that failed to validate.
    // `ticketTokenFrom` is the shared precedence rule (`profile-authorization.ts`)
    // — the same gate the profile route applies, so this page and that route
    // cannot disagree about who a ticket is readable by: a browser in that
    // second state lands here with `identity` unset (the fresh-link
    // fallback below), never a ticket-mode form for an address the caller
    // cannot actually submit under.
    const token = ticketTokenFrom(await cookies());
    const ticketEmail = token ? await peekSignupTicket(prisma, token, 'teacher') : null;
    if (ticketEmail) identity = { email: ticketEmail, mode: 'ticket' };
  }

  return (
    <div className="flex-1 flex flex-col justify-center py-10">
      {identity ? (
        <ProfileSetupForm email={identity.email} mode={identity.mode} />
      ) : (
        <SignupForm
          title="Let's get you a fresh link"
          intro="Enter your email and we'll send a fresh link. It brings you back here to set up your teacher page."
          sentMessage="We sent you a fresh link. Clicking it brings you back here to set up your teacher page."
        />
      )}
    </div>
  );
}
