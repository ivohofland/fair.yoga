import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ProfileSetupForm } from '@/components/signup/profile-setup-form';
import { SignupForm } from '@/components/signup/signup-form';
import { SIGNUP_TICKET_COOKIE, peekSignupTicket } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

/**
 * Step two of teacher signup (#385). Three ways to arrive, matching the two
 * authorizations `POST /api/account/teacher-profile` accepts plus the case
 * where neither holds:
 *
 *   - TICKET. The ordinary new signup: `/verify` left the signup ticket in a
 *     cookie and sent the browser here. `peekSignupTicket` reads the address
 *     WITHOUT consuming it — the profile route is the only thing that spends
 *     it, so opening this page twice costs nothing.
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
 *   - NEITHER. A dead or missing ticket and no session. Not a dead end: it
 *     renders the same email form `/signup` does, so the way out is one
 *     field rather than a back button and a guess about which page to start
 *     from.
 */
export default async function ProfileSetupPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');

  const token = (await cookies()).get(SIGNUP_TICKET_COOKIE)?.value;
  const ticketEmail = token ? await peekSignupTicket(prisma, token) : null;

  // The ticket wins where both exist, which is the order the route resolves
  // them in too: it is the narrower authorization — it names one address and
  // dies on use — so letting the session shadow it would spend neither.
  let identity: { email: string; mode: 'ticket' | 'session' } | null = null;
  if (ticketEmail) {
    identity = { email: ticketEmail, mode: 'ticket' };
  } else if (session) {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    identity = { email: account.email, mode: 'session' };
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
