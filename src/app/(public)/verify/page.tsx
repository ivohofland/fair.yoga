'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/icon';
import { TEACHER_PROFILE_PATH } from '@/lib/schemas';

type Status = 'verifying' | 'success' | 'error' | 'already-signed-in' | 'handoff' | 'timeout';
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
 * decides when this is on screen. It is the heaviest screen in the flow,
 * which is why it must not appear for a verification that will finish first.
 */
function VerifyingState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">One moment</p>
      <h1 className="type-display mb-4">{RAIL_HEADING}</h1>
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

/**
 * The one screen here that cannot say whether the link worked.
 *
 * The request was abandoned, not answered: the token may be spent or
 * untouched, and a session may or may not exist. `ErrorState`'s "this link
 * can't be used" would be a guess presented as a finding, and it is wrong
 * exactly when the reader's sign-in did land. So this names the uncertainty
 * instead, and offers the one recovery that is safe under both readings —
 * asking for a fresh link costs an email round trip and is correct whether or
 * not the old one was consumed. Retrying the same token is not: it is
 * single-use, and nothing on this side can tell whether it was already spent.
 */
function TimedOutState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-danger mb-[10px]">Connection problem</p>
      <h1 className="type-display mb-4">
        We couldn&apos;t reach
        <br />
        the server.
      </h1>
      <p className="type-body max-w-[360px] mb-6">
        Your link may have worked anyway &mdash; we just never got an answer.
        If it did, that link is spent now, so use a fresh one.
      </p>
      <Link
        href="/login"
        className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
      >
        Send a new link
      </Link>
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
 * How long after mount the rail waits before appearing. A verification that
 * answers first never brings it to the screen at all.
 *
 * Exported so the tests step the clock by this rather than by a copy of it.
 */
export const RAIL_APPEARS_AFTER_MS = 300;

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
export const RAIL_STAYS_FOR_MS = 600;

/**
 * How long the whole verification may take before this page stops waiting.
 *
 * The far end of the lifetime `RAIL_APPEARS_AFTER_MS` and `RAIL_STAYS_FOR_MS`
 * bound the near end of. It is armed against the `verifying` STATE, not
 * against either request that can occupy it — so it covers the session probe
 * behind a failed verification as well as the verification itself, with one
 * threshold instead of two.
 *
 * Must exceed `RAIL_APPEARS_AFTER_MS + RAIL_STAYS_FOR_MS`, and a test asserts
 * it: a held outcome runs from the stay timer rather than from `settle`, so a
 * ceiling inside the rail's own window could fire with an outcome already
 * parked behind it, where nothing guards it.
 *
 * Deliberately provisional. This is not measured against a real network, and
 * cannot be — so it is sized to make being WRONG cheap rather than to be
 * right. A ceiling that fires on a verification which would still have
 * succeeded costs that reader one re-sent email, which is what
 * `TimedOutState` offers and why its copy refuses to say the link failed.
 * Revise it against latency seen on a deployed instance; if the copy ever
 * stops making an early fire survivable, revise the copy first.
 *
 * Reasoning and arithmetic:
 * docs/superpowers/specs/2026-09-05-verify-ceiling-design.md
 */
export const VERIFY_CEILING_MS = 20_000;

/** The rail's heading. Exported so a test asserting its absence cannot be
 *  quietly retired by a copy edit here. */
export const RAIL_HEADING = 'Checking your link';

/**
 * Bounds the verifying rail's life away from zero.
 *
 * A screen's lifetime has two ends, and nothing can know at render time
 * whether a verification will answer in 90ms or three seconds — so gating
 * only the start could never bound that lifetime. `settle` is the other end:
 * an outcome applied through it cannot take the screen while the rail is
 * mid-flash. It runs its callback immediately when the rail was never shown,
 * which is the ordinary fast sign-in and the reason this costs that reader
 * nothing.
 *
 * Callers must route EVERY exit from `verifying` through `settle`; the type
 * system cannot make them, so each exit has a test that fails if it stops.
 *
 * The minimum is timed from the rail's own appearance rather than measured
 * against a clock read, so no part of this depends on `Date` being faked
 * alongside the timers.
 *
 * @param onApplyThrew - recovery for a callback that throws. On the fast path
 * an outcome runs inside the caller's promise chain and a throw lands in its
 * `.catch`; held, it runs from a timer with no such backstop, and the reader
 * whose token is already spent would be left on a screen that never resolves.
 */
