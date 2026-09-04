'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import { TEACHER_PROFILE_PATH } from '@/lib/schemas';

type Status = 'verifying' | 'success' | 'error' | 'already-signed-in' | 'handoff';
type StepState = 'done' | 'now' | 'pending';
type RailStep = { num: string; text: string; when: string; state: StepState };

function Rail({ steps }: { steps: RailStep[] }) {
  return (
    <ul className="list-none p-0 mt-6 mb-2 border-t border-border">
      {steps.map((s) => {
        const isDone = s.state === 'done';
        const isNow = s.state === 'now';
        const isPending = s.state === 'pending';
        return (
          <li
            key={s.num}
            className={`grid grid-cols-[24px_1fr_auto] gap-x-3 items-center min-h-14 py-2 border-b border-border ${
              isNow ? '-mx-2 px-2 bg-teal-tint rounded-field border-b-transparent' : ''
            }`}
          >
            <span className="flex items-center justify-center">
              {isDone ? (
                <Icon name="check" size={16} className="text-teal" />
              ) : isNow ? (
                <span className="block w-2 h-2 rounded-full bg-teal" />
              ) : (
                <span className="block w-2 h-2 rounded-full border border-brown-light" />
              )}
            </span>
            <span
              className={`text-[15px] ${
                isDone
                  ? 'text-brown'
                  : isPending
                    ? 'text-brown-light'
                    : 'text-ink font-medium'
              }`}
            >
              {s.text}
            </span>
            <span className={`type-caption ${isPending ? 'text-brown-light' : ''}`}>
              {s.when}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function StatusLine({
  variant = 'default',
  children,
}: {
  variant?: 'default' | 'error' | 'done';
  children: React.ReactNode;
}) {
  const pipColor = variant === 'error' ? 'bg-danger' : 'bg-teal';
  return (
    <div className="mt-[18px] type-caption flex items-baseline gap-2">
      <span
        className={`block w-1.5 h-1.5 rounded-full flex-none ${pipColor}`}
        style={{ transform: 'translateY(-2px)' }}
      />
      <span>{children}</span>
    </div>
  );
}

function Fineprint({ children }: { children: React.ReactNode }) {
  return <p className="mt-6 type-caption leading-[1.55]">{children}</p>;
}

/**
 * Written for a slow connection, and shown only on one: `useVerifyingRail`
 * below decides when this is on screen, and every route to it goes through
 * that hook. It is the heaviest screen in the flow, and before #435 it was
 * also the shortest-lived — visible for 89–194ms on a local verification,
 * gone before it resolved into anything.
 */
function VerifyingState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">One moment</p>
      <h1 className="type-display mb-4">Checking your link</h1>
      <p className="type-body max-w-[360px]">
        You tapped a one-time link. We&apos;re confirming it&apos;s still valid,
        and that this is the browser you requested it from.
      </p>
      <Rail
        steps={[
          { num: 'i.', text: 'Link received', when: 'just now', state: 'done' },
          { num: 'ii.', text: 'Checking the token', when: 'in progress', state: 'now' },
          { num: 'iii.', text: 'Opening your dashboard', when: '—', state: 'pending' },
        ]}
      />
      <StatusLine>
        Usually takes under a second. If this lingers, your connection may be slow.
      </StatusLine>
      <Fineprint>
        If you didn&apos;t request this link, you can close the tab &mdash; nothing
        happens without confirmation.
      </Fineprint>
    </div>
  );
}

/**
 * Three destinations the copy can name — teacher schedule, student
 * bookings, straight back to a class mid-booking — plus whatever deep
 * link a login redirect carried (any protected path): name the real one
 * when we can, stay generic when we can't.
 */
function destinationCopy(dest: string): string {
  if (dest.includes('/book/')) return 'Taking you back to your class now.';
  if (dest.startsWith('/bookings')) return 'Taking you to your bookings now.';
  if (dest === '/schedule') return 'Taking you to your schedule now.';
  if (dest === TEACHER_PROFILE_PATH) return 'Taking you to set up your page now.';
  return 'Taking you back to where you left off.';
}

/** The signup branch of `verify/route.ts` serves both families, and they are
 *  going to different places. Keyed on `TEACHER_PROFILE_PATH`
 *  (`src/lib/schemas.ts`) — the same constant `signupTicketFor` produces the
 *  teacher destination from — so the two cannot desync on the literal. */
function newSignupHeadline(dest: string): string {
  return dest === TEACHER_PROFILE_PATH ? "Let's set up your page." : "Let's finish your booking.";
}

/**
 * Two lengths, and the flags decide which. With nothing to report this state
 * is visible for under a second, so it carries only the confirmation plus the
 * fallback link — the one line that matters exactly when the redirect fails
 * and the reader suddenly has time. Longer education (spent links,
 * wrong-account) still lives on the states people dwell on by choice.
 *
 * `signupCancelled` and `sessionEnded` are the exception: each names
 * something the reader HAD and no longer has, which they cannot act on
 * without being told. The redirect slows to match (see `VerifyContent`).
 *
 * `isNewSignup` distinguishes the one destination that never sets a
 * session: a `teacher_signup` or `student_signup` token with no account yet
 * hands back a signup ticket, not a session (`magic-link/verify/route.ts`)
 * — so "Welcome back / You're signed in" would be false on both halves for
 * that reader, and it is also what separates the two ways a pending signup
 * can end: displaced by a newer one here, or abandoned by signing in.
 */
function SuccessState({
  redirectTo,
  isNewSignup,
  signupCancelled,
  sessionEnded,
}: {
  redirectTo: string;
  isNewSignup: boolean;
  signupCancelled: boolean;
  sessionEnded: boolean;
}) {
  const dest = redirectTo || '/schedule';
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">{isNewSignup ? 'Email confirmed' : 'Welcome back'}</p>
      <h1 className="type-display mb-4">
        {isNewSignup ? newSignupHeadline(dest) : "You're signed in."}
      </h1>
      <p className="type-body max-w-[360px]">
        {isNewSignup ? 'Almost there.' : 'The link checked out.'} {destinationCopy(dest)}
      </p>
      <StatusLine variant="done">
        Redirecting to{' '}
        <span className="type-number">{dest}</span>
        {' — if it doesn’t load, '}
        <Link href={dest} className="text-teal">
          tap here
        </Link>
        .
      </StatusLine>
      {signupCancelled && (
        <StatusLine>
          {isNewSignup
            ? 'Your other pending signup was cancelled by this one.'
            : 'Your pending signup was cancelled because you signed in.'}{' '}
          You can start it again from the signup page.
        </StatusLine>
      )}
      {sessionEnded && (
        <StatusLine>
          Starting this signup signed you out of your other account. You can sign
          back in any time.
        </StatusLine>
      )}
    </div>
  );
}

function ErrorReason({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative text-[14px] text-brown leading-[1.55] mb-1.5 before:content-['·'] before:absolute before:-left-[14px] before:text-brown">
      {children}
    </li>
  );
}

function ErrorState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-danger mb-[10px]">Verification failed</p>
      <h1 className="type-display mb-4">
        This link can&apos;t
        <br />
        be used.
      </h1>
      <p className="type-body max-w-[360px] mb-3">
        It&apos;s either past its fifteen-minute window, already been used, or doesn&apos;t
        match what we sent. Nothing to worry about &mdash; ask for a fresh one.
      </p>
      <ul className="list-none pl-[18px] mt-3 mb-6">
        <ErrorReason>The link is older than fifteen minutes</ErrorReason>
        <ErrorReason>It&apos;s already been used to sign in once</ErrorReason>
      </ul>
      <div className="flex flex-col gap-3 mt-2">
        <Link
          href="/login"
          className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
        >
          Send a new link
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center justify-center w-full text-center border-[1.5px] border-teal text-teal hover:bg-teal-tint rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
        >
          Use a different email
        </Link>
      </div>
      <StatusLine variant="error">
        If this keeps happening, write to{' '}
        <a href="mailto:hello@fair.yoga" className="text-teal">
          hello@fair.yoga
        </a>{' '}
        &mdash; a real person will read it.
      </StatusLine>
    </div>
  );
}

function AlreadySignedInState({ home }: { home: string }) {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">Already signed in</p>
      <h1 className="type-display mb-4">
        You&apos;re still
        <br />
        signed in.
      </h1>
      <p className="type-body max-w-[360px] mb-6">
        That link is spent &mdash; one-time links only work once. But your
        session on this device is active, so there&apos;s nothing to redo.
      </p>
      <Link
        href={home}
        className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
      >
        {home === '/bookings' ? 'Continue to your bookings' : 'Continue to your schedule'}
      </Link>
      <Fineprint>
        Meant to sign in as someone else? Sign out first &mdash; you&apos;ll find
        it under Settings.
      </Fineprint>
    </div>
  );
}

