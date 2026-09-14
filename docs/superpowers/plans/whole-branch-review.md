# Whole-Branch Review: Toggle-Payload & Result Type Pins (Issue #207)

**Branch:** `fix/207-toggle-payload-type-pins`  
**Base:** `main`  
**Issue:** #207  
**Plan Reference:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins.md`  
**Mutation Ledger:** `docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`  
**Reviewer:** Antigravity Code Reviewer  
**Date:** 2026-09-14  

---

## 1. Executive Summary & Verdict

### Verdict: **APPROVED**

The branch `fix/207-toggle-payload-type-pins` completes all acceptance criteria for Issue #207 with exemplary craftsmanship, adherence to repository architecture (`AGENTS.md`, `CLAUDE.md`), and rigorous type design discipline.

All compile-time invariants previously checked via ad-hoc `@ts-expect-error` directives in test bodies have been elevated into first-class compile-time pins declared directly beside the source type definitions (`src/lib/api-types.ts`, `src/services/rule-lifecycle.ts`, and `src/services/studio-class-editability.ts`). Every pin uses the canonical `NoneOf` idiom (`const _pin: NoneOf<Condition ? 'Condition' : never> = true; void _pin;`), which guarantees that when an invariant is violated, the TypeScript compiler refuses compilation and explicitly names the offending relation.

All remaining call-site `@ts-expect-error` directives across 15 test files in the codebase were systematically audited and annotated with uniform JSDoc docblocks explaining that they are verified by `npm run typecheck` (`tsc --noEmit`) only and are invisible to Vitest runtime execution.

All verification gates (`pnpm run typecheck`, `pnpm test`, `pnpm run lint`) pass cleanly with 0 errors across 249 test files (3,227 tests). The branch is organized into six clean, logical commits ready for rebase-merging.

---

## 2. Cross-Task Consistency

### 2.1 Uniform Construction of `NoneOf` Pins
Across all three modified source files (`src/lib/api-types.ts`, `src/services/rule-lifecycle.ts`, `src/services/studio-class-editability.ts`), all 9 `NoneOf` pins follow a strictly uniform structural template:

```ts
const _pinName: NoneOf<
  Condition extends Invariant
    ? 'Condition extends Invariant'
    : never
