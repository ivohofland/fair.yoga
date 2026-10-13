# VAT as a cost component in class pricing (#819)

## Problem

Student prices always include VAT. A teacher who charges VAT cannot compare a
class like for like today. The room cost they enter excludes VAT, which they
reclaim, but the student income it is set against includes VAT. VAT becomes one
more cost in the class total, next to the room:

```
total = withVat(room cost + teacher rate)
```

The total is split across students exactly as today, so student prices include
VAT. The teacher's rate is what they earn after VAT.

The default VAT % on `Teacher` already shipped as #833
(`Teacher.defaultVatPercent`, `src/lib/vat.ts`). This issue adds the per-class
and per-template field, the pricing change, the completion snapshot and the
displays. The decisions comment on #819 is part of the brief:
- VAT is calculated per student and summed.
- `Payment.vatAmount` is stored but not shown.
- Reporting is excl. VAT.
- Negative VAT is not a case to design for.

## Premise check (measured on `main` at `dafe0d4b`)

- **Held:** the engine has one line to change. `calculateClassPricing`
  (`src/services/pricing.ts`) computes `totalCost = roomCost +
  effectiveTeacherRate`, then splits it by largest remainder in cents, so the
  student prices sum to the total. Splitting the VAT-inclusive total keeps that
  property for free.
- **Held:** nothing is priced in SQL or cached at booking.
  `Registration.price` stays null until `completeClass`, and the booking
  notification says the price settles after class.
- **Held:** `settings_locked` freezes whatever `ECONOMIC_FIELDS`
  (`src/lib/class-fields.ts`) lists. Adding `vatPercent` there locks it on first
  registration, which is what makes the completion-time VAT the rate students
  booked under.
- **Wrong in the issue comment: "nothing checks `roomCost + minRate ≥ 0`."**
  `Class_room_subsidy_check` and `ClassTemplate_room_subsidy_check`
  (`CHECK ("minRate" >= -"roomCost")`,
  `prisma/migrations/20260924190000_class_economics_checks/`) and
  `economicsViolations` (`src/lib/class-economics.ts`, `room_subsidy`)
  already forbid it. Total ≥ room + minRate ≥ 0, so every price is ≥ 0, and
  so is the VAT included in it. The separate fix the comment proposes is not
  needed.
- **Incomplete in the issue: "the pricing engine, the class-form pricing
  preview and the landing demo."** The preview and the demo do not use the
  engine. `PricingPreviewResult` adds `roomCost + rate` itself and splits it
  per tier with `tierPrices` (`src/lib/pricing-preview.ts`), which rounds per
  tier. VAT has to go into both formulas.
- **Not in the issue: "teacher earns" is a subtraction written four times.**
  - `billAtLeastMinimum` (`src/lib/tier-estimates.ts`) computes
    `billedCents − roomCents`, which feeds `completeClass`, its completion
    notification, and the class overview's pricing estimate.
  - `PricingBreakdown` (`src/components/class/pricing-breakdown.tsx`) computes
    `totalRevenue − roomCost`.
  - The student's "Where your payment goes" (`src/lib/payment-breakdown.ts`)
    computes the same.
  - `/settings/reporting` computes the same.

  With VAT, each copy that is not updated overstates earnings by the VAT.
- **Not in the issue: `Class.effectiveTeacherRate` stores earnings, not the
  interpolated rate,** and nothing reads it except the GDPR export (`grep -rn
  effectiveTeacherRate src | grep -v '\.test\.'`).
  - The past-class breakdown spec
    (`2026-09-14-past-class-payment-breakdown-design.md`) chose the
    subtraction over that column on purpose. Two independently rounded
    columns do not guarantee `room + earnings = total`; the subtraction does.
  - It also already disagrees with the subtraction in one case. A class
    completed with no charged registrations stores `0`, while reporting and
    `PricingBreakdown` show `0 − roomCost`. Task 1 makes that branch call the
    earnings function too (Decision 1). No live classes exist yet, so there
    are no stored rows to backfill.
- **Not in the issue: currency is the wrong pattern to copy.**
  - `Class.currency` is stamped by the server (`api/classes/route.ts`,
    `class-generator.ts`). It is in no zod schema and no form, and
    `ClassTemplate` has no currency column.
  - `vatPercent` is teacher-edited, so it follows `minRate`:
    - four zod schemas (`src/lib/schemas.ts`)
    - the three forms with their `NoneOf` pins
    - the editable-field allowlists (`TeacherEditableClassField`,
      `TeacherEditableClassTemplateField`)
    - the template→class copy in `CLASS_GENERATOR.createChildren`