/**
 * This browser didn't hold the cookie tying it to the request, so nothing
 * was consumed here — no session, no error. The code is only good on the
 * browser that asked for the link; the link below is the escape hatch for
 * whoever lost track of that original tab.
 */
function HandoffState({ code }: { code: string }) {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">One more step</p>
      <h1 className="type-display mb-4">Enter this where you started</h1>
      <p className="type-body max-w-[360px] mb-6">
        We couldn&apos;t confirm this is the browser that asked for the
        link, so here&apos;s a code instead of a sign-in. Go back to where
        you requested it and type this in.
      </p>
      <p
        className="type-number text-[40px] text-center tracking-[0.3em] mb-6"
        aria-label={`Your code is ${code}`}
      >
        {code}
      </p>
      <Fineprint>
        Only you should ever see this code. If you didn&apos;t try to sign in
        just now, ignore it &mdash; nobody from fair.yoga will ever ask you to
        read it to them.
      </Fineprint>
      <Fineprint>
        Lost that tab?{' '}
        <Link href="/login" className="text-teal">
          Sign in here instead
        </Link>
        .
      </Fineprint>
    </div>
  );
}

/**
 * How long verification may run before the reader is shown anything about
 * it. Below this the rail never renders at all — the `(public)` layout's
 * wordmark carries the screen on its own, and the reader's next sight is the
 * outcome.
 */
