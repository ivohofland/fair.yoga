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

**Guard 8 is the one that matters.** Guards 2, 4 and 7 are all provable by a
single non-concurrent test. Guard 8 is invisible to every such test — mutation
8 was run against the two ordinary archive tests as well, and both stayed
green. Record that here, because it is the argument for why the concurrency
test earns its complexity.
