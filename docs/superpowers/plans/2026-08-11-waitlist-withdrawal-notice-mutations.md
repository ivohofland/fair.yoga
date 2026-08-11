# #112 mutation ledger

Every guard this branch adds, broken and observed to fail. Per §3 of the
solve-issue skill: a pin that compiles but cannot fail certifies nothing.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | `WaitlistEntry.class` cascade | FK → `ON DELETE RESTRICT` on the test DB | cascade pin | `PrismaClientKnownRequestError: Foreign key constraint violated on the constraint: \`WaitlistEntry_classId_fkey\`` |
| 2 | Auto-cancel waitlist read | delete the `findMany`, drop the spread | auto-cancel notice | `AssertionError: expected null not to be null` |
| 3 | Auto-cancel `removed` update | delete the `updateMany` | auto-cancel entry status | `AssertionError: expected 'waiting' to be 'removed'` |
| 4 | Erasure concatenation | `recipients` → `registrations` | queue-only erasure | `AssertionError: expected null not to be null` |
| 5 | Erasure empty-list guard | back to `registrations.length > 0` | queue-only erasure | `AssertionError: expected null not to be null` |
| 6 | Erasure `removed` update (pre-existing) | delete the `updateMany` | erasure entry status | `AssertionError: expected 'waiting' to be 'removed'` |
| 7 | Archive candidate read | delete the read + notify block | archive notice | `PrismaClientKnownRequestError: Invalid \`prisma.notification.findFirstOrThrow()\` invocation` (P2025, row not found) |
| 8 | Archive **survivor filter** | `withdrawn = candidates` | concurrency test | `AssertionError: expected 1 to be +0` |

## Round 2 — added after PR review

PR review measured three of the guards above as weaker than this table claimed,
and found four mutations nothing caught. All re-measured after the fix wave.

| # | Guard | Mutation | Tests that failed | Observed |
|---|---|---|---|---|
| 9 | Archive **per-class** survivor logic | `withdrawn = survived.size === 0 ? candidates : []` | mixed-batch | `expected +0 to be 1` — before the mixed-batch test existed this mutation passed the entire file |
| 10 | Archive `status: 'waiting'` filter | drop it from the candidate read | already-left-the-queue | a student who left the queue is notified; `expected 1 to be +0` |
| 11 | **Candidate read stays wider than the delete** | re-add `registrations: { none: … }` to it | became-deletable race | `NotFoundError: No Notification found` — the C1 regression guard |
| 12 | Auto-cancel registered audience | `[...registrations, ...waiting]` → `[...waiting]` | auto-cancel notice | `expected null not to be null` |
| 13 | Auto-cancel `status: 'waiting'` filter | drop it from the recipient read | auto-cancel notice | `expected 1 to be +0` |
| 14 | Erasure body names the class | revert to the pre-#112 text | queue-only erasure | `expected '…has been cancelled — the te…' to contain 'Lock class class on…'` |

**Guard 8 got stronger, and the reason is the point.** It used to fail exactly
one test — the concurrency test — because the candidate read mirrored the
delete, so a spared class was never a candidate and the ordinary "spared" test
could not tell `withdrawn = candidates` from the real filter. Widening the
candidate read (guard 11) made the survivor filter load-bearing in the ordinary
case too. Mutation 8 now fails **three** tests, not one.

**The concurrency test's canary was defeatable.** `expect(raced).toBe(true)`
only proved the interposition fired *somewhere*. Review measured mutation 8
**passing** when one extra `waitlistEntry.findMany` was added anywhere earlier
in the archive branch: the race landed on the wrong read, the candidate read
came back empty, and every assertion was satisfied. Now pinned with
`expect(calls).toBe(1)` and `expect(candidateRows).toBe(1)` — the same shape
`gdpr.test.ts:1046` already used.

Guards 2, 4 and 7 remain provable by a single non-concurrent test. Guards 8 and
11 are the two that need real concurrency, and they need it in opposite
directions: 8 is "spared in the gap, so do not notify", 11 is "became deletable
in the gap, so do notify".