const RAIL_APPEARS_AFTER_MS = 300;

/**
 * How long the rail keeps the screen once it HAS appeared, even when the
 * outcome lands a millisecond behind it.
 *
 * The pair removes the flicker; neither number does it alone. A threshold on
 * its own moves the cliff rather than removing it — a verification settling
 * just past `RAIL_APPEARS_AFTER_MS` would paint the rail for the few
 * milliseconds between the two events, which is the defect, not a smaller
 * version of it. Nothing here slows the fast path: below the threshold there
 * is nothing to hold, because nothing was shown.
 */
const RAIL_STAYS_FOR_MS = 600;

/**
 * Bounds the verifying rail's life away from zero.
 *
 * A screen's lifetime has two ends, and nothing can know at render time
 * whether a verification will answer in 90ms or three seconds — so gating
 * only the start could never bound that lifetime. `settle` is the other end:
 * every path out of `verifying` applies its outcome through it, so none of
 * them can take the screen while the rail is mid-flash. It runs its callback
 * immediately when the rail was never shown, which is the ordinary fast
 * sign-in and the reason this costs that reader nothing.
 *
 * The minimum is timed from the rail's own appearance rather than measured
 * against a clock read, so no part of this depends on `Date` being faked
 * alongside the timers.
 */
function useVerifyingRail(enabled: boolean): {
  railVisible: boolean;
  settle: (apply: () => void) => void;
} {
  const [railVisible, setRailVisible] = useState(false);
  /** True while the rail is on screen and still owed its minimum. */
  const owed = useRef(false);
  const waiting = useRef<(() => void) | null>(null);
  const appearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    appearTimer.current = setTimeout(() => {
      owed.current = true;
      setRailVisible(true);
      stayTimer.current = setTimeout(() => {
        owed.current = false;
        const held = waiting.current;
        waiting.current = null;
        held?.();
      }, RAIL_STAYS_FOR_MS);
    }, RAIL_APPEARS_AFTER_MS);

    return () => {
      if (appearTimer.current) clearTimeout(appearTimer.current);
      if (stayTimer.current) clearTimeout(stayTimer.current);
      waiting.current = null;
    };
  }, [enabled]);

  const settle = useCallback((apply: () => void) => {
    // Cancelled rather than merely ignored: an outcome is on its way to the
    // screen, and the rail must not appear from behind it.
    if (appearTimer.current) {
      clearTimeout(appearTimer.current);
      appearTimer.current = null;
    }
    if (owed.current) waiting.current = apply;
    else apply();
  }, []);

  return { railVisible, settle };
}

function VerifyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'error');
  const [redirectTo, setRedirectTo] = useState<string>('');
  const [isNewSignup, setIsNewSignup] = useState(false);
  const [signupCancelled, setSignupCancelled] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [home, setHome] = useState<string>('/schedule');
  const [handoffCode, setHandoffCode] = useState<string>('');
  const { railVisible, settle } = useVerifyingRail(token !== null);

  useEffect(() => {
    if (!token) return;
    fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Verification failed');
        return res.json();
      })
      .then((json) => {
        // Nothing was consumed: the code names a pending claim, still
        // waiting on the browser that requested the link.
        if (json.data.handoffCode) {
          const code: string = json.data.handoffCode;
          settle(() => {
            setHandoffCode(code);
            setStatus('handoff');
          });
          return;
        }
        const dest: string = json.data.redirectTo;
        // The signup-ticket branch of `verify/route.ts` never sets
        // `accountId` — it hands back a ticket cookie instead of a session
        // — so its absence is the signal this reader was never signed in at
        // all.
        const isNew = !json.data.accountId;
        const cancelled = Boolean(json.data.signupCancelled);
        const endedSession = Boolean(json.data.sessionEnded);
        settle(() => {
          setIsNewSignup(isNew);
          setSignupCancelled(cancelled);
          setSessionEnded(endedSession);
          setRedirectTo(dest);
          setStatus('success');
          // Either notice is something the reader lost and has to read below
          // the redirect line — give it enough time to actually be read
          // instead of the ordinary redirect beat. Scheduled from inside
          // `settle`, so the beat is measured from where this state takes the
          // screen rather than from where the response arrived.
          setTimeout(() => router.push(dest), cancelled || endedSession ? 4000 : 900);
        });
      })
      .catch(async () => {
        // A stale link is often re-clicked from the inbox AFTER a
        // successful sign-in. Telling a signed-in user their sign-in
        // "failed" is worse than the truth: the link is spent, the
        // session is fine.
        try {
          const res = await fetch('/api/auth/session');
          if (res.ok) {
            const json = (await res.json()) as {
              data: { teacherId: string | null; studentId: string | null };
            };
            const landing = json.data.teacherId ? '/schedule' : '/bookings';
            settle(() => {
              setHome(landing);
              setStatus('already-signed-in');
            });
            return;
          }
        } catch {
          // fall through to the plain failure state
        }
        settle(() => setStatus('error'));
      });
  }, [token, router, settle]);

  if (status === 'error') return <ErrorState />;
  if (status === 'already-signed-in') return <AlreadySignedInState home={home} />;
  if (status === 'success')
    return (
      <SuccessState
        redirectTo={redirectTo}
        isNewSignup={isNewSignup}
        signupCancelled={signupCancelled}
        sessionEnded={sessionEnded}
      />
    );
  if (status === 'handoff') return <HandoffState code={handoffCode} />;
  return railVisible ? <VerifyingState /> : null;
}

export default function VerifyPage() {
  return (
    // Renders nothing, for the same reason the gate below the threshold does:
    // this is a pre-mount render. It happens before a verification has been
    // sent, so it cannot know whether one will take 90ms or three seconds,
    // and a screen it paints may be replaced on the very next frame.
    // `useVerifyingRail` decides instead, and only once `VerifyContent` has
    // mounted.
    //
    // Not interchangeable with the gate: which of the two is the FIRST paint
    // depends on how this page is being served. Built, it prerenders (a
    // `useSearchParams` bailout takes the nearest boundary with it), so this
    // fallback is the HTML a deployed reader gets before any JavaScript runs;
    // under `next dev` the page is rendered per request and `VerifyContent`
    // produces that HTML itself. Each site covers what the other cannot.
    <Suspense fallback={null}>
      <VerifyContent />
    </Suspense>
  );
}
