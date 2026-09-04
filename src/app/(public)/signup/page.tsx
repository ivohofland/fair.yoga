import { redirect } from 'next/navigation';
import { AlreadyTeachingPanel } from '@/components/signup/already-teaching-panel';
import { SignupForm } from '@/components/signup/signup-form';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

/**
 * Step one of teacher signup (#385): an address, and nothing else. The
 * profile is asked for at `/signup/profile`, after the link is clicked —
 * so an abandoned signup leaves a token that expires, never a half-built
 * teacher.
 *
 * Neither signed-in branch below is about tidiness — each closes a door that
 * otherwise leads nowhere.
 *
 * A teacher who is already signed in is not offered a second signup, and is
 * told so here rather than moved somewhere that would not say it (#431). The
 * only address this form could usefully take is one they are not signed in
 * as, so the panel names the address they ARE signed in as and offers the
 * sign-out that makes another one reachable.
 *
 * A signed-in account WITHOUT a teacher profile (a student, since
 * `SessionUser` makes a profile-less session unrepresentable) is sent
 * straight to the profile form: submitting this form would find their address
 * already has an `Account` and mail them an ordinary sign-in link, which
 * lands back where they started and never creates a teacher. They need no
 * email round trip — their live session is already one of the two
 * authorizations the profile route accepts.
 */
export default async function SignupPage() {
  const session = await getSession();
  if (session?.teacherId) {
    // `SessionUser` carries ids and no address, so the panel's copy needs the
    // same lookup `/signup/profile` makes for its own session-mode identity.
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    return <AlreadyTeachingPanel email={account.email} />;
  }
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
