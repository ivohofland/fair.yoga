# Mutation Record — Toggle-Payload & Result Type Pins (Issue #207)

This document records the mutation testing protocol for Issue #207 in accordance with `AGENTS.md` and `docs/mutation-testing.md`:
> *"A guard that cannot fail certifies nothing. When executing mutation probes (breaking a guard to watch tests go red, then restoring)..."*

Every mutation was executed in-place, checked via `pnpm run typecheck` (`tsc --noEmit`), recorded verbatim with exit code and compiler error text, restored immediately, and re-verified to a clean green state.

---

## Mutation Summary Table

| # | Guard Under Test | Target File | Mutation Description | Exit Code | OFFENDER Caught by Guard |
|---|---|---|---|---|---|
| 1 | `_classIsNotStudio` | `src/lib/api-types.ts:114` | Change `templateKind: 'class'` to `'studio'` in `TemplateToggleResponse` | 2 | `"TemplateToggleResponse extends StudioTemplateToggleResponse"` |
| 2 | `_studioIsNotClass` | `src/lib/api-types.ts:121` | Change `templateKind: 'studio'` to `'class'` in `StudioTemplateToggleResponse` | 2 | `"StudioTemplateToggleResponse extends TemplateToggleResponse"` |
| 3 | `_classArchiveIsNotStudio` & `_studioArchiveIsNotClass` | `src/services/rule-lifecycle.ts:370, 377` | Replace `template: WithSlot<TChild>` with `template: { id: string }` in `ArchiveRuleResult` | 2 | `"ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>"` & twin |
| 4 | `_classPauseIsNotStudio` & `_studioPauseIsNotClass` | `src/services/rule-lifecycle.ts:999, 1006` | Replace `template: WithSlot<TChild>` with `template: { id: string }` in `PauseRuleResult` | 2 | `"PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>"` & twin |
| 5 | `_classUpdateIsNotStudio` & `_studioUpdateIsNotClass` | `src/services/rule-lifecycle.ts:1613, 1620` | Replace `template: WithSlot<TChild>` with `template: { id: string }` in `UpdateRuleResult` | 2 | `"UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>"` & twin |
| 6 | `_illegalVerdictCannotStand` | `src/services/studio-class-editability.ts:72` | Mutate `StudioClassEditVerdict` to `{ scheduleEditable: boolean; dateEditable: boolean }` | 2 | `"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"` |

---

## Mutation Details

### Mutation 1: Toggle Payload Invariant (`_classIsNotStudio`)

- **Target File:** `src/lib/api-types.ts:43`
- **Guard:** `_classIsNotStudio` (`src/lib/api-types.ts:114-118`)
- **Diff:**
  ```diff
  --- a/src/lib/api-types.ts
  +++ b/src/lib/api-types.ts
  @@ -43,1 +43,1 @@ export type TemplateToggleResponse =
  -      templateKind: 'class';
  +      templateKind: 'studio';
  ```
- **Command:** `pnpm run typecheck`
- **Exit Code:** 2
- **Compiler Output (verbatim):**
  ```text
  $ tsc --noEmit
  src/app/api/class-templates/[id]/route.ts(491,44): error TS2345: Argument of type '{ action: "active"; templateKind: "class"; scheduled: number; added: number; counts: SkipCounts; id: string; scheduleRuleId: string; kind: $Enums.ClassFamily; ... 21 more ...; withdrawnCount: number | null; }' is not assignable to parameter of type 'PatchResponse'.
    Types of property 'templateKind' are incompatible.
      Type '"class"' is not assignable to type '"studio"'.
  src/components/settings/template-action-messages.test.ts(147,9): error TS2322: Type '"class"' is not assignable to type '"studio"'.
  src/lib/api-types.ts(114,7): error TS2322: Type 'true' is not assignable to type '"TemplateToggleResponse extends StudioTemplateToggleResponse"'.
  src/lib/api-types.ts(121,7): error TS2322: Type 'true' is not assignable to type '"StudioTemplateToggleResponse extends TemplateToggleResponse"'.
  ```
- **Outcome:** The `_classIsNotStudio` pin bit and named the exact broken condition `"TemplateToggleResponse extends StudioTemplateToggleResponse"`. Restored and re-verified clean (`tsc --noEmit` exit 0). ✅

---

### Mutation 2: Toggle Payload Invariant (`_studioIsNotClass`)

