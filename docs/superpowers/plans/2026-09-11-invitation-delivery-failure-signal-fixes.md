# Fix plan: PR #583 review findings (#392 invitation delivery failure signal)

**Goal:** Close the two Critical defects a five-agent review of PR #583 found (the failure
signal correlates with address class, reopening #166; and the two tests meant to prove it
doesn't are vacuous), fix the attempt-staleness race a third agent found, and sweep in the
ten Important findings — without expanding scope beyond what the review actually surfaced.

**Branch:** `investigate_issue_392` (PR #583, already open against `main`). This is a fix
wave on the existing branch, not a new one — matches this project's own precedent
(`a871d847`, `40a3172a`, `c952875e`, all "fix(tests): address PR #NNN review findings").

**Decision locked in:** oracle fix = circuit-breaker suppression (user choice, not accepted
risk, not narrowed-to-uselessness).

## Fix 1 (Critical #1 + #3 combined): class-independent, attempt-scoped failure recording

Both defects live in the same function and are fixed by the same edit, so one fix covers
both review findings.

**1a — Circuit breaker (closes Critical #1, the oracle).** New module
`src/lib/notify-health.ts`: an in-memory, process-global, 5-minute sliding window of dispatch
failure timestamps. `recordDispatchFailure()` pushes `Date.now()`, prunes anything older than
5 minutes, and returns `true` once the pruned window holds 3 or more entries — the signal that
recent failures look systemic (a real Resend outage/misconfiguration affects every stranger
send in the window, not one address) rather than a single transient blip. `deliverInvitation`
calls it inside its `.catch`, before deciding whether to persist `lastNotifyFailedAt` at all;
when it returns `true`, skip the persist (still log operator-side, unconditionally, exactly as
today). Global rather than per-teacher: the attacker cannot cause Resend to fail, so the
window only ever fills during a genuine operational fault, and a global counter closes both a
single teacher's batch-probe and a slow, spread-out probe (other teachers' concurrent
failures during the same outage count too). A test-only `__resetDispatchFailureTrackingForTests()`
export, because Vitest isolates module state per test *file*, not per test — without a reset,
tests within `invitations.deliver.test.ts` that trigger multiple failures would leak counter
state into each other.

```ts
// src/lib/notify-health.ts
/**
 * Whether the fire-and-forget dispatch failures piling up right now look
 * systemic rather than a one-off (#392 oracle-safety follow-up). A single
 * stranger-path failure (Resend SDK/API rejection) is rare and carries no
 * address-class signal on its own; a burst of them in a short window is what
 * a Resend outage or a lapsed API key/domain looks like, and that failure
 * mode hits every stranger send alike, never the registered-student path
 * (`createNotification`, a local DB insert) — so treating a burst as
 * "suppress the per-row signal" is what keeps `lastNotifyFailedAt` from
 * becoming a proxy for "does this address have a fair.yoga account."
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

/** Test-only. Vitest isolates module state per file, not per test. */
export function __resetDispatchFailureTrackingForTests(): void {
  recentFailures = [];
}
```

**1b — Attempt-scoped CAS (closes Critical #3, the staleness race).** `deliverInvitation`
gains a required `dispatchedAt: Date` field on its input — the exact `Date` value the caller
already wrote synchronously into `lastNotifiedAt` moments earlier. The failure `updateMany`'s
`where` becomes `{ id: input.invitationId, lastNotifiedAt: input.dispatchedAt }` instead of
`{ id: input.invitationId }` alone: if a later attempt's own synchronous pre-write has already
moved `lastNotifiedAt` on by the time this (earlier, superseded) attempt's failure resolves,
this write matches zero rows and is a correct no-op — the row's current state belongs to the
newer attempt, not this one.

```ts
// src/services/invitations.ts — deliverInvitation
export function deliverInvitation(
  db: PrismaClient,
  input: {
    teacherId: string; email: string; invitationId: string; source: DeliverySource;
    dispatchedAt: Date;
  },
): FireAndForget {
  void (async () => {
    const teacher = await db.teacher.findUniqueOrThrow({
      where: { id: input.teacherId },
      select: { firstName: true, lastName: true },
    });
    await notifyInvitee(db, {
      teacherId: input.teacherId, email: input.email,
      teacherName: `${teacher.firstName} ${teacher.lastName}`,
    });
  })().catch((err: unknown) => {
    log.error(
      { err, teacherId: input.teacherId, invitationId: input.invitationId },
      DELIVERY_FAILURE_MESSAGE[input.source],
    );

    const { looksSystemic } = recordDispatchFailure();
    if (looksSystemic) return; // #392 oracle-safety: see notify-health.ts

    db.invitation
      .updateMany({
        // Scoped by the dispatch-time lastNotifiedAt, not just id: a
        // superseded attempt's late failure must not overwrite a newer
        // attempt's row state (#392 review, Critical #3).
        where: { id: input.invitationId, lastNotifiedAt: input.dispatchedAt },
        data: { lastNotifyFailedAt: new Date() },
      })
      .catch((writeErr: unknown) => {
        log.error({ err: writeErr, invitationId: input.invitationId }, 'failed to record notify failure');
      });
  });
}
```

Callers (`src/app/api/students/route.ts`, `src/app/api/invitations/[id]/resend/route.ts`):
capture the synchronous write's `new Date()` into a `const dispatchedAt`, reuse it in both the
write and the `deliverInvitation` call:

```ts
// students/route.ts
const dispatchedAt = new Date();
await prisma.invitation.updateMany({
  where: { id: result.value.id },
  data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: parsed.data.email, lastNotifyFailedAt: null },
});
// ...
if (result.value.delivered) {
  deliverInvitation(prisma, {
    teacherId: session.teacherId, email: parsed.data.email,
    invitationId: result.value.id, source: 'create', dispatchedAt,
  });
}
```

```ts
// resend/route.ts — same shape
const dispatchedAt = new Date();
const updated = await prisma.invitation.updateMany({
  where: { id },
  data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: invitation.email, lastNotifyFailedAt: null },
});
if (updated.count === 0) return NOT_FOUND();
deliverInvitation(prisma, {
  teacherId: session.teacherId, email: invitation.email,
  invitationId: id, source: 'resend', dispatchedAt,
});
```

**Tests:**
- `src/lib/notify-health.test.ts` (new): a single failure doesn't look systemic; the 3rd
  failure within the window does; failures older than 5 minutes age out (fake timers);
  `__resetDispatchFailureTrackingForTests` actually clears state.
- `invitations.deliver.test.ts`: extend the existing failure test to call
  `__resetDispatchFailureTrackingForTests()` in `beforeEach`, and pass `dispatchedAt`. Add: (a)
  three consecutive dispatch failures in a row — assert the row touched by the 3rd gets no
  `lastNotifyFailedAt` (suppressed), the first two do; (b) a failure whose `dispatchedAt` no
  longer matches the row's current `lastNotifiedAt` (simulating a superseded attempt) writes
  nothing — seed the row, call `deliverInvitation` with a `dispatchedAt` one hour in the past,
  assert `lastNotifyFailedAt` stays null.
- **Re-run the exact mutation the pr-test-analyzer used** (revert `notifyInvitee`'s blocked/
  linked early returns to throw) against the *fixed* integration tests below, to confirm they
  now catch it — see Fix 2.

## Fix 2 (Critical #2): synchronize the two vacuous oracle-safety tests

`tests/integration/invitations-api.test.ts:816`, `:1027` — both read the row immediately after
the HTTP response, before the fire-and-forget dispatch has necessarily settled. Wrap both
assertions in `vi.waitFor` (or this file's existing polling helper, `waitFor` — check which
one the file already imports and match it) so they wait for the dispatch to actually resolve
before checking `lastNotifyFailedAt`, the same pattern the file already uses a few lines below
the blocked-address test for its own "control" notification.

**Verification (do this, don't just trust the diff):** with the fix applied, repeat the
pr-test-analyzer's mutation — temporarily change `notifyInvitee`'s `if (blocked) return;` to
`if (blocked) throw new Error('mutation-proof #392');`, run the blocked-address test, confirm
it now fails; restore; confirm green. Same for the already-linked branch against the decoy
test. This is the only way to know the fix actually closes the gap the review proved was open.

## Fix 3 (Important #7): the dropped `notifyInvitee`-unit-level already-linked test

Add to `src/services/invitations.notify.test.ts`, extending the existing `'sends nothing at
all to a student already on this teacher's roster (#412)'` test (or a sibling right after it):
call `deliverInvitation` (not just `notifyInvitee`) against a real `Invitation` row for the
already-linked student, force the outer dispatch to still resolve normally (it does — the
early return means no throw), and assert `lastNotifyFailedAt` stays null. This is the spec's
own Tests item 3, silently dropped from the original plan; carrying it in now closes the last
gap the review found in coverage of the two withheld paths.

## Fix 4 (Important #4, #5, #9): correct the three overclaiming/overreaching docblocks

- `src/services/invitations.ts` (`deliverInvitation`'s docblock): remove "matching every other
  background write in this file" (false — no other background write exists there). Add one
  sentence on the circuit breaker and the CAS scoping, stating what's now actually true.
- `src/lib/contacts.ts` (`invitationDeliveryStatus`'s docblock): cut the three-to-four-file
  membership roster (which routes clear the column) down to what this function itself relies
  on — the `lastNotifiedEmail === email` gate it performs — and link to
  `docs/data-model.md`'s `last_notify_failed_at` row for the cross-file facts instead of
  restating them. Correct "carries the same non-disclosure property `state: 'sent'` always
  has" to state the real, narrower property post-fix (bounded exposure via the circuit
  breaker, not zero exposure).
- `docs/data-model.md`'s `last_notify_failed_at` row: replace "the same two events... those two
  sites" with a description that doesn't count in prose (name what triggers clearing, not how
  many places do it), and add the circuit-breaker and CAS-scoping behavior.

## Fix 5 (Important #6): exhaustive render in `page.tsx`

Replace the three independent `&&` expressions with a `Record<Delivery['state'], (at?: Date) =>
string>`-style lookup or an exhaustive `switch` with a `never` default, matching `STATUS_LABEL`
two lines above it in the same file. While here: apply `text-danger` (already used the same way
in `students/[id]/page.tsx:137`) to the `'failed'` line only — a minimal, in-design-system
distinguishing treatment that closes part of the PR-body gap (Fix 6) without adding scope
(no advice text, no new component).

## Fix 6 (Important #8): correct the PR body

Once Fix 5's `text-danger` treatment lands, update the PR body to describe what's actually
there (a distinguishing color, no advice copy) rather than the invented "warning state...
advising the teacher to check the email address and retry."

## Fix 7 (Important #10): test the inner `.catch`'s own failure path, and desync-proof the
positive test

- New test in `invitations.deliver.test.ts`: mock `prisma.invitation.updateMany` to reject
  once, force the outer dispatch to also fail, assert no unhandled rejection and a second
  `log.error` call with `'failed to record notify failure'` — the silent-failure-hunter's
  suggested test, taken directly.
- The existing `'records a delivery failure on the invitation row (#392)'` test: move the DB
  read inside `vi.waitFor` instead of a single read after waiting on the log call.

## Fix 8 (Important #11, #12): comment completeness

- `src/app/api/invitations/[id]/route.ts`'s `readdressed` comment: add one clause noting
  `lastNotifyFailedAt: null` rides along with `delivered: false` for the same reason.
- `src/app/api/invitations/[id]/resend/route.ts`'s marker docblock: update "The marker write
  below (`lastNotifiedAt`/`lastNotifiedEmail`)" to name the third field now written
  unconditionally alongside them.

## Fix 9 (Important #13): test fixture conventions

`src/services/invitations.deliver.test.ts`'s new `beforeAll`/`afterAll`: switch to a single
`` `${Date.now()}-${crypto.randomBytes(3).toString('hex')}` `` suffix computed once (matching
`invitations.notify.test.ts:19`), and replace the hand-rolled teardown with `teardownTeacher`
from `tests/helpers.ts` (the helper `main`'s `d7733c74` standardized on).

## Verification before pushing

1. Each fix's own test(s) green.
2. Both mutation-proofs from Fix 2 actually performed (revert → red → restore → green),
   output recorded in the PR body update.
3. `pnpm run worktree:up` (this worktree's isolated app), then `pnpm run verify` — typecheck,
   lint, full suite. Record the pass counts.
4. `git status --short` clean, `pnpm run worktree:down` when done.

## Out of scope (unchanged from the original PR)

- The readdress-away-and-back edge case (accepted, documented cost of no paired
  `lastNotifyFailedEmail` column).
- Building a real UI affordance beyond the caption + color (no banner, no retry button, no
  "delivery degraded" indicator) — the circuit breaker's suppression is invisible to the
  teacher by design. **Correction, found in the first re-review**: this originally said
  suppression "falls back to `'not-sent'`" — false. `lastNotifiedAt`/`lastNotifiedEmail` are
  already written by the time suppression is even decided, so a suppressed row reads
  `'sent'`, identical to pre-#392 behaviour for every failure. Not a new UI lie, just the old
  one, and still a deliberate no-new-UI-state choice — but the plan's own justification for it
  was wrong on the day it shipped.
