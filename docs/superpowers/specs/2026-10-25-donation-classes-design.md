# Donation-based classes (#912)

A teacher can mark a class or a class template as **by donation**. Booking,
cancelling, the waitlist, walk-ins, reminders and the lifecycle are unchanged.
Nothing is priced, no amount is shown to a student anywhere, and after class
each student who came is invited — once, optionally — to give what they like
through the teacher's own Level 1 payment details. The teacher records what came
in for the class as a whole, and never learns who gave what.

## 1. Premise check

Measured against `main` at `64ac841c`. The sweep's file:line evidence lived in a
scratchpad report; the corrections that change the design are restated here.

**Held:**
- `minRate = targetRate = 0` passes every `CHECK` in
  `20260924190000_class_economics_checks` (`roomCost >= 0`, `minRate <=
  targetRate`, `minRate >= -roomCost`) and `class_vat` (`vatPercent` 0..100),
  so the rate columns need no nullability change.
- Missing payout details never block completion: `payGuidanceFor` answers
  `'directly'` and the student is told to pay the teacher directly.
- Walk-ins are billed exactly like booked students — `completeClass` filters on
  `CHARGED_STATUSES` and never reads `isWalkIn`.
- `payment_request` is in `ESSENTIAL_NOTIFICATION_TYPES`; `late_cancel` and a
  final-hour claim are both billed at completion.
- `Registration.price` and `tierRatio` are nullable; `tierAtBooking` is required,
  which suits "students still choose a tier".
- Level 2 is per-`Payment` with a fixed amount (`ProcessorPayment.paymentId`
  required, `amount Decimal`).

**Wrong or incomplete in the issue:**
- *"Add `pricingMode` to `ECONOMIC_FIELDS`."* Wrong: the template update path
  (`class-template-lifecycle.ts`, the `ECONOMIC_FIELDS` loop) throws for any
  member whose value is not a number, so a template edit sending `pricingMode`
  would 500. It gets its own list, joined into `LOCKED_FIELDS` the way
  `SCHEDULE_LOCKED_FIELDS` is (§3.2).
- *"Works the same way as `StudioClass` income tracking."* Wrong: `StudioClass`
  has no entered total — reporting derives `hourlyRate × duration`. A
  teacher-entered total is new.
- *"Reuse `Class.totalRevenue`?"* Effectively closed: it is in
  `PlainUpdateForbiddenClassField` with a completeness pin, tied to `vatTotal` by
  `Class_vat_total_snapshot_check`, and read by the student `PaymentBreakdown`,
  which renders a **Room** line — the anchor the issue forbids. Separate column.
- *The four "copy" files.* `charge-note.ts` and `payment-request-copy.ts` are
  copy; `cancel-deadline.ts` and `price-line.ts` are logic. About a dozen
  charge/price strings elsewhere were missed — the register is §6.