- **Target File:** `src/lib/api-types.ts:60`
- **Guard:** `_studioIsNotClass` (`src/lib/api-types.ts:121-125`)
- **Diff:**
  ```diff
  --- a/src/lib/api-types.ts
  +++ b/src/lib/api-types.ts
  @@ -60,1 +60,1 @@ export type StudioTemplateToggleResponse =
  -      templateKind: 'studio';
  +      templateKind: 'class';
  ```
- **Command:** `pnpm run typecheck`
- **Exit Code:** 2
- **Compiler Output (verbatim):**
  ```text
  $ tsc --noEmit
  src/app/api/studio-class-templates/[id]/route.ts(268,44): error TS2345: Argument of type '{ action: "active"; templateKind: "studio"; scheduled: number; added: number; counts: SkipCounts; id: string; scheduleRuleId: string; kind: $Enums.ClassFamily; ... 12 more ...; withdrawnCount: number | null; }' is not assignable to parameter of type 'PatchResponse'.
    Types of property 'templateKind' are incompatible.
      Type '"studio"' is not assignable to type '"class"'.
  src/components/settings/template-action-messages.test.ts(308,9): error TS2322: Type '"studio"' is not assignable to type '"class"'.
  src/lib/api-types.ts(114,7): error TS2322: Type 'true' is not assignable to type '"TemplateToggleResponse extends StudioTemplateToggleResponse"'.
  src/lib/api-types.ts(121,7): error TS2322: Type 'true' is not assignable to type '"StudioTemplateToggleResponse extends TemplateToggleResponse"'.
  ```
- **Outcome:** The `_studioIsNotClass` pin bit and named the exact broken condition `"StudioTemplateToggleResponse extends TemplateToggleResponse"`. Restored and re-verified clean (`tsc --noEmit` exit 0). ✅

---

### Mutation 3: Archive Rule Result Invariant (`_classArchiveIsNotStudio` & `_studioArchiveIsNotClass`)

- **Target File:** `src/services/rule-lifecycle.ts:327-331`
- **Guards:** `_classArchiveIsNotStudio` & `_studioArchiveIsNotClass` (`src/services/rule-lifecycle.ts:370-382`)
- **Diff:**
  ```diff
  --- a/src/services/rule-lifecycle.ts
  +++ b/src/services/rule-lifecycle.ts
  @@ -327,4 +327,4 @@ export type ArchiveRuleResult<TChild> =
  -  | { ok: true; action: 'archived'; template: WithSlot<TChild>; deleted: number; remaining: number }
  -  | { ok: true; action: 'unarchived'; template: WithSlot<TChild> }
  -  | { ok: true; action: 'unchanged'; template: WithSlot<TChild> }
  +  | { ok: true; action: 'archived'; template: { id: string }; deleted: number; remaining: number }
  +  | { ok: true; action: 'unarchived'; template: { id: string } }
  +  | { ok: true; action: 'unchanged'; template: { id: string } }
  ```
- **Command:** `pnpm run typecheck`
- **Exit Code:** 2
- **Compiler Output (verbatim excerpt showing pin bites):**
  ```text
  $ tsc --noEmit
  src/services/rule-lifecycle.ts(370,7): error TS2322: Type 'true' is not assignable to type '"ArchiveRuleResult<ClassTemplate> extends ArchiveRuleResult<StudioClassTemplate>"'.
  src/services/rule-lifecycle.ts(377,7): error TS2322: Type 'true' is not assignable to type '"ArchiveRuleResult<StudioClassTemplate> extends ArchiveRuleResult<ClassTemplate>"'.
  ```
- **Outcome:** Stripping family discrimination on `template` caused both `_classArchiveIsNotStudio` and `_studioArchiveIsNotClass` pins to fail, each naming the exact offending extension relation. Restored and re-verified clean (`tsc --noEmit` exit 0). ✅

---

### Mutation 4: Pause Rule Result Invariant (`_classPauseIsNotStudio` & `_studioPauseIsNotClass`)

- **Target File:** `src/services/rule-lifecycle.ts:923-977`
- **Guards:** `_classPauseIsNotStudio` & `_studioPauseIsNotClass` (`src/services/rule-lifecycle.ts:999-1011`)
- **Diff:**
  ```diff
  --- a/src/services/rule-lifecycle.ts
  +++ b/src/services/rule-lifecycle.ts
  @@ -923,7 +923,7 @@ export type PauseRuleResult<TChild> =
      | {
          ok: true;
          action: 'paused';
  -       template: WithSlot<TChild>;
  +       template: { id: string };
          lastScheduled: LastScheduledClass | null;
        }
      | {
          ok: true;
          action: 'active';
  -       template: WithSlot<TChild>;
  +       template: { id: string };
  ...
  -  | { ok: true; action: 'unchanged'; template: WithSlot<TChild> }
  +  | { ok: true; action: 'unchanged'; template: { id: string } }
  ```
