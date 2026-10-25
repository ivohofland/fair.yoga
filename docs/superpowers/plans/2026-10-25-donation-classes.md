# Donation-Based Classes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can mark a class or class template *by donation*. Booking and the lifecycle stay unchanged, no amount is shown to a student anywhere, everyone who came is invited once to give through the teacher's own Level 1 details, and the teacher records one total per class.

**Architecture:** A `PricingMode` enum on `Class` and `ClassTemplate`, locked with the economics, stamped by the generator. `completeClass` branches on it and writes no `Payment`. In the same transaction it claims `Registration.donationInvitedAt` with a conditional update and creates one optional `donation_invitation` per claimed row. A later attendance correction claims the same stamp under `lockClassRow`. The student gets a give page (`/bookings/[classId]/give`) and a hideable bookings prompt. The teacher records `Class.donationTotal`, which only `recordDonationTotal` writes. Every money reader switches on the mode with a `never` default, or keys a `Record<PricingMode, …>`.

**Tech Stack:** Next.js 16 App Router, Prisma 6.19 + PostgreSQL, zod, Vitest (projects `unit`, `unit-sweeps`, `components`, `integration`), Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-donation-classes-design.md`

## Global Constraints

- Every `pnpm`/`node` command runs on Node 24. The shell default is 22, so prefix the first command of each session with `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.
- TypeScript `strict`, no `any`. A compile-time pin this plan trips is satisfied by **classifying** the new field, never by widening or deleting the pin.
- Migrations: `pnpm exec prisma migrate dev --name <name>` for what Prisma can express. A CHECK goes in its own migration, created with `pnpm exec prisma migrate dev --create-only --name <name>`, hand-written in the pattern of `prisma/migrations/20260721061528_student_claim_link_check/migration.sql` (a comment stating the invariant, then `ALTER TABLE … ADD CONSTRAINT … CHECK (…)`), then applied with `pnpm exec prisma migrate dev`. An applied migration is never edited, comments included.
- `pricingMode` is a `PRICING_LOCKED_FIELDS` member and **not** an `ECONOMIC_FIELDS` member. The template update's `ECONOMIC_FIELDS` loop throws for any non-number (`class-template-lifecycle.ts`, `updateChild`).
- A template is a stamp (#194). No code path writes a template's `pricingMode` onto an existing `Class`.
- No surface a student sees shows an amount, a room cost, a breakdown, or a suggested figure for a donation class. No notification or email carries an IBAN, QR, payment link or amount. No copy says or implies a donation is VAT-free.
- The give page never calls `payGuidanceForTeacher`, which counts a Mollie connection as a method. It reads `paymentMethodsForTeacher` live.
- Every reader that shows money switches on `pricingMode` with a `never` default, or keys a `Record<PricingMode, …>` checked with `satisfies`. Tiered copy and behaviour are unchanged.
- Copy, verbatim from the spec (§4, §6, §7):
  - invitation body `Thank you for coming to {classType}. It was by donation — if you'd like to give, here's how.` (title `Thank you for coming`);
  - teacher completion notice `{classType} class on {day} at {HH:mm} is complete — {n} {student|students} invited to give.` For `n = 0`: `{classType} class on {day} at {HH:mm} is complete. No one to invite.`;
  - give page heading `Thank you for coming.`, no-method line `Give your teacher directly, however suits you.`;
  - bookings prompt `Give if you'd like`, button `Hide`;
  - price line `By donation`;
  - booking line `This class is by donation. After class you can give what you like, if you like.`;
  - late-cancel confirm `After the deadline, cancelling is recorded as a late cancellation.`;
  - late-cancel notice clause `You cancelled after the deadline, so this is recorded as a late cancellation.`;
  - `ALREADY_LATE_CANCELLED` donation message `This booking is already cancelled.`;
  - walk-in clause `This class is by donation.`;
  - complete-button confirm `Finish class? {n} {student|students} will be invited to give.`;
  - class-detail caption `Invitations to give go out at {HH:mm}.`;
  - completed card `Donations received`, `Not recorded yet`, `Record`, `incl. {€} VAT`;
  - form choice `Pricing`, `Tiered`, `By donation`;
  - reporting `Earned from teaching`, `EARNED`, `Donation classes`, `{n} without a recorded total`, empty state `Completed classes and what they earned appear here.`
- Comment discipline (CLAUDE.md). A comment annotates the code it sits on. No prose counts or member rosters in comments. Membership is tethered with `satisfies Record<…>` or an exhaustive `switch`.
- Never kill or restart the dev server on :3000; integration and e2e need it live. Warm every route a step touches with `curl -s -o /dev/null <url>` before judging RED or GREEN.
- Stage exact paths. Quote any path containing `(`…`)`. Never `git add -A`/`.`.
- Commit messages end with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Fast loops: `pnpm exec vitest run --project unit <path>`, `--project components <path>`, `--project integration <path>`. A file listed in `vitest.tiers.ts` runs under `--project unit-sweeps`.

## Review Focus

1. **A teacher retries a correction whose invitation claim failed.** The `attended` write committed, then the claim's transaction hit the 2s lock bound and the request answered 503. The retry finds the row already `attended`. It must still invite, and it answers applied, not `unchanged`. Pinned in Task 4.
2. **A teacher's account erasure completes an in-flight donation class** (`completeClass(…, { finishedEarly: true })`). That must invite nobody: an invitation would ask students to give to an erased teacher. Pinned in Task 3.
3. **A student's past donation row and a stale pay link.** `/bookings` must render with no `PAYMENT_SNAPSHOT_MISSING` degradation, because the snapshot is null by design. `/bookings/{id}/pay` must answer 404 without `CHARGED_REGISTRATION_WITHOUT_PAYMENT`. Pinned in Task 2.
4. **A donation class whose hidden, stored rates break the room-subsidy rule after a room-cost edit.** Example: stored `minRate = -20`, then room cost lowered to 10. The edit form must name the cause in visible words, not show a message about a field that is not on screen. Pinned in Task 7.
5. **A `no_show` correction after an invitation went out.** The give page answers 404 and the bookings prompt disappears, and the inbox row stays. Flipping back to `attended` sends nothing new. Pinned in Task 5 (page and prompt) and Task 4 (no resend).

## Task order

Tasks 1 → 3 → 4 → 5 are load-bearing in that order:
- 3 needs Task 1's columns.
- 4 needs Task 3's stamp and notification type.
- 5 needs Task 4's correction semantics and Task 2's `MethodAmount`.

Task 2 needs only Task 1. Tasks 6, 7, 8 and 9 each need Task 1, and 6 also needs Task 3 (`DONATION_INVITED_STATUSES`). Task 10 (e2e) needs all of them. Task 11 is last.

## File map

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` + migrations `donation_classes`, `donation_checks`, `donation_invitation_type` | `PricingMode`, `pricingMode`, `donationTotal`, the two `Registration` stamps, the three CHECKs, the notification type |
| `src/lib/class-fields.ts` | `PRICING_LOCKED_FIELDS`, joined into `LOCKED_FIELDS` |
| `src/lib/registration-status.ts` | `DONATION_INVITED_STATUSES`, derived from an exhaustive record |
| `src/lib/epc-qr.ts` (new) | Pure EPC payload builder, fixed or open amount |
| `src/lib/method-amount.ts` (new) | `MethodAmount` type |
| `src/components/student/method-panel.tsx` (new) | `MethodPanel` lifted out of the pay page, taking `MethodAmount` |
| `src/lib/donation-prompt.ts` (new) | `canSeeGivePage`, `showsDonationPrompt`, `DONATION_PROMPT_DAYS` |
| `src/services/donations.ts` (new) | Completion claim, correction claim, `hideDonationPrompt`, `recordDonationTotal`, notification builders |
| `src/app/(student)/bookings/[classId]/give/page.tsx` (new) | The give page |
| `src/components/student/donation-prompt.tsx` (new) | Bookings-row prompt with Hide |
| `src/app/api/registrations/[id]/donation-prompt/hide/route.ts` (new) | Hide endpoint |
| `src/app/api/classes/[id]/donation-total/route.ts` (new) | Record-total endpoint |
| `src/components/class/donation-summary.tsx`, `donations-received-card.tsx` (new) | Class detail before and after completion |
| `src/components/class/pricing-mode-choice.tsx` (new) | The `Pricing` radio pair used by all three forms |
| `src/lib/reporting.ts` (new) | Pure report aggregation the page renders |

---

### Task 1: The data model, locking, schemas and the generator stamp

**Files:**
- Modify: `prisma/schema.prisma` (enum `PricingMode`; `model Class`, `model ClassTemplate`, `model Registration`)
- Create: `prisma/migrations/<ts>_donation_classes/migration.sql` (generated)
- Create: `prisma/migrations/<ts>_donation_checks/migration.sql` (hand-authored)
- Modify: `src/lib/class-fields.ts`
- Modify: `src/lib/schemas.ts` (`createClassSchema`, `updateClassSchema`, `createClassTemplateSchema`, `updateClassTemplateSchema`)
- Modify: `src/app/api/classes/route.ts` (POST create data, beside `isPrivate: body.isPrivate ?? false`)
- Modify: `src/app/api/classes/[id]/route.ts` (the `locked` branch's message)
- Modify: `src/services/class-lifecycle.ts` (`TeacherEditableClassField`, `PlainUpdateForbiddenClassField` and `_classForbiddenListIsComplete`)
- Modify: `src/services/class-template-lifecycle.ts` (`TeacherEditableClassTemplateField`, template create data)
- Modify: `src/services/class-generator.ts` (`CLASS_GENERATOR.createChildren`)
- Modify: `src/app/(teacher)/class/new/new-class-form.tsx`, `src/components/class/class-edit-form.tsx`, `src/components/settings/template-form.tsx`. These get form **state only**, no UI; Task 7 adds the UI.
- Modify: `src/app/(teacher)/class/[id]/edit/page.tsx`, `src/app/(teacher)/settings/recurring/[id]/page.tsx` (pass the stored mode into `initial`)
- Create: `src/services/donation-constraints.test.ts`
- Test: `src/services/class-generator.test.ts`, `tests/integration/classes-api.test.ts`, `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Produces:
  - Prisma: `enum PricingMode { tiered donation }`; `Class.pricingMode` and `ClassTemplate.pricingMode` (`PricingMode`, default `tiered`); `Class.donationTotal: Decimal | null`; `Registration.donationInvitedAt: Date | null`; `Registration.donationPromptHiddenAt: Date | null`.
  - `src/lib/class-fields.ts`: `export const PRICING_LOCKED_FIELDS: readonly ['pricingMode']`, `export type PricingLockedField`. `LOCKED_FIELDS` is now `[...ECONOMIC_FIELDS, ...PRICING_LOCKED_FIELDS, ...SCHEDULE_LOCKED_FIELDS]`.
  - The four schemas accept `pricingMode?: 'tiered' | 'donation'`.
  - Form state: `FormData.pricingMode` (new-class wizard), `ClassEditInitial.pricingMode`, `TemplateFormValues.pricingMode`, each typed `PricingMode`.

- [ ] **Step 1: Write the failing constraint tests** in a new `src/services/donation-constraints.test.ts`. Copy the teacher/room/teacherRoom `beforeAll`/`afterAll` from `src/services/class-economics-constraints.test.ts` (prefix the suffix `donation-check-`). Write straight through Prisma so only the database can refuse:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';
import { createPrismaClient } from '@/lib/prisma-client';

/**
 * Bite tests for the CHECKs `prisma/migrations/<ts>_donation_checks` adds
 * (#912). Each write bypasses every service, so a pass means the DATABASE
 * refuses the row. Assertions match the constraint's own name, so an
 * unrelated failure (a slot collision, an FK) cannot satisfy them.
 */
const prisma = createPrismaClient();
const uniqueSuffix = `donation-check-${Date.now()}`;
// …teacherId / accountId / roomId / teacherRoomId / studentId setup, as in
// class-economics-constraints.test.ts, plus one Student for the registration cases.

let counter = 0;
const makeClass = (data: { pricingMode: 'tiered' | 'donation'; donationTotal?: number | null }) => {
  counter += 1;
  return createClassFixture(prisma, {
    teacherId, teacherRoomId, classType: 'Donation Check',
    date: slotDate('2027-02-01', counter), startTime: hhmmToTime('09:00'), durationMinutes: 60,
    roomCost: 20, minRate: 0, targetRate: 0, minStudents: 1, maxStudents: 10,
    status: 'completed', ...data,
  });
};

describe('Class donation CHECKs (#912)', () => {
  it('Class_donation_total_nonnegative_check refuses a negative total', async () => {
    await expect(makeClass({ pricingMode: 'donation', donationTotal: -0.01 }))
      .rejects.toThrow('Class_donation_total_nonnegative_check');
  });
  it('Class_donation_total_mode_check refuses a total on a tiered class', async () => {
    await expect(makeClass({ pricingMode: 'tiered', donationTotal: 10 }))
      .rejects.toThrow('Class_donation_total_mode_check');
  });
  it('accepts a zero total on a donation class, and a null one on either mode', async () => {
    await expect(makeClass({ pricingMode: 'donation', donationTotal: 0 })).resolves.toBeDefined();
    await expect(makeClass({ pricingMode: 'donation', donationTotal: null })).resolves.toBeDefined();
    await expect(makeClass({ pricingMode: 'tiered', donationTotal: null })).resolves.toBeDefined();
  });
  it('accepts minRate = targetRate = 0 under every economics CHECK', async () => {
    await expect(makeClass({ pricingMode: 'donation' })).resolves.toBeDefined();
  });
});

describe('Registration donation CHECK (#912)', () => {
  it('Registration_donation_hidden_requires_invited_check refuses a hide without an invitation', async () => {
    const cls = await makeClass({ pricingMode: 'donation' });
    await expect(prisma.registration.create({
      data: { classId: cls.id, studentId, tierAtBooking: 3, donationPromptHiddenAt: new Date() },
    })).rejects.toThrow('Registration_donation_hidden_requires_invited_check');
  });
  it('accepts a hide after an invitation', async () => {
    const cls = await makeClass({ pricingMode: 'donation' });
    await expect(prisma.registration.create({
      data: { classId: cls.id, studentId, tierAtBooking: 3, donationInvitedAt: new Date(), donationPromptHiddenAt: new Date() },
    })).resolves.toBeDefined();
  });
});
```

Cleanup in `afterAll` deletes registrations by `class: { calendarEntry: { teacherId } }` before the entries. Every `deleteMany` filter is guarded with `if (teacherId)`, as the copied file does.

- [ ] **Step 2: Run it and confirm it fails.**
Run: `pnpm exec vitest run --project unit src/services/donation-constraints.test.ts`
Expected: FAIL at type-check or runtime: `Unknown argument 'pricingMode'` / `donationTotal` from Prisma.

- [ ] **Step 3: Schema and generated migration.** In `prisma/schema.prisma`:

```prisma
enum PricingMode {
  tiered
  donation
}
```

- `model ClassTemplate`, after `isPrivate`: `pricingMode PricingMode @default(tiered)`.
- `model Class`, after `isPrivate`: `pricingMode PricingMode @default(tiered)`.
- `model Class`, after `vatTotal`:
  ```prisma
  /// What a donation class's students gave in total, as the teacher recorded it.
  /// NULL is "not recorded", distinct from 0. Written only by `recordDonationTotal`.
  donationTotal Decimal? @db.Decimal(10, 2)
  ```
- `model Registration`, after `classReminderSentAt`:
  ```prisma
  /// When this booking was invited to give. Set once, never cleared.
  donationInvitedAt      DateTime?
  /// When the student hid the giving prompt. Records only that it was hidden.
  donationPromptHiddenAt DateTime?
  ```

Run: `pnpm exec prisma migrate dev --name donation_classes`
Expected: one migration that creates the enum, adds the two `pricingMode` columns `NOT NULL DEFAULT 'tiered'`, `donationTotal DECIMAL(10,2)`, and the two `TIMESTAMP(3)` columns.

- [ ] **Step 4: Hand-author the CHECKs.**
Run: `pnpm exec prisma migrate dev --create-only --name donation_checks`. Write its `migration.sql`:

```sql
-- Invariants, DB-enforced, for donation-based classes (#912). A total is
-- never negative and exists only on a donation class; a prompt is hidden
-- only after its booking was invited. "Only a donation class's bookings are
-- invited" reads the Class row, so no CHECK can hold it: the two writers of
-- "donationInvitedAt" gate on the class's mode instead.
ALTER TABLE "Class" ADD CONSTRAINT "Class_donation_total_nonnegative_check"
  CHECK ("donationTotal" IS NULL OR "donationTotal" >= 0);
ALTER TABLE "Class" ADD CONSTRAINT "Class_donation_total_mode_check"
  CHECK ("donationTotal" IS NULL OR "pricingMode" = 'donation');
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_donation_hidden_requires_invited_check"
  CHECK ("donationPromptHiddenAt" IS NULL OR "donationInvitedAt" IS NOT NULL);
```

Run: `pnpm exec prisma migrate dev`. Expected: applies `donation_checks` and reports no drift.

- [ ] **Step 5: Run the constraint tests.**
Run: `pnpm exec vitest run --project unit src/services/donation-constraints.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove each CHECK bites.** The `unit` project runs against `ethical_yoga_test`. For each of the three constraints in turn:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c 'ALTER TABLE "Class" DROP CONSTRAINT "Class_donation_total_nonnegative_check"'
pnpm exec vitest run --project unit src/services/donation-constraints.test.ts -t nonnegative
```
  - Record the exact failure. Expected: `promise resolved "{…}" instead of rejecting`.
  - Restore it with the migration's own statement, run in the same `docker exec … psql -c '…'` form.
  - Re-run the case. Expected: PASS.
  - Do the same for `Class_donation_total_mode_check` (`-t "mode_check"`) and for `Registration_donation_hidden_requires_invited_check` on `"Registration"` (`-t hidden_requires`).
  - Afterwards run `pnpm exec prisma migrate status`. Expected: up to date. The restored constraints are byte-identical, so there is no drift.

- [ ] **Step 7: Lock the field.** Replace the tail of `src/lib/class-fields.ts`:

```ts
/**
 * How a class is priced (#912). Locked with the economics: a booked class's
 * students booked against the pricing it showed them.
 */
export const PRICING_LOCKED_FIELDS = Object.freeze(['pricingMode'] as const);

export type PricingLockedField = (typeof PRICING_LOCKED_FIELDS)[number];

/** Everything `settingsLocked` freezes: the economics, the pricing mode, then the schedule. */
export const LOCKED_FIELDS = Object.freeze([
  ...ECONOMIC_FIELDS,
  ...PRICING_LOCKED_FIELDS,
  ...SCHEDULE_LOCKED_FIELDS,
] as const);
```

- [ ] **Step 8: Schemas.** Add `pricingMode: z.enum(['tiered', 'donation']).optional(),` after `isPrivate` in all four schemas in `src/lib/schemas.ts`. In `updateClassSchema` add the comment `// Locked with the economics (#912); see PRICING_LOCKED_FIELDS in src/lib/class-fields.ts.`

- [ ] **Step 9: Classify the fields and thread them through.**
  - Run `pnpm exec tsc --noEmit`. Expected: failures in `_classUpdateFieldsArePermitted` and in `_templateFieldsArePermitted`/`_templateListsPartitionTheModel`, each naming `"pricingMode"`. The forms' `_formCovers*` pins fail too. Record the error text.
  - `TeacherEditableClassField` gains `| 'pricingMode'`.
  - `TeacherEditableClassTemplateField` gains `| 'pricingMode'`.
  - `PlainUpdateForbiddenClassField` gains `| 'donationTotal'`, and the duplicated union inside `_classForbiddenListIsComplete` gains it too. Its docblock names its guard as `recordDonationTotal` (`services/donations.ts`): extend the "the financial totals → written only by `completeClass`" line of `TeacherEditableClassField`'s docblock to "…, and `donationTotal` only by `recordDonationTotal`".
  - POST create in `src/app/api/classes/route.ts`: `pricingMode: body.pricingMode ?? 'tiered',`.
  - Template create in `class-template-lifecycle.ts`: `pricingMode: input.pricingMode ?? 'tiered',`.
  - `CLASS_GENERATOR.createChildren`: `pricingMode: template.pricingMode,` beside `isPrivate: template.isPrivate,`.
  - The `locked` branch in `src/app/api/classes/[id]/route.ts` keeps `'SETTINGS_LOCKED'`. Its message picks the schedule sentence when a schedule field is among `result.fields`. Otherwise it picks `'Pricing is locked once the first student books.'` when only `pricingMode` was sent, and the existing prices-and-capacity sentence in every other case.
  - Forms, state only:
    - `new-class-form.tsx`: `FormData` gains `pricingMode: PricingMode` (initially `'tiered'`), sent in the POST payload.
    - `class-edit-form.tsx`: `ClassEditInitial` gains `pricingMode: PricingMode`. The payload deletes `pricingMode` when it equals `initial.pricingMode`, the same rule `isPrivate` follows.
    - `template-form.tsx`: `TemplateFormValues` gains `pricingMode: PricingMode` (default `'tiered'`). On an edit the payload deletes it when unchanged.
    - The two edit pages pass `pricingMode: cls.pricingMode` / `template.pricingMode`.
  - Re-run `tsc`. Expected: exit 0.

- [ ] **Step 10: Failing integration and generator tests.**
  - `tests/integration/classes-api.test.ts`, inside the describe that owns `put`, `ownerToken`, `lockedClassId` and `economicsClassId` (the #910 cases sit there):

```ts
it('a pricingMode change on a locked class -> 409 SETTINGS_LOCKED, mode unchanged (#912)', async () => {
  const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
  expect(before.settingsLocked).toBe(true);
  await expectRefusal(await put(ownerToken, lockedClassId, { pricingMode: 'donation' }), 'SETTINGS_LOCKED');
  const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
  expect(after.pricingMode).toBe(before.pricingMode);
});

it('an unbooked class moves to donation and back with its rates untouched (#912)', async () => {
  const before = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
  expect(before.settingsLocked).toBe(false);
  expect((await put(ownerToken, economicsClassId, { pricingMode: 'donation' })).status).toBe(200);
  expect((await put(ownerToken, economicsClassId, { pricingMode: 'tiered' })).status).toBe(200);
  const after = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
  expect(after.pricingMode).toBe('tiered');
  expect(after.minRate.toString()).toBe(before.minRate.toString());
  expect(after.targetRate.toString()).toBe(before.targetRate.toString());
});
```

  In the `POST /api/classes` describe, reuse that block's own valid-body builder:

```ts
it('creates a donation class when pricingMode is sent, a tiered one when omitted (#912)', async () => {
  // POST once with { ...validBody(), pricingMode: 'donation' } and once without; read both rows back
  expect(donation.pricingMode).toBe('donation');
  expect(tiered.pricingMode).toBe('tiered');
});
```

  - `tests/integration/class-templates-api.test.ts`, beside the #910 case at "persists isPrivate on the template": a create with `pricingMode: 'donation'` persists it, and every generated class carries `'donation'`. Give it a weekday and slot of its own, as that case does. Also: a PUT `{ pricingMode: 'donation' }` on a template with generated classes answers 200 and leaves their `pricingMode` as `'tiered'`.
  - `src/services/class-generator.test.ts`: add `describe('pricingMode on generated classes (#912)')` mirroring `describe('isPrivate on generated classes (#910)')` exactly. It needs the same `from`, the same `generatedClasses`, a `beforeEach`/`afterEach` resetting `pricingMode: 'tiered'`, a stamp case (4 created, all `'donation'`), and a flip-through-`updateClassTemplate` case (all still `'tiered'`).

- [ ] **Step 11: Run them.**
Run: `pnpm exec vitest run --project unit src/services/class-generator.test.ts -t 912 && pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t 912 && pnpm exec vitest run --project integration tests/integration/class-templates-api.test.ts -t 912`
Expected: PASS. The lock case passes through the existing `updateClass` machinery because `pricingMode` is now in `LOCKED_FIELDS`.

- [ ] **Step 12: Prove the lock bites.** Make `LOCKED_FIELDS` omit `...PRICING_LOCKED_FIELDS`. Warm `curl -s -o /dev/null http://localhost:3000/api/classes`, run the locked case, and record the failure. Expected: `expected 200 to be 409` or the code mismatch. Restore, warm, PASS.

- [ ] **Step 13: Prove the generator stamp bites.** Delete `pricingMode: template.pricingMode,` from `createChildren`. Run the stamp case and record the failure. Expected: `every(c => c.pricingMode === 'donation')` is false. Restore, PASS.

- [ ] **Step 14: Docs.** In `docs/data-model.md`:
  - `ClassTemplate` table: add `pricingMode | PricingMode, default tiered | Stamped onto each generated Class; changing it touches no existing class (#194, #912)`.
  - `Class` table: `pricingMode` with `Locked with the economics: a PRICING_LOCKED_FIELDS member (#912)`, and `donationTotal | Decimal(10,2)?` with `What the teacher recorded for a donation class. NULL is not recorded. Written only by recordDonationTotal; VAT is derived on read (#912)`.
  - `Registration` table: both timestamps, with the spec §3.4 wording.

- [ ] **Step 15: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/*_donation_classes prisma/migrations/*_donation_checks src/lib/class-fields.ts src/lib/schemas.ts src/app/api/classes/route.ts "src/app/api/classes/[id]/route.ts" src/services/class-lifecycle.ts src/services/class-template-lifecycle.ts src/services/class-generator.ts src/services/class-generator.test.ts src/services/donation-constraints.test.ts "src/app/(teacher)/class/new/new-class-form.tsx" src/components/class/class-edit-form.tsx src/components/settings/template-form.tsx "src/app/(teacher)/class/[id]/edit/page.tsx" "src/app/(teacher)/settings/recurring/[id]/page.tsx" tests/integration/classes-api.test.ts tests/integration/class-templates-api.test.ts docs/data-model.md
git commit -m "feat(#912): PricingMode, donationTotal and the donation stamps, locked and stamped"
```

---

### Task 2: Money readers learn the donation mode — `MethodAmount`, EPC without an amount, price line, breakdown

**Files:**
- Create: `src/lib/method-amount.ts`, `src/lib/epc-qr.ts`, `src/lib/epc-qr.test.ts`
- Create: `src/components/student/method-panel.tsx`, `src/components/student/method-panel.test.tsx`
- Modify: `src/components/student/payment-qr.tsx`, `src/components/student/payment-qr.test.tsx`
- Modify: `src/components/student/payment-link-panel.tsx`
- Modify: `src/app/(student)/bookings/[classId]/pay/page.tsx` (drop the local `MethodPanel`; pass `pricingMode` to the breakdown and to `reportMissingPayment`)
- Modify: `src/lib/price-line.ts`, `src/lib/price-line.test.ts`, `src/components/booking/price-range.tsx`
- Modify: `src/app/(public)/[slug]/page.tsx`, `src/app/(public)/[slug]/book/[classId]/page.tsx`, `src/app/(student)/bookings/page.tsx` (pass `pricingMode`)
- Modify: `src/lib/payment-breakdown.ts`, `src/lib/payment-breakdown.test.ts`, `src/lib/payment-breakdown.server.ts`
- Modify: `src/lib/pay-page.server.ts`, `src/lib/pay-page.server.test.ts`

**Interfaces:**
- Consumes: `PricingMode` (Task 1).
- Produces:

```ts
// src/lib/method-amount.ts
export type MethodAmount = { kind: 'fixed'; amount: number } | { kind: 'open' };

// src/lib/epc-qr.ts
export function epcQrPayload(input: {
  iban: string; bic: string | null; beneficiary: string;
  amount: MethodAmount; currency: typeof EPC_QR_CURRENCY; remittance: string;
}): string;

// src/components/student/method-panel.tsx
export type MethodPanelProps = { method: PaymentMethod; currency: Currency; reference: string } & (
  | { amount: { kind: 'fixed'; amount: number }; paymentId: string }
  | { amount: { kind: 'open' }; paymentId?: never }
);
export function MethodPanel(props: MethodPanelProps): React.ReactNode;

// src/lib/price-line.ts
export type PriceLineResult =
  | { kind: 'personal'; spread: AttendanceSpread }
  | { kind: 'anonymous'; estimates: TierPrices }
  | { kind: 'donation' };
// ResolvePriceLineInput gains `pricingMode: PricingMode`.

// src/lib/payment-breakdown.ts — ResolvePaymentBreakdownInput gains `pricingMode: PricingMode`.
// src/lib/pay-page.server.ts — reportMissingPayment's argument gains `pricingMode: PricingMode`.
```

`PaymentQr` and `PaymentLinkPanel` replace `amount: number` with `amount: MethodAmount`.

- [ ] **Step 1: Failing unit tests.**
  - `src/lib/epc-qr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { epcQrPayload } from './epc-qr';

const BASE = { iban: 'NL91 ABNA 0417 1643 00', bic: null, beneficiary: 'I. Hofland', currency: 'EUR' as const, remittance: 'Vinyasa Saturday' };

describe('epcQrPayload', () => {
  it('encodes a fixed amount on line 8', () => {
    const lines = epcQrPayload({ ...BASE, amount: { kind: 'fixed', amount: 12.5 } }).split('\n');
    expect(lines[7]).toBe('EUR12.50');
    expect(lines[6]).toBe('NL91ABNA0417164300');
  });
  it('leaves the amount line empty for an open amount, keeping every other line', () => {
    const lines = epcQrPayload({ ...BASE, amount: { kind: 'open' } }).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[7]).toBe('');
    expect(lines[10]).toBe('Vinyasa Saturday');
  });
});
```

  - `src/lib/price-line.test.ts`: `it('returns donation for a donation class, whatever the viewer', …)`. Use `{ ...BASE, pricingMode: 'donation', registrations: [...], viewer: { studentId: 's1', tier: 4, tierSelectedAt: new Date() } }` and expect `{ kind: 'donation' }`. Add `pricingMode: 'tiered'` to `BASE` so the existing cases compile.
  - `src/lib/payment-breakdown.test.ts`: `it('hides the breakdown of a donation class, whose snapshot is null by design', …)`. Use `{ ...COMPLETED, pricingMode: 'donation', totalRevenue: null, vatTotal: null, payment: null }` and expect `{ kind: 'hidden' }`. Add `pricingMode: 'tiered'` to `COMPLETED`.
  - `src/lib/pay-page.server.test.ts`: `it('records nothing for a donation class, which never has a payment', …)` — spy on `log.warn` as the file's other cases do and call `reportMissingPayment({ classId: 'c', registrationId: 'r', registrationStatus: 'attended', classStatus: 'completed', pricingMode: 'donation' })`. Expect `warn` not called. Add `pricingMode: 'tiered'` to the existing calls.

- [ ] **Step 2: Run them and confirm failure.**
Run: `pnpm exec vitest run --project unit src/lib/epc-qr.test.ts src/lib/price-line.test.ts src/lib/payment-breakdown.test.ts src/lib/pay-page.server.test.ts`
Expected: FAIL. `Cannot find module './epc-qr'`, and `kind` is `'personal'`/`'snapshot_missing'`, or `warn` was called.

- [ ] **Step 3: Implement the pure modules.**
  - `src/lib/method-amount.ts` exports `MethodAmount` (docblock: "What a payment method's panel may name: a fixed amount owed, or none, for a gift (#912).").
  - `src/lib/epc-qr.ts` moves the payload array out of `payment-qr.tsx` unchanged, except line 8:

```ts
amount.kind === 'fixed' ? `${currency}${amount.amount.toFixed(2)}` : '',
```
  - `resolvePriceLine` becomes a switch:

```ts
export function resolvePriceLine(input: ResolvePriceLineInput): PriceLineResult {
  switch (input.pricingMode) {
    case 'donation':
      return { kind: 'donation' };
    case 'tiered':
      return resolveTieredPriceLine(input);
    default: {
      const unhandled: never = input.pricingMode;
      throw new Error(`resolvePriceLine: unhandled pricing mode ${String(unhandled)}`);
    }
  }
}
```

  The current body moves unchanged into `function resolveTieredPriceLine(input: ResolvePriceLineInput): PriceLineResult`.
  - `resolvePaymentBreakdown`: before `if (classStatus !== 'completed')`, add a `switch (input.pricingMode)`. `'donation'` returns `{ kind: 'hidden' }`; `'tiered'` breaks; the `never` default throws.
  - `reportMissingPayment`: `if (found.pricingMode === 'donation') return;` as the first line, with the comment `// A donation class never has a payment (#912).`
  - `resolveReportedPaymentBreakdown` passes the input through unchanged. Its type follows.

- [ ] **Step 4: Components.**
  - `PaymentQr` builds its payload with `epcQrPayload`. Its alt text is `` `Payment QR: ${formatMoney(amount.amount, currency)} to ${beneficiary}` `` for `fixed` and `` `Payment QR to ${beneficiary}` `` for `open`.
  - `PaymentLinkPanel` with `open`:
    - renders `Give through the link, with this reference:`;
    - passes `CopyFieldList` only the `reference` field;
    - keeps the button and the "marks it as received" caption off (a gift is not marked).
  - `PaymentLinkPanel` with `fixed` is unchanged.
  - `src/components/student/method-panel.tsx`: the pay page's `MethodPanel`, moved and typed to `MethodPanelProps`.
    - `bank_transfer` reads `Transfer <amount> to:` for `fixed` and `Transfer to:` for `open`.
    - `processor` with `open` logs `log.error({ kind: 'processor' }, 'method panel: a processor method cannot take an open amount')` and returns null.
    - The `never` default stays.
  - The pay page imports it and passes `amount={{ kind: 'fixed', amount }}`.
  - Callers of `resolvePriceLine` (`[slug]/page.tsx`, `book/[classId]/page.tsx`, both calls in `bookings/page.tsx`) pass `pricingMode: cls.pricingMode`.
  - `resolveReportedPaymentBreakdown` calls in the pay page and bookings page pass `pricingMode: cls.pricingMode`.
  - `reportMissingPayment` in the pay page passes `pricingMode: registration.class.pricingMode`.
  - `ClassPriceLine` becomes a `switch (line.kind)` with a `never` default. `'donation'` renders `<p className={`type-caption ${className ?? ''}`.trim()}>By donation</p>`.

- [ ] **Step 5: Component tests.**
  - `payment-qr.test.tsx`: update `payloadFor` to pass `amount={{ kind: 'fixed', amount: 12.5 }}`. Add a case rendering `amount={{ kind: 'open' }}`: assert `lines[7]` is `''` and the image's alt is `Payment QR to I. Hofland`, matching no `/\d/` digit pattern.
  - `method-panel.test.tsx`: render each of `bank_transfer`, `epc_qr`, `payment_link` with `{ kind: 'open' }`, using `qrcode` mocked as in `payment-qr.test.tsx`. Assert `container.textContent` does not match `/€|\d+[.,]\d{2}/`. Render `bank_transfer` with `{ kind: 'fixed', amount: 12.5 }` and assert `€12.50` appears.

- [ ] **Step 6: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit src/lib/epc-qr.test.ts src/lib/price-line.test.ts src/lib/payment-breakdown.test.ts src/lib/payment-breakdown.server.test.ts src/lib/pay-page.server.test.ts && pnpm exec vitest run --project components src/components/student src/components/booking`
Expected: PASS. Then warm and run the pay page suite unchanged: `curl -s -o /dev/null http://localhost:3000/bookings && pnpm exec vitest run --project integration tests/integration/pay-page.test.ts`. Expected: PASS (tiered behaviour unchanged).

- [ ] **Step 7: Prove the price-line `never` default bites.** Delete the `case 'donation':` arm in `resolvePriceLine`. Run `pnpm exec tsc --noEmit` and record the exact error at the `const unhandled: never` line. Expected: `Type '"donation"' is not assignable to type 'never'.` Restore, tsc exit 0.

- [ ] **Step 8: Prove the open-amount guard bites.** In `epcQrPayload`, make the open branch return `` `${currency}0.00` `` — the faked-€0 encoding the spec rules out. Run `epc-qr.test.ts` and record the failure (`expected 'EUR0.00' to be ''`). Restore, PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/lib/method-amount.ts src/lib/epc-qr.ts src/lib/epc-qr.test.ts src/components/student/method-panel.tsx src/components/student/method-panel.test.tsx src/components/student/payment-qr.tsx src/components/student/payment-qr.test.tsx src/components/student/payment-link-panel.tsx "src/app/(student)/bookings/[classId]/pay/page.tsx" src/lib/price-line.ts src/lib/price-line.test.ts src/components/booking/price-range.tsx "src/app/(public)/[slug]/page.tsx" "src/app/(public)/[slug]/book/[classId]/page.tsx" "src/app/(student)/bookings/page.tsx" src/lib/payment-breakdown.ts src/lib/payment-breakdown.test.ts src/lib/payment-breakdown.server.ts src/lib/pay-page.server.ts src/lib/pay-page.server.test.ts
git commit -m "feat(#912): money readers switch on pricingMode; an open MethodAmount names no amount"
```

---

### Task 3: Completion of a donation class — the claim, the invitation type, the teacher's notice

**Files:**
- Modify: `prisma/schema.prisma` (enum `NotificationType`)
- Create: `prisma/migrations/<ts>_donation_invitation_type/migration.sql` (generated)
- Modify: `src/lib/registration-status.ts`
- Create: `src/services/donations.ts`, `src/services/donations.test.ts`
- Modify: `src/services/class-lifecycle.ts` (`completeClass`)
- Modify: `src/lib/notification-retention.ts`, `src/lib/push-policy.ts`, `src/lib/push-policy.test.ts`, `src/lib/email-templates.ts`, `src/lib/email-templates.test.ts`, `src/lib/notification-links.ts`, `src/lib/notification-links.test.ts`, `src/lib/notification-retention.test.ts`, `src/services/notification-policy.test.ts`
- Modify: `docs/data-model.md` (Notification types)

**Interfaces:**
- Consumes: Task 1's columns.
- Produces:

```ts
// src/lib/registration-status.ts
export const DONATION_INVITED_STATUSES: readonly RegistrationStatus[]; // registered, attended — derived

// src/lib/notification-links.ts
export function givePagePath(classId: string): string; // `/bookings/${classId}/give`
export const GIVE_LABEL = 'How to give';

// src/services/donations.ts
export type InvitedRow = { id: string; studentId: string };
export async function claimCompletionInvitations(tx: Prisma.TransactionClient, classId: string, at: Date): Promise<InvitedRow[]>;
export function donationInvitation(studentId: string, cls: { id: string; calendarEntry: { classType: string } }): CreateNotificationInput;
export function donationCompletionNotice(cls: DonationNoticeClass, invited: number): CreateNotificationInput;
export type DonationNoticeClass = { id: string; calendarEntry: { teacherId: string; classType: string; date: Date; startTime: Date } };
```

- [ ] **Step 1: Failing service tests** in a new `src/services/donations.test.ts`. Copy the teacher/room/teacherRoom fixture and teardown from `describe('completeClass (DB)')` in `src/services/class-lifecycle.test.ts`. Prefix the suffix `donations-`. Use a `makeClass` that passes `pricingMode: 'donation', minRate: 0, targetRate: 0, status: 'in_progress'` and `slotDate('2026-06-01', counter)`. A `seedStudent(i)` helper creates a `Student` with `incomeTier: 3`.

```ts
describe('completeClass on a donation class (#912)', () => {
  it('writes no Payment, leaves the snapshot null and stamps exactly registered + attended', async () => {
    const cls = await makeClass();
    const regs = {
      registered: await register(cls.id, 'registered'),
      attended: await register(cls.id, 'attended'),
      walkIn: await register(cls.id, 'registered', { isWalkIn: true }),
      noShow: await register(cls.id, 'no_show'),
      lateCancel: await register(cls.id, 'late_cancel'),
      cancelled: await register(cls.id, 'cancelled'),
    };
    const result = await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    expect(result.ok).toBe(true);

    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
    const row = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(row.status).toBe('completed');
    expect(row.totalRevenue).toBeNull();
    expect(row.vatTotal).toBeNull();
    expect(row.effectiveTeacherRate).toBeNull();
    expect(row.donationTotal).toBeNull();
    expect(row.totalStudents).toBe(5); // the CHARGED_STATUSES count, as tiered completion writes it

    const stamped = await prisma.registration.findMany({ where: { classId: cls.id, donationInvitedAt: { not: null } }, select: { id: true } });
    expect(stamped.map((r) => r.id).sort()).toEqual([regs.registered, regs.attended, regs.walkIn].sort());

    const invites = await prisma.notification.findMany({ where: { relatedClassId: cls.id, type: 'donation_invitation' } });
    expect(invites.map((n) => n.recipientId).sort()).toEqual(/* the three students' ids, sorted */);
    for (const n of invites) {
      expect(n.body).not.toMatch(/€|\d+[.,]\d{2}|IBAN|NL\d{2}/);
    }

    const notice = await prisma.notification.findFirstOrThrow({ where: { relatedClassId: cls.id, recipientType: 'teacher' } });
    expect(notice.body).toMatch(/is complete — 3 students invited to give\.$/);
    expect(await prisma.registration.count({ where: { classId: cls.id, price: { not: null } } })).toBe(0);
  });

  it('a donation class nobody came to completes with "No one to invite."', async () => {
    const cls = await makeClass();
    await register(cls.id, 'no_show');
    await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    const notice = await prisma.notification.findFirstOrThrow({ where: { relatedClassId: cls.id, recipientType: 'teacher' } });
    expect(notice.body).toMatch(/is complete\. No one to invite\.$/);
  });

  it('never re-stamps a booking already invited', async () => {
    const cls = await makeClass();
    const regId = await register(cls.id, 'attended');
    // A value completion cannot produce: it stamps the transaction's own clock.
    const reserved = new Date('2000-01-01T00:00:00.000Z');
    await prisma.registration.update({ where: { id: regId }, data: { donationInvitedAt: reserved } });
    await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
    expect(after.donationInvitedAt?.toISOString()).toBe(reserved.toISOString());
    expect(await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'donation_invitation' } })).toBe(0);
  });

  it('an erasure completion (finishedEarly) invites nobody (Review Focus 2)', async () => {
    const cls = await makeClass();
    const regId = await register(cls.id, 'attended');
    await completeClass(prisma, cls.id, { finishedEarly: true });
    expect((await prisma.registration.findUniqueOrThrow({ where: { id: regId } })).donationInvitedAt).toBeNull();
    expect(await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'donation_invitation' } })).toBe(0);
  });

  it('a tiered class still bills as before and stamps nothing', async () => {
    const cls = await makeClass({ pricingMode: 'tiered', minRate: 15, targetRate: 25 });
    await register(cls.id, 'attended');
    await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(1);
    expect(await prisma.registration.count({ where: { classId: cls.id, donationInvitedAt: { not: null } } })).toBe(0);
  });
});
```

`register(classId, status, extra?)` creates a fresh student and a `Registration` with `tierAtBooking: 3` and returns its id. Teardown deletes notifications by `relatedClassId` over the teacher's classes before the entries.

- [ ] **Step 2: Run and confirm failure.**
Run: `pnpm exec vitest run --project unit src/services/donations.test.ts`
Expected: FAIL. TypeScript rejects `'donation_invitation'` as a `NotificationType`, or the first case finds Payment rows.

- [ ] **Step 3: Notification type.** Add `donation_invitation` to `enum NotificationType` in `prisma/schema.prisma`. Run `pnpm exec prisma migrate dev --name donation_invitation_type`. Expected: one `ALTER TYPE "NotificationType" ADD VALUE 'donation_invitation';`.

- [ ] **Step 4: Classify it everywhere the compiler asks.** Run `pnpm exec tsc --noEmit` and fix each error it names by classifying, never by widening:
  - `NOTIFICATION_RETENTION_DAYS`: `donation_invitation: SHORT_RETENTION_DAYS,` with the comment `// The giving prompt hides itself on the same day (src/lib/donation-prompt.ts).`
  - `STUDENT_PUSH_GROUP`: `donation_invitation: 'payments',` (lock screen shows the fixed line).
  - `STUDENT_INTROS`: `donation_invitation: 'Thank you for coming to class.',`.
  - `ESSENTIAL_NOTIFICATION_TYPES` stays without it. It is optional, so `studentUnsubscribeKind` answers `'student_notifications'` with no edit.
  - `notification-links.ts`: add `givePagePath` and `GIVE_LABEL` (interfaces above). In `studentNotificationHref`, after the `isPaymentNotification` branch, add `if (notification.type === 'donation_invitation') return notification.relatedClass ? givePagePath(notification.relatedClass.id) : null;`.
  - `email-templates.ts` `studentAction`: after the payment branch, a `donation_invitation` branch returns `{ label: GIVE_LABEL, path: givePagePath(notification.relatedClassId) }`. With no `relatedClassId` it returns `undefined`, logged through `logDegraded` with a new code `DONATION_INVITATION_WITHOUT_CLASS`, registered in `src/lib/degradation-codes.ts` beside `PAYMENT_NOTIFICATION_WITHOUT_CLASS` and documented in `docs/degradation-sites.md`. Never the pay page.
  - Tests:
    - `push-policy.test.ts` table gains `['donation_invitation', 'payments']`; its "files every NotificationType" case already covers the key set.
    - `notification-links.test.ts`: a `donation_invitation` row links to `/bookings/c1/give`, and to `null` without a class.
    - `email-templates.test.ts`: the rendered donation email's text contains `/bookings/c1/give` and not `/pay`.
    - `notification-policy.test.ts`: `shouldEmailStudent('donation_invitation', false)` is `false`.
    - `notification-retention.test.ts`: it is 30 days.