- **Not in the issue: the template→class copy is an untethered literal.**
  `createChildren` (`src/services/class-generator.ts`) lists each column by
  hand. Prisma flags a missing required column but not one with a
  `@default`, so a forgotten `vatPercent` line compiles and silently stamps 0.
  Guarded by a test, below.
- **Not in the issue: reporting reads the `totalRevenue` snapshot, never
  `Payment`.** This is the #47 grace policy: a waived payment stays counted.
  Deriving reporting from `Σ(Payment.amount − vatAmount)`, one of the
  comment's two options, would quietly reverse that policy. This design keeps
  the snapshot and adds a VAT snapshot beside it.

## Decisions

1. **Extract the earnings subtraction first** into one pure function. All four
   sites call it, and so does `completeClass`'s zero-charge branch, which
   today stores `effectiveTeacherRate: 0` while every display shows
   `−roomCost`. It lands as its own task before any VAT code. The zero-charge
   value is its only behaviour change, and only the GDPR export reads that
   column.
2. **A `Class.vatTotal` snapshot** is written beside `totalRevenue` at
   completion. `totalRevenue` keeps meaning "what students were billed, incl.
   VAT", and reporting keeps its #47 semantics. Option C (derive from
   `Payment`) was rejected because it reverses #47. Option B (store
   `totalRevenue` excl. VAT) was rejected because it changes what an existing
   column means.
3. **The form preview stays a model of the rule.**
   - "You earn" is the rate as typed.
   - VAT = `withVat(room + rate) − (room + rate)`.
   - The three lines add up to the total by construction.

   Per-student rounding can leave the actual earnings a cent or two off the
   rate. That figure is shown exactly by the class overview's estimate and by
   the completion snapshot, both of which go through the engine.
4. **At 0% nothing about VAT appears anywhere**: no VAT line, no "excl./incl.
   VAT" label. The landing demo sets `vatPercent: 0` and needs no special case.
5. **An omitted `vatPercent` on create means the teacher's default**, not 0.
6. **Room-cost wording follows the VAT field.** A teacher who does not charge
   VAT cannot reclaim the room's VAT, so for them the true room cost includes
   it.

## Design

### Data model

One migration. The CHECKs are hand-authored, following
`20261011105105_teacher_default_vat_percent`.

| Column | Type | Rule |
|---|---|---|
| `ClassTemplate.vatPercent` | `Decimal(6,3) @default(0)` | `CHECK (vatPercent >= 0 AND vatPercent <= 100)` |
| `Class.vatPercent` | `Decimal(6,3) @default(0)` | same CHECK. Joins `ECONOMIC_FIELDS`, so it is locked once booked |
| `Class.vatTotal` | `Decimal(10,2)`, nullable | `CHECK (vatTotal >= 0)` and `CHECK ((vatTotal IS NULL) = (totalRevenue IS NULL))`. The migration sets `vatTotal = 0` where `totalRevenue IS NOT NULL` before adding the tether |
| `Payment.vatAmount` | `Decimal(10,2) NOT NULL @default(0)` | `CHECK (vatAmount >= 0 AND vatAmount <= amount)` |

Existing rows read 0 throughout, which is true: they were priced at an
implicit 0%.

### Arithmetic: integer cents, percentage in thousandths

`src/lib/vat.ts` gains pure helpers. A percentage of at most 3 decimals
(already enforced by `vatPercentViolation`) becomes an exact integer number of
thousandths (14.975 → 14975), so no float percentage is ever multiplied:

- `vatThousandths(percent: number): number`, which is
  `Math.round(percent × 1000)`
- `withVatCents(baseCents, t)`, which is
  `Math.round(baseCents × (100000 + t) / 100000)`
- `includedVatCents(priceCents, t)`, which is
  `Math.round(priceCents × t / (100000 + t))`

At `t = 0` the first is the identity and the second is 0.

**`src/lib/teacher-earnings.ts`**: `teacherEarningsCents({ totalCents,
roomCents, vatCents })`, which is `totalCents − roomCents − vatCents`. Task 1
introduces it without `vatCents`. Task 3 adds `vatCents` as a **required**
field, so the compiler finds every caller.

### Engine and completion

- `ClassPricingInput` gains `vatPercent: number`.
  - `totalCost` becomes `withVatCents(round(100 × (room + effectiveRate)),
    t) / 100`.
  - The largest-remainder split is unchanged.
  - Each `PricedStudent` gains `vat`, which is
    `includedVatCents(priceCents, t) / 100`.