- **Command:** `pnpm run typecheck`
- **Exit Code:** 2
- **Compiler Output (verbatim excerpt showing pin bites):**
  ```text
  $ tsc --noEmit
  src/services/rule-lifecycle.ts(999,7): error TS2322: Type 'true' is not assignable to type '"PauseRuleResult<ClassTemplate> extends PauseRuleResult<StudioClassTemplate>"'.
  src/services/rule-lifecycle.ts(1006,7): error TS2322: Type 'true' is not assignable to type '"PauseRuleResult<StudioClassTemplate> extends PauseRuleResult<ClassTemplate>"'.
  ```
- **Outcome:** Collapsing `template` on `PauseRuleResult` triggered both `_classPauseIsNotStudio` and `_studioPauseIsNotClass` compile-time pins, explicitly naming the bidirectional invariant violations. Restored and re-verified clean (`tsc --noEmit` exit 0). ✅

---

### Mutation 5: Update Rule Result Invariant (`_classUpdateIsNotStudio` & `_studioUpdateIsNotClass`)

- **Target File:** `src/services/rule-lifecycle.ts:1528`
- **Guards:** `_classUpdateIsNotStudio` & `_studioUpdateIsNotClass` (`src/services/rule-lifecycle.ts:1613-1625`)
- **Diff:**
  ```diff
  --- a/src/services/rule-lifecycle.ts
  +++ b/src/services/rule-lifecycle.ts
  @@ -1527,2 +1527,2 @@ export type UpdateRuleResult<TChild> =
      | {
          ok: true;
  -       template: WithSlot<TChild>;
  +       template: { id: string };
  ```
- **Command:** `pnpm run typecheck`
- **Exit Code:** 2
- **Compiler Output (verbatim excerpt showing pin bites):**
  ```text
  $ tsc --noEmit
  src/services/rule-lifecycle.ts(1613,7): error TS2322: Type 'true' is not assignable to type '"UpdateRuleResult<ClassTemplate> extends UpdateRuleResult<StudioClassTemplate>"'.
  src/services/rule-lifecycle.ts(1620,7): error TS2322: Type 'true' is not assignable to type '"UpdateRuleResult<StudioClassTemplate> extends UpdateRuleResult<ClassTemplate>"'.
  ```
- **Outcome:** Removing `WithSlot<TChild>` from `UpdateRuleResult` triggered both compile-time pins, reporting each direction's violation verbatim. Restored and re-verified clean (`tsc --noEmit` exit 0). ✅

---

### Mutation 6: Verdict Pin Invariant (`_illegalVerdictCannotStand`)

- **Target File:** `src/services/studio-class-editability.ts:65-69`
- **Guard:** `_illegalVerdictCannotStand` (`src/services/studio-class-editability.ts:72-76`)
- **Diff:**
  ```diff
  --- a/src/services/studio-class-editability.ts
  +++ b/src/services/studio-class-editability.ts
  @@ -65,5 +65,2 @@ export type StudioClassEditVerdict =
  -  /** Income record: only `studentCount` and `cancelledAt` remain writable. */
  -  | { scheduleEditable: false; dateEditable: false }
  -  /** Not past: the whole schedule may change; `date` only on a manual row. */
  -  | { scheduleEditable: true; dateEditable: boolean };
  +  | { scheduleEditable: boolean; dateEditable: boolean };
  ```
- **Command:** `pnpm run typecheck`
- **Exit Code:** 2
- **Compiler Output (verbatim):**
  ```text
  $ tsc --noEmit
  src/services/studio-class-editability.ts(69,7): error TS2322: Type 'true' is not assignable to type '"{ scheduleEditable: false; dateEditable: true } extends StudioClassEditVerdict"'.
  ```
- **Outcome:** Allowing the illegal state `{ scheduleEditable: false, dateEditable: true }` immediately triggered `_illegalVerdictCannotStand` with exactly one compiler diagnostic naming the illegal state. Restored and re-verified clean (`tsc --noEmit` exit 0). ✅

---

## Verification

After restoring all mutations, the test suite and typechecker were executed:

1. **`pnpm run typecheck`**: Exit 0 (clean, 0 errors).
2. **`pnpm test`**: Exit 0.
   - Pass 1 (`unit`, `components`): 178 test files passed (2299 passed tests).
   - Pass 2 (`unit-sweeps`, `integration`): 71 test files passed (928 passed tests).
   - Total: 249 test files passed, 3227 passed tests.

