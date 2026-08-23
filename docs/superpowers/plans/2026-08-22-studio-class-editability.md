# Studio Class Editability Implementation Plan

> **For agentic workers:** implement task-by-task in order; every task ends in a
> commit on `fix/276-studio-class-edit-surface`. Steps use checkbox syntax.

**Goal:** Make the set of fields a teacher may change on a logged studio class a
stated decision, and give every API-accepted field a UI that reaches it — so
#194's "change existing classes individually" becomes true for the studio family.

**Architecture:** A pure predicate in `src/services/studio-class-editability.ts`
answers two questions from `{ templateId, date }`: is the schedule still
editable (not an income record), and may `date` move (manual rows only). The
`PUT` route enforces both after ownership; the detail page renders an entry link
from the same verdict; a dedicated `/studio-class/[id]/edit` page prefills a
client form — the `/class/[id]/edit` pattern, kept parallel-but-separate.

**Tech Stack:** Next.js App Router, TypeScript `strict`, Prisma, vitest (three
projects), Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-22-studio-class-editability-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`.
- **Services stay framework-agnostic.** `studio-class-editability.ts` imports
  `startOfLocalDay` from `@/lib/timezone` and nothing else — no `next/*`, no
  `@/lib/log`. The route logs and responds.
- **The predicate's parameter is `{ templateId: string | null; date: Date }`** —
  structural, handed a fresh two-field literal at every call site, never the
  Prisma row. Same discipline (and same rationale) as `studio-class-deletion.ts`.
- **Calendar dates only.** Past means `startOfLocalDay(now, timeZone) > date`.
  No start-instant reasoning anywhere in this branch.
- **Cancellation gates nothing.** The verdict reads no `cancelledAt`.
- **Generated rows never receive a `date` in a payload.** The form *omits* the
  field when `dateEditable` is false — the API refuses presence, not difference,
  so re-sending the unchanged date would 409.
- **No template-key catch arm.** Unreachable by the spec's §D2 argument; the
  reasoning lives beside the existing catches.
- **`vitest.config.ts` pins `TZ: 'America/New_York'`.** The predicate takes an
  explicit `timeZone`, so unit tests pass zones explicitly; integration fixtures
  keep to far-from-today dates (`2020-…`, `2099-…`) so no tz edge can flip them.
- **Components project:** `fetch` is NOT mocked — stub per test with
  `vi.stubGlobal('fetch', …)`; `routerRefresh` comes from `tests/setup/components.ts`.
- **This round runs in a worktree.** The user's dev server owns :3000 and serves
  another checkout. This branch carries a one-line `INTEGRATION_BASE_URL`
  override in `tests/helpers.ts` (default unchanged: `http://localhost:3000`),
  and the worktree's own dev server runs on **:3001** with
  `CRON_SCHEDULER=off EMAIL_DRY_RUN=1`. Integration runs as
  `INTEGRATION_BASE_URL=http://localhost:3001 npx vitest run --project integration …`.
- **Warm routes before judging a red.** After any source edit, curl each touched
  route once; a cold `next dev` compile reads exactly like an assertion failure.
- **Never `git add -A`; stage exact paths; quote `(teacher)` paths.**
- **Never start/restart anything on :3000.**

## Baseline (measure, do not inherit)

Record files + tests per vitest project before Task 1, totals reconciling
(`files: u + c + i`, `tests: u + c + i`). Predict the after-figure; measure it
again at the end and explain any drift.

---

### Task 0: Worktree plumbing

**Files:**
- Edit: `tests/helpers.ts` (one line)

- [ ] `BASE_URL` becomes `process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000'`.
      Default byte-identical to today; CI unaffected.
- [ ] Copy `.env` from the main checkout into the worktree; append
      `CRON_SCHEDULER="off"`. `npm install` (postinstall runs `prisma generate`).
- [ ] Start the worktree server: `EMAIL_DRY_RUN=1 CRON_SCHEDULER=off npx next dev -p 3001 &`,
      log to the scratchpad. Curl `/` until 200.
- [ ] Sanity: run one existing integration file against :3001
      (`INTEGRATION_BASE_URL=http://localhost:3001 npx vitest run --project integration tests/integration/studio-class-page.test.ts`) — green.
- [ ] Commit: `test: integration base URL honours INTEGRATION_BASE_URL (worktree round)`.

### Task 1: The editability predicate

**Files:**
- Create: `src/services/studio-class-editability.ts`
- Test: `src/services/studio-class-editability.test.ts` (unit project)

**Interfaces:**
- Consumes: `startOfLocalDay` from `@/lib/timezone`.
- Produces, relied on by Tasks 3 and 4:

```ts
export interface StudioClassEditVerdict {
  /** false ⇒ income record: only studentCount and cancelledAt remain writable */
  scheduleEditable: boolean;
  /** `date` may move: manual row, and not an income record */
  dateEditable: boolean;
}