- [ ] **Step 5: `DONATION_INVITED_STATUSES`.** In `src/lib/registration-status.ts`, after `CHARGED_STATUSES`:

```ts
/**
 * Whether a booking in this status came to the class, as a donation class's
 * invitation counts it (#912): an unmarked booking counts as present.
 * Exhaustive over the enum, so a new status is a compile error until decided.
 */
const CAME_TO_CLASS: Record<RegistrationStatus, boolean> = {
  registered: true,
  attended: true,
  no_show: false,
  late_cancel: false,
  cancelled: false,
};

/** The statuses a donation class invites to give. Derived from `CAME_TO_CLASS`. */
export const DONATION_INVITED_STATUSES: readonly RegistrationStatus[] = Object.freeze(
  (Object.keys(CAME_TO_CLASS) as RegistrationStatus[]).filter((status) => CAME_TO_CLASS[status]),
);
```

- [ ] **Step 6: `src/services/donations.ts`.**

```ts
import type { Prisma } from '@/lib/prisma-client';
import { DONATION_INVITED_STATUSES } from '@/lib/registration-status';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import type { CreateNotificationInput } from '@/services/notifications';

export type InvitedRow = { id: string; studentId: string };

/**
 * Stamps every booking of `classId` that came and was not yet invited, and
 * returns exactly the rows it stamped — the invitations go to these, never
 * to a re-read. Runs inside `completeClass`'s transaction, under its class lock.
 */
export async function claimCompletionInvitations(
  tx: Prisma.TransactionClient,
  classId: string,
  at: Date,
): Promise<InvitedRow[]> {
  return tx.registration.updateManyAndReturn({
    where: { classId, status: { in: [...DONATION_INVITED_STATUSES] }, donationInvitedAt: null },
    data: { donationInvitedAt: at },
    select: { id: true, studentId: true },
  });
}

export function donationInvitation(
  studentId: string,
  cls: { id: string; calendarEntry: { classType: string } },
): CreateNotificationInput {
  return {
    recipientType: 'student',
    recipientId: studentId,
    type: 'donation_invitation',
    title: 'Thank you for coming',
    body: `Thank you for coming to ${cls.calendarEntry.classType}. It was by donation — if you'd like to give, here's how.`,
    relatedClassId: cls.id,
  };
}

export type DonationNoticeClass = {
  id: string;
  calendarEntry: { teacherId: string; classType: string; date: Date; startTime: Date };
};

export function donationCompletionNotice(cls: DonationNoticeClass, invited: number): CreateNotificationInput {
  const { classType, date, startTime, teacherId } = cls.calendarEntry;
  const lead = `${classType} class on ${formatDayHeader(date)} at ${timeToHHmm(startTime)} is complete`;
  return {
    recipientType: 'teacher',
    recipientId: teacherId,
    type: 'payment_request',
    title: 'Class completed',
    body: invited === 0
      ? `${lead}. No one to invite.`
      : `${lead} — ${invited} ${invited === 1 ? 'student' : 'students'} invited to give.`,
    relatedClassId: cls.id,
  };
}
```

