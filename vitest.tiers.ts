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
// NOT a complete census of files that take locks, and it never was one.
// Taking one is not the trigger; being unable to share a tier is. A file whose
// locks are all on rows and keys it minted itself, whose parked transactions
// wait for a release rather than for a clock, and none of whose assertions is
// a bound or an elapsed time can hold real locks in `unit` — tier noise cannot
// make any assertion in it wrong. It can still make such a file SLOWER, and a
// file with no per-test timeout of its own runs under vitest's 5s default, so
// enough noise could in principle end one as a test timeout; what rules that
// out is margin, measured per file in the verdict that kept it here.
//
// MEMBERSHIP IS HELD BY THE MARKER, NOT BY A COMMAND. Every file below carries
// `@serial-tier lock-contention` in its own header, with the reason that file
// cannot share a parallel tier, and `src/lib/serial-tier-membership.test.ts`
// fails if the markers and this array disagree in either direction, or if a
// listed path stops existing. That pair is the whole membership rule: no
// command decides it, and a file whose machinery no command can see joins the
// same way every other one does — #468 added `update-class-lock-order.test.ts`
// and `template-room-race.test.ts`, neither of which writes lock machinery in
// its own source text, so no lock-shaped search reaches either.
//
// #459 and #468 carry the written verdicts, each with its measurement — moved
// here, or measured and kept in the parallel tier. A roster here would be a
// second copy of them.
//
// For FINDING a file that belongs here, the command below reaches the
// SQLSTATE-shaped ones, asserted in either direction:
//
//   grep -rlE '(not\.)?toMatch\(/[^/]*(40P01|55P03|deadlock|lock timeout)' src --include='*.test.ts'
//
// Every hit needs a verdict; not every hit belongs. And it is a floor rather
// than a census — the same assertion is also written `toBe('returned')`,
// `toEqual({ ok: true, … })` and `expect(elapsedMs).toBeGreaterThan(5_000)`,
// which no regex reaches. #459 records both census attempts that failed and
// why the property is not recoverable from source text.
export const LOCK_CONTENTION_TESTS = [
  // Each file's own reason lives in its own header, beside the code that makes
  // it true, and the membership test keeps the two from parting company. Only
  // what is NOT visible from a single file is recorded here.
  'src/services/room-archive-lock-order.test.ts',
  'src/services/template-lock-order.test.ts',
  'src/services/class-lifecycle-tier-guard.test.ts',
  'src/lib/db-locks-lock-order.test.ts',
  'src/services/invitations-lock-order.test.ts',
  // Split out of `gdpr.test.ts` rather than moving that file, which runs in
  // ~26s: moving all of it cost the serial tier +92% (37.8s -> 72.6s). The
  // same move `class-lifecycle-tier-guard.test.ts` made, for the same reason,
  // and the one made for the `*-lock-order.test.ts` siblings below — each
  // states its own reason in its own header. No test count here — the
  // argument is about time, and a count moves whenever someone adds a case.
  'src/services/gdpr-lock-order.test.ts',
  'src/services/roster-link.test.ts',
  // The first kind again: its room-deleted-mid-create race holds a
  // transaction open — via an external release signal, for ~1s — via an
  // uncommitted `DELETE FROM "TeacherRoom"`, while `POST /api/classes`'s own
  // transaction contends for the same row's `FOR KEY SHARE`, the same shape
  // as `roster-link.test.ts` (issue 339).
  'src/app/api/classes/route.test.ts',
  // The first kind again: each of its two cases holds a real row lock for
  // the length of a staged race (~1s), the same shape as
  // `room-archive-lock-order.test.ts` (issue 339).
  'src/services/class-room-race.test.ts',
  // #459: split out of `waitlist.test.ts` for the same reason.
  'src/services/waitlist-lock-order.test.ts',
  // #459: split out of `class-template-lifecycle.test.ts` for the same reason.
  'src/services/class-template-lifecycle-lock-order.test.ts',
  // #468: no extraction — the file was already the sibling, so it needed only
  // the marker and this entry.
  'src/services/transition-class-lock-order.test.ts',
  // #468: split out of `class-lifecycle.test.ts`, which already had a serial
  // sibling for a different mechanism — each file's header carries its own.
  'src/services/class-lifecycle-lock-order.test.ts',
  // #468: split out of `studio-class-template-lifecycle.test.ts` for the same
  // reason — the sibling's own header carries it, case by case.
  'src/services/studio-class-template-lifecycle-lock-order.test.ts',
  // #468: split out of `class-generator.test.ts`, which keeps every case that
  // stages nothing — the sibling's header gives the reason, shape by shape.
  'src/services/class-generator-lock-order.test.ts',
  // #468, and found by reading rather than by any command: neither writes lock
  // machinery in its own source text — one locks inside `completeClass`, the
  // other through a foreign-key cascade — so every text search for it walks
  // past them. No extraction — each is one test and the whole file is the
  // staged race.
  'src/services/update-class-lock-order.test.ts',
  'src/services/template-room-race.test.ts',
] as const;

// The two lists above have different reasons and are kept apart so neither
// comment has to describe the other's membership. This is what `vitest.config.ts`
// splices into both projects, so a file added to either list moves tiers in one
// edit.
export const SERIAL_TESTS = [...SWEEP_TESTS, ...LOCK_CONTENTION_TESTS];