function useVerifyingRail(
  enabled: boolean,
  onApplyThrew: () => void,
  onCeiling: () => void,
): {
  railVisible: boolean;
  settle: (apply: () => void) => void;
} {
  const [railVisible, setRailVisible] = useState(false);
  /** True while the rail is on screen and still owed its minimum. */
  const owed = useRef(false);
  /** True once the ceiling has taken this state's one exit. */
  const givenUp = useRef(false);
  const waiting = useRef<(() => void) | null>(null);
  const appearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ceilingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Held in a ref, not closed over: `settle` has to keep one identity for the
  // life of the mount, because the caller's verification effect depends on it
  // and re-running that effect re-sends a single-use token.
  const recover = useRef(onApplyThrew);
  const giveUp = useRef(onCeiling);
  useEffect(() => {
    recover.current = onApplyThrew;
    giveUp.current = onCeiling;
  });

  /** The one place an outcome is invoked, from either side of the hold. */
  const run = useCallback((apply: () => void) => {
    try {
      apply();
    } catch (err) {
      console.error('[verify] the outcome threw on its way to the screen', err);
      recover.current();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    appearTimer.current = setTimeout(() => {
      owed.current = true;
      setRailVisible(true);
      stayTimer.current = setTimeout(() => {
        owed.current = false;
        const held = waiting.current;
        waiting.current = null;
        if (held) run(held);
      }, RAIL_STAYS_FOR_MS);
    }, RAIL_APPEARS_AFTER_MS);

    // Armed here rather than from the fetch, because what it bounds is this
    // state and not one request: the exit through `.catch` sends a second one.
    ceilingTimer.current = setTimeout(() => {
      givenUp.current = true;
      console.error('[verify] no answer within the ceiling; giving up');
      giveUp.current();
    }, VERIFY_CEILING_MS);

    return () => {
      if (appearTimer.current) clearTimeout(appearTimer.current);
      if (stayTimer.current) clearTimeout(stayTimer.current);
      if (ceilingTimer.current) clearTimeout(ceilingTimer.current);
      waiting.current = null;
      // Cleared with the timer that would otherwise have cleared it. Leaving
      // it set would strand a later `settle`: it would park a callback for a
      // stay timer that no longer exists, and the reader would hold on the
      // rail with nothing coming.
      owed.current = false;
      givenUp.current = false;
    };
  }, [enabled, run]);

  const settle = useCallback((apply: () => void) => {
    // This state's one exit is already taken, and taking it back is worse than
    // doing nothing. On the failing branch it would replace an honest "we
    // couldn't reach the server" with a claim about the link that nothing here
    // can support; on the succeeding one it would run a callback that
    // schedules `router.push`, and that timer survives unmount — so it would
    // pull a reader off whatever page they had already moved on to.
    if (givenUp.current) return;

    // Cancelled rather than merely ignored: an outcome is on its way to the
    // screen, and the rail must not appear from behind it.
    if (appearTimer.current) {
      clearTimeout(appearTimer.current);
      appearTimer.current = null;
    }
    // Same reason, other end. This verification answered, so the ceiling has
    // nothing left to bound — including across the hold below, which can
    // still be running when it would otherwise fire.
    if (ceilingTimer.current) {
      clearTimeout(ceilingTimer.current);
      ceilingTimer.current = null;
    }
    if (!owed.current) {
      run(apply);
      return;
    }
    // Two outcomes for one verification means the token was redeemed twice —
    // React's development double-mount is the way to see it. Last one wins,
    // as it did before this gate existed, but the loser is worth a line: it
    // takes its side effects (the success branch's redirect among them) with
    // it.
    if (waiting.current) {
      console.error('[verify] a second outcome arrived while one was held; dropping the first');
    }
    waiting.current = apply;
    // `run` is the only non-ref here and is itself stable, so `settle` keeps
    // one identity for the life of the mount. That matters: the caller's
    // verification effect depends on it, and re-running that effect re-posts a
    // single-use token — pinned by the call-count assertion in `page.test.tsx`.
  }, [run]);

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
  const inFlight = useRef<AbortController | null>(null);
  // `Boolean(token)`, matching the status initializer above and the fetch
  // guard below: `?token=` yields '', which is not a verification worth
  // arming a timer for.
  const { railVisible, settle } = useVerifyingRail(
    Boolean(token),
    () => setStatus('error'),
    () => {
      inFlight.current?.abort();
      setStatus('timeout');
    },
  );

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    inFlight.current = controller;
    fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
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
        // The ceiling abandoned this request; the screen already says so.
        // Probing now would spend a round trip on an answer nothing may act
        // on, and its failure would log a fault that did not happen.
        if (controller.signal.aborted) return;

        // A stale link is often re-clicked from the inbox AFTER a
        // successful sign-in. Telling a signed-in user their sign-in
        // "failed" is worse than the truth: the link is spent, the
        // session is fine.
        try {
          const res = await fetch('/api/auth/session', {
            signal: controller.signal,
          });
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
        } catch (err) {
          // Reaching here means the probe itself misbehaved — the request
          // failed, or a 200 carried something that is not the shape this
          // reads. Worth a line, unlike the rejection that brought us into
          // this `catch`: that one is an expired or already-used link, the
          // commonest ordinary event on this page and no kind of fault.
          console.error('[verify] the session probe failed after a failed verification', err);
        }
        settle(() => setStatus('error'));
      });
  }, [token, router, settle]);

  if (status === 'error') return <ErrorState />;
  if (status === 'timeout') return <TimedOutState />;
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
  // `railVisible` only ever goes up, and must keep doing so. It is what holds
  // the screen when the stay timer expires with nothing to run — a verify POST
  // that failed at 400ms, say, whose session probe answers at 1500ms. Reset it
  // there and that reader gets 600ms of blank instead.
  return railVisible ? <VerifyingState /> : null;
}

export default function VerifyPage() {
  return (
    // Renders nothing, and cannot defer to `useVerifyingRail` the way the
    // fall-through does — this runs before `VerifyContent` mounts, so no timer
    // of ours has started. A rail painted here would not be gated by anything:
    // it would sit in the served HTML and then vanish at hydration, whatever
    // the verification went on to do.
    //
    // The cost is honest and worth stating: where this markup is what the
    // reader gets first, the wordmark-only window lasts until hydration and
    // only then does `RAIL_APPEARS_AFTER_MS` begin. Neither constant bounds
    // it. On a slow connection that window is longer than anything measured
    // for this change.
    <Suspense fallback={null}>
      <VerifyContent />
    </Suspense>
  );
}
