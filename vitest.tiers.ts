/**
 * Which test files cannot run in the parallel `unit` tier, and why.
 *
 * Beside `vitest.config.ts` rather than inside it because two things need
 * these lists: the config, which splices `SERIAL_TESTS` into the two projects,
 * and `src/lib/serial-tier-membership.test.ts`, which holds
 * `LOCK_CONTENTION_TESTS` against the markers in the files it names. A config
 * file cannot supply the second — adding a named export beside its default one
 * makes Rollup warn on every vitest invocation.
 */

// Files testing a service whose sweep writes rows it was never handed, with
// no scope parameter to pass. One list, spliced into `unit-sweeps`'s
// `include` and `unit`'s `exclude`, so the two cannot drift apart.
export const SWEEP_TESTS = [
  'src/lib/auth/magic-link.test.ts',
  'src/services/class-transitions.test.ts',
  'src/services/waitlist-reconciliation.test.ts',
  'src/services/waitlist-retention.test.ts',
  'src/services/auth-cleanup.test.ts',
  'src/services/email-fallback.test.ts',
  'src/services/email-fallback.consent.test.ts',
  'src/services/notifications.test.ts',
  'src/services/payment-reminders.test.ts',
  'src/services/studio-class-generator.test.ts',
] as const;

// Files that cannot run in `unit`'s parallel tier because of LOCK TIMING —
// either they create it or they measure it. Two kinds, one list, because both
// need the same thing:
//
//   - files that hold a real row lock for seconds at a time
//     (`room-archive-lock-order.test.ts`), and
//   - files whose assertion is destroyed by that noise
//     (`template-lock-order.test.ts`, which asserts its race ends in neither
//     `40P01` nor `55P03` — so any lock noise in the tier is a false failure
//     it cannot tell from the defect it watches for).
//
// The trigger is the tier's contention budget rather than any one call site:
// removing issue 272's new `setLockTimeout` and skipping the new cases still
// left the tier failing intermittently, while the branch before them did not.
// Issue 272's mirror foreign keys take row locks no application code asks for,
// which is that budget getting tighter.
//
// NOT a complete census of files that hold locks. `room-archive.test.ts` still
// holds one in `unit` — a `ClassTemplate` `FOR UPDATE` kept until the resume
// answers, under a 6s ceiling, not the flat 2.5s this note used to claim.
// What makes that tolerable is that no file left in the tier reads lock timing
// to assert on, and the sweep above is what re-established it: this note
// previously said the holder was safe "because the assertion-side file left
// the tier" while THREE assertion-side files were still in it. The claim was
// true of `template-lock-order.test.ts` alone and was read as true of the
// tier. Adding a case that reads lock timing to a parallel file is what this
// list exists to catch — re-derive the census with:
//
//   grep -rln 'not.toMatch(/[^/]*\(40P01\|55P03\)' src --include='*.test.ts'
//
// Every hit belongs on this list.
export const LOCK_CONTENTION_TESTS = [
  'src/services/room-archive-lock-order.test.ts',
  'src/services/template-lock-order.test.ts',
  // The third kind: a file whose DDL takes ACCESS EXCLUSIVE on a table the
  // rest of the tier reads. `class-lifecycle-tier-guard.test.ts` drops and
  // re-adds a CHECK on `Registration`, so it queues behind every concurrent
  // user of that table and blocks them in turn. Its own header carries the
  // measurement.
  'src/services/class-lifecycle-tier-guard.test.ts',
  // Added by the preventive sweep the paragraph below asks for, and all three
  // are the SECOND kind: each asserts a staged race ends in neither `40P01`
  // nor `55P03`, so tier noise is a false failure none of them can tell from
  // the defect it watches for — `template-lock-order.test.ts`'s exact shape.
  // Found by looking, not by failing.
  'src/lib/db-locks-lock-order.test.ts',
  'src/services/invitations-lock-order.test.ts',
  // Split out of `gdpr.test.ts` rather than moving it: that file runs in
  // ~26s and exactly one of its tests reads lock timing, so moving all of it
  // cost the serial tier +92% (37.8s -> 72.6s) against +2.5s extracted. Same
  // move `class-lifecycle-tier-guard.test.ts` made, for the same kind of
  // reason. No test count here — the argument is about time, and a count
  // moves every time someone adds a case to that file. The sibling copy of
  // this note in `gdpr-lock-order.test.ts` was de-numbered for the same
  // reason; this one was missed and went stale.
  'src/services/gdpr-lock-order.test.ts',
  // The first kind again: its insert-race test holds a transaction open —
  // via an external release signal, for 200ms+ — while a concurrent
  // `linkTeacherStudent` call contends for the same uncommitted
  // `(teacherId, studentId)` tuple, the same shape as
  // `room-archive-lock-order.test.ts`.
  'src/services/roster-link.test.ts',
] as const;

// The two lists above have different reasons and are kept apart so neither
// comment has to describe the other's membership. This is what the projects
// below splice, so a file added to either list moves tiers in one edit.
export const SERIAL_TESTS = [...SWEEP_TESTS, ...LOCK_CONTENTION_TESTS];