export function studioClassEditability(
  sc: { templateId: string | null; date: Date },
  now: Date,
  timeZone: string,
): StudioClassEditVerdict;

export type StudioClassEditRefusal = 'income_record' | 'generated_date';

export const STUDIO_CLASS_EDIT_REFUSALS: Record<
  StudioClassEditRefusal,
  { readonly message: string; readonly code: string }
>;
// income_record  → STUDIO_CLASS_INCOME_RECORD
// generated_date → STUDIO_CLASS_GENERATED_DATE
```

- [ ] **Step 1: failing tests first.** Boundary matrix with instants, not prose:
      `now = 2026-06-15T12:00:00Z` (08:00 New York, 14:00 Amsterdam);
      dates `2026-06-14 / 15 / 16` as midnight-UTC `@db.Date` values. Assert:
      yesterday ⇒ `{ scheduleEditable: false, dateEditable: false }`;
      today ⇒ both true (a today-dated class stays editable — attendance is
      logged after the fact); tomorrow ⇒ both true. Repeat the edge case where
      the zones disagree about "today" (a UTC instant whose New York date is
      one behind). Manual vs generated: `templateId: null` ⇒ `dateEditable`;
      non-null ⇒ false while `scheduleEditable` stays true. Invariant:
      `dateEditable ⇒ scheduleEditable`. NaN date ⇒ fail closed (both false),
      mirroring the deletion service's stance.
- [ ] **Step 2: implement.** Fail-closed NaN guard with the same
      redundant-on-purpose comment shape as `studio-class-deletion.ts:169-179`.
      Refusal messages written for the teacher (prose naming the remedy), codes
      as above; `Record` keyed by the union so a new member fails to compile.
- [ ] **Step 3: prove the guards bite.**
      - M1: invert the comparison (`>` → `<`) → boundary tests red. Record the
        exact failure text.
      - M2: delete the NaN guard → NaN test red. Record.
      Restore, re-run green. Warm nothing (pure unit).
- [ ] Commit: `feat: studioClassEditability, the policy the PUT was missing (issue 276)`.

### Task 2: Persistence coverage for the already-accepted fields

**Files:**
- Test: `tests/integration/studio-api.test.ts` (extend the studio-class PUT area)

The issue's cheapest true claim: `location`, `durationMinutes`, `hourlyRate`
are accepted by the schema and tested nowhere. Before any behaviour changes,
pin what exists.

- [ ] Three happy-path tests on a manual, future-dated fixture
      (`2099-…`, owner token): PUT one field → 200 → **read the row back
      through Prisma** and assert the new value survived (a 200 alone proves
      nothing about persistence). One field per test, so a schema regression
      names its field.
- [ ] These must pass **unchanged** against `main`'s behaviour — they pin
      today's contract, they do not add one. Verify by running them before
      touching any source file.
- [ ] Commit: `test: the three studio fields the PUT accepted and nothing exercised (issue 276)`.

### Task 3: Schema admission + the route's two gates

**Files:**
- Edit: `src/lib/schemas.ts` (`updateStudioClassSchema`)
- Edit: `src/app/api/studio-classes/[id]/route.ts` (PUT only)
- Edit: `src/lib/schemas.test.ts` (`SERVER_OWNED_FIELDS` entry)
- Test: `tests/integration/studio-api.test.ts`

Order within the task is load-bearing: schema, pin, route, then tests — the
route compiles against the schema, and the pin fails until both agree.

- [ ] Schema: add `classType: z.string().min(1).optional()` and
      `date: isoDate.optional()` (the same `isoDate` the create schema uses).
- [ ] Pin: `updateStudioClassSchema: ['cancelledAt', 'date']` — both now
      transform server-side; adjust the entry's comment to say so.
- [ ] Route, after the empty-body check:
      ```ts
      const verdict = studioClassEditability(
        { templateId: studioClass.templateId, date: studioClass.date },
        new Date(),
        session.defaultTimezone,
      );
      ```
      Destructure the always-writable pair first:
      `const { cancelledAt, studentCount, date: dateString, ...gated } = parsed.data;`
      — `Object.keys(gated).length > 0` is the has-gated-fields test, total by
      construction over a `.strict()` schema.
      Gate 1 (past): `!verdict.scheduleEditable && gated non-empty` → 409,
      `STUDIO_CLASS_INCOME_RECORD` message/code from the Record. Whole request
      refused; nothing partially applied.
      Gate 2 (generated date): `dateString !== undefined && !verdict.dateEditable`
      → 409 `STUDIO_CLASS_GENERATED_DATE`.
      Transform: `new Date(dateString)` into the update data (class-route
      pattern, `src/app/api/classes/[id]/route.ts:54-57`). `cancelledAt`
      handling byte-unchanged.
      Where the catches live: a comment stating why no template-key arm exists
      (spec §D2: `templateId` never writable here; NULLs distinct in a Postgres
      unique index ⇒ P2002 on `@@unique([templateId, date])` unreachable through
      this route).
- [ ] Integration tests:
      1. `classType` happy path (manual future fixture) with Prisma read-back.
      2. `date` happy path on a **manual** row: move `2099-06-01` → `2099-06-02`,
         read back.
      3. Income-record refusal: past fixture (`2020-01-01`), PUT
         `{ hourlyRate: 99 }` → 409 code `STUDIO_CLASS_INCOME_RECORD`, row
         unchanged.
      4. No partial application: past fixture, PUT
         `{ hourlyRate: 99, studentCount: 7 }` → 409 and **`studentCount` still
         null** in the DB.
      5. Counts still writable on a past row: PUT `{ studentCount: 3 }` → 200,
         read back (the policy's whole point, pinned).
      6. Generated-date refusal: generated future fixture, PUT
         `{ date: … }` → 409 `STUDIO_CLASS_GENERATED_DATE`, date unchanged.
      7. Slot key bites through `date`: two manual rows, `2027-05-10` and
         `2027-05-11`, both 12:00; move the later onto the earlier's date →
         409 `DUPLICATE_STUDIO_SLOT`, row unchanged.
      8. Cross-family bites through `date`: mirror the existing cross-family
         fixture pattern (grep `CROSS_FAMILY_CLASS_SLOT` in
         `tests/integration/` for the established way to plant a `Class` in the
         slot); move a manual studio row onto it → 409
         `CROSS_FAMILY_CLASS_SLOT`.
      9. Empty body still 400; the other-teacher 403 loop untouched.
- [ ] Prove the guards bite (warm routes first — these are cold-compile-prone):
      - M3: delete gate 1 → tests 3–4 red. Record error text.
      - M4: delete gate 2 → test 6 red. Record.
      - M5: revert the pin entry to `['cancelledAt']` → pin test red. Record.
      Restore, full new-suite green.
- [ ] Commit: `feat: date and classType admitted, the two gates that keep the policy true (issue 276)`.

### Task 4: The surface — edit page, form, entry link

**Files:**
- Create: `src/app/(teacher)/studio-class/[id]/edit/page.tsx`
- Create: `src/components/studio-class/studio-class-edit-form.tsx`
- Test: `src/components/studio-class/studio-class-edit-form.test.tsx` (components)
- Edit: `src/app/(teacher)/studio-class/[id]/page.tsx` (entry link)
- Test: `tests/integration/studio-class-page.test.ts` (link gating over HTTP)

- [ ] Edit page (mirror `/class/[id]/edit/page.tsx`): session, fetch row,
      ownership → `redirect('/')`; verdict from a fresh two-field literal;
      `!verdict.scheduleEditable` → `redirect(\`/studio-class/${id}\`)`; render
      the form with initials + `dateEditable`. `export const dynamic =
      'force-dynamic'` like the class edit page.
- [ ] Form ('use client'): six inputs — classType, location, date (disabled +
      explainer caption when `!dateEditable`, explainer names cancel-plus-manual),
      startTime (`type="time"`), durationMinutes, hourlyRate (`step 0.01`).
      Submit: single PUT; **omit `date` from the payload entirely when
      `!dateEditable`** (presence, not difference, is what the API refuses).
      Success: `Saved` caption + `router.refresh()`; failure: `readErrorMessage`
      verbatim in the danger slot; `saving` disables the button. Reuse the
      StudentCountEditor one-slot success/error convention.
- [ ] Entry link on the detail page: compute the verdict beside the existing
      deletability call (one shared two-field literal); render
      `Edit class → /studio-class/[id]/edit` when `scheduleEditable` — in the
      live branch's actions block **and** under the cancellation notice
      (spec D4: hiding it on cancelled non-past rows would re-create the
      mismatch one state over).
- [ ] Component tests: prefill renders initials; submit sends the expected
      payload (assert `date` absent for a generated row); 200 → Saved caption +
      refresh called; 409 → API message shown verbatim; disabled date input +
      explainer when `dateEditable` false. Stub `fetch` per test.
- [ ] Integration page tests (mirror the removal-button assertions): Edit link
      present on a live non-past row; present on a cancelled non-past row;
      absent on a past row; absent for another teacher (redirect).
- [ ] Mutation M6: remove the `scheduleEditable` condition from the link →
      page test red (warm the page route first). Restore.
- [ ] Commit: `feat: the studio class edit surface reaches every writable field (issue 276)`.

---

## Verification ladder

1. Per task: targeted vitest by path; warm touched routes first.
2. Whole branch: `INTEGRATION_BASE_URL=http://localhost:3001 npm run verify`
   (typecheck → lint → all three projects; green verify = the whole
   integration suite ran).
3. Mutations M1–M6 recorded with exact error text, restored, re-verified.
4. CI remains the outer gate (prisma validate, migration drift, build,
   Playwright). Local e2e is left to CI this round — the worktree cannot take
   :3000.

## Out of scope (unchanged from spec §6)

#275's un-cancel door; #284; status enums; audit logs; notifications; DELETE
route; reporting pages.