- *"Thank-you message with the teacher's bank account."* Conflicts with the
  payout-change alert (#786): the pause hides payment details only because they
  are read live on the pay page, and no notification today embeds an IBAN. A
  message carrying one cannot be withdrawn by a pause — a hijacked IBAN would go
  out by email to every student. The message links to a live page instead (§4.3).
- *"EPC QR without an amount."* The format allows it, but `payment-qr.tsx`
  always encodes one; and a faked €0 class would encode `EUR0.00`, outside the
  allowed range. Code change, plus a manual banking-app check (§9).
- *A missing total.* Reporting coalesces null to 0, so an unrecorded donation
  class would report `−roomCost` as earnings. Null must mean "unknown" (§5).

## 2. Decisions taken with the owner

| # | Question | Decision |
|---|---|---|
| 1 | Where the total lives | New nullable `Class.donationTotal`; VAT derived on read |
| 2 | Reporting | Its own line |
| 3 | Walk-ins | Same invitation as everyone else |
| 4 | No recorded total | A quiet "Not recorded yet" on the class page only; reporting treats it as unknown, not €0 |
| 5 | IBAN in the message | No — instruction plus a link to a live page |
| 6 | Pause, then resume | Re-notify nobody: a second nudge to give is the pressure this feature avoids |
| 7 | Who is invited | Those who came: `registered` (unmarked counts as present) and `attended`; a later correction to `attended` invites then, once |
| 8a | Essential or optional | Optional (email honours the opt-out); the inbox row is always created |
| 8b | No Level 1 method | "Give your teacher directly, however suits you" — a Mollie-only teacher has no online donation path, accepted |
| — | Dismissal | A neutral **Hide**, plus auto-hide after 30 days. Needed also for those who did give: the platform cannot know, and must not |
| — | Where "how to give" lives | A new page, not a branch of the pay page |
| — | Invited exactly once | A `donationInvitedAt` stamp claimed by conditional update |
| — | Rates on a donation class | Kept, never read; switching an unbooked class back restores them |

## 3. Data model

### 3.1 `PricingMode`

```prisma
enum PricingMode {
  tiered
  donation
}
```

`pricingMode PricingMode @default(tiered)` on `Class` and `ClassTemplate`. The
generator (`class-generator.ts`) copies it onto each generated class; that copy
has no compiler tether, so a test pins it as #910 did for `isPrivate`. A template
is a stamp: changing a template's mode changes no existing class.

Every reader that chooses what a student is shown or charged switches on
`pricingMode` with a `never` default, or keys a `Record<PricingMode, …>` checked
with `satisfies`, so a new mode, or a reader that forgot donation, fails to
compile rather than showing a price. Teacher-side filters (form field
visibility, reporting's per-mode partitions, the economics wording) compare
against one literal instead; re-derive them with
`git grep -nE "pricingMode [!=]== '" -- src ':!*.test.*'`.

### 3.2 Locking

```ts
export const PRICING_LOCKED_FIELDS = Object.freeze(['pricingMode'] as const);
export const LOCKED_FIELDS = Object.freeze([
  ...ECONOMIC_FIELDS, ...PRICING_LOCKED_FIELDS, ...SCHEDULE_LOCKED_FIELDS,
] as const);
```

A booked class refuses a mode change with the existing 409 `SETTINGS_LOCKED`;
`class-edit-form.tsx` strips it from a locked payload like the other members.
The `ClassTemplate` side is not locked (templates have no bookings). Moving
between modes on an unbooked class or a template touches nothing else: rates
stay as stored.

### 3.3 `Class.donationTotal`

`donationTotal Decimal? @db.Decimal(10, 2)` — the precision of `totalRevenue`.
`NULL` is "not recorded", distinct from `0`.

Hand-authored `CHECK`s (pattern: `20260721061528_student_claim_link_check`):
- `Class_donation_total_nonnegative_check`: `"donationTotal" IS NULL OR "donationTotal" >= 0`
- `Class_donation_total_mode_check`: `"donationTotal" IS NULL OR "pricingMode" = 'donation'`

Its VAT is never stored: `includedVatCents(totalCents, vatThousandths(vatPercent))`
(`src/lib/vat.ts`) wherever it is needed — the same "VAT contained in the price"
rule CLAUDE.md states for per-student prices. Nothing to keep in sync.

`donationTotal` joins `PlainUpdateForbiddenClassField` and its completeness pin;
the only writer is `recordDonationTotal` (§4.5).

**The completion snapshot is untouched in meaning.** For a donation class
`completeClass` writes `totalStudents` and leaves `totalRevenue`, `vatTotal` and
`effectiveTeacherRate` null — legal under `Class_vat_total_snapshot_check`
(both null). "Written once at completion" stays true of all three.

### 3.4 `Registration`

- `donationInvitedAt DateTime?` — when this booking was invited to give. Set
  once, never cleared.
- `donationPromptHiddenAt DateTime?` — when the student hid the prompt. Records
  only that it was hidden; deliberately not "I gave".
- `Registration_donation_hidden_requires_invited_check`:
  `"donationPromptHiddenAt" IS NULL OR "donationInvitedAt" IS NOT NULL`
- "Only a donation class's bookings are invited" cannot be a `CHECK` (it would
  read the `Class` row); `completeClass` and the attendance claim (§4.2) are the
  only writers of `donationInvitedAt` and both gate on the class's mode
  (re-derive: `git grep -n donationInvitedAt -- src ':!*.test.*'`).

`price` and `tierRatio` stay null on a donation registration.

## 4. Behaviour

### 4.1 Completion

`completeClass` switches on `pricingMode`. For `donation`, inside its existing
transaction (which already holds the class lock):

1. No pricing engine, no `Payment` rows, no registration price writes.
2. Write the class: `status = completed`, `totalStudents`, snapshot columns null.
3. Claim the invitations:
   ```sql
   UPDATE "Registration" SET "donationInvitedAt" = now()
   WHERE "classId" = $1 AND status IN ('registered','attended')
     AND "donationInvitedAt" IS NULL
   RETURNING id
   ```
4. In the same transaction, create one `donation_invitation` per returned id
   — exactly the rows stamped, never a re-read. `completeClass` already creates
   its notifications inside its transaction (`createBulkNotifications(tx, …)`),
   so the stamp and the inbox row commit together: a booking can never be
   stamped and not told.

**Erasure completes, but invites nobody.** A teacher's account erasure finishes
their in-flight classes early (`CompletionTiming`'s `finishedEarly`). A donation
class completed that way stamps and sends nothing: the invitation would ask
students to give to an erased teacher.

`no_show`, `late_cancel` and `cancelled` are not invited. Walk-ins are invited
like anyone else. The auto-completion sweep goes through the same function.

The teacher's completion notice: *"{class} is complete — {n} students invited to
give."* No earnings figure; `n` may be 0 (*"No one to invite."*).

### 4.2 A later correction to `attended`

`PUT /api/registrations/[id]` keeps its unlocked status write (lock-order doc,
*`Registration` status writers outside the class lock*). After that write
succeeds with `attended`, a second short transaction:

1. `lockClassRow(classId)` — `Class` before `Registration`, per `docs/lock-order.md`.
2. Conditional claim:
   `UPDATE … SET "donationInvitedAt" = now() WHERE id = $1 AND status = 'attended'
   AND "donationInvitedAt" IS NULL` and the class is `completed`, `donation`, not cancelled.
3. One row → create the invitation in the same transaction.

**A retry after a failed claim.** If the claim's transaction fails (the class
lock's bound, a 503) after the `attended` write committed, the teacher's retry
finds the status already `attended`. The route runs the claim on that path too,
and answers *applied* when it stamps — inviting is a change, so the answer is
not `respondUnchanged`.

**Why this closes the race with completion.** The interleavings are argued once,
in `docs/lock-order.md` ("`Registration` status writers outside the class
lock", the `claimCorrectionInvitation` paragraph): no interleaving invites twice
or misses.

A correction to `no_show` after an invitation changes no stamp, so flipping back
to `attended` does not resend. The give page and the bookings prompt check status
live, so a `no_show` simply stops seeing them; an inbox row already sent stays.

`docs/lock-order.md` gains this writer under the `Registration` section (it
writes no `status`, takes the class lock, and orders correctly).

### 4.3 The invitation

New `NotificationType` `donation_invitation`, student-only.

- **Not essential** — `Student.emailNotifications` governs its email; the inbox
  row is always created.
- **Retention 30 days** (`notification-retention.ts`), matching the prompt's
  auto-hide.
- **Push group `payments`** (`push-policy.ts`) — lock screen shows the fixed line.
- **Email fallback** — normal timing; its button links to the give page, never
  to the pay page.
- **Body:** *"Thank you for coming to {class}. It was by donation — if you'd like
  to give, here's how."* Link: `/bookings/{classId}/give`. No IBAN, no QR, no
  payment link, no amount, ever.

Every `Record<NotificationType, …>` gets its entry (the compiler finds them).

### 4.4 The give page — `/bookings/[classId]/give`

Student page. Eligibility, as one predicate in `src/lib/` (unit-tested), read
whole: the class is the student's own booking, `completed`, not cancelled,
`pricingMode = donation`; the booking is `registered` or `attended`; and
`donationInvitedAt` is set. Anything else is `notFound()` — naming nothing.

Content:
- *"Thank you for coming."* plus the class name and date.
- `paymentMethodsForTeacher(teacher, cls.currency)`, read live:
  - `paused` → the existing hold-off line, no methods;
  - methods → bank account(s) in the class currency, the EPC QR **without an
    amount** (EUR only), `Teacher.paymentLink`;
  - none → *"Give your teacher directly, however suits you."*
- No amount, no room cost, no breakdown, no "I've sent it". The transfer
  reference is the existing `paymentReference(entry)` (`payment-methods.ts`),
  which is built from class type and date only — nothing that identifies the
  student, which keeps anonymity intact at the bank statement too.

Do **not** use `payGuidanceForTeacher` — it counts a Mollie connection as a
method, and Level 2 does not apply here.

`MethodPanel` and `PaymentQr` take a discriminated amount:

```ts
type MethodAmount = { kind: 'fixed'; amount: number } | { kind: 'open' };
```

The pay page passes `fixed`; the give page `open`. An `open` QR leaves the EPC
amount line empty and its alt text names no amount. The type is what keeps the
give page from ever rendering an amount and the pay page from losing one.

### 4.5 The bookings list and Hide

A past row of a donation class shows **"Give if you'd like"** (→ give page) and
**Hide** while: the give page would render, `donationPromptHiddenAt` is null, and
`now < donationInvitedAt + 30 days`. Otherwise the right-hand side is empty, as a
past row without a payment is today. No price, no breakdown.

`POST /api/registrations/[id]/donation-prompt/hide`: the student's own booking
only (403 otherwise); a booking that was never invited → 409
`DONATION_NOT_INVITED`; already hidden → `respondUnchanged`. Sets
`donationPromptHiddenAt = now()`. Nothing teacher-facing reads it.

### 4.6 Recording the total

`recordDonationTotal(db, teacherId, classId, amount: number | null)` in
`src/services/`, exposed as `PUT /api/classes/[id]/donation-total` with
`{ amount: number | null }` — the codebase's money convention (`moneyField`,
`z.number()`), ≥ 0.

Order, per *Error responses*: a missing class → 404; another teacher's class →
403 `Not your class`, as the sibling class routes answer (a class id is public in
every booking link, so a 404 would hide nothing; the student give page, by
contrast, stays a 404 that names nothing, because there the *reason* is the
private fact) →
`CLASS_CANCELLED` → `DONATION_CLASS_REQUIRED` (409, a tiered class) →
`CLASS_NOT_COMPLETED` (409) → same value → `respondUnchanged` → write. `null`
clears back to "not recorded". This is the only post-completion write to a
`Class` economic value, and it bypasses `updateClass`'s terminal freeze by being
its own statement, not a field of that update.

New codes in `src/lib/api-error-codes.ts`, all 409:
`DONATION_CLASS_REQUIRED`, `CLASS_NOT_COMPLETED`, `DONATION_NOT_INVITED`.

### 4.7 Payout pause (#786)

No new mechanism. The give page reads the pause live. Resume re-notifies only
outstanding `Payment`s, and a donation class has none — by decision 6, nobody
is re-invited.

## 5. Reporting (`/settings/reporting`)

- **New line "Donation classes"**, per currency, between "Your classes" and
  "Studio classes": `teacherEarningsCents(donationTotal, roomCost,
  includedVat)` summed over **recorded** donation classes. Beneath it, when any
  exist: *"{n} without a recorded total"* (caption).
- **"Your classes"** becomes tiered classes only.
- **Unrecorded donation classes** add nothing to any earnings figure (hero,
  lines, month column), still add their `roomCost` to "Room costs paid", and
  still count in "{n} classes · {m} students reached" and the month's CLASSES and
  STUDENTS.
- **Wording**: hero *"Total charged for teaching"* → *"Earned from teaching"*;
  month column *CHARGED* → *EARNED*; empty state *"Completed classes and what
  they charged appear here."* → *"Completed classes and what they earned appear
  here."* The hero already sums net earnings, so "charged" was already the wrong
  word.

## 6. Copy register

Each site switches on `pricingMode`; tiered copy is unchanged.

| Site | Donation version |
|---|---|
| `booking-flow.tsx` — price intro, tier table, "Estimates assume…" | Hidden; one line: *"This class is by donation. After class you can give what you like, if you like."* Tier picker stays, with its existing explanation |
| `booking-flow.tsx` — *"Book — around €X"* | *"Book"* |
| `booking-flow.tsx` — *"Claiming is charged even if you can't make it."* | Omitted |
| `booking-flow.tsx` — *"The final price settles after class…"* | Omitted |
| `cancel-booking-button.tsx` — late-cancel warnings | *"After the deadline, cancelling is recorded as a late cancellation."* |
| `api/registrations/[id]/route.ts` — late-cancel notice | *"You cancelled after the deadline, so this is recorded as a late cancellation."* |
| `route.ts` — "You won't be charged for it." | Omitted |
| `route.ts` — `ALREADY_LATE_CANCELLED` "…charge stands." | *"This booking is already cancelled."* (code unchanged) |
| `waitlist.ts` — promotion "…stays charged if you cancel again" | Clause omitted |
| `waitlist.ts` — final-hour claim "…charged even if you can't make it" | Clause omitted |
| `walk-ins.ts` — *"Your price is calculated after class."* | *"This class is by donation."* (`walk_in_added` stays essential: it is the booking confirmation) |
| `charge-note.ts` — late-cancel note on an upcoming booking (`bookings/page.tsx`) | *"Cancelled after the deadline."* (the pay-page reads are unreachable: no `Payment`) |
| `api/registrations/route.ts` — booking confirmation *"The final price settles after class."* | Omitted |
| `email-templates.ts` — teacher intro *"A class has been priced."* | *"One of your classes is complete."* — **for both modes** (the tiered email changes one line) |
| `student-archive-copy.ts` — *"…haven't been billed yet."* | *"…haven't finished yet."* — for both modes; the code is unchanged |
| `payment-request-copy.ts` | Not reached: no `Payment` |
| `complete-class-button.tsx` — "Payment requests go to N students now" | *"{n} students will be invited to give."* |
| class detail — "Payment requests go out automatically at …" | *"Invitations to give go out at …"* |
| `class-lifecycle.ts` teacher completion notice | §4.1 |
| `price-line.ts` / `PriceRange` | `{ kind: 'donation' }` → *"By donation · give what you like after class"* (`/[slug]`, booking page, bookings list) |

No copy says or implies a donation is VAT-free. No surface suggests an amount.

## 7. Teacher surfaces

- **Class form and template form.** A **Pricing** choice — *Tiered · By
  donation* — opens the economics section. Donation *replaces* the rate fields
  and `PricingPreviewResult` (the form gets no longer: #910/#911). Room cost,
  VAT, min/max students stay. Locked when booked, shown with the existing lock
  treatment.
- **Class detail, before completion.** `PricingPreview` → a *"By donation"* line
  and, at 0% VAT, *"Room cost {€}: your break-even."*; above 0%, *"Room cost
  {€}: your break-even is {room × (1 + VAT)} in donations, VAT included."* —
  what has to come in for the room to be covered. An online class (#911) has no
  room, so it shows the *"By donation"* line alone, as `PricingPreview` and
  `PricingBreakdown` leave out their room line for it.
- **Class detail, completed.** No `PricingBreakdown`, no `PaymentChecklist`. A
  **Donations received** card: the amount (with *"incl. {€} VAT"* when
  `vatPercent > 0`), or *"Not recorded yet"* with **Record**; editable and
  clearable. This is the only prompt to record — nothing in the inbox or the
  schedule.
- **Schedule card, payments overview** — already empty with no `Payment` rows.
- **Two readers that assume a completed class has a payment snapshot** learn the
  mode: `resolvePaymentBreakdown` would report `snapshot_missing` (and `/bookings`
  log `PAYMENT_SNAPSHOT_MISSING`) for every past donation row, and
  `reportMissingPayment` would log `CHARGED_REGISTRATION_WITHOUT_PAYMENT` when a
  stale pay link is opened. Neither is a defect for a donation class; both stay
  silent for one.
- **GDPR.** Teacher export: `pricingMode`, `donationTotal` per class. Student
  export: their own `donationInvitedAt`, `donationPromptHiddenAt`. No teacher
  surface or export reads either `Registration` timestamp.

## 8. Testing

- **Unit:** `resolvePriceLine` donation case; give-page eligibility predicate
  (each condition flipped alone); reporting aggregation with recorded,
  unrecorded and tiered classes; EPC payload with `open` amount.
- **Components:** `PaymentQr`/`MethodPanel` `open` renders no amount; bookings
  row shows prompt only within the window and not after Hide.
- **Constraints** (`src/services/`, beside `class-economics-constraints.test.ts`):
  each new `CHECK` refuses its violating row.
- **Integration:**
  - completion of a donation class creates zero `Payment` rows and stamps
    exactly `registered` + `attended` (a `no_show`, `late_cancel`, walk-in and
    cancelled row in the same class);
  - correction `no_show → attended` after completion invites once; `→ no_show →
    attended` again does not resend; a correction before completion does not
    invite on its own;
  - locked class refuses a mode change, 409 `SETTINGS_LOCKED`;
  - template → generated class copies the mode;
  - donation-total endpoint: each refusal code, `respondUnchanged`, clear to null;
  - Hide endpoint: own only, not-invited, unchanged;
  - give page: 404 for each ineligible state; paused shows hold-off.
- **E2E:** book a donation class → complete → inbox link → give page shows no
  amount.

**Every guard is broken once on purpose**, the error recorded, then restored:
each `CHECK`; the `donationInvitedAt IS NULL` clause in both claims; the
`status IN (...)` clause; the `lockClassRow` in the correction path; the
`never` default in the price-line switch; the generator copy test.

## 9. Manual check

An EPC QR is read by the **student's** banking app; the teacher's bank only
receives an ordinary SEPA transfer, where the amount plays no part. Which app a
given student uses is unknowable, so no single scan decides anything. What makes
an app that mishandles an amount-less code harmless is that the give page always
shows the IBAN, beneficiary and reference as text beside the QR (the same
`PaymentDetails` the pay page renders) — the student types the transfer instead.

The check: scan an amount-less code with the common apps to hand (ING, Rabobank,
ABN AMRO, bunq, plus a non-Dutch one if available) and record which open a
transfer with the amount left blank. Keep the QR if most do; drop it for donation
classes only if most fail, since a code that usually errors is worse than none.

## 10. Out of scope

Level 2 (Mollie/Stripe) donations; suggested amounts; any per-student record of
giving; re-notifying on resume; donation `StudioClass`es. **#910 is unaffected.**
An online class (#911) combines with donation as §7 states — no room line, and
#911's own online wording otherwise unchanged.
