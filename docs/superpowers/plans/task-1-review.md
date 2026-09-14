# Task 1 Review: Pre-lock Superset Property Test in Any Session TimeZone (#289)

**Issue:** #289  
**Plan:** `docs/superpowers/plans/2026-09-14-pre-lock-superset-timezone.md`  
**Implementer Report:** `docs/superpowers/plans/task-1-report.md`  
**Reviewer:** Review Subagent  
**Date:** 2026-09-14  

---

## Verdict: APPROVED

The implementation of Task 1 meets all requirements defined in the plan, adheres strictly to project guidelines, and provides robust verification of the pre-lock superset property across time zones.

---

## Review Checklist & Findings

### 1. Spec Compliance
- **Time zones**: Tests all 6 required session time zones: `'UTC'`, `'Europe/Amsterdam'`, `'Asia/Tokyo'`, `'Pacific/Kiritimati'`, `'America/New_York'`, and `'Pacific/Niue'`.
- **Bound values**: Uses `utcMidnight = '2026-08-15 00:00:00+00'` and `instant = '2026-08-15 22:30:00+00'`.
- **Query**: Compares `(d > DATE '2026-08-15')` with `(d > TIMESTAMPTZ '${utcMidnight}')` over a 3-day sample set (`2026-08-14`, `2026-08-15`, `2026-08-16`).
- **Property Assertion**: Enforces the implication `row.reread => row.shipped`, guaranteeing the pre-lock is always a superset (or equal) to the re-read deletion set.
- **Negative Control**: Explicitly asserts that for east-of-UTC zones (`Asia/Tokyo` and `Pacific/Kiritimati`), `tomorrow.rawInstant` is `false` while `tomorrow.shipped` is `true`. This prevents vacuous passing if Postgres timezone promotion semantics change.

### 2. Isolation & Safety
- Each timezone probe is isolated within `prisma.$transaction(async (tx) => ...)` executing `SET LOCAL TimeZone = '${timeZone}'`.
- Because `SET LOCAL` is scoped to the transaction, it does not leak session configuration to connection pool connections or subsequent tests.

### 3. Verification & Test Execution
- Vitest run for the specific test:
  ```bash
  pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "the pre-lock bound never selects fewer rows"
  ```
  **Result:** Passed (1 passed, 65 skipped, 1.55s).
- Vitest run for the entire test file:
  ```bash
  pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts
  ```
  **Result:** Passed (66 passed, 3.35s).
- Typecheck:
  ```bash
  pnpm run typecheck
  ```
  **Result:** Clean exit (code 0).
- ESLint:
  ```bash
  pnpm run lint
  ```
  **Result:** 0 errors (clean pass, only pre-existing client warnings).

### 4. Code Quality & Comments
- Comments in `src/services/class-template-lifecycle.test.ts` clearly explain the mathematical containment property, why an implication (superset) rather than strict equality is asserted, and the role of the negative control.
- Types are strictly defined on the `$queryRawUnsafe` call with no `any`.

---

## Conclusion
Task 1 is complete and approved. Proceed to Task 2.
