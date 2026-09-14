# Code Review: PR #597 (Issue #207) — Toggle-Payload & Result Type Pins

- **PR:** #597
- **Branch:** `fix/207-toggle-payload-type-pins` against `main`
- **Issue:** #207 (Express toggle payload and lifecycle result non-interchangeability with `NoneOf` pins)
- **Plan Reference:** [`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md)
- **Mutation Ledger:** [`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md)
- **Review Date:** 2026-09-14
- **Reviewer:** Antigravity Code Reviewer
- **Overall Verdict:** **APPROVE WITH MINOR ADVISORY FIX** (1 comment discipline finding with confidence ≥ 80)

---

## 1. Reviewed Files

The entire diff of `git diff main..HEAD` across 30 files was examined:

### Source Files
- [`src/lib/api-types.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-types.ts) — Replaced legacy `Assert<Equals<..., false>>` with `NoneOf` compile-time pins (`_classIsNotStudio`, `_studioIsNotClass`).
- [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts) — Added `NoneOf` compile-time pins for `ArchiveRuleResult`, `PauseRuleResult`, and `UpdateRuleResult`; updated docblocks to remove obsolete cross-module test citations.
- [`src/services/studio-class-editability.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.ts) — Added `_illegalVerdictCannotStand` `NoneOf` pin asserting that `dateEditable` cannot stand without `scheduleEditable`.

### Test Files (Cleanups & Documentation Alignment)
- [`src/components/settings/template-action-messages.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/components/settings/template-action-messages.test.ts) — Removed redundant test-level `@ts-expect-error` non-interchangeability assertion.
- [`src/services/rule-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts) — Removed redundant `@ts-expect-error` test calls; retained positive assertions; updated docblocks.
- [`src/services/studio-class-editability.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-editability.test.ts) — Removed migrated test-level `_illegalVerdict` `@ts-expect-error` assignment; updated docblock.
- [`src/lib/api-utils.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-utils.test.ts) — Added `npm run typecheck` only docblocks for `@ts-expect-error` directives.
- [`src/lib/db-locks.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/db-locks.test.ts) — Documented typecheck-only enforcement.
- [`src/lib/entry-conflict.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/entry-conflict.test.ts) — Documented typecheck-only enforcement.
- [`src/lib/registration-status.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/registration-status.test.ts) — Documented typecheck-only enforcement.
- [`src/lib/rule-slot-holder.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/rule-slot-holder.test.ts) — Documented typecheck-only enforcement.
- [`src/lib/timezone.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/timezone.test.ts) — Documented typecheck-only enforcement.
- [`src/lib/worktree/identity.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/worktree/identity.test.ts) — Documented typecheck-only enforcement.
- [`src/lib/worktree/registry.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/worktree/registry.test.ts) — Documented typecheck-only enforcement.
- [`src/services/class-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-lifecycle.test.ts) — Documented typecheck-only enforcement.
- [`src/services/class-template-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle.test.ts) — Documented typecheck-only enforcement.
- [`src/services/entry-generation.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/entry-generation.test.ts) — Documented typecheck-only enforcement.
- [`src/services/studio-class-deletion.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-deletion.test.ts) — Documented typecheck-only enforcement.
- [`src/services/studio-class-template-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-template-lifecycle.test.ts) — Documented typecheck-only enforcement.

### Documentation & Plan Artifacts
- [`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md)
- [`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md)
- [`docs/superpowers/plans/task-1-report.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-1-report.md)
- [`docs/superpowers/plans/task-1-review.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-1-review.md)
- [`docs/superpowers/plans/task-2-report.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-2-report.md)
- [`docs/superpowers/plans/task-2-review.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-2-review.md)
- [`docs/superpowers/plans/task-3-report.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-3-report.md)
- [`docs/superpowers/plans/task-3-review.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-3-review.md)
- [`docs/superpowers/plans/task-4-report.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-4-report.md)
- [`docs/superpowers/plans/task-4-review.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/task-4-review.md)
- [`docs/superpowers/plans/whole-branch-review.md`](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/whole-branch-review.md)

---

## 2. Executive Summary & Quality Assessment

PR #597 addresses Issue #207 by elevating type non-interchangeability checks from brittle runtime test files with `@ts-expect-error` into compile-time invariant pins located directly beside the relevant type declarations.

### Key Strengths:
1. **Canonical `NoneOf` Pin Idiom**: All 9 new compile-time pins (`src/lib/api-types.ts`, `src/services/rule-lifecycle.ts`, `src/services/studio-class-editability.ts`) strictly follow the canonical shape:
   ```ts
   const _pinName: NoneOf<
     Condition extends Offender
       ? 'Condition extends Offender'
       : never
   > = true;
   void _pinName;
   ```
   This guarantees that any invariant violation causes the TypeScript compiler (`tsc --noEmit`) to reject compilation with an informative error naming the exact offending condition (`Type 'true' is not assignable to type '"<OffenderDescription>"'`).
2. **Elimination of Unsafe Casts & Redundant Tests**:
   - Replaced `void 0 as unknown as [_classIsNotStudio, _studioIsNotClass];` in `api-types.ts` with typed `const` / `void` pairs.
   - Removed duplicate `@ts-expect-error` tests in `template-action-messages.test.ts` and `rule-lifecycle.test.ts` that merely asserted non-assignability via dummy `expect(true).toBe(true)` calls.