`payment_request` is the teacher's class-completed type: `TEACHER_EMAIL_POLICY` and `TEACHER_PUSH_GROUP` already key it as such.

- [ ] **Step 7: Branch `completeClass`.** In `src/services/class-lifecycle.ts`, directly after `const chargedRegistrations = …` and **before** the zero-charged short-circuit, which would write `totalRevenue: 0`:

```ts
    switch (cls.pricingMode) {
      case 'donation': {
        // #912. No pricing engine, no Payment, no price write. The snapshot
        // columns stay null, which `Class_vat_total_snapshot_check` allows.
        await tx.class.update({
          where: { id: classId },
          data: { status: 'completed', totalStudents: chargedRegistrations.length },
        });
        // An erasure finishing the class asks nobody to give to an erased teacher.
        const invited =
          timing.finishedEarly === true ? [] : await claimCompletionInvitations(tx, classId, new Date());
        await createBulkNotifications(tx, [
          ...invited.map((r) => donationInvitation(r.studentId, cls)),
          donationCompletionNotice(cls, invited.length),
        ]);
        return { ok: true, newStatus: 'completed' as ClassStatus };
      }
      case 'tiered':
        break;
      default: {
        const unhandled: never = cls.pricingMode;
        throw new Error(`completeClass: unhandled pricing mode ${String(unhandled)}`);
      }
    }
```

