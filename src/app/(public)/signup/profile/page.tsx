import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ProfileSetupForm } from '@/components/signup/profile-setup-form';
import { SignupForm } from '@/components/signup/signup-form';
import { SIGNUP_TICKET_COOKIE, peekSignupTicket } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

/**
 * Step two of teacher signup (#385), reached by clicking the emailed link:
 * `/verify` leaves the signup ticket in a cookie and sends the browser here.
 *
 * `peekSignupTicket` reads the address WITHOUT consuming the ticket — the
 * profile route is the only thing that spends it, so opening this page twice
 * costs nothing.
 *
 * A dead or missing ticket is not a dead end. It renders the same email form
 * `/signup` does, so the way out is one field rather than a back button and
 * a guess about which page to start from.
 */
export default async function ProfileSetupPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');

  const token = (await cookies()).get(SIGNUP_TICKET_COOKIE)?.value;
  const email = token ? await peekSignupTicket(prisma, token) : null;

  return (
    <div className="flex-1 flex flex-col justify-center py-10">
      {email ? (
        <ProfileSetupForm email={email} />
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
