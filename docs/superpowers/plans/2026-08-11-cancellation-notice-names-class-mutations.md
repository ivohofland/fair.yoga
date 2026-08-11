# #200 mutation ledger

Four mutations, two per body: a wholesale revert, and a single dropped field.
The second is the realistic regression — an edit that trims the sentence — and
it is the one a whole-string equality assertion would have caught while a
`toContain('Hatha')` alone would not.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | Teacher body names the class | revert to the pre-#200 text | auto-cancel teacher note | `AssertionError: expected 'Hatha was cancelled — only 0 of 4 min…' to contain 'Monday, 20 Jul'` |
| 2 | Teacher body carries the time | drop ` at ${fresh.startTime}` | auto-cancel teacher note | `AssertionError: expected 'Hatha class on Monday, 20 Jul was can…' to contain '18:00'` |
| 3 | Route body names the class | revert to the pre-#200 text | cancellation notice (integration) | `AssertionError: expected 'Classes API Notice has been cancelled…' to contain 'Monday, 1 Jun'` |
| 4 | Route body carries the time | drop ` at ${cls.startTime}` | cancellation notice (integration) | `AssertionError: expected 'Classes API Notice class on Monday, 1…' to contain '09:00'` |

Mutations 3 and 4 run against the app on :3000, so each needs a save-and-recompile
before the re-run — a mutation "passing" without one means the old bundle answered.
Both failed with the mutated source's own text in the `Received` line, which is the
evidence the recompile happened before the assertion ran.
