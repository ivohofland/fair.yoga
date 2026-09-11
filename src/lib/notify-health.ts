const WINDOW_MS = 5 * 60 * 1000;
const SYSTEMIC_THRESHOLD = 3;

let recentFailures: number[] = [];

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
 * Global, not per-teacher — and NOT because a teacher can't cause a
 * `sendInvitationEmail` throw on demand (they can: `sendInvitationEmail`
 * throws on any Resend `{ error }`, including a rate-limit rejection, and
 * `checkStudentWriteLimit`'s 50/hour sliding-log cap is looser than
 * Resend's own per-second send rate — a burst of 50 stranger invites in a
 * few seconds is within the app's own budget and can trip Resend's). What
 * makes global the right scope regardless: an attacker trying to single out
 * one target address (`[decoy, decoy, target]`, hoping only the target's
 * throw gets suppressed) fills the SAME shared window with their own decoy
 * failures, so the target's own throw is suppressed right along with them —
 * a self-induced burst defeats the differential-targeting attempt exactly
 * as well as a genuine outage does. A per-teacher window would not: it
 * would let each teacher spend their own quiet allowance independently.
 *
 * Accepted residual: this closes the DISCLOSURE risk, not availability. A
 * single teacher can hold `looksSystemic` true indefinitely — a burst of 3
 * every ~4 minutes stays under the 50/hour cap — silently suppressing the
 * failure signal platform-wide for every teacher for as long as they keep
 * it up. That is #392's whole feature reverting to its pre-existing,
 * pre-#392 behaviour (an operator-only log line), not a new leak; there is
 * no operator-facing signal that suppression is active versus simply quiet.
 */
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