- `billAtLeastMinimum` returns `vatCents = Σ vat` over the **billed** students
  only. Padding seats bill no one, so they carry no VAT. Its `earningsCents`
  comes from `teacherEarningsCents`.
- `completeClass`:
  - writes each `Payment.vatAmount`
  - writes `Class.vatTotal = vatCents / 100`
  - writes `effectiveTeacherRate` as the earnings above

  The zero-charge branch writes `vatTotal: 0` beside `totalRevenue: 0`, and
  `effectiveTeacherRate` via `teacherEarningsCents` (so `−roomCost`). The
  completion notification's earnings figure is excl. VAT with no copy change.
- Every type that repeats the economic fields gains `vatPercent`. The compiler
  then finds every page that builds one from a class row:
  - `TierEstimateInput`, `ResolvePriceLineInput`
  - `ClassEconomics`, `PricingPreviewInputs`

  Those pages are the public teacher page, the booking page and the student
  bookings list. Each adds `vatPercent` to its `select`. The two hand-written
  economics `select`s in `class-lifecycle.ts` (the `updateClass` merge) and
  `class-template-lifecycle.ts` (the child-update gate) gain it too.

### Wire, forms, pre-fill

- **Wire:**
  - `vatPercent` joins `createClassSchema`, `updateClassSchema`,
    `createClassTemplateSchema` and `updateClassTemplateSchema` as a JSON
    number.
  - It is validated by `vatPercentViolation`, so the copy matches the profile
    field.
  - It is optional on create. If omitted, the create route and
    `createClassTemplate` use the teacher's `defaultVatPercent`, read in the
    same teacher lookup that already supplies currency.
  - `vatPercent` joins both editable-field allowlists.
- **Generator:** `createChildren` stamps `vatPercent: template.vatPercent`.
  Editing a template's VAT changes only classes generated afterwards (#194: a
  template is a stamp).
- **Pre-fill:**
  - `class/new` and `settings/recurring/new` read `defaultVatPercent` and pass
    it to seed `INITIAL_FORM`.
  - The two edit pages pass the row's own value. A later change to the profile
    default touches nothing that exists.
- **The field:**
  - `VAT %`, directly after room cost, in all three forms.
  - Hint: *Included in student prices. Use 0 if you don't charge VAT.*
  - It is locked on a booked class like the other economic fields.
  - The preview's economics gate also stays closed while `vatPercentViolation`
    is non-null.
- **Conditional wording when the form's VAT > 0:**
  - The room cost label becomes `Room cost excl. VAT (€)`, with the hint *You
    reclaim the room's VAT in your own VAT return.*
  - The minimum and target rate labels gain `excl. VAT`.
  - At 0% the labels read as today.
- **Room settings:** `Rental rate` in the three room forms gets one static
  hint, *If you charge VAT, enter it excl. VAT.*

### Displays

Each display below shows its VAT lines and labels only when the class's
`vatPercent > 0`.

| Display | At > 0% |
|---|---|
| Form preview (`PricingPreviewResult`) | `You earn (excl. VAT)` (the rate) · `Room cost (excl. VAT)` · `VAT (9%)` · `Total class cost`; tier table headed `What students pay (incl. VAT)` |
| Overview estimate (`PricingPreview`) | `Estimated earnings (excl. VAT)` from `billAtLeastMinimum`; a `VAT` line from its `vatCents`; the rate range labelled excl. VAT; per-tier prices incl. VAT |
| After completion (`PricingBreakdown`) | `Your earnings (excl. VAT)` via `teacherEarningsCents`; `Room cost`; `VAT` from `vatTotal`; `Total revenue (incl. VAT)` |
| Student "Where your payment goes" | a `VAT` line between Room and Teacher, from `vatTotal`; Teacher via `teacherEarningsCents`, so Room + VAT + Teacher = Class total. The student's own `vatAmount` is not shown |
| Reporting | earnings via `teacherEarningsCents`, hence excl. VAT. No VAT total shown (stored for a later VAT report) |

Student-facing price ranges before the class, payment amounts, the pay page and
emails are totals. They include VAT once the engine does and carry no new
label.

### Export, seed, docs

- **GDPR export (`src/services/gdpr.ts`):**
  - Teacher export classes gain `vatPercent` and `vatTotal` in their explicit
    field list. Templates spread their row, so `vatPercent` arrives on its own.
  - The student export's payment select gains `vatAmount`.
