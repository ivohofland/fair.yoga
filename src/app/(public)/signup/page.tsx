import { redirect } from 'next/navigation';
import { SignupForm } from '@/components/signup/signup-form';
import { getSession } from '@/lib/session';

/**
 * Step one of teacher signup (#385): an address, and nothing else. The
 * profile is asked for at `/signup/profile`, after the link is clicked —
 * so an abandoned signup leaves a token that expires, never a half-built
 * teacher.
 *
 * Neither redirect below is about tidiness — each closes a door that
 * otherwise leads nowhere. A teacher who is already signed in is sent home
 * rather than offered a second signup. A signed-in account WITHOUT a teacher
 * profile (a student, since `SessionUser` makes a profile-less session
 * unrepresentable) is sent straight to the profile form: submitting this
 * form would find their address already has an `Account` and mail them an
 * ordinary sign-in link, which lands back where they started and never
 * creates a teacher. They need no email round trip — their live session is
 * already one of the two authorizations the profile route accepts.
 */
export default async function SignupPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session) redirect('/signup/profile');

  return (
    <div className="flex-1 flex flex-col justify-center py-10">
      <SignupForm
        title="Start teaching on fair.yoga"
        intro="One email address, no password. We'll send you a link — clicking it brings you back here to set up your page."
        sentMessage="We sent you a link. Clicking it brings you back here to set up your teacher page."
      />
    </div>
  );
}
