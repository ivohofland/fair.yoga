/**
 * Whether the fire-and-forget dispatch failures piling up right now look
 * systemic rather than a one-off (#392 review, Critical #1). A single
 * stranger-path failure (a thrown `sendInvitationEmail`, i.e. a Resend
 * SDK/API rejection) is rare and carries no address-class signal on its own.
 * A burst of them in a short window is what a Resend outage or a lapsed API
 * key/sending domain looks like — and that failure mode hits every stranger
 * send alike, never the registered-student path (`createNotification`, a
 * local DB insert that essentially never fails). Left unguarded,
 * `Invitation.lastNotifyFailedAt` would then read "failed" for every
 * unregistered invitee and "sent" for every registered one during the
 * outage — a deterministic partition by account-registration status, the
 * exact bit #166 closed. Treating a burst as "suppress the per-row signal"
 * is what keeps that column from becoming a proxy for "does this address
 * have a fair.yoga account."
 *
 * Global, not per-teacher: the attacker cannot cause Resend to fail, so this
 * window only ever fills during a genuine operational fault, and a global
 * counter closes both a single teacher's batch of probes and a slow,
 * spread-out one — other teachers' concurrent failures during the same
 * fault count too.
 */
const WINDOW_MS = 5 * 60 * 1000;
const SYSTEMIC_THRESHOLD = 3;

let recentFailures: number[] = [];

export function recordDispatchFailure(): { looksSystemic: boolean } {
  const now = Date.now();
  recentFailures = recentFailures.filter((t) => now - t < WINDOW_MS);
  recentFailures.push(now);
  return { looksSystemic: recentFailures.length >= SYSTEMIC_THRESHOLD };
}

/**
 * Test-only. Vitest isolates module state per test file, not per test, so a
 * file with more than one test that calls `recordDispatchFailure` needs this
 * in `beforeEach` — without it, an earlier test's failures count toward a
 * later test's threshold.
 */
export function __resetDispatchFailureTrackingForTests(): void {
  recentFailures = [];
}