The notifications are created inside the transaction, as `payment_request` is, so a stamp and its inbox row commit together. Update `completeClass`'s docblock to say a donation class is completed without pricing or payments (#912).

- [ ] **Step 8: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit src/services/donations.test.ts src/lib/push-policy.test.ts src/lib/notification-links.test.ts src/lib/email-templates.test.ts src/services/notification-policy.test.ts src/lib/notification-retention.test.ts`
Expected: PASS.

- [ ] **Step 9: Prove the `IS NULL` clause bites.** Remove `donationInvitedAt: null` from `claimCompletionInvitations`'s `where`. Run `-t "never re-stamps"` and record the failure: the reserved `2000-01-01` instant is overwritten and an invitation is counted. Restore, PASS.

- [ ] **Step 10: Prove the status clause bites.** Remove `status: { in: [...DONATION_INVITED_STATUSES] }` from the same `where`. Run the first case and record the failure: the stamped set includes the `no_show`, `late_cancel` and `cancelled` ids. Restore, PASS.

- [ ] **Step 11: Prove the erasure guard bites.** Replace the `finishedEarly` conditional with the unconditional claim. Run the `finishedEarly` case and record the failure. Restore, PASS.

- [ ] **Step 12: Docs.** In `docs/data-model.md`'s Notification section, add `donation_invitation` to the type table: student only, optional, retention 30 days, push group `payments`, links to `/bookings/{classId}/give`.

- [ ] **Step 13: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/*_donation_invitation_type src/lib/registration-status.ts src/services/donations.ts src/services/donations.test.ts src/services/class-lifecycle.ts src/lib/notification-retention.ts src/lib/notification-retention.test.ts src/lib/push-policy.ts src/lib/push-policy.test.ts src/lib/email-templates.ts src/lib/email-templates.test.ts src/lib/notification-links.ts src/lib/notification-links.test.ts src/services/notification-policy.test.ts src/lib/degradation-codes.ts docs/degradation-sites.md docs/data-model.md
git commit -m "feat(#912): completing a donation class invites who came, once, and bills no one"
```

---

### Task 4: An attendance correction to `attended` invites, once, under the class lock

**Files:**
- Modify: `src/services/donations.ts` (add `claimCorrectionInvitation`)
- Modify: `src/app/api/registrations/[id]/route.ts` (PUT)
- Create: `src/services/donation-correction-lock-order.test.ts`
- Modify: `vitest.tiers.ts` (`LOCK_CONTENTION_TESTS`)
- Modify: `src/services/donations.test.ts`
- Modify: `tests/integration/registrations-api.test.ts`
- Modify: `docs/lock-order.md`

**Interfaces:**
- Consumes: `donationInvitation`, `DONATION_INVITED_STATUSES` (Task 3), `lockClassRow` (`src/lib/db-locks.ts`).
- Produces:

```ts
export async function claimCorrectionInvitation(
  db: PrismaClient,
  registrationId: string,
): Promise<'invited' | 'not_invited'>;
```

- [ ] **Step 1: Failing service tests** in `src/services/donations.test.ts`, under `describe('claimCorrectionInvitation (#912)')`. They reuse that file's fixtures:

```ts
it('a no_show corrected to attended after completion is invited once', async () => {
  const cls = await makeClass();
  const regId = await register(cls.id, 'no_show');
  await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
  await prisma.registration.update({ where: { id: regId }, data: { status: 'attended' } }); // the route's unlocked write
  expect(await claimCorrectionInvitation(prisma, regId)).toBe('invited');
  expect(await claimCorrectionInvitation(prisma, regId)).toBe('not_invited');
  expect(await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'donation_invitation' } })).toBe(1);
});

it('attended → no_show → attended again sends nothing new (Review Focus 5)', async () => {
  const cls = await makeClass();
  const regId = await register(cls.id, 'attended');
  await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
  await prisma.registration.update({ where: { id: regId }, data: { status: 'no_show' } });
  await prisma.registration.update({ where: { id: regId }, data: { status: 'attended' } });
  expect(await claimCorrectionInvitation(prisma, regId)).toBe('not_invited');
  expect(await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'donation_invitation' } })).toBe(1);
});

it('a correction before completion does not invite on its own', async () => {
  const cls = await makeClass();
  const regId = await register(cls.id, 'attended');
  expect(await claimCorrectionInvitation(prisma, regId)).toBe('not_invited');
  expect((await prisma.registration.findUniqueOrThrow({ where: { id: regId } })).donationInvitedAt).toBeNull();
});

it('a tiered class is never invited', async () => {
  const cls = await makeClass({ pricingMode: 'tiered', minRate: 15, targetRate: 25 });
  const regId = await register(cls.id, 'no_show');
  await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
  await prisma.registration.update({ where: { id: regId }, data: { status: 'attended' } });
  expect(await claimCorrectionInvitation(prisma, regId)).toBe('not_invited');
});
```

- [ ] **Step 2: Failing lock-order test** in a new `src/services/donation-correction-lock-order.test.ts`. Its header opens with `@serial-tier lock-contention`: it holds a `Class` row `FOR UPDATE` on a second connection for 900ms while the code under test parks on that row under `lockClassRow`'s 2s bound. Add its path to `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts` with the comment `// #912: the class-lifecycle-lock-order.test.ts shape, for the correction's invitation claim.`. Copy the fixture shape and teardown from `src/services/class-lifecycle-lock-order.test.ts`, prefixing the suffix `donlock-`.

```ts
it('a correction that commits while completion holds the lock is invited once completion commits', async () => {
  const cls = await makeClass({ status: 'in_progress', pricingMode: 'donation' });
  const regId = await register(cls.id, 'no_show');

  // The interleaving the lock exists for: completion has locked the class and
  // run its claim (which skips the no_show) but has not committed when the
  // teacher's correction to `attended` commits.
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
    await tx.class.update({ where: { id: cls.id }, data: { status: 'completed' } });
    await new Promise((r) => setTimeout(r, 900));
  }, { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 150));

  await prisma.registration.update({ where: { id: regId }, data: { status: 'attended' } });
  const claimed = claimCorrectionInvitation(prisma, regId);
  const outcome = await Promise.race([
    claimed.then(() => 'returned' as const),
    new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
  ]);
  expect(outcome).toBe('waiting');

  await holder;
  // Without the lock the claim reads the class as still in_progress (the
  // holder has not committed), stamps nothing, and nobody ever invites.
  expect(await claimed).toBe('invited');
  expect((await prisma.registration.findUniqueOrThrow({ where: { id: regId } })).donationInvitedAt).not.toBeNull();
});
```

- [ ] **Step 3: Run both and confirm failure.**
Run: `pnpm exec vitest run --project unit src/services/donations.test.ts -t claimCorrectionInvitation && pnpm exec vitest run --project unit-sweeps src/services/donation-correction-lock-order.test.ts`
Expected: FAIL, `claimCorrectionInvitation is not a function` / not exported.

- [ ] **Step 4: Implement** in `src/services/donations.ts`:

```ts
/**
 * A teacher's correction to `attended` after completion (#912): invites the
 * booking if it is the first time. The status write itself commits before
 * this runs (`PUT /api/registrations/[id]` opens no transaction); taking the
 * class lock here is what closes the race with `completeClass` — the argument
 * is `docs/lock-order.md` ("`Registration` status writers outside the class
 * lock"). Class before Registration, as every holder of both takes them.
 */