3. **Comprehensive Typecheck-Only Enforcement Audit**: All 15 test files containing call-site `@ts-expect-error` directives now explicitly document that their enforcement is handled by `npm run typecheck` (`tsc --noEmit`) only and is invisible to Vitest runtime test execution.
4. **Empirical Mutation Proofs**: The mutation ledger (`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`) documents 6 live mutation probes across all newly introduced pins, recording exit codes (2) and verbatim compiler diagnostic messages demonstrating that each guard fails RED as intended when broken.

---

## 3. High-Confidence Issues (Confidence ≥ 80)

Only one issue meets the confidence threshold of ≥ 80. It is an explicit violation of the **Comment Discipline** rules established in [`CLAUDE.md`](file:///Users/ivohofland/Projects/fair.yoga/CLAUDE.md).

### Issue 1: Hardcoded Count in JSDoc Comment Docblock

- **Severity & Confidence**: **Important (Confidence: 85/100)**
- **Location**: [`src/services/rule-lifecycle.test.ts:95`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95)
- **Guideline Violation**:
  [`CLAUDE.md`](file:///Users/ivohofland/Projects/fair.yoga/CLAUDE.md) under **Comment Discipline** specifies:
  > *"Never write a count or a member list in prose — name the type. 'Every `SkipCounts` member' survives a fifth member; a prose roster does not. `countSkipReasons`'s docblock had its member counts refreshed and its call-site roster left stale, and so described a state this repo was never in."*
  > *"Counts are legitimate in `docs/` and in this file — that is what having an owner looks like — and they ship with the command that re-derives them, as `docs/lock-order.md` does for `FOR UPDATE OF`. In a comment, never."*

- **Explanation**:
  Line 95 of `src/services/rule-lifecycle.test.ts` states:
  ```ts
   * The 7 `@ts-expect-error` property assignment checks below are verified by
   * `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test
   * execution (tests do not typecheck or transpile types).
  ```
  Specifying the literal number `7` in prose creates an immediate comment-rot vulnerability if an 8th `@ts-expect-error` check is added (e.g., when adding a new family or template property) or if checks are refactored.
  Notice that all other 14 test files updated during Task 4 adhered strictly to this rule by avoiding prose numbers (e.g. `src/lib/api-utils.test.ts:107` states *"The `@ts-expect-error` compile-time type assertions below are verified by..."* and `src/lib/db-locks.test.ts:53` states *"These checks are verified by..."*).

- **Concrete Fix**:
  Remove `"7 "` from line 95 of `src/services/rule-lifecycle.test.ts`:
  ```diff
  --- a/src/services/rule-lifecycle.test.ts
  +++ b/src/services/rule-lifecycle.test.ts
  @@ -93,3 +93,3 @@ describe('rule-lifecycle family descriptors', () => {
      * A claim about what the compiler refuses is worth only the pin that makes
      * the compiler refuse it.
      *
  -   * The 7 `@ts-expect-error` property assignment checks below are verified by
  +   * The `@ts-expect-error` property assignment checks below are verified by
      * `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime test
  ```

---

## 4. Compliance Verification Checklist

| Guideline / Principle | Source | Status | Analysis |
|---|---|---|---|
| **Next.js 16 conventions** | `AGENTS.md` | **PASS** | No `middleware.ts` created; `src/proxy.ts` is untouched. |
| **TypeScript strict mode** | `AGENTS.md` / `CLAUDE.md` | **PASS** | Strict mode enabled; zero `any`, zero implicit types, no unsafe assertions. Removed legacy `void 0 as unknown as [...]`. |
| **Service layer purity** | `AGENTS.md` / `CLAUDE.md` | **PASS** | `src/services/rule-lifecycle.ts` and `src/services/studio-class-editability.ts` contain zero framework/HTTP imports (`NextRequest`, `NextResponse`). Pure functions and domain types only. |
| **FireAndForget contract** | `AGENTS.md` / `CLAUDE.md` | **PASS** | No un-awaited asynchronous leaks or improper promise returns. |
| **Single teacher, single slot exclusivity** | `AGENTS.md` / `CLAUDE.md` | **PASS** | Domain exclusivity constraints untouched. |
| **Database mutations** | `AGENTS.md` / `CLAUDE.md` | **PASS** | No schema changes in `prisma/schema.prisma`. |
| **Comment discipline** | `CLAUDE.md` | **WARN** | 1 instance of a hardcoded prose count in `src/services/rule-lifecycle.test.ts:95` (Issue 1 above). All other comments cleanly annotate immediate code and cite relevant issue numbers. |
| **Bug & regression detection** | Skill instructions | **PASS** | No runtime logic was modified. All compile-time pins are sound and verified by mutation testing. Zero regressions. |
| **Performance & security** | Skill instructions | **PASS** | The `const` + `void` pin pattern is standard in the codebase and causes no measurable runtime overhead or security vulnerabilities. |

---

## 5. Verification Suite Audit

1. **`tsc --noEmit` (`pnpm run typecheck`)**: Exit code 0 (clean, 0 errors).
2. **`eslint` (`pnpm exec eslint <touched-files>`)**: Exit code 0 (clean, 0 errors, 0 warnings on all modified source and test files).
3. **Vitest Test Suite**: 249 test files passed (3,227 tests passed across both sequential passes).
4. **Mutation Testing Ledger**: 6 distinct mutations recorded in `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`, all verified to exit with code 2 and verbatim error messages naming the offending condition.

---

## 6. Conclusion & Recommendation

The PR is in excellent condition and achieves all objectives of Issue #207 with architectural precision. Upon addressing the single advisory comment fix in [`src/services/rule-lifecycle.test.ts:95`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.test.ts#L95) to preserve comment discipline, PR #597 is recommended for rebase-merge into `main`.