> = true;
void _pinName;
```

#### Pin Inventory Across Touched Files:

| File | Target Type | Pin Variable | Condition Pin Asserted |
|---|---|---|---|
| `src/lib/api-types.ts:114` | `TemplateToggleResponse` | `_classIsNotStudio` | `TemplateToggleResponse extends StudioTemplateToggleResponse` |
| `src/lib/api-types.ts:121` | `StudioTemplateToggleResponse` | `_studioIsNotClass` | `StudioTemplateToggleResponse extends TemplateToggleResponse` |
| `src/services/rule-lifecycle.ts:370` | `ArchiveRuleResult<TChild>` | `_classArchiveIsNotStudio` | `ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>` |
| `src/services/rule-lifecycle.ts:377` | `ArchiveRuleResult<TChild>` | `_studioArchiveIsNotClass` | `ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>` |
| `src/services/rule-lifecycle.ts:999` | `PauseRuleResult<TChild>` | `_classPauseIsNotStudio` | `PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>` |
| `src/services/rule-lifecycle.ts:1006` | `PauseRuleResult<TChild>` | `_studioPauseIsNotClass` | `PauseRuleResult<StudioClassTemplate> extends PauseRuleResult<ClassTemplate>` |
| `src/services/rule-lifecycle.ts:1613` | `UpdateRuleResult<TChild>` | `_classUpdateIsNotStudio` | `UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>` |
| `src/services/rule-lifecycle.ts:1620` | `UpdateRuleResult<TChild>` | `_studioUpdateIsNotClass` | `UpdateRuleResult<StudioClassTemplate> extends UpdateRuleResult<ClassTemplate>` |
| `src/services/studio-class-editability.ts:72` | `StudioClassEditVerdict` | `_illegalVerdictCannotStand` | `{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict` |

### 2.2 Pin Variable Naming, Error Types, Comments, and `void` Statements
- **Variable Names**: All pin variables use `_camelCase` with a leading underscore, conforming to repository naming standards for unused compile-time assertions (matching `_noneOfHoldsIsTrue` in `src/lib/type-pins.ts`).
- **Error Literal Phrasing**: In every case, the error string literal returned on violation matches the exact type condition being checked (e.g., `'TemplateToggleResponse extends StudioTemplateToggleResponse'`), ensuring unambiguous compiler error messages of the form `Type 'true' is not assignable to type '"<Condition>"'`.
- **Comment Discipline & Traceability**:
  - `src/lib/api-types.ts`: Cites lineage issues `#93, #119, #206, #207`.
  - `src/services/rule-lifecycle.ts`: Cites `#207` across each pair of result pins and in the docblocks of `ArchiveRuleResult` and `PauseRuleResult`.
  - `src/services/studio-class-editability.ts`: Cites `#207` in the pin header comment.
- **`void` Statements**: Every pin declaration `const _x: NoneOf<…> = true;` is immediately paired with `void _x;` on the succeeding line. As documented in `src/lib/type-pins.ts`, this instantiates the conditional type under both server and client conditions while eliminating unused variable warnings without needing `eslint-disable`.

### 2.3 Call-Site `@ts-expect-error` Test Docblock Alignment
All 15 test files containing call-site `@ts-expect-error` directives were reviewed for documentation alignment:
- `src/components/settings/template-action-messages.test.ts` (redundant test block removed; active tests remain clean)
- `src/services/rule-lifecycle.test.ts` (lines 95–97)
- `src/services/studio-class-editability.test.ts` (lines 185–189)
- `src/services/studio-class-deletion.test.ts` (lines 167–169)
- `src/lib/api-utils.test.ts` (lines 109–113, 456–458, 577–579)
- `src/lib/db-locks.test.ts` (lines 53–55)
- `src/lib/entry-conflict.test.ts` (lines 273–275)
- `src/lib/registration-status.test.ts` (lines 31–33)
- `src/lib/rule-slot-holder.test.ts` (lines 175–177)
- `src/lib/timezone.test.ts` (lines 470–472)
- `src/lib/worktree/identity.test.ts` (lines 106–108)
- `src/lib/worktree/registry.test.ts` (lines 708–710)
- `src/services/class-lifecycle.test.ts` (lines 36–38, 109–111, 2105–2108)
- `src/services/class-template-lifecycle.test.ts` (lines 36–38)
- `src/services/entry-generation.test.ts` (lines 14–16)
- `src/services/studio-class-template-lifecycle.test.ts` (lines 12–14)

**Consistency Check**: Every single test docblock consistently explains the two essential boundaries:
1. The check is verified by `npm run typecheck` only (`tsc --noEmit`), failing compilation via `TS2578` (unused `@ts-expect-error`) if the guard weakens.
2. It is invisible to Vitest runtime test execution because tests do not typecheck or transpile types at runtime.

---

## 3. Integrity of Type Design

### 3.1 Preservation of Resolution Identity in `NoneOf`
In `src/lib/type-pins.ts`, `NoneOf` is defined as:
```ts
export type NoneOf<T extends PropertyKey> = [T] extends [never] ? true : T;
```
The tuple wrapping `[T] extends [never]` is load-bearing:
- When the invariant holds, `T` is `never`. Because `[never] extends [never]` is true, `NoneOf<never>` resolves to `true`. The assignment `= true;` succeeds.
- When an invariant fails, `T` evaluates to the string literal `'OffenderDescription'`. Because `['OffenderDescription'] extends [never]` is false, `NoneOf<'OffenderDescription'>` returns the literal type `'OffenderDescription'` unchanged.
- Because `[T]` avoids distributive conditional type behavior over naked type parameters, `NoneOf` preserves exact resolution identity, which is certified by `Equals` fixtures in `src/lib/type-pins.ts:81-87`.

### 3.2 Evaluation & Absence of Trivial Truthiness
Each pin condition was evaluated for potential false positives, false negatives, or trivial truthiness:

1. **Toggle Payloads (`TemplateToggleResponse` vs `StudioTemplateToggleResponse`)**:
   - Both types are discriminated unions sharing arms (`'paused'`, `'archived'`, `'unarchived' | 'unchanged'`) and differing on their `'active'` arm by `templateKind: 'class'` vs `templateKind: 'studio'`.
   - In TypeScript, union subtype testing `A extends B` requires every constituent arm of `A` to be assignable to `B`. Because the `'active'` arm has an incompatible discriminant, neither extends the other.
   - If `templateKind` is mutated to match, the mutated type becomes a complete subtype of the other, evaluating `A extends B` to `true` and triggering the compiler diagnostic. Trivial truthiness is impossible.

2. **Lifecycle Results (`ArchiveRuleResult`, `PauseRuleResult`, `UpdateRuleResult`)**:
   - Each result type is generic over `TChild`, with `template: WithSlot<TChild>`.
   - `ClassTemplate` and `StudioClassTemplate` have distinct required fields (`room`, `teacherId` vs `studioRoomId`, `teacherRoomId`). Neither is assignable to the other.
   - If the child type distinction on `template` is erased (e.g. collapsed to `{ id: string }`), both directions evaluate to `true`, instantly triggering compiler failures on both pins.

3. **Verdict Pin (`StudioClassEditVerdict`)**:
   - The union consists of `{ scheduleEditable: false; dateEditable: false }` and `{ scheduleEditable: true; dateEditable: boolean }`.
   - The illegal state `{ scheduleEditable: false; dateEditable: true }` does not satisfy the first arm (`dateEditable: true` is not assignable to `false`) and does not satisfy the second arm (`scheduleEditable: false` is not assignable to `true`).
   - If `StudioClassEditVerdict` were widened to allow independent booleans `{ scheduleEditable: boolean; dateEditable: boolean }`, `{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict` immediately evaluates to `true`, triggering the pin.

### 3.3 Mutation Testing Ledger Verification
The mutation testing ledger (`docs/superpowers/plans/2026-09-14-toggle-payload-type-pins-mutations.md`) documents 6 live mutation probes:
- Mutation 1: `_classIsNotStudio` (caught with `"TemplateToggleResponse extends StudioTemplateToggleResponse"`)
- Mutation 2: `_studioIsNotClass` (caught with `"StudioTemplateToggleResponse extends TemplateToggleResponse"`)
- Mutation 3: `_classArchiveIsNotStudio` & `_studioArchiveIsNotClass` (both caught with exact result type extension names)
- Mutation 4: `_classPauseIsNotStudio` & `_studioPauseIsNotClass` (both caught with exact result type extension names)
- Mutation 5: `_classUpdateIsNotStudio` & `_studioUpdateIsNotClass` (both caught with exact result type extension names)
- Mutation 6: `_illegalVerdictCannotStand` (caught with `"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"`)

All target line numbers in the ledger match the source files in `HEAD` exactly. Every mutation provably failed compilation (`tsc --noEmit` exit 2) naming the offender, and restored cleanly.

### 3.4 Stale References, Broken Links, and Comments Audit
- `src/services/rule-lifecycle.ts`: Removed obsolete references claiming invariants are held in `rule-lifecycle.test.ts` and `template-action-messages.test.ts`. Accurately references the `NoneOf` compile-time pins declared directly below.
- `src/services/studio-class-editability.ts` and `studio-class-editability.test.ts`: Clearly separates the parameter type guard (`it('refuses a widened row at the type level')`) from the union invariant pin (`_illegalVerdictCannotStand`).
- No dangling references, dead imports, or inaccurate docblocks remain.

---

## 4. Verification Suite Results

All three verification gates specified in `AGENTS.md` and the user prompt were executed against the branch in its current state:

### 4.1 Typecheck (`pnpm run typecheck`)
- **Command:** `tsc --noEmit`
- **Result:** Exit code 0 (clean, 0 errors)

### 4.2 Linter (`pnpm run lint`)
- **Command:** `eslint`
- **Result:** Exit code 0 (clean, 0 errors, 6 pre-existing warnings in unrelated files)

### 4.3 Test Suite (`pnpm test`)
- **Command:** `vitest run --project unit --project components && vitest run --project unit-sweeps --project integration`
- **Result:** Exit code 0 (clean, all passes succeeded)
  - **Pass 1** (`unit`, `components`): 178 test files passed (2,299 tests passed)
  - **Pass 2** (`unit-sweeps`, `integration`): 71 test files passed (928 tests passed)
  - **Total:** 249 test files passed, 3,227 tests passed

---

## 5. Commit History & Cleanliness

The branch consists of 6 atomic, descriptive commits following Conventional Commits format:

```text
d8cbb3bd docs(types): record mutation testing ledger for toggle payload and result type pins (#207)
ae78586e docs(tests): clarify typecheck-only enforcement on remaining call-site @ts-expect-error guards (#207)
627ab151 fix(studio-class-editability): express verdict illegal state pin with NoneOf (#207)
13adfcc9 fix(rule-lifecycle): express result type non-interchangeability with NoneOf pins (#207)
ce6f792e fix(api-types): express toggle payload non-interchangeability with NoneOf pins (#207)
1c96868b docs: add implementation plan for issue #207
```

- Each commit corresponds to one distinct task from the approved implementation plan.
- No squash merge is necessary; the branch is completely clean and ready for rebase-merge into `main`.

---

## 6. Final Recommendation

**Merge Readiness:** Ready for rebase-merge. No further modifications required.