export async function claimCorrectionInvitation(
  db: PrismaClient,
  registrationId: string,
): Promise<'invited' | 'not_invited'> {
  return db.$transaction(async (tx) => {
    const found = await tx.registration.findUnique({ where: { id: registrationId }, select: { classId: true } });
    if (!found) return 'not_invited';
    await lockClassRow(tx, found.classId);
    const [row] = await tx.registration.updateManyAndReturn({
      where: {
        id: registrationId,
        status: 'attended',
        donationInvitedAt: null,
        class: { status: 'completed', pricingMode: 'donation', calendarEntry: { cancelledAt: null } },
      },
      data: { donationInvitedAt: new Date() },
      select: { studentId: true },
    });
    if (!row) return 'not_invited';
    const cls = await tx.class.findUniqueOrThrow({
      where: { id: found.classId },
      select: { id: true, calendarEntry: { select: { classType: true } } },
    });
    await createBulkNotifications(tx, [donationInvitation(row.studentId, cls)]);
    return 'invited';
  });
}
```

- [ ] **Step 5: Wire the route.** In the PUT handler of `src/app/api/registrations/[id]/route.ts`:
  - After a successful write (`updated.count > 0`), when `requested === 'attended'`, `await claimCorrectionInvitation(prisma, id)` before `respondTyped`.
  - In the miss branch, replace `if (current.status === requested) return respondUnchanged(…)` with:

```ts
    if (current.status === requested) {
      // A retry after a claim that failed (Review Focus 1): the status holds,
      // the invitation may not. Inviting now is a change, so it is not "unchanged".
      if (requested === 'attended' && (await claimCorrectionInvitation(prisma, id)) === 'invited') {
        return respondTyped<AttendanceBody>({ id, status: requested });
      }
      return respondUnchanged<AttendanceBody>({ id, status: requested });
    }
```
  - Add one paragraph to the WHERE-scoping comment block: the `attended` claim follows the write in its own transaction (`claimCorrectionInvitation`, `services/donations.ts`).

- [ ] **Step 6: Integration test** in `tests/integration/registrations-api.test.ts`, inside the describe that already PUTs attendance on a completed class (it pins the "correction after completion" requirement):
  - A donation class completed with one `no_show`. The teacher PUTs `{ status: 'attended' }` → 200, and exactly one `donation_invitation` exists.
  - A second PUT `attended` answers `expectUnchanged`, still one invitation.
  - **Review Focus 1:** set the row to `attended` directly with `donationInvitedAt: null` on a completed donation class, as a failed claim leaves it. PUT `attended` → `expectApplied` (not unchanged) and one invitation.

  Warm first: `curl -s -o /dev/null http://localhost:3000/api/registrations/x`.

- [ ] **Step 7: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit src/services/donations.test.ts && pnpm exec vitest run --project unit-sweeps src/services/donation-correction-lock-order.test.ts && pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts && pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS. `serial-tier-membership.test.ts` holds the new `LOCK_CONTENTION_TESTS` entry against the file's `@serial-tier lock-contention` marker.

- [ ] **Step 8: Prove the lock bites.** Delete `await lockClassRow(tx, found.classId);`. Run the lock-order test and record the failure. Expected: `expected 'returned' to be 'waiting'`, or `expected 'not_invited' to be 'invited'`. Restore, PASS.

- [ ] **Step 9: Prove the correction's `IS NULL` clause bites.** Remove `donationInvitedAt: null` from the correction claim's `where`. Run `-t "again sends nothing new"` and record the failure (2 invitations where 1 was expected). Restore, PASS.