- **Seed (`prisma/seed.ts`):**
  - **Required:** both completed-class writers set `vatTotal`, or the tether
    CHECK refuses the seed.
  - Ivo (EUR) gets `defaultVatPercent: 9`. Sarah (GBP) and Maya (USD) stay
    at 0.
  - Ivo's recurring template is at 9%.
  - One upcoming Ivo class is at 21%, as the override.
  - One completed Ivo class is at 9%. Its registration prices, `vatAmount`s,
    `vatTotal` and earnings come from calling `billAtLeastMinimum`, not
    hand-typed literals.
  - Ivo's existing completed classes stay at 0%, so their literals remain
    valid.
- **Docs:**
  - `docs/product-concept.md` (Income-Based Pricing Engine) gains the VAT
    formula, the per-student rule, and the issue's worked example: room €30 +
    rate €80 = €110, VAT 9% = €9.90, total €119.90.
  - `docs/data-model.md` gains rows for the four columns.

## Testing

**Regression proof at 0%:** no existing money expectation changes. That covers
the pricing, completion, breakdown and reporting tests, the e2e
`€3.68 – €15.56` booking price, and the visual snapshots of 0% data. An edited
money expectation is a review finding, not a fix.

New tests by layer:

- **Unit, `vat.ts`:**
  - the helpers at `t = 0`
  - `withVatCents(11000, 9000) = 11990`
  - 14.975 and 8.1 convert exactly
  - included VAT ≤ price across a sweep of prices
- **Unit, engine:**
  - the issue's example
  - Σ prices = total to the cent
  - |Σ vat − total × t/(100000+t)| ≤ ½ cent × students
  - `billAtLeastMinimum` sums VAT over billed students only
- **Unit, `teacherEarningsCents`:** the subtraction, including a negative
  result.
- **Service/DB, `completeClass`:**
  - `vatAmount` on each payment
  - `vatTotal = Σ vatAmount`
  - `effectiveTeacherRate` = earnings
  - the zero-charge branch writes `vatTotal: 0`
- **Integration, API:**
  - create without `vatPercent` → the teacher's default; with it → that value
  - `"9"`, `-1` and `8.1234` → 400
  - editing `vatPercent` on a booked class → 409 `SETTINGS_LOCKED`
  - a template VAT edit reaches newly generated classes and leaves existing
    ones alone
- **Components:**
  - the three forms pre-fill from the prop and switch the labels at > 0%
  - each display renders unchanged at 0% and with its VAT lines at 9%
- **Seed:** `prisma db seed` runs clean against the worktree database.
- **Visual snapshots:** the plan measures which Playwright snapshots render
  seeded Ivo data before deciding to re-baseline or point them at a 0%
  teacher.

**Guards, each broken once with the failure text recorded:**
1. `vatPercent` CHECK on `Class` and on `ClassTemplate`: 100.001.
2. The `vatTotal` ↔ `totalRevenue` tether: completion with `vatTotal` null.
3. `vatAmount <= amount`.
4. Generator stamping: drop `vatPercent: template.vatPercent`, so a 9%
   template stamps a 0% class.
5. `ECONOMIC_FIELDS` membership: drop `vatPercent`, so a booked class's VAT
   becomes editable.
6. Server default: drop the fallback, so an omitted field stamps 0.
7. VAT on billed seats only: sum over the padded `pricing.students` instead
   of `billed`.

## Task shape

The order is load-bearing:

1. Extract `teacherEarningsCents`. The only expectation change allowed is the
   zero-charge branch's `effectiveTeacherRate`, which goes from 0 to
   `−roomCost`.
2. Schema, migration, CHECKs, and the `vat.ts` helpers.
3. Engine, `billAtLeastMinimum`, and `completeClass` writing VAT. This makes
   `vatCents` required on the earnings function.
4. Wire and forms together, because the `NoneOf` pins tie each form's values to
   its zod schema both ways. This covers schemas, allowlists, the server
   default, generator stamping, `ECONOMIC_FIELDS`, the three forms, pre-fill
   and the room-settings hint.
5. Displays.
6. GDPR export, seed, docs.

## Out of scope

- Invoices, VAT reports, VAT returns, per-country presets (the issue).
- Studio classes: no pricing engine; their income is invoiced business to
  business (the issue).
- Showing `Payment.vatAmount` or a VAT total anywhere (the issue comment:
  store, don't show yet).
- The `roomCost + minRate ≥ 0` fix the issue comment proposes. It already
  exists (see Premise check).
