# Price-line unification (#433)

## Premise, verified against the running code

#433 asked two open questions about the teacher's public schedule and the
student's bookings overview. A brainstorm on the issue (2026-09-11) already
resolved the direction; this spec is the design for building it. Verified
directly against the current tree (`ec5a484d`):

- **Public schedule card** (`src/app/(public)/[slug]/page.tsx:150-156`): a
  booked or waitlisted class's price paragraph is **replaced** by a `✓ Booked`
  / `On the waitlist` line (#31). An unbooked card always shows the
  tier-spread `PriceRange`, even for a signed-in student whose tier is already
  settled — #33 never reached this page.
- **Booking page** (`.../book/[classId]/page.tsx:157-175`): already the one
  place implementing the full rule — `PersonalPriceRange` once
  `viewer.tierSelectedAt` is set and a `quotedTier` resolves (own registration's
  stamped tier if booked, else the profile tier), `PriceRange` otherwise. This
  page needs no behavior change, only extraction so the other two pages stop
  duplicating it.
- **Bookings overview** (`src/app/(student)/bookings/page.tsx`, "Upcoming"
  section, lines 213-259): no progress bar, no price line, no link back to the
  class at all — confirmed absent. The nested `_count.registrations` at line
  47 has no status filter, so it counts `cancelled` and `late_cancel` rows
  too; nothing currently reads that count for display, so the bug is latent
  until this issue starts using it.

## Decision (from the issue)

**One price-line rule on every page.** Which line a student sees depends only
on whether their tier is known — never on whether they've booked:

- Tier known → `PersonalPriceRange`: "€X – €Y depending on how many join"
- Tier unknown (signed out, or before choosing a tier) → `PriceRange`: "€X –
  €Y depending on your income tier"

`✓ Booked` / `On the waitlist` become **labels alongside** the price line,
not a replacement — this reverses the "replace" half of #31's decision (the
booked-state visibility #31 introduced stays).

This also finishes what #33 left open: "a signed-in student with a known tier
who hasn't booked" now gets the personal range on the public schedule card
too, not only on the booking page.

| Page | Change |
|---|---|
| Public schedule card | Booked/waitlist label + price line (personal or anonymous, per the rule above), always. |
| Booking page | None — already follows the rule. Extract its logic to shared code. |
| Bookings overview, upcoming | Add: registration progress bar, price line, link to the booking page. Waitlist rows get the same three. |
| Bookings overview, past | Unchanged (final amount stands; the breakdown behind it is #576). |

### Resolved design details (not stated in the issue)

- **Label placement**: the booked/waitlist label renders as its own short
  teal `type-label` line, directly above the price line — two stacked lines,
  same structural slot the price line already occupies. Not merged into one
  sentence: the label and the price are different kinds of fact (a state vs.
  an estimate) and the existing payment-status convention on this codebase
  already keeps state text separate from amount text (`✓ Paid` vs the number
  beside it, `bookings/page.tsx:279-285`).
- **Bookings overview "link to the booking page"**: a small `type-label
  text-teal` text link, **not** a wrapped card — the card already nests an
  interactive control (`CancelBookingButton` / `WaitlistEntryActions`), and
  nesting an anchor around a button is invalid HTML and breaks hydration.
  Label: "View class →", pointing at `/${teacher.pageSlug}/book/${cls.id}`.

## Architecture: one shared resolver, one shared renderer

Both are new, and both live beside the existing `price-range.tsx` /
`tier-estimates.ts` pair they wrap — no new top-level module.

**`src/lib/price-line.ts`** (pure, framework-agnostic, unit-testable exactly
like `tier-estimates.test.ts`):

```ts
export type PriceLineResult =
  | { kind: 'personal'; spread: AttendanceSpread }
  | { kind: 'anonymous'; estimates: TierPrices };

export interface ResolvePriceLineInput {
  roomCost: number; minRate: number; targetRate: number;
  minStudents: number; maxStudents: number;
  /** Charged-status registrations for this class (registered/attended/no_show/late_cancel). */
  registrations: { id: string; studentId: string; tierAtBooking: number }[];
  /** null when signed out, or signed in without a student profile. */
  viewer: { studentId: string; tier: IncomeTier | null; tierSelectedAt: Date | null } | null;
}

export function resolvePriceLine(input: ResolvePriceLineInput): PriceLineResult
```

Behavior (lifted verbatim from the booking page's existing branch, so this is
an extraction, not a rewrite):

1. `ownRegistration = registrations.find(r => r.studentId === viewer?.studentId) ?? null`.
2. `quotedTier = ownRegistration ? readIncomeTier(ownRegistration.tierAtBooking, { registrationId: ownRegistration.id }) : viewer?.tier ?? null`.
   `readIncomeTier`, not `toIncomeTier` — same reasoning the booking page's
   comment already states (#158): a personal claim must not be built on a
   silently-substituted tier.
3. If `viewer?.tierSelectedAt` is set **and** `quotedTier !== null`: `personal`,
   via `estimateAttendanceSpread` with `registrations` minus `ownRegistration`
   (mapped through `toIncomeTier` — an aggregate over *other* people tolerates
   the substitution) and `viewerTier: quotedTier`.
4. Otherwise: `anonymous`, via `estimateTierPrices` with `registrations` minus
   `ownRegistration` (mapped through `toIncomeTier`). Final-review fix: this
   was drafted unfiltered, on the reasoning that it "matches today's
   booking-page behavior when `alreadyBooked` is true but `tierSelectedAt` is
   still null" — but that behavior was itself a double-count bug (the viewer's
   own row counted once in the pool and again as `estimateTierPrices`'
   internal +1 joiner), and this issue newly routes the public schedule page
   and the bookings overview through the same anonymous branch, so the bug
   would have shipped in two more places with no prior justification for
   leaving it. Found and fixed during final review; `resolvePriceLine` now
   excludes `ownRegistration` on both branches.

**`src/components/booking/price-line.tsx`** (or added to `price-range.tsx` —
implementer's call, whichever keeps the file cohesive):

```tsx
export function ClassPriceLine({ line, className }: { line: PriceLineResult; className?: string }) {
  return line.kind === 'personal'
    ? <PersonalPriceRange spread={line.spread} className={className} />
    : <PriceRange estimates={line.estimates} className={className} />;
}
```

`PriceRange` and `PersonalPriceRange` keep their existing exports and props —
no call site outside this refactor is touched.

## Per-page changes

**Booking page** (`.../book/[classId]/page.tsx`): replace lines 61-70 and
93-175's tier/quotedTier/branch logic with one `resolvePriceLine` call feeding
one `<ClassPriceLine>`. `openPaymentsCount`, `guestTeacher`, `ticketEmail` and
the rest of `BookingFlow`'s props are unaffected. This task's tests are
**regression-only**: every existing e2e/integration assertion about this page
must still pass unchanged, because the rule doesn't change here.

**Public schedule card** (`[slug]/page.tsx`): the per-class query needs
`tierAtBooking` and `studentId` added to the existing `registrations` select
(both cheap — same row already fetched). Fetch the viewer's `tier` +
`tierSelectedAt` once (a single `Student` read alongside the existing
own-registration/waitlist queries, guarded by the same `session?.studentId`
check). Per card: call `resolvePriceLine`, keep the existing
`bookedClassIds`/`waitingClassIds` lookups for the label, and render the label
(if any) followed by `<ClassPriceLine>` — never in place of it.

**Bookings overview** (`bookings/page.tsx`):
- Fix the count bug: the nested `registrations` under `class` (for the
  Upcoming section) needs a `status: { in: [...ACTIVE_REGISTRATION_STATUSES] }`
  filter feeding the progress bar's `registered` prop, replacing the
  unfiltered `_count`. Test-first: a fixture with a cancelled or late-cancelled
  registration on the class must not inflate the bar.
- Also select `tierAtBooking` alongside on the same nested `registrations`
  (need the full charged-status pool for `resolvePriceLine`, which is a
  superset of `ACTIVE_REGISTRATION_STATUSES` — see `registration-status.ts`'s
  docblock on why the two sets differ by exactly `late_cancel`). Fetch it with
  `status: { in: CHARGED_STATUSES }` (from `services/class-lifecycle.ts`) and
  derive the active count client-side from that same list rather than a
  second query, mirroring how the public schedule card already computes
  `activeCount` off one fetched list.
- Add `<RegistrationProgress>`, `<ClassPriceLine>` (viewer here is always the
  signed-in student themselves — `reg` already names their own row, so
  `resolvePriceLine`'s `ownRegistration` lookup will find it), and the "View
  class →" link to each Upcoming card.
- Waitlist rows: add the same three. The nested `class` query there currently
  selects `_count` only for capacity math (`canClaim`) — extend it with the
  same `registrations` (tierAtBooking, studentId, status) selection so
  `resolvePriceLine` has a pool. A waitlist entry has no backing `Registration`
  row, so `ownRegistration` resolves to `null` inside `resolvePriceLine` and
  `quotedTier` falls back to the viewer's profile tier — already-verified
  behavior, since this is exactly what the booking page does today for a
  waitlisted, known-tier viewer.

## Test impact — what's already wrong today and must be corrected, not just extended

Per CLAUDE.md's Comment/claim discipline extended to tests: a behavior change
must fix every place that pinned the *old* behavior, not just add coverage for
the new one. Swept every `page.goto(\`/${slug}\`)` and `/bookings` visit across
`tests/e2e/*.spec.ts` combined with a price-line or booked/waitlist assertion:

- **`booking.spec.ts:437-439`** — after a booking, the fixture's student now
  has `tierSelectedAt` set (`after.tierSelectedAt` asserted at line 428).
  Under the new rule *every* class card for this student on `/${slug}` shows
  the personal range (both the booked class and the still-unbooked
  `secondClassId`) — the `depending on your income tier` count-1 assertion is
  the **old** rule and must become 0, with a new assertion that `depending on
  how many join` is now visible (count depends on how many open classes this
  fixture's teacher has — verify against the fixture, don't guess). The anon
  view two lines down (445-447) is unaffected: anonymous visitors never have a
  known tier.
- **`student-journey.spec.ts:229-231`** — Bram, known tier (`tierSelectedAt`
  set at fixture setup, line 104), just left the waitlist. The assertion
  `depending on your income tier` visible is the **old** rule's leftover; his
  tier is known, so the card shows `depending on how many join` instead. Fix
  the assertion to check for the personal-range copy.
- **`student-journey.spec.ts:255-257`** — same fixture, Alice (also known
  tier) just cancelled. Same correction: her unbooked card now shows
  `depending on how many join`, not `depending on your income tier`.
- **`student-journey.spec.ts:217-218`** (Bram, waitlisted) — the assertion
  happens to still hold under the new rule (`depending on your income tier`
  count 0), but for a different reason: previously the label replaced the line
  entirely, now it's replaced by the personal line existing alongside the
  label. Strengthen it to also assert `depending on how many join` is now
  visible, so the test proves the new behavior rather than merely failing to
  disprove it.
- **`student-journey.spec.ts:274-276`** (Bram promoted to booked) — assertions
  hold as-is (`✓ Booked` visible, `On the waitlist` count 0); optionally
  strengthen with a personal-range assertion for the same reason as above.
- **`magic-link-handoff.spec.ts:273`** and **`booking.spec.ts:145,165,328`** —
  all on the booking sub-page, which doesn't change behavior. Regression-only;
  should keep passing unchanged once the extraction lands.
- **`a11y.spec.ts:246`**, **`visual.spec.ts:354`** — anonymous visits to
  `/${slug}`; unaffected by the rule (anonymous visitors have no tier), but
  `visual.spec.ts`'s screenshot may still shift if the booked/waitlist-label
  markup changes anonymous-view spacing — it shouldn't, since anonymous
  visitors never see the label, but re-run it to confirm rather than assume.

New coverage to add (test-first, per task):
- Unit tests for `resolvePriceLine` in `src/lib/price-line.test.ts`: unknown
  tier → anonymous; known tier + not booked → personal at profile tier; known
  tier + booked → personal at the *stamped* registration tier, pool excludes
  self; `tierSelectedAt` null despite an existing booking → anonymous
  (existing edge case, pin it so the extraction can't silently change it);
  corrupt own-registration tier (`readIncomeTier` → null) → anonymous even
  with `tierSelectedAt` set.
- Integration test (extend or sibling of `tests/integration/bookings-page.test.ts`)
  for the Upcoming section: a cancelled/late-cancelled registration on the
  class must not inflate the progress bar's count; the price line renders
  personal vs. anonymous per the student's `tierSelectedAt`.
- e2e: extend the existing waitlist/cancel flows above rather than adding new
  tests, since they already exercise every transition this issue touches.

## Out of scope / accepted (from the issue, restated for the record)

- **Teacher-side tier inference**: accepted — the teacher already sees who's
  in which tier via payments. `docs/product-concept.md` was already reworded
  to match; unaffected by this change.
- **Student-to-student inference**: judged low risk in the issue's own
  measurement (needs a known booker, a before/after view, no intervening
  booking). This issue doesn't add a new before/after surface — the personal
  line is about the *viewer's own* price, not a per-tier breakdown of others —
  so it doesn't change that risk.
- **#158** (corrupted stored tier): already correctly handled by the
  `readIncomeTier`/`toIncomeTier` split this spec's `resolvePriceLine` reuses
  verbatim — not reopened here.
- **#576** (past-classes payment breakdown): untouched; the past section of
  `bookings/page.tsx` is not part of this issue.