- [ ] **Step 10: Lock-order doc.** In `docs/lock-order.md`, under `### \`Registration\` status writers outside the class lock`, after the list, add a paragraph:
  - `claimCorrectionInvitation` (`services/donations.ts`, #912) follows the attendance write in its own transaction. It writes no `status`, takes `lockClassRow` first, then writes `Registration`, which is the documented order.
  - State the race argument from spec §4.2 in three sentences.
  - Extend the re-derive command's alternation to `(update|updateMany|updateManyAndReturn|upsert|create|createMany)`, so the two `donationInvitedAt` claims are among its hits.
  - Name both claims in the "hits that write no `status`" sentence.

- [ ] **Step 11: Commit.**

```bash
git add src/services/donations.ts src/services/donations.test.ts src/services/donation-correction-lock-order.test.ts vitest.tiers.ts "src/app/api/registrations/[id]/route.ts" tests/integration/registrations-api.test.ts docs/lock-order.md
git commit -m "feat(#912): a correction to attended invites once, under the class lock"
```

---

### Task 5: The give page, the bookings prompt and Hide

**Files:**
- Create: `src/lib/donation-prompt.ts`, `src/lib/donation-prompt.test.ts`
- Create: `src/app/(student)/bookings/[classId]/give/page.tsx`
- Create: `src/components/student/donation-prompt.tsx`, `src/components/student/donation-prompt.test.tsx`
- Create: `src/app/api/registrations/[id]/donation-prompt/hide/route.ts`
- Modify: `src/services/donations.ts` (add `hideDonationPrompt`)
- Modify: `src/lib/api-error-codes.ts` (`DONATION_NOT_INVITED: 409`)
- Modify: `src/app/(student)/bookings/page.tsx` (past row)
- Create: `tests/integration/give-page.test.ts`

**Interfaces:**
- Consumes: `MethodPanel`, `MethodAmount` (Task 2); `DONATION_INVITED_STATUSES`, `NOTIFICATION_RETENTION_DAYS.donation_invitation`, `givePagePath` (Task 3).
- Produces:

```ts
// src/lib/donation-prompt.ts
export interface DonationBookingState {
  classStatus: ClassStatus;
  classCancelledAt: Date | null;
  pricingMode: PricingMode;
  registrationStatus: RegistrationStatus;
  donationInvitedAt: Date | null;
}
export function canSeeGivePage(s: DonationBookingState): boolean;
export const DONATION_PROMPT_DAYS: number; // NOTIFICATION_RETENTION_DAYS.donation_invitation
export function showsDonationPrompt(s: DonationBookingState & { donationPromptHiddenAt: Date | null }, now: Date): boolean;

// src/services/donations.ts
export type HidePromptResult =
  | { kind: 'hidden'; hiddenAt: Date }
  | { kind: 'unchanged'; hiddenAt: Date }
  | { kind: 'not_found' } | { kind: 'forbidden' } | { kind: 'not_invited' };
export async function hideDonationPrompt(db: PrismaClient, studentId: string, registrationId: string): Promise<HidePromptResult>;
```

- [ ] **Step 1: Failing unit tests** in `src/lib/donation-prompt.test.ts`. Flip each condition alone from an eligible base:

```ts
import { describe, it, expect } from 'vitest';
import { canSeeGivePage, showsDonationPrompt, DONATION_PROMPT_DAYS } from './donation-prompt';

const invitedAt = new Date('2026-06-01T12:00:00.000Z');
const ELIGIBLE = {
  classStatus: 'completed', classCancelledAt: null, pricingMode: 'donation',
  registrationStatus: 'attended', donationInvitedAt: invitedAt,
} as const;

describe('canSeeGivePage', () => {
  it('is true for an invited booking that came to a completed donation class', () => {
    expect(canSeeGivePage(ELIGIBLE)).toBe(true);
    expect(canSeeGivePage({ ...ELIGIBLE, registrationStatus: 'registered' })).toBe(true);
  });
  it.each([
    ['not completed', { classStatus: 'in_progress' }],
    ['cancelled', { classCancelledAt: new Date() }],
    ['tiered', { pricingMode: 'tiered' }],
    ['no_show', { registrationStatus: 'no_show' }],
    ['late_cancel', { registrationStatus: 'late_cancel' }],
    ['cancelled booking', { registrationStatus: 'cancelled' }],
    ['never invited', { donationInvitedAt: null }],
  ] as const)('is false when %s', (_label, flip) => {
    expect(canSeeGivePage({ ...ELIGIBLE, ...flip })).toBe(false);
  });
});

describe('showsDonationPrompt', () => {
  const day = 86_400_000;
  it('shows within the window and not once hidden', () => {
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: null }, new Date(invitedAt.getTime() + day))).toBe(true);
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: new Date() }, new Date(invitedAt.getTime() + day))).toBe(false);
  });
  it('hides itself at exactly the window edge', () => {
    const edge = new Date(invitedAt.getTime() + DONATION_PROMPT_DAYS * day);
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: null }, new Date(edge.getTime() - 1))).toBe(true);
    expect(showsDonationPrompt({ ...ELIGIBLE, donationPromptHiddenAt: null }, edge)).toBe(false);
  });
  it('never shows where the give page would not render', () => {
    expect(showsDonationPrompt({ ...ELIGIBLE, registrationStatus: 'no_show', donationPromptHiddenAt: null }, invitedAt)).toBe(false);
  });
});
```

Run: `pnpm exec vitest run --project unit src/lib/donation-prompt.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 2: Implement `src/lib/donation-prompt.ts`.** Import types only from `@/lib/prisma-client`, and `DONATION_INVITED_STATUSES` and `NOTIFICATION_RETENTION_DAYS` as values. Both modules are client-safe.

```ts
/** Who may open `/bookings/[classId]/give` (#912), read whole; anything else is a 404 naming nothing. */
export function canSeeGivePage(s: DonationBookingState): boolean {
  switch (s.pricingMode) {
    case 'tiered':
      return false;
    case 'donation':
      return (
        s.classStatus === 'completed' &&
        s.classCancelledAt === null &&
        DONATION_INVITED_STATUSES.includes(s.registrationStatus) &&
        s.donationInvitedAt !== null
      );
    default: {
      const unhandled: never = s.pricingMode;
      throw new Error(`canSeeGivePage: unhandled pricing mode ${String(unhandled)}`);
    }
  }
}

/** The prompt hides itself when the invitation's inbox row is reaped. */
export const DONATION_PROMPT_DAYS = NOTIFICATION_RETENTION_DAYS.donation_invitation;

const DAY_MS = 86_400_000;

export function showsDonationPrompt(
  s: DonationBookingState & { donationPromptHiddenAt: Date | null },
  now: Date,
): boolean {
  if (!canSeeGivePage(s) || s.donationPromptHiddenAt !== null || s.donationInvitedAt === null) return false;
  return now.getTime() < s.donationInvitedAt.getTime() + DONATION_PROMPT_DAYS * DAY_MS;
}
```

Run the unit test. Expected: PASS.

- [ ] **Step 3: Failing integration test** in a new `tests/integration/give-page.test.ts`. Build fixtures with `makeTeacher`/`makeStudent` in the shape `tests/integration/pay-page.test.ts` uses (copy them, prefix `give-`):
  - a teacher with a EUR bank account;
  - a teacher with none;
  - a paused teacher (`paymentsPausedAt: new Date()`);
  - a teacher with only a `paymentLink`.

  Each class is a completed donation class (`createClassFixture` with `pricingMode: 'donation', minRate: 0, targetRate: 0, status: 'completed'`) and the student's registration carries `donationInvitedAt`.

```ts
const give = (token: string, classId: string) =>
  fetch(`${BASE_URL}/bookings/${classId}/give`, { headers: { ...cookie(token), ...freshIp() }, redirect: 'manual' });

it('shows the bank details with no amount, and the QR caption', async () => {
  const res = await give(studentToken, classIds.bank);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('Thank you for coming.');
  expect(html).toContain(IBAN_SHOWN);           // the formatted IBAN PaymentDetails renders
  expect(html).not.toMatch(/€\s?\d|EUR\d/);     // no amount anywhere, QR alt included
  expect(html).not.toContain('Room');           // no breakdown
});

it('tells a student with no teacher method to give directly', async () => {
  expect(await (await give(studentToken, classIds.noMethod)).text()).toContain('Give your teacher directly, however suits you.');
});

it('shows the hold-off line, and no method, while payments are paused', async () => {
  const html = await (await give(studentToken, classIds.paused)).text();
  expect(html).toContain(PAYMENTS_PAUSED_COPY);
  expect(html).not.toContain(IBAN_SHOWN);
});

it.each([
  ['another student', () => give(otherStudentToken, classIds.bank)],
  ['a tiered class', () => give(studentToken, classIds.tiered)],
  ['a not-yet-completed donation class', () => give(studentToken, classIds.inProgress)],
  ['a no_show booking (Review Focus 5)', () => give(studentToken, classIds.noShow)],
  ['a never-invited booking', () => give(studentToken, classIds.uninvited)],
  ['a cancelled class', () => give(studentToken, classIds.cancelled)],
])('answers 404 for %s', async (_label, request) => {
  expect((await request()).status).toBe(404);
});

describe('POST /api/registrations/[id]/donation-prompt/hide', () => {
  const hide = (token: string, regId: string) =>
    fetch(`${BASE_URL}/api/registrations/${regId}/donation-prompt/hide`, { method: 'POST', headers: { ...cookie(token), ...freshIp() } });
  it('hides the student own prompt, then answers unchanged', async () => {
    await expectApplied(await hide(studentToken, regIds.bank));
    await expectUnchanged(await hide(studentToken, regIds.bank));
  });
  it('refuses another student with 403', async () => {
    expect((await hide(otherStudentToken, regIds.bank)).status).toBe(403);
  });
  it('refuses a never-invited booking with DONATION_NOT_INVITED', async () => {
    await expectRefusal(await hide(studentToken, regIds.uninvited), 'DONATION_NOT_INVITED');
  });
});

it('the bookings list offers the prompt, then not after Hide, and never a price', async () => {
  // GET /bookings for a fresh invited booking: contains "Give if you&#x27;d like" (match what React emits)
  // and the give link; POST hide; GET again: neither appears. No "€" in that row's markup.
});
```

  Each 404 case must differ from the eligible booking in one condition only. The `no_show` booking was invited first and then corrected, which is the Review Focus 5 state. Check once how React escapes the apostrophe and assert that form.

Run (warm first: `curl -s -o /dev/null http://localhost:3000/bookings`): `pnpm exec vitest run --project integration tests/integration/give-page.test.ts`
Expected: FAIL, 404 for the eligible cases and the hide route missing.

- [ ] **Step 4: `hideDonationPrompt`.** Read the registration's `studentId`, `donationInvitedAt` and `donationPromptHiddenAt`, then:
  - missing → `not_found`;
  - another student → `forbidden`;
  - `donationInvitedAt === null` → `not_invited`;
  - already hidden → `unchanged`;
  - otherwise `updateMany({ where: { id, donationInvitedAt: { not: null }, donationPromptHiddenAt: null }, data: { donationPromptHiddenAt: new Date() } })`.

  A zero count re-reads and answers `unchanged` with the stored instant (a concurrent Hide won).

- [ ] **Step 5: Hide route** `src/app/api/registrations/[id]/donation-prompt/hide/route.ts`:
  - `requireStudent`, then a `switch` on the result kind with a `never` default:
    - `hidden` → `respondTyped<{ id: string; hiddenAt: string }>(…)`;
    - `unchanged` → `respondUnchanged(…)`;
    - `not_found` → `respondError('This booking no longer exists.', 404, 'NOT_FOUND')`;
    - `forbidden` → `respondError('Access denied', 403)`;
    - `not_invited` → `respondError("There's nothing to hide for this booking.", 409, 'DONATION_NOT_INVITED')`.
  - Register `DONATION_NOT_INVITED: 409` in `API_ERROR_STATUS`, alphabetically.

- [ ] **Step 6: The give page** `src/app/(student)/bookings/[classId]/give/page.tsx`:
  - `getSession` and `redirectNonStudent`, as the pay page does.
  - Read `prisma.registration.findUnique({ where: { classId_studentId: { classId, studentId: session.studentId } }, include: { class: { include: { calendarEntry: { include: { teacher: { select: { firstName: true, lastName: true, ...teacherPaymentSelect } } } } } } } })`.
  - `notFound()` unless the registration exists and `canSeeGivePage({ classStatus, classCancelledAt: entry.cancelledAt, pricingMode, registrationStatus, donationInvitedAt })`.
  - Render, in order:
    - the pay page's back link to `/bookings`;
    - `<h1 className="type-title">Thank you for coming.</h1>`;
    - the caption `` `${entry.classType} · ${formatDayHeader(entry.date)} · with ${teacher.firstName} ${teacher.lastName}` ``;
    - the body below, for `const methods = paymentMethodsForTeacher(teacher, cls.currency)`.
  - The body:
    - `methods.kind === 'paused'` → `<p className="type-body">{PAYMENTS_PAUSED_COPY}</p>`.
    - No methods → `<p className="type-body">Give your teacher directly, however suits you.</p>`.
    - Otherwise the pay page's `<details name="give-method">` chooser:
      - one `<details>` per method, labelled with `paymentMethodLabel` and the `PAYMENT_METHOD_COPY` hint;
      - each body is `<MethodPanel method={method} amount={{ kind: 'open' }} currency={cls.currency} reference={paymentReference(entry)} />`;
      - methods of kind `processor` are filtered out before rendering (`paymentMethodsForTeacher` never returns one; the filter states it for the type).
  - Nothing else: no amount, room, breakdown or "I've sent it".

- [ ] **Step 7: The bookings prompt.**
  - `src/components/student/donation-prompt.tsx` (`'use client'`), props `{ registrationId: string; classId: string; classType: string; date: string }`.
  - It renders a `Link` to `givePagePath(classId)` reading `Give if you'd like`, in the `Pay now` pill style, and a `Hide` text button (`type-label text-teal`).
  - Hide POSTs the route, then `router.refresh()`. A failure logs through `logRequestFailure('donation-prompt', { registrationId }, err)` and shows `Could not hide this. Try again.` in a `role="alert"` caption.
  - In `bookings/page.tsx`'s past rows, when `showsDonationPrompt({...}, now)` holds, render `<DonationPrompt … />` beneath the title block. The right-hand side stays empty, since there is no payment.

- [ ] **Step 8: Component test** `donation-prompt.test.tsx`:
  - The link's `href` is `/bookings/c1/give` and no text matches `/€|\d+[.,]\d{2}/`.
  - Clicking Hide POSTs `/api/registrations/r1/donation-prompt/hide` and calls `router.refresh`. Mock `next/navigation` as sibling component tests do.
  - A rejected fetch shows the alert.

- [ ] **Step 9: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit src/lib/donation-prompt.test.ts && pnpm exec vitest run --project components src/components/student/donation-prompt.test.tsx && curl -s -o /dev/null http://localhost:3000/bookings && pnpm exec vitest run --project integration tests/integration/give-page.test.ts tests/integration/bookings-page.test.ts`
Expected: PASS.

- [ ] **Step 10: Prove the eligibility guard bites.** Make `canSeeGivePage`'s donation branch drop `DONATION_INVITED_STATUSES.includes(…)`. Warm `/bookings/x/give`, run the `no_show` 404 case, and record the failure (`expected 200 to be 404`). Restore, warm, PASS.

- [ ] **Step 11: Commit.**

```bash
git add src/lib/donation-prompt.ts src/lib/donation-prompt.test.ts "src/app/(student)/bookings/[classId]/give/page.tsx" src/components/student/donation-prompt.tsx src/components/student/donation-prompt.test.tsx "src/app/api/registrations/[id]/donation-prompt/hide/route.ts" src/services/donations.ts src/lib/api-error-codes.ts "src/app/(student)/bookings/page.tsx" tests/integration/give-page.test.ts
git commit -m "feat(#912): the give page, and a bookings prompt the student can hide"
```

---

### Task 6: The teacher records the total — service, endpoint, class detail, finish copy

**Files:**
- Modify: `src/services/donations.ts` (add `recordDonationTotal`)
- Modify: `src/lib/schemas.ts` (`donationTotalSchema`)
- Modify: `src/lib/api-error-codes.ts` (`DONATION_CLASS_REQUIRED: 409`, `CLASS_NOT_COMPLETED: 409`)
- Modify: `src/app/api/classes/[id]/shared.ts`
- Create: `src/app/api/classes/[id]/donation-total/route.ts`
- Create: `src/components/class/donation-summary.tsx`, `src/components/class/donations-received-card.tsx`, `src/components/class/donations-received-card.test.tsx`
- Modify: `src/components/class/complete-class-button.tsx` and its test
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx`
- Create: `tests/integration/donation-total-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `donationTotal`; Task 3's `DONATION_INVITED_STATUSES`.
- Produces:

```ts
export type RecordDonationTotalResult =
  | { ok: true; outcome: 'applied' | 'unchanged'; donationTotal: number | null }
  | { ok: false; reason: 'not_found' | 'cancelled' | 'not_donation' | 'not_completed' };
export async function recordDonationTotal(
  db: PrismaClient, teacherId: string, classId: string, amount: number | null,
): Promise<RecordDonationTotalResult>;

// src/lib/schemas.ts
export const donationTotalSchema = z.object({ amount: moneyField().nullable() }).strict();

// CompleteClassButton gains `pricingMode: PricingMode` and `invitedCount: number`.
```

- [ ] **Step 1: Failing integration test** in a new `tests/integration/donation-total-api.test.ts`:
  - Fixtures: an owner teacher and another teacher, then classes `completedDonation`, `inProgressDonation`, `completedTiered` and `cancelledDonation`. Create them with `createClassFixture`. The cancelled one is a donation class with `cancelledAt` on its entry and status `open`.

```ts
const put = (token: string, id: string, body: unknown) =>
  fetch(`${BASE_URL}/api/classes/${id}/donation-total`, {
    method: 'PUT', headers: { ...cookie(token), ...freshIp(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

it('records, answers unchanged for the same amount, and clears back to null', async () => {
  await expectApplied(await put(ownerToken, ids.completedDonation, { amount: 84.5 }));
  expect((await prisma.class.findUniqueOrThrow({ where: { id: ids.completedDonation } })).donationTotal?.toString()).toBe('84.5');
  await expectUnchanged(await put(ownerToken, ids.completedDonation, { amount: 84.5 }));
  await expectApplied(await put(ownerToken, ids.completedDonation, { amount: null }));
  expect((await prisma.class.findUniqueOrThrow({ where: { id: ids.completedDonation } })).donationTotal).toBeNull();
  await expectUnchanged(await put(ownerToken, ids.completedDonation, { amount: null }));
});
it('records 0, which is not the same as not recorded', async () => {
  await expectApplied(await put(ownerToken, ids.completedDonation, { amount: 0 }));
  expect((await prisma.class.findUniqueOrThrow({ where: { id: ids.completedDonation } })).donationTotal?.toString()).toBe('0');
});
it("answers 404 for another teacher's class", async () => {
  await expectRefusal(await put(otherToken, ids.completedDonation, { amount: 1 }), 'NOT_FOUND');
});
it.each([
  ['cancelledDonation', 'CLASS_CANCELLED'],
  ['completedTiered', 'DONATION_CLASS_REQUIRED'],
  ['inProgressDonation', 'CLASS_NOT_COMPLETED'],
] as const)('%s → %s', async (key, code) => {
  await expectRefusal(await put(ownerToken, ids[key], { amount: 1 }), code);
});
it('refuses a negative amount with 400', async () => {
  expect((await put(ownerToken, ids.completedDonation, { amount: -1 })).status).toBe(400);
});
```

Warm `curl -s -o /dev/null http://localhost:3000/api/classes/x/donation-total` and run. Expected: FAIL (404 from the missing route).

- [ ] **Step 2: Codes and refusals.** Register `CLASS_NOT_COMPLETED: 409` and `DONATION_CLASS_REQUIRED: 409` in `API_ERROR_STATUS`, alphabetically. In `src/app/api/classes/[id]/shared.ts`, add:

```ts
/** A donation-only door reached for a tiered class (#912). */
export const DONATION_CLASS_REQUIRED = codedRefusal('DONATION_CLASS_REQUIRED', "This class isn't by donation.");

/** A door that waits for completion, reached before it. */
export const CLASS_NOT_COMPLETED = codedRefusal('CLASS_NOT_COMPLETED', 'Record what came in once the class is complete.');
```

- [ ] **Step 3: `recordDonationTotal`.** The order is spec §4.6's:

```ts
export async function recordDonationTotal(db, teacherId, classId, amount) {
  const cls = await db.class.findFirst({
    where: { id: classId, calendarEntry: { teacherId } },
    select: { status: true, pricingMode: true, donationTotal: true, calendarEntry: { select: { cancelledAt: true } } },
  });
  if (!cls) return { ok: false, reason: 'not_found' };
  if (cls.calendarEntry.cancelledAt !== null) return { ok: false, reason: 'cancelled' };
  switch (cls.pricingMode) {
    case 'tiered': return { ok: false, reason: 'not_donation' };
    case 'donation': break;
    default: { const unhandled: never = cls.pricingMode; throw new Error(`recordDonationTotal: unhandled pricing mode ${String(unhandled)}`); }
  }
  if (cls.status !== 'completed') return { ok: false, reason: 'not_completed' };
  const toCents = (v: number | null) => (v === null ? null : Math.round(v * 100));
  const wanted = toCents(amount);
  const stored = toCents(cls.donationTotal === null ? null : Number(cls.donationTotal));
  if (wanted === stored) return { ok: true, outcome: 'unchanged', donationTotal: stored === null ? null : stored / 100 };
  const written = await db.class.updateMany({
    where: { id: classId, status: 'completed', pricingMode: 'donation', calendarEntry: { teacherId, cancelledAt: null } },
    data: { donationTotal: wanted === null ? null : wanted / 100 },
  });
  if (written.count === 0) return recordDonationTotal(db, teacherId, classId, amount); // classify from a fresh read
  return { ok: true, outcome: 'applied', donationTotal: wanted === null ? null : wanted / 100 };
}
```

A completed class is terminal, so the gates read above cannot move between the read and the CAS. The recursion therefore classifies a deleted row as `not_found` and cannot loop: a row the CAS missed answers a refusal on the re-read. The docblock states that it is its own statement, outside `updateClass`'s terminal freeze, and the only writer of `donationTotal`.

- [ ] **Step 4: Route** `src/app/api/classes/[id]/donation-total/route.ts`:
  - `requireTeacher`, `parseBody(request, donationTotalSchema)`, then the service.
  - A `satisfies Record<…, CodedRefusal>` map from reason to `CLASS_GONE`, `CLASS_CANCELLED`, `DONATION_CLASS_REQUIRED` and `CLASS_NOT_COMPLETED`, answered with `respondRefusal`.
  - `applied` → `respondTyped<{ classId: string; donationTotal: number | null }>`; `unchanged` → `respondUnchanged` of the same body.

Run Step 1's test. Expected: PASS.

- [ ] **Step 5: Class detail components.**
  - `donation-summary.tsx` (server), props `{ roomCost: number; vatPercent: number; currency: Currency }`.
  - It renders a `py-6` section with `<h2 className="type-subtitle mb-3">Pricing</h2>`, `<p className="type-body">By donation</p>`, and a caption.
  - With `vatPercent === 0` the caption reads `Room cost {formatMoney(roomCost)}: your break-even.`. With `vatPercent > 0` it reads `Room cost {formatMoney(roomCost)}: your break-even is {formatMoney(withVat(roomCost, vatThousandths(vatPercent)))} in donations, VAT included.` This is spec defect 9, so the plan reviewer confirms the wording.
  - `donations-received-card.tsx` (`'use client'`), props `{ classId: string; donationTotal: number | null; vatPercent: number; currency: Currency }`:
    - a sand-soft card titled `Donations received`;
    - with a total: the figure in `type-number`, then `incl. {formatMoneyCents(includedVatCents(cents, vatThousandths(vatPercent)), currency)} VAT` when `vatPercent > 0`, then `Edit` and `Clear` text buttons;
    - with none: the caption `Not recorded yet` and a `Record` button;
    - Record/Edit opens a `NumberInput` (`decimals={MONEY_DECIMALS}`) and `Save`, which PUTs `{ amount }`; Clear PUTs `{ amount: null }`;
    - success refreshes the router; a refusal shows `readErrorMessage(res, 'Could not save. Try again.')` in a `role="alert"` caption, and failures log through `logRequestFailure('donations-received-card', { classId }, err)`.
  - `(overview)/page.tsx`:
    - Each of the three `<PricingPreview cls={cls} />` sites becomes `cls.pricingMode === 'donation' ? <DonationSummary … /> : <PricingPreview cls={cls} />`, written through one local `pricingSection` const that switches with a `never` default.
    - The completed block switches the same way: tiered keeps `PricingBreakdown` + `PaymentChecklist`; donation renders `<DonationsReceivedCard classId={cls.id} donationTotal={cls.donationTotal === null ? null : Number(cls.donationTotal)} vatPercent={Number(cls.vatPercent)} currency={cls.currency} />`.
    - Compute `const invitedCount = cls.registrations.filter((r) => DONATION_INVITED_STATUSES.includes(r.status)).length;`.
    - The `canFinish` caption is `Invitations to give go out at {formatClockInZone(autoAt, tz)}.` for a donation class with `invitedCount > 0`. The tiered sentences are unchanged.
  - `complete-class-button.tsx`: `confirmCopy` takes `(pricingMode, chargedCount, invitedCount)` and switches on the mode with a `never` default. Donation reads `Finish class? {n} {student|students} will be invited to give.`, and for 0 the existing zero-student sentence. Tiered is unchanged.

- [ ] **Step 6: Component tests.**
  - `donations-received-card.test.tsx` covers four cases:
    - null → `Not recorded yet` and `Record`;
    - `84.5` at VAT 21 → `€84.50` and `incl. €14.67 VAT` (`includedVatCents(8450, 21000) = 1467`);
    - Save PUTs `{ amount: 84.5 }`;
    - Clear PUTs `{ amount: null }`.
  - The `complete-class-button` test: a donation class with 3 invited shows `Finish class? 3 students will be invited to give.`, and a tiered one keeps its sentence.

- [ ] **Step 7: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project components src/components/class && pnpm exec vitest run --project components "src/app/(teacher)/class/[id]/(overview)/page.test.tsx" && pnpm exec vitest run --project integration tests/integration/donation-total-api.test.ts`
Expected: PASS.

- [ ] **Step 8: Prove the mode gate bites.** Change the service's `case 'tiered': return { ok: false, reason: 'not_donation' };` to `break;`. Warm the route and run the `completedTiered` case. Record the failure: the `CHECK` raises `Class_donation_total_mode_check` as a 500, or the code mismatches. Restore, PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/services/donations.ts src/lib/schemas.ts src/lib/api-error-codes.ts "src/app/api/classes/[id]/shared.ts" "src/app/api/classes/[id]/donation-total/route.ts" src/components/class/donation-summary.tsx src/components/class/donations-received-card.tsx src/components/class/donations-received-card.test.tsx src/components/class/complete-class-button.tsx src/components/class/complete-class-button.test.tsx "src/app/(teacher)/class/[id]/(overview)/page.tsx" tests/integration/donation-total-api.test.ts
git commit -m "feat(#912): the teacher records what came in; class detail shows it"
```

---

### Task 7: The Pricing choice in the class wizard, the edit form and the template form

**Files:**
- Create: `src/components/class/pricing-mode-choice.tsx`
- Modify: `src/app/(teacher)/class/new/new-class-form.tsx` and `new-class-form.test.tsx`
- Modify: `src/components/class/class-edit-form.tsx` and `class-edit-form.test.tsx`
- Modify: `src/components/settings/template-form.tsx` and `template-form.test.tsx`

**Interfaces:**
- Consumes: the form state fields Task 1 added.
- Produces:

```tsx
export function PricingModeChoice(props: {
  value: PricingMode;
  onChange: (mode: PricingMode) => void;
  disabled?: boolean;
  name: string;
}): React.ReactNode;
```

- [ ] **Step 1: Failing component tests.**
  - `new-class-form.test.tsx`:
    - On step 2, choosing `By donation` hides the `Min rate`/`Target rate` inputs and the pricing preview table, and keeps room cost, VAT, min and max students.
    - Step 4's Pricing row reads `By donation · Room cost: €…`.
    - The POST body carries `pricingMode: 'donation'`.
    - Switching back to `Tiered` shows the rates with the values typed before.
  - `class-edit-form.test.tsx`:
    - With `settingsLocked: true` the choice is disabled and its fieldset carries the existing lock caption.
    - Unlocked, choosing donation and saving sends `pricingMode: 'donation'` and does not send changed rate values (the hidden rates go out exactly as `initial` holds them).
    - Review Focus 4: an initial donation class with `minRate: -20, roomCost: 20`, room cost changed to 10, Save. Expect no fetch and the alert `Your saved tiered rates need a room cost of at least €20.00. Switch to Tiered to change them.`
  - `template-form.test.tsx`:
    - Choosing donation hides the rates and sends `pricingMode: 'donation'`.
    - An edit that changes only the mode shows `Classes already on your schedule keep their own setting.`
    - An edit changing `classType` only shows no notice.

- [ ] **Step 2: Run and confirm failure.**
Run: `pnpm exec vitest run --project components "src/app/(teacher)/class/new/new-class-form.test.tsx" src/components/class/class-edit-form.test.tsx src/components/settings/template-form.test.tsx -t 912`
Expected: FAIL, no `By donation` radio found.

- [ ] **Step 3: `PricingModeChoice`.**
  - A `<fieldset>` with `<legend className="type-label">Pricing</legend>`.
  - Two radios in the `refund-dialog.tsx` markup: `<label className="flex items-center gap-3 min-h-11 type-body"><input type="radio" className="h-5 w-5 accent-teal" …/>`. The labels are `Tiered` and `By donation`.
  - The options come from `const PRICING_MODE_LABELS = { tiered: 'Tiered', donation: 'By donation' } as const satisfies Record<PricingMode, string>;`.

- [ ] **Step 4: Wire the three forms.** In each, place `PricingModeChoice` first in the economics block.
  - When `pricingMode === 'donation'`, the rate inputs and `PricingPreviewTable` are not rendered.
  - Room cost, VAT, and min/max students stay.
  - Rates stay in form state and are sent as held. Nothing zeroes them.
  - Validation still runs on the hidden rates, because the server and the CHECKs do. A cross-field violation whose path is a rate field is shown in donation mode as ``Your saved tiered rates need a room cost of at least ${formatMoney(-minRate, currency)}. Switch to Tiered to change them.`` for `room_subsidy`, and as `Your saved tiered rates are out of order. Switch to Tiered to change them.` for `rate_order`. These live as a `DONATION_ECONOMICS_COPY` beside each form's `ECONOMICS_COPY`, keyed `satisfies Partial<Record<EconomicsRule, …>>`.
  - The edit form disables the choice with the other economics when `settingsLocked`. `LOCKED_FIELDS` already strips `pricingMode` from a locked payload.
  - The wizard's step 4 Pricing row switches on the mode with a `never` default.
  - The template form's existing "keep their own setting" notice fires when `isPrivate` **or** `pricingMode` differs from `edit.initial`.

- [ ] **Step 5: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project components "src/app/(teacher)/class/new" src/components/class/class-edit-form.test.tsx src/components/settings/template-form.test.tsx`
Expected: PASS.

- [ ] **Step 6: Prove the hidden-rate message bites.** Make the donation branch fall back to `ECONOMICS_COPY` (the tiered message about a field that is not on screen). Run the Review Focus 4 case and record the failure. Restore, PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/components/class/pricing-mode-choice.tsx "src/app/(teacher)/class/new/new-class-form.tsx" "src/app/(teacher)/class/new/new-class-form.test.tsx" src/components/class/class-edit-form.tsx src/components/class/class-edit-form.test.tsx src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "feat(#912): a Pricing choice — Tiered or By donation — in every class form"
```

---

### Task 8: Reporting — donation classes on their own line, unrecorded ones unknown

**Files:**
- Create: `src/lib/reporting.ts`, `src/lib/reporting.test.ts`
- Modify: `src/app/(teacher)/settings/reporting/page.tsx`
- Modify: `tests/integration/reporting-page.test.ts`

**Interfaces:**
- Consumes: `Class.pricingMode`, `Class.donationTotal`.
- Produces:

```ts
export interface ReportClass {
  currency: Currency; pricingMode: PricingMode; roomCost: Prisma.Decimal; vatPercent: Prisma.Decimal;
  totalRevenue: Prisma.Decimal | null; vatTotal: Prisma.Decimal | null; donationTotal: Prisma.Decimal | null;
  totalStudents: number | null; calendarEntry: { date: Date };
}
export interface ReportStudioClass {
  currency: Currency; hourlyRate: Prisma.Decimal; studentCount: number | null;
  calendarEntry: { date: Date; durationMinutes: number };
}
export interface Report {
  total: MoneyTotals; tiered: MoneyTotals; donation: MoneyTotals; unrecordedDonationCount: number;
  studio: MoneyTotals; roomCosts: MoneyTotals; classCount: number;
  months: { label: string; classes: number; students: number; earnings: MoneyTotals }[];
}
/** What one class earned, or null when nothing is known (an unrecorded donation class). */
export function classEarningsCents(c: ReportClass): number | null;
export function buildReport(classes: readonly ReportClass[], studio: readonly ReportStudioClass[], fallback: Currency): Report;
```

- [ ] **Step 1: Failing unit test** `src/lib/reporting.test.ts`:

```ts
const d = (v: string) => new Prisma.Decimal(v);
const base = { currency: 'EUR', roomCost: d('20.00'), vatPercent: d('0'), totalStudents: 4, calendarEntry: { date: new Date('2026-06-03T00:00:00Z') } } as const;
const tiered = { ...base, pricingMode: 'tiered', totalRevenue: d('60.00'), vatTotal: d('0'), donationTotal: null } as const;
const recorded = { ...base, pricingMode: 'donation', totalRevenue: null, vatTotal: null, donationTotal: d('50.00') } as const;
const recordedVat = { ...recorded, vatPercent: d('21'), donationTotal: d('60.50') } as const;
const unrecorded = { ...base, pricingMode: 'donation', totalRevenue: null, vatTotal: null, donationTotal: null } as const;

it('a tiered class earns its total less room and VAT', () => expect(classEarningsCents(tiered)).toBe(4000));
it('a recorded donation class earns its total less room and the VAT contained in it', () => {
  expect(classEarningsCents(recorded)).toBe(3000);
  expect(classEarningsCents(recordedVat)).toBe(6050 - 2000 - 1050); // includedVatCents(6050, 21000) = 1050
});
it('an unrecorded donation class earns null, never −roomCost', () => expect(classEarningsCents(unrecorded)).toBeNull());

it('reports each line, counts the unrecorded and keeps them out of every earnings figure', () => {
  const r = buildReport([tiered, recorded, unrecorded], [], 'EUR');
  expect(r.tiered).toEqual([{ currency: 'EUR', cents: 4000 }]);
  expect(r.donation).toEqual([{ currency: 'EUR', cents: 3000 }]);
  expect(r.unrecordedDonationCount).toBe(1);
  expect(r.total).toEqual([{ currency: 'EUR', cents: 7000 }]);
  expect(r.roomCosts).toEqual([{ currency: 'EUR', cents: 6000 }]);   // the unrecorded class's room still counts
  expect(r.classCount).toBe(3);
  expect(r.months[0]).toMatchObject({ classes: 3, students: 12, earnings: [{ currency: 'EUR', cents: 7000 }] });
});
```

Run: `pnpm exec vitest run --project unit src/lib/reporting.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 2: Implement `src/lib/reporting.ts`.** Move the page's aggregation in unchanged: `monthKey`, cents conversion, studio earnings, `totalsByCurrency`/`orZero`, and the six-month rollup. Then:
  - `classEarningsCents` switches on `pricingMode` with a `never` default:
    - `tiered` keeps the page's current formula;
    - `donation` with a null total returns `null`;
    - `donation` with a total returns `teacherEarningsCents({ totalCents, roomCents, vatCents: includedVatCents(totalCents, vatThousandths(Number(vatPercent))) })`.
  - A `null` contributes to no earnings list, but the class still adds to `classCount`, to `roomCosts`, and to its month's `classes` and `students`.
  - `tiered` sums tiered classes only, and `donation` sums recorded donation classes only.

- [ ] **Step 3: Rewire the page.** The page selects `pricingMode`, `donationTotal` and `vatPercent` beside its current columns. It calls `buildReport`, and renders:
  - The hero label is `Earned from teaching`.
  - Lines, in order: `Your classes` (`report.tiered`), `Donation classes` (`report.donation`), `Studio classes`, `Room costs paid`.
  - Under `Donation classes`, when `report.unrecordedDonationCount > 0`, a `type-caption` line reads `{n} without a recorded total`.
  - The month header reads `EARNED`.
  - The empty-state body reads `Completed classes and what they earned appear here.`
  - The `Donation classes` line renders only when the teacher has any completed donation class, so a tiered-only teacher's page is unchanged apart from the three wording edits.

- [ ] **Step 4: Integration.** In `tests/integration/reporting-page.test.ts`:
  - Update the existing assertions on the three renamed strings.
  - Add a case: a teacher with one tiered, one recorded and one unrecorded donation class.
    - The page shows the `Donation classes` figure and `1 without a recorded total`.
    - The hero equals tiered plus recorded.
    - No figure equals tiered minus the unrecorded class's room cost.
  - Warm `curl -s -o /dev/null http://localhost:3000/settings/reporting` first.

- [ ] **Step 5: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project unit src/lib/reporting.test.ts && pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts tests/integration/reporting-currency.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the unknown-is-not-zero guard bites.** Make the unrecorded branch return `teacherEarningsCents({ totalCents: 0, roomCents, vatCents: 0 })`, the coalesce-to-zero the spec rules out. Run the unit suite and record the failures (the hero is `4000`, and the unrecorded case is `-2000`). Restore, PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/reporting.ts src/lib/reporting.test.ts "src/app/(teacher)/settings/reporting/page.tsx" tests/integration/reporting-page.test.ts
git commit -m "feat(#912): reporting counts donation classes on their own line, unrecorded as unknown"
```

---

### Task 9: The rest of the copy register, and the GDPR exports

**Files:**
- Modify: `src/components/booking/booking-flow.tsx` and its test
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx`
- Modify: `src/components/student/cancel-booking-button.tsx` and its test
- Modify: `src/app/(student)/bookings/page.tsx` (cancel button prop; late-cancel note)
- Modify: `src/lib/charge-note.ts`
- Create: `src/lib/charge-note.test.ts`
- Modify: `src/app/api/registrations/[id]/route.ts` (DELETE notices, `answerForCancelledRow`)
- Modify: `src/app/api/registrations/route.ts` (booking confirmation body; `WalkInNotice` input)
- Modify: `src/services/waitlist.ts` (promotion `cancelTerms`, claim body)
- Modify: `src/services/walk-ins.ts` (`WalkInNotice`, body)
- Modify: `src/lib/email-templates.ts` (`TEACHER_INTROS.payment_request`)
- Modify: `src/services/gdpr.ts`, `src/services/gdpr.test.ts`
- Test: `tests/integration/registrations-api.test.ts`, `src/services/waitlist.test.ts`, `src/services/walk-ins.test.ts` (the tiered walk-in sentence is also asserted in `src/services/email-fallback.consent.test.ts`, which stays unchanged)

**Interfaces:**
- Consumes: `PricingMode`.
- Produces:
  - `BookingFlowProps` replaces `tierPrices` with `pricing: { mode: 'tiered'; tierPrices: number[] } | { mode: 'donation' }`.
  - `CancelBookingButtonProps` gains `pricingMode: PricingMode`.
  - `WalkInNotice` gains `readonly pricingMode: PricingMode`.
  - `src/lib/charge-note.ts` gains `export function lateCancelNoteFor(mode: PricingMode): string`.

- [ ] **Step 1: Failing tests.**
  - `booking-flow.test.tsx`, with `pricing={{ mode: 'donation' }}`:
    - shows `This class is by donation. After class you can give what you like, if you like.`;
    - shows the tier cards without any `€`;
    - the button reads exactly `Book`;
    - no `Estimates assume` and no `Learn more`.
    - In the claim window (`isFull`, `inClaimWindow`) the caption lacks `Claiming is charged`.
    - After booking, the confirmation lacks `final price`.
  - `cancel-booking-button.test.tsx`: with `pricingMode="donation"` past the deadline, the confirm reads `After the deadline, cancelling is recorded as a late cancellation.` and contains no `charged` or `pay`. Before the deadline it reads `Cancel this booking? Free until {label}.`
  - `charge-note.test.ts`: `lateCancelNoteFor('donation')` is `Cancelled after the deadline.`; `lateCancelNoteFor('tiered')` is `LATE_CANCEL_CHARGE_NOTE`.
  - `tests/integration/registrations-api.test.ts`, on a donation class:
    - a student's late cancel creates a `booking_cancelled` body ending `You cancelled after the deadline, so this is recorded as a late cancellation.`;
    - a free cancel's body has no `charged`;
    - a teacher's cancel of a late-cancelled booking answers `ALREADY_LATE_CANCELLED` (the code is unchanged);
    - a fresh booking's `booking_confirmed` body has no `price`.
  - Waitlist and walk-in service tests:
    - a promotion into a donation class whose booking was late-cancelled before carries no `stays charged`;
    - a final-hour claim body has no `charged`;
    - a walk-in body ends `This class is by donation.`
  - `gdpr.test.ts`:
    - `exportTeacherData`'s `classes[]` carry `pricingMode` and `donationTotal`;
    - `exportStudentData`'s `bookings[]` carry `donationInvitedAt` and `donationPromptHiddenAt`;
    - teacher-side exports carry neither `Registration` timestamp: `JSON.stringify(exportTeacherData(...))` does not contain `donationInvitedAt` or `donationPromptHiddenAt`.

- [ ] **Step 2: Run and confirm failure.**
Run: `pnpm exec vitest run --project components src/components/booking/booking-flow.test.tsx src/components/student/cancel-booking-button.test.tsx && pnpm exec vitest run --project unit src/lib/charge-note.test.ts src/services/gdpr.test.ts`
Expected: FAIL (props absent, strings differ, export keys missing).

- [ ] **Step 3: Implement each site.** Each site switches on `pricingMode` with a `never` default, or keys a `satisfies Record<PricingMode, …>` table. Tiered strings stay byte-identical.
  - `booking-flow.tsx`:
    - Donation renders the donation line in place of the `Your price is based on…` paragraph.
    - The tier cards render without the price `<span>`.
    - The `Estimates assume…`/`Learn more`/`PricingExplainer` block is not rendered.
    - The button reads `Book`.
    - The claim-window caption drops its last sentence.
    - The booked phase reads `Your spot is confirmed.`
  - The booking page builds `pricing` with a `switch (cls.pricingMode)` and computes `estimateTierPrices` only in the tiered arm.
  - `cancel-booking-button.tsx`:
    - Past the deadline, donation reads `After the deadline, cancelling is recorded as a late cancellation.`
    - Before the deadline it reads `Cancel this booking? Free until {freeCancelUntilLabel}.`
    - The bookings page passes `pricingMode={cls.pricingMode}` and swaps `LATE_CANCEL_CHARGE_NOTE` for `lateCancelNoteFor(cls.pricingMode)`.
  - `charge-note.ts`: add `lateCancelNoteFor` via `const LATE_CANCEL_NOTES = { tiered: LATE_CANCEL_CHARGE_NOTE, donation: 'Cancelled after the deadline.' } as const satisfies Record<PricingMode, string>;`.
  - `api/registrations/[id]/route.ts`:
    - The DELETE handler's class select gains `pricingMode: true`.
    - Late-cancel body for donation: `` `Your booking for ${phrase} is cancelled. You cancelled after the deadline, so this is recorded as a late cancellation.` ``
    - The free-cancel and teacher-removal bodies drop ` You won't be charged for it.` for donation.
    - `answerForCancelledRow` takes the mode and sends `This booking is already cancelled.` for donation (code `ALREADY_LATE_CANCELLED` unchanged). Thread the mode into `answerMissedCancel`'s fresh read too.
  - `api/registrations/route.ts`:
    - The `booking_confirmed` body for donation reads `` `You're booked for ${cls.calendarEntry.classType}. It's by donation.` ``
    - `notice` gains `pricingMode: cls.pricingMode`.
  - `walk-ins.ts`: the body's last sentence switches on the mode — tiered keeps `Your price is calculated after class.`, donation reads `This class is by donation.` `walk_in_added` stays essential.
  - `waitlist.ts`:
    - `cancelTerms`'s second arm reads `You cancelled this class after the deadline before.` for donation.
    - The claim body for donation ends at `…in ${classType}.` with no charge clause.
    - Both reads already `include` the class's columns.
  - `email-templates.ts`: `TEACHER_INTROS.payment_request` becomes `'One of your classes is complete.'` This is spec defect 7. The type is the teacher's completion notice for both modes, and the current wording names pricing. Flag it in the PR body as a tiered-email copy change.
  - `gdpr.ts`:
    - Teacher `classes` map gains `pricingMode: c.pricingMode, donationTotal: c.donationTotal`.
    - Student `bookings` map gains `donationInvitedAt: r.donationInvitedAt, donationPromptHiddenAt: r.donationPromptHiddenAt`.
    - `recurringTemplates` already spreads every template column, so `pricingMode` arrives with no edit; assert it in the test.

- [ ] **Step 4: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project components src/components/booking src/components/student && pnpm exec vitest run --project unit src/lib/charge-note.test.ts src/services/gdpr.test.ts src/services/waitlist.test.ts && curl -s -o /dev/null http://localhost:3000/api/registrations && pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS. Then grep that no tiered string moved: `git diff -U0 -- src | grep '^-' | grep -E "charged|price"`. Every hit must be a line rewritten into a mode switch whose tiered arm carries the same text.

- [ ] **Step 5: Commit.**

```bash
git add src/components/booking/booking-flow.tsx src/components/booking/booking-flow.test.tsx "src/app/(public)/[slug]/book/[classId]/page.tsx" src/components/student/cancel-booking-button.tsx src/components/student/cancel-booking-button.test.tsx "src/app/(student)/bookings/page.tsx" src/lib/charge-note.ts src/lib/charge-note.test.ts "src/app/api/registrations/[id]/route.ts" src/app/api/registrations/route.ts src/services/waitlist.ts src/services/walk-ins.ts src/lib/email-templates.ts src/services/gdpr.ts src/services/gdpr.test.ts tests/integration/registrations-api.test.ts src/services/waitlist.test.ts src/services/walk-ins.test.ts
git commit -m "feat(#912): donation copy at every charge site; GDPR exports carry the new fields"
```

---

### Task 10: End to end — book, complete, open the invitation, see no amount

**Files:**
- Create: `tests/e2e/donation-class.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the spec.**
  - Follow the fixture and teardown shape of `tests/e2e/pay-page.spec.ts`: `createGuardedPrismaClient`, `accountIdOfTeacher`/`accountIdOfStudent`, `seedSession` + `sessionCookie`, undefined-guarded `afterAll`, and the serial mode.
  - Fixture: a teacher with a EUR bank account (`NL91ABNA0417164300`) and a student.
  - A donation class (`pricingMode: 'donation'`, `minRate: 0`, `targetRate: 0`, `status: 'open'`) one week ahead.

```ts
test('a donation class: book, complete, follow the invitation, give without an amount', async ({ page, request }) => {
  await page.context().addCookies([sessionCookie(studentToken)]);
  await page.goto(`/${slug}/book/${classId}`);
  await expect(page.getByText('This class is by donation. After class you can give what you like, if you like.')).toBeVisible();
  await page.getByRole('radio', { name: /Tier 3/ }).click();
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByText('Your spot is confirmed.')).toBeVisible();

  // Move the class into its past so completion opens, then finish it as the teacher.
  await prisma.calendarEntry.update({ where: { id: entryId }, data: { date: new Date('2026-06-01T00:00:00Z') } });
  await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
  const done = await request.post(`/api/classes/${classId}/complete`, { headers: cookie(teacherToken) });
  expect(done.ok()).toBe(true);

  await page.goto('/updates');
  await page.getByText('Thank you for coming', { exact: false }).first().click();
  await expect(page).toHaveURL(new RegExp(`/bookings/${classId}/give$`));
  await expect(page.getByRole('heading', { name: 'Thank you for coming.' })).toBeVisible();
  await page.getByText('Bank transfer').click();
  const body = await page.locator('main').innerText();
  expect(body).not.toMatch(/€\s?\d|EUR\s?\d/);
  await expect(page.getByText('NL91', { exact: false })).toBeVisible();
});
```

- [ ] **Step 2: Run it.**
Run: `pnpm exec playwright test tests/e2e/donation-class.spec.ts --project chromium`
Expected: PASS against the running app. If it fails, the failure names the step. Fix the code, not the spec, unless the spec misreads a selector.

- [ ] **Step 3: Prove the spec bites.** Temporarily make the give page pass `amount={{ kind: 'fixed', amount: 10 }}`. The type allows it only with a `paymentId`, so pass the registration id. Run and record the failure on the `not.toMatch(/€…/)` line. Restore, PASS.

- [ ] **Step 4: Commit.**

```bash
git add tests/e2e/donation-class.spec.ts
git commit -m "test(#912): e2e — a donation class's invitation leads to a give page with no amount"
```

---

### Task 11: Project docs, baselines and the whole-branch gate

**Files:**
- Modify: `CLAUDE.md`
- Modify: `tests/e2e/visual-baseline-attestations.json` (by the attest script)

- [ ] **Step 1: CLAUDE.md.** Replace what this branch made untrue; add nothing that counts.
  - Class Lifecycle, the `settings_locked` bullet: `LOCKED_FIELDS` (`src/lib/class-fields.ts`: the economic fields, `pricingMode`, then `date` and `startTime`).
  - Class Lifecycle, the last bullet: `After completion: pricing engine runs → payments created → notifications sent; a donation class (#912) runs no pricing and creates no payment — it invites everyone who came to give, once`.
  - Payment Model: a new bullet. **Donation classes (#912):** `Class.pricingMode = donation` shows no amount to students. Completion stamps `Registration.donationInvitedAt` on everyone who came (`DONATION_INVITED_STATUSES`) and sends an optional `donation_invitation` linking to `/bookings/{classId}/give`, which shows the teacher's Level 1 details live with no amount. The teacher records `Class.donationTotal` (null = not recorded; VAT derived on read). See `docs/superpowers/specs/2026-10-25-donation-classes-design.md`.
  - Communication, layer 2: `(kept for a year; waitlist spot alerts and donation invitations for 30 days — src/lib/notification-retention.ts)`.

- [ ] **Step 2: Re-attest the two visual baselines whose source this branch touched without changing tiered rendering.**
  - Run: `pnpm exec playwright test tests/e2e/visual.spec.ts --project chromium -g "public-page|class-detail-open"`. Expected: PASS against the committed baselines, which proves no rendered change.
  - Then `pnpm run attest-visual-baseline public-page` and `pnpm run attest-visual-baseline class-detail-open`.
  - Edit each new attestation's `note` to say that #912 adds a donation branch and that the tiered render is unchanged.

- [ ] **Step 3: Whole-branch verification.**
  - `pnpm run verify` (typecheck, lint, every vitest project, lockfile, migrations, baseline freshness; needs :3000 live). Record the per-project file counts from the output as `total = unit + components + unit-sweeps + integration` for the PR body.
  - `pnpm run build`. It catches client imports of server-only modules (`method-panel.tsx` imports `@/lib/log` and must only be imported from server components; `donation-prompt.tsx` must not import it).
  - `pnpm exec prisma validate`, then `pnpm exec prisma migrate status`. Expected: three new migrations, all applied, no drift.
  - `pnpm exec playwright test tests/e2e/donation-class.spec.ts tests/e2e/pay-page.spec.ts`.

- [ ] **Step 4: Manual check (spec §9).** Render a give page for a EUR bank teacher. Scan its amount-less QR with the banking apps to hand (ING, Rabobank, ABN AMRO, bunq, plus a non-Dutch one if available). Record, per app, whether it opens a transfer with the amount blank. Put the table in the PR body. Most opening it keeps the QR. Most failing means removing the `epc_qr` row from the give page only, as a follow-up commit.

- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md tests/e2e/visual-baseline-attestations.json
git commit -m "docs(#912): CLAUDE.md states the donation branch; re-attest unchanged baselines"
```

---

## Self-review notes

- **Spec coverage:**
  - §3.1–3.4 → Task 1 (columns, CHECKs, lock, stamp), Task 3 (`DONATION_INVITED_STATUSES`).
  - §4.1 → Task 3. §4.2 → Task 4. §4.3 → Task 3. §4.4 → Tasks 2 and 5. §4.5 → Task 5. §4.6 → Task 6. §4.7 needs no code: the give page reads the pause live (Task 5 pins it).
  - §5 → Task 8. §6 → Tasks 2, 6 and 9. §7 → Tasks 6, 7 and 9. §8 → each owning task's tests and "prove it bites" steps. §9 → Task 11.
- **Guards broken once on purpose:**
  - each CHECK → Task 1 Step 6;
  - both `IS NULL` clauses → Task 3 Step 9 and Task 4 Step 9;
  - `status IN` → Task 3 Step 10;
  - `lockClassRow` → Task 4 Step 8;
  - price-line `never` → Task 2 Step 7;
  - generator copy → Task 1 Step 13.
- **Type names used across tasks:**
  - `MethodAmount`, `epcQrPayload`, `MethodPanelProps` (Task 2 → 5).
  - `DONATION_INVITED_STATUSES`, `givePagePath`, `GIVE_LABEL`, `claimCompletionInvitations`, `donationInvitation`, `donationCompletionNotice` (Task 3 → 4, 5, 6).
  - `claimCorrectionInvitation` (Task 4). `canSeeGivePage`, `showsDonationPrompt`, `DONATION_PROMPT_DAYS`, `hideDonationPrompt` (Task 5).
  - `recordDonationTotal`, `donationTotalSchema` (Task 6). `PricingModeChoice` (Task 7). `classEarningsCents`, `buildReport` (Task 8). `lateCancelNoteFor` (Task 9).
