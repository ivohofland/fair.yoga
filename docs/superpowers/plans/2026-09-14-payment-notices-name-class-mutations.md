# #202 mutation ledger

Eight mutations across the four payment notification bodies: two per body (a wholesale revert and a single dropped time field).
The second mutation per body is the realistic regression — an edit that trims the sentence — and it is what justifies three separate `toContain` substring assertions over a single whole-string equality assertion.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | Student payment request names the class | revert to pre-#202 text | `completeClass` (`class-lifecycle.test.ts`) | `AssertionError: expected 'Your price for Vinyasa is €8.90. Pay …' to contain 'Monday, 1 Jun'` |
| 2 | Student payment request carries the time | drop ` at ${timeToHHmm(…)}` | `completeClass` (`class-lifecycle.test.ts`) | `AssertionError: expected 'Your price for Vinyasa class on Monda…' to contain '18:00'` |
| 3 | Teacher payment notice names the class | revert to pre-#202 text | `completeClass` (`class-lifecycle.test.ts`) | `AssertionError: expected 'Vinyasa completed — €15.00 earnings, …' to contain 'Monday, 1 Jun'` |
| 4 | Teacher payment notice carries the time | drop ` at ${timeToHHmm(…)}` | `completeClass` (`class-lifecycle.test.ts`) | `AssertionError: expected 'Vinyasa class on Monday, 1 Jun comple…' to contain '18:00'` |
| 5 | Manual payment reminder names the class | revert to pre-#202 text | `sendPaymentReminder` (`payments.test.ts`) | `AssertionError: expected '€24.59 for Hatha is still open. Pay y…' to contain 'Monday, 1 Jun'` |
| 6 | Manual payment reminder carries the time | drop ` at ${timeToHHmm(…)}` | `sendPaymentReminder` (`payments.test.ts`) | `AssertionError: expected '€24.59 for Hatha class on Monday, 1 J…' to contain '09:00'` |
| 7 | Automated payment reminder names the class | revert to pre-#202 text | `sendPaymentReminders` (`payment-reminders.test.ts`) | `AssertionError: expected '€12.50 for PayRem Hatha is still open…' to contain 'Monday, 1 Jun'` |
| 8 | Automated payment reminder carries the time | drop ` at ${timeToHHmm(…)}` | `sendPaymentReminders` (`payment-reminders.test.ts`) | `AssertionError: expected '€12.50 for PayRem Hatha class on Mond…' to contain '09:00'` |

## Acceptance grep verification

Every notification `body:` template in `src/` about a specific class (cancellations and payments) now standardizes on `formatDayHeader` and `timeToHHmm`:

```bash
grep -rn "has been cancelled\|was cancelled\|has been withdrawn\|Your price for\|completed —\|is still open" src --include="*.ts" | grep -v "\.test\.ts" | grep "body:"
```

Result: 9 sites (5 cancellations + 4 payments), 9 occurrences of `formatDayHeader` and `timeToHHmm`.
