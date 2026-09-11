# Price-line unification (#433) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One price-line rule — personal range once a student's tier is known,
anonymous range otherwise, on every page that shows a class card — with
booked/waitlist state shown as a label alongside the price, never replacing
it.

**Architecture:** Extract the booking page's existing tier-known/unknown
branch into a pure resolver (`resolvePriceLine`) and a tiny rendering
component (`ClassPriceLine`), then wire both into the two pages that don't
yet follow the rule: the public schedule card and the student's bookings
overview. The booking page itself only gets refactored to call the shared
code — its behavior does not change.

**Tech Stack:** Next.js 16 App Router server components, Prisma, TypeScript
strict, Vitest (unit + integration projects), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-11-price-line-unification-design.md`

## Global Constraints

- Tier-known check is always `viewer.tierSelectedAt !== null && quotedTier !== null` — never substitute `toIncomeTier`'s median for a personal claim; use `readIncomeTier` and let `null` force the anonymous branch (spec, "Architecture").
- `quotedTier` is the viewer's *own* stamped registration tier when they have an active/charged registration on the class, else their profile tier — resolved once, in `resolvePriceLine`, not re-derived per page.
- Booked/waitlist state is a **label alongside** the price line, never a replacement, on every page (spec, "Decision").
- The booking page's rendered output must not change — Task 1 is a pure extraction, proven by the existing e2e/integration suite staying green unchanged.
- No new top-level module: `resolvePriceLine` lives beside `tier-estimates.ts` in `src/lib/`, `ClassPriceLine` lives beside `PriceRange`/`PersonalPriceRange` in `src/components/booking/price-range.tsx`.

---

## File Structure

- Create: `src/lib/price-line.ts` — `resolvePriceLine`, pure, framework-agnostic.
- Create: `src/lib/price-line.test.ts` — unit tests for the resolver.
- Modify: `src/components/booking/price-range.tsx` — add `ClassPriceLine`.
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx` — use the shared resolver/renderer (Task 1).
- Modify: `src/app/(public)/[slug]/page.tsx` — wire the rule onto the public schedule card (Task 2).
- Modify: `tests/e2e/booking.spec.ts`, `tests/e2e/student-journey.spec.ts` — correct assertions the new rule falsifies (Task 2).
- Modify: `src/app/(student)/bookings/page.tsx` — active-count fix, progress bar, price line, link (Task 3).
- Modify: `tests/integration/bookings-page.test.ts` — new coverage for the above (Task 3).

---

### Task 1: Extract `resolvePriceLine` / `ClassPriceLine`, refactor the booking page onto it

**Files:**
- Create: `src/lib/price-line.ts`
- Create: `src/lib/price-line.test.ts`
- Modify: `src/components/booking/price-range.tsx`
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx:61-70,93-175`

**Interfaces:**
- Produces: `resolvePriceLine(input: ResolvePriceLineInput): PriceLineResult` and `ResolvePriceLineInput`, `PriceLineResult` types, from `@/lib/price-line`. Consumed by Tasks 2 and 3.
- Produces: `ClassPriceLine({ line, className }: { line: PriceLineResult; className?: string })` from `@/components/booking/price-range`. Consumed by Tasks 2 and 3.

- [ ] **Step 1: Write the failing unit tests for `resolvePriceLine`**

Create `src/lib/price-line.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolvePriceLine } from './price-line';

const BASE = {
  roomCost: 40,
  minRate: 20,
  targetRate: 120,
  minStudents: 4,
  maxStudents: 8,
};

describe('resolvePriceLine', () => {
  it('returns anonymous when the viewer is signed out', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: null,
    });
    expect(result.kind).toBe('anonymous');
  });

  it('returns anonymous when the viewer has not chosen a tier yet', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: { studentId: 's1', tier: 3, tierSelectedAt: null },
    });
    expect(result.kind).toBe('anonymous');
  });

  it('returns personal at the profile tier when the tier is known and the viewer has not booked', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'r1', studentId: 'other', tierAtBooking: 3 },
      ],
      viewer: { studentId: 's1', tier: 4, tierSelectedAt: new Date() },
    });
    expect(result.kind).toBe('personal');
  });

  it('returns personal at the STAMPED registration tier, not the current profile tier, once booked', () => {
    const bookedAtTier1 = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'own', studentId: 's1', tierAtBooking: 1 },
      ],
      // Profile tier has since changed to 5 — must not leak into the quote.
      viewer: { studentId: 's1', tier: 5, tierSelectedAt: new Date() },
    });
    const anonymousAtTier1 = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: { studentId: 's1', tier: 1, tierSelectedAt: new Date() },
    });
    expect(bookedAtTier1.kind).toBe('personal');
    expect(anonymousAtTier1.kind).toBe('personal');
    if (bookedAtTier1.kind === 'personal' && anonymousAtTier1.kind === 'personal') {
      // Same viewer tier (1), same otherwise-empty pool -> same spread,
      // proving the own registration was excluded from the pool and its
      // stamped tier (not the profile's) was quoted.
      expect(bookedAtTier1.spread).toEqual(anonymousAtTier1.spread);
    }
  });

  it('falls back to anonymous when the own registration tier is corrupt (#158)', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'own', studentId: 's1', tierAtBooking: 99 },
      ],
      viewer: { studentId: 's1', tier: 3, tierSelectedAt: new Date() },
    });
    expect(result.kind).toBe('anonymous');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/price-line.test.ts`
Expected: FAIL — `Cannot find module './price-line'` (the module does not exist yet).

- [ ] **Step 3: Write `resolvePriceLine`**

Create `src/lib/price-line.ts`:

```ts
import { estimateTierPrices, estimateAttendanceSpread, type TierPrices, type AttendanceSpread } from '@/lib/tier-estimates';
import { readIncomeTier, toIncomeTier } from '@/lib/tiers.server';
import type { IncomeTier } from '@/lib/tiers';

export type PriceLineResult =
  | { kind: 'personal'; spread: AttendanceSpread }
  | { kind: 'anonymous'; estimates: TierPrices };

export interface PriceLineRegistration {
  id: string;
  studentId: string;
  tierAtBooking: number;
}

export interface PriceLineViewer {
  studentId: string;
  tier: IncomeTier | null;
  tierSelectedAt: Date | null;
}

export interface ResolvePriceLineInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** Charged-status registrations for this class (registered/attended/no_show/late_cancel). */
  registrations: PriceLineRegistration[];
  /** null when signed out, or signed in without a student profile. */
  viewer: PriceLineViewer | null;
}

/**
 * One price-line rule for every surface that shows a class card: personal
 * range once the viewer's tier is settled, anonymous range otherwise —
 * never keyed on whether they've booked. See
 * docs/superpowers/specs/2026-09-11-price-line-unification-design.md.
 */
export function resolvePriceLine(input: ResolvePriceLineInput): PriceLineResult {
  const { roomCost, minRate, targetRate, minStudents, maxStudents, registrations, viewer } = input;

  const ownRegistration = viewer
    ? (registrations.find((r) => r.studentId === viewer.studentId) ?? null)
    : null;

  // A claim about THIS person's price must not be built on a silently
  // substituted tier (#158) — readIncomeTier, not toIncomeTier.
  const quotedTier = ownRegistration
    ? readIncomeTier(ownRegistration.tierAtBooking, { registrationId: ownRegistration.id })
    : (viewer?.tier ?? null);

  if (viewer?.tierSelectedAt && quotedTier !== null) {
    const spread = estimateAttendanceSpread({
      roomCost,
      minRate,
      targetRate,
      minStudents,
      maxStudents,
      registeredTiers: registrations
        .filter((r) => r !== ownRegistration)
        .map((r) => toIncomeTier(r.tierAtBooking, { registrationId: r.id })),
      viewerTier: quotedTier,
    });
    return { kind: 'personal', spread };
  }

  const estimates = estimateTierPrices({
    roomCost,
    minRate,
    targetRate,
    minStudents,
    maxStudents,
    registeredTiers: registrations.map((r) => toIncomeTier(r.tierAtBooking, { registrationId: r.id })),
  });
  return { kind: 'anonymous', estimates };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/price-line.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add `ClassPriceLine` to `price-range.tsx`**

Append to `src/components/booking/price-range.tsx`:

```tsx
import type { PriceLineResult } from '@/lib/price-line';

interface ClassPriceLineProps {
  line: PriceLineResult;
  className?: string;
}

// Renders whichever variant resolvePriceLine picked — the one place that
// switches on `line.kind`, so no page duplicates the branch.
export function ClassPriceLine({ line, className }: ClassPriceLineProps) {
  return line.kind === 'personal'
    ? <PersonalPriceRange spread={line.spread} className={className} />
    : <PriceRange estimates={line.estimates} className={className} />;
}
```

- [ ] **Step 6: Refactor the booking page onto the shared resolver — no behavior change**

In `src/app/(public)/[slug]/book/[classId]/page.tsx`:

Replace the import block's `PriceRange, PersonalPriceRange` import with:

```ts
import { ClassPriceLine } from '@/components/booking/price-range';
import { resolvePriceLine } from '@/lib/price-line';
```

Replace lines 93-120 (the `viewer`, `ownRegistration`, `alreadyBooked`, `quotedTier` block) — keep `viewer`, `ownRegistration`, and `alreadyBooked` exactly as they are (still needed by `BookingFlow`'s props and `openPaymentsCount`), but delete the now-redundant `quotedTier` const — it moves inside `resolvePriceLine`.

Replace the JSX at lines 157-175:

```tsx
      <ClassPriceLine
        line={resolvePriceLine({
          roomCost: Number(cls.roomCost),
          minRate: Number(cls.minRate),
          targetRate: Number(cls.targetRate),
          minStudents: cls.minStudents,
          maxStudents: cls.maxStudents,
          registrations: cls.registrations,
          viewer: viewer ? { studentId: viewer.id, tier: viewer.tier, tierSelectedAt: student!.tierSelectedAt } : null,
        })}
        className="mt-2 mb-6"
      />
```

Note: `viewer.tier` is already `readIncomeTier(student.incomeTier, ...)` from line 94 — reuse it rather than re-reading. `student!.tierSelectedAt` — `student` is non-null whenever `viewer` is (the ternary that builds `viewer` on line 93-95 only fires when `student` is truthy), so the `!` is safe there; alternatively restructure `viewer` to carry `tierSelectedAt` directly to avoid the assertion — implementer's call, keep whichever reads clearer.

The now-unused `estimates` top-level const (lines 61-70) and its imports (`estimateTierPrices`) can be deleted if nothing else on the page reads `estimates` — check the full file for other references (`BookingFlow`'s `tierPrices={estimates}` prop at line 184 **does** still need it, so keep the top-level `estimates` const and its import; only the inline `PriceRange`/`PersonalPriceRange` JSX branch is replaced).

- [ ] **Step 7: Typecheck and run the booking page's existing regression coverage**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run (worktree app must be up — `pnpm run worktree:up` if not already):
`pnpm exec vitest run --project integration` (full integration tier — this page has no dedicated integration test file per the earlier sweep, but registrations/booking-flow integration tests exercise the same route)
Expected: PASS, unchanged pass count from before this task.

Run: `pnpm exec playwright test tests/e2e/booking.spec.ts tests/e2e/magic-link-handoff.spec.ts`
Expected: PASS, unchanged — this task must not move any of these assertions. (`INTEGRATION_BASE_URL` is read automatically once `pnpm run worktree:up` has run.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/price-line.ts src/lib/price-line.test.ts src/components/booking/price-range.tsx "src/app/(public)/[slug]/book/[classId]/page.tsx"
git commit -m "refactor(booking): extract resolvePriceLine/ClassPriceLine from the booking page"
```

---

### Task 2: Wire the rule onto the public schedule card

**Files:**
- Modify: `src/app/(public)/[slug]/page.tsx`
- Modify: `tests/e2e/booking.spec.ts:437-439`
- Modify: `tests/e2e/student-journey.spec.ts:217-218,229-231,255-257`

**Interfaces:**
- Consumes: `resolvePriceLine`, `ResolvePriceLineInput` from `@/lib/price-line`; `ClassPriceLine` from `@/components/booking/price-range` (Task 1).

- [ ] **Step 1: Extend the class query and add a viewer-profile read**

In `src/app/(public)/[slug]/page.tsx`, extend the `registrations` select at
lines 62-65 to include `studentId`:

```ts
      registrations: {
        where: { status: { in: ['registered', 'attended', 'no_show', 'late_cancel'] } },
        select: { id: true, tierAtBooking: true, status: true, studentId: true },
      },
```

Extend the `session?.studentId` block (lines 71-88) to also fetch the
viewer's tier/tierSelectedAt once, alongside the existing own-registration and
waitlist queries:

```ts
  const session = await getSession();
  let bookedClassIds = new Set<string>();
  let waitingClassIds = new Set<string>();
  let viewer: { studentId: string; tier: IncomeTier | null; tierSelectedAt: Date | null } | null = null;
  if (session?.studentId && classes.length > 0) {
    const classIds = classes.map((c) => c.id);
    const [own, waiting, student] = await Promise.all([
      prisma.registration.findMany({
        where: { studentId: session.studentId, classId: { in: classIds }, status: 'registered' },
        select: { classId: true },
      }),
      prisma.waitlistEntry.findMany({
        where: { studentId: session.studentId, classId: { in: classIds }, status: 'waiting' },
        select: { classId: true },
      }),
      prisma.student.findUniqueOrThrow({
        where: { id: session.studentId },
        select: { incomeTier: true, tierSelectedAt: true },
      }),
    ]);
    bookedClassIds = new Set(own.map((r) => r.classId));
    waitingClassIds = new Set(waiting.map((w) => w.classId));
    viewer = {
      studentId: session.studentId,
      tier: readIncomeTier(student.incomeTier, { studentId: session.studentId }),
      tierSelectedAt: student.tierSelectedAt,
    };
  }
```

Add `readIncomeTier` and `IncomeTier` to the existing `@/lib/tiers.server` /
new `@/lib/tiers` imports at the top of the file (the file already imports
`toIncomeTier` from `@/lib/tiers.server` at line 15 — add `readIncomeTier` to
that same import line; add `import type { IncomeTier } from '@/lib/tiers';`).
Also add:

```ts
import { resolvePriceLine } from '@/lib/price-line';
import { ClassPriceLine } from '@/components/booking/price-range';
```

- [ ] **Step 2: Render the label alongside the price line, never in place of it**

Replace lines 150-156:

```tsx
                {(bookedClassIds.has(cls.id) || waitingClassIds.has(cls.id)) && (
                  <p className="type-label text-teal mt-2">
                    {bookedClassIds.has(cls.id) ? '✓ Booked' : 'On the waitlist'}
                  </p>
                )}
                <ClassPriceLine
                  line={resolvePriceLine({
                    roomCost: Number(cls.roomCost),
                    minRate: Number(cls.minRate),
                    targetRate: Number(cls.targetRate),
                    minStudents: cls.minStudents,
                    maxStudents: cls.maxStudents,
                    registrations: cls.registrations,
                    viewer,
                  })}
                  className={bookedClassIds.has(cls.id) || waitingClassIds.has(cls.id) ? 'mt-1' : 'mt-2'}
                />
```

(Tighter top margin when the label is present, since the label already
carries its own bottom spacing via line-height — matches the existing `mt-2`
default when there's no label above it.)

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the affected e2e specs to see the now-outdated assertions fail**

Run: `pnpm exec playwright test tests/e2e/booking.spec.ts tests/e2e/student-journey.spec.ts`
Expected: FAIL — specifically the assertions the spec's "Test impact" section named:
`booking.spec.ts` around line 439 (`depending on your income tier` count no
longer 1), and `student-journey.spec.ts` around lines 230-231 and 256-257
(`depending on your income tier` no longer visible for a known-tier student).
Read the failure diffs — they show the actual rendered text, which is what
Step 5 pins.

- [ ] **Step 5: Correct the outdated assertions to the new, verified behavior**

In `tests/e2e/booking.spec.ts`, replace lines 437-439:

```ts
    // The teacher page now shows a price line on every card, personal or
    // anonymous depending on the viewer's own tier — booked/unbooked no
    // longer decides which line renders (#433).
    await page.goto(`/${slug}`);
    await expect(page.getByText('✓ Booked')).toHaveCount(1);
    await expect(page.getByText(/depending on your income tier/)).toHaveCount(0);
    await expect(page.getByText(/depending on how many join/).first()).toBeVisible();
```

(Do not hand-pick an exact count for `depending on how many join` unless the
Step 4 failure diff showed exactly how many open classes this fixture's
teacher has on `/${slug}` — assert `.first()` visibility if more than one
class card can legitimately show it, matching the style already used at line
328 for the analogous case on the booking page.)

In `tests/e2e/student-journey.spec.ts`, replace lines 217-218:

```ts
    await expect(page.getByText('On the waitlist')).toBeVisible();
    await expect(page.getByText(/depending on your income tier/)).toHaveCount(0);
    // Bram's tier is already known (fixture, line ~104) — the personal
    // range shows alongside the waitlist label now, not nothing (#433).
    await expect(page.getByText(/depending on how many join/)).toBeVisible();
```

Replace lines 229-231:

```ts
    // A removed entry is not "on the waitlist" — the card quotes a price
    // again. Bram's tier is known, so it's the personal range, not the
    // tier-spread one (#433).
    await page.goto(`/${slug}`);
    await expect(page.getByText('On the waitlist')).toHaveCount(0);
    await expect(page.getByText(/depending on how many join/)).toBeVisible();
```

Replace lines 255-257:

```ts
    // Her card drops the booked line the moment the registration is
    // cancelled — the price range is the honest state again. Alice's tier
    // is known, so it's the personal range (#433).
    await page.goto(`/${slug}`);
    await expect(page.getByText('✓ Booked')).toHaveCount(0);
    await expect(page.getByText(/depending on how many join/)).toBeVisible();
```

Leave lines 274-276 unchanged — those assertions (`✓ Booked` visible, `On the
waitlist` count 0) still hold exactly as written.

- [ ] **Step 6: Run the corrected specs to verify they pass**

Run: `pnpm exec playwright test tests/e2e/booking.spec.ts tests/e2e/student-journey.spec.ts tests/e2e/magic-link-handoff.spec.ts tests/e2e/a11y.spec.ts tests/e2e/visual.spec.ts`
Expected: PASS. If `visual.spec.ts`'s `public-page.png` screenshot diffs,
inspect it — it should not, since the label only ever renders for a
signed-in viewer and that test visits the page anonymously; if it does diff,
capture why before updating the baseline (`--update-snapshots`) rather than
blindly accepting a changed image.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/[slug]/page.tsx" tests/e2e/booking.spec.ts tests/e2e/student-journey.spec.ts
git commit -m "feat(schedule): show the price line alongside booked/waitlist state (#433)"
```

---

### Task 3: Bookings overview — fix the count bug, add progress/price/link

**Files:**
- Modify: `src/app/(student)/bookings/page.tsx`
- Modify/Create: `tests/integration/bookings-page.test.ts` (new `describe` block; the file already exists for a different fixture — add alongside, do not disturb the existing payment-status-gate suite)

**Interfaces:**
- Consumes: `resolvePriceLine`, `ResolvePriceLineInput` from `@/lib/price-line`; `ClassPriceLine` from `@/components/booking/price-range`; `RegistrationProgress` from `@/components/ui/registration-progress` (all pre-existing except the two from Task 1).

- [ ] **Step 1: Write the failing integration test for the active-count fix**

Add to `tests/integration/bookings-page.test.ts` (new top-level `describe`,
after the existing one — copy its fixture-setup shape: real `prisma` client,
`uniqueSuffix()`, a teacher, a room, a student, a class, `seedSession` +
`cookie` from `../helpers`, HTML fetched from `BASE_URL` and parsed as text):

```ts
describe('GET /bookings (page) — upcoming registration count', () => {
  const suffix2 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let cancelledAccountId = '';
  let roomId = '';
  let classId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `bookings-count-teacher-${suffix2}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Count', lastName: 'Teacher', email: teacherEmail,
        pageSlug: `bookings-count-teacher-${suffix2}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Count Studio',
        address: `${suffix2} Count St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 6, rentalRate: 15 },
    });

    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Count Test Class',
      date: new Date('2099-07-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 40,
      minStudents: 2,
      maxStudents: 6,
      status: 'open',
    });
    classId = cls.id;

    const studentEmail = `bookings-count-student-${suffix2}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Counted', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        incomeTier: 3, tierSelectedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId;
    studentToken = await seedSession(prisma, studentAccountId);

    // The viewer's own booking (counts).
    await prisma.registration.create({
      data: { classId, studentId, tierAtBooking: 3, status: 'registered' },
    });
    // A second student who cancelled — must NOT inflate the progress bar.
    const cancelledEmail = `bookings-count-cancelled-${suffix2}@test.local`;
    const cancelledStudent = await prisma.student.create({
      data: {
        firstName: 'Cancelled', lastName: 'Student', email: cancelledEmail,
        incomeTier: 2,
        account: { create: { email: cancelledEmail } },
      },
      select: { id: true, accountId: true },
    });
    cancelledAccountId = cancelledStudent.accountId;
    await prisma.registration.create({
      data: { classId, studentId: cancelledStudent.id, tierAtBooking: 2, status: 'cancelled' },
    });

    // Warm the route before the assertions score anything (next dev compiles
    // a page lazily on its first hit).
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId, cancelledAccountId] } },
    });
    await prisma.student.deleteMany({ where: { email: { contains: suffix2 } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId, cancelledAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('counts only active registrations, not cancelled ones, in the progress bar', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();
    // One active registration (the viewer's own) against a min of 2 — the
    // cancelled row must not count toward it. The rendered count is "1"
    // paired with "/ 2–6"; asserting the pair together rules out a
    // coincidental "1" elsewhere in the page.
    expect(html).toMatch(/1[\s\S]{0,80}\/ 2–6/);
  });

  it('shows the price line and a link to the booking page', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    const html = await res.text();
    expect(html).toContain('depending on how many join');
    expect(html).toContain(`/bookings-count-teacher-${suffix2}/book/${classId}`);
  });
});
```

This mirrors the existing suite's exact fixture shape in this same file —
`Room` requires `address`/`city`/`postcode`/`createdById` (verified against
`prisma/schema.prisma`'s `Room` model; there is no `teacherId` column on
`Room`), `cookie(token)` is already the full headers object (not nested under
a `cookie:` key — see the existing suite's `fetch(..., { headers:
cookie(studentToken) })` two paragraphs above), and cleanup deletes sessions
by `accountId`, not by re-deriving one from a student id. No new imports are
needed beyond what the file already has (`BASE_URL`, `cookie`, `uniqueSuffix`,
`seedSession`, `createClassFixture`, `hhmmToTime`) — reuse them rather than
adding an e2e-only helper like `accountIdOfStudent` (that one lives in
`tests/e2e/account-helpers.ts` and isn't available to `tests/integration/`).

- [ ] **Step 2: Run the test to verify it fails**

Ensure the worktree app is up: `pnpm run worktree:up` (skip if already
running).
Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: FAIL — both new assertions fail (no progress bar, no price line, no
link exist yet on this page).

- [ ] **Step 3: Fix the query and render the progress bar + price line + link on Upcoming cards**

In `src/app/(student)/bookings/page.tsx`, add imports:

```ts
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { ClassPriceLine } from '@/components/booking/price-range';
import { resolvePriceLine } from '@/lib/price-line';
import { readIncomeTier } from '@/lib/tiers.server';
import { CHARGED_STATUSES } from '@/services/class-lifecycle';
```

Replace the `class` nested include at lines 31-49 (the `registrations` query)
— add a `registrations` selection alongside the existing `_count`:

```ts
        class: {
          include: {
            calendarEntry: {
              include: {
                teacher: {
                  select: {
                    firstName: true,
                    lastName: true,
                    pageSlug: true,
                    bankIban: true,
                    bankAccountName: true,
                  },
                },
              },
            },
            teacherRoom: { include: { room: true } },
            registrations: {
              where: { status: { in: [...CHARGED_STATUSES] } },
              select: { id: true, studentId: true, tierAtBooking: true, status: true },
            },
          },
        },
```

(Drop the old `_count: { select: { registrations: true } }` — the full list
above replaces it, same as the public schedule card's pattern.)

The top-level query also needs the viewer's own tier/tierSelectedAt — add a
fourth entry to the existing `Promise.all` (lines 26-141), a
`prisma.student.findUniqueOrThrow` keyed on `session.studentId` selecting
`{ incomeTier: true, tierSelectedAt: true }`, and build a `viewer` object from
it the same way Task 2 does on the public schedule page (reuse the same
shape: `{ studentId: session.studentId, tier: readIncomeTier(...), tierSelectedAt }`).

In the Upcoming card's JSX (replace lines 240-253's structure — keep the
`late_cancel` branch as-is, extend the `cls.status === 'open' && !cancelled`
branch):

```tsx
                  {(() => {
                    const activeCount = cls.registrations.filter(
                      (r) => r.status !== 'late_cancel',
                    ).length;
                    return (
                      <RegistrationProgress
                        registered={activeCount}
                        min={cls.minStudents}
                        max={cls.maxStudents}
                        className="mt-3"
                      />
                    );
                  })()}
                  <ClassPriceLine
                    line={resolvePriceLine({
                      roomCost: Number(cls.roomCost),
                      minRate: Number(cls.minRate),
                      targetRate: Number(cls.targetRate),
                      minStudents: cls.minStudents,
                      maxStudents: cls.maxStudents,
                      registrations: cls.registrations,
                      viewer,
                    })}
                    className="mt-2"
                  />
                  <Link
                    href={`/${cls.calendarEntry.teacher.pageSlug}/book/${cls.id}`}
                    className="type-label text-teal no-underline inline-block mt-2"
                  >
                    View class &rarr;
                  </Link>
                  {reg.status === 'late_cancel' ? (
                    <p className="type-caption mt-2">
                      Cancelled after the deadline — this class is still charged.
                    </p>
                  ) : (
                    cls.status === 'open' && !cancelled && (
                      <div className="mt-3">
                        <CancelBookingButton
                          registrationId={reg.id}
                          cancelDeadline={cls.cancelDeadline}
                        />
                      </div>
                    )
                  )}
```

`Number(cls.roomCost)` etc. — `Class`'s economic columns are Prisma
`Decimal`, same reason every other page in this codebase wraps them in
`Number(...)` before handing them to `resolvePriceLine`/`estimateTierPrices`
(see the public schedule card, Task 2).

- [ ] **Step 4: Extend the Waitlist section's query and render the same three additions**

Extend the `waitlistEntries` query's nested `class` include (lines 94-118) —
add a `registrations` selection beside the existing `_count`:

```ts
      include: {
        class: {
          include: {
            calendarEntry: {
              include: {
                teacher: {
                  select: {
                    firstName: true,
                    lastName: true,
                    pageSlug: true,
                    defaultTimezone: true,
                  },
                },
              },
            },
            registrations: {
              where: { status: { in: [...CHARGED_STATUSES] } },
              select: { id: true, studentId: true, tierAtBooking: true, status: true },
            },
            _count: {
              select: {
                registrations: {
                  where: { status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
                },
              },
            },
          },
        },
      },
```

(Keep the existing `_count` — `canClaim`'s capacity check at line 192 already
reads it; the new `registrations` selection is additive.)

In the waitlist row's JSX (after the existing `<p className="type-caption">`
block, before `<WaitlistEntryActions .../>`):

```tsx
                <RegistrationProgress
                  registered={cls._count.registrations}
                  min={cls.minStudents}
                  max={cls.maxStudents}
                  className="mt-2"
                />
                <ClassPriceLine
                  line={resolvePriceLine({
                    roomCost: Number(cls.roomCost),
                    minRate: Number(cls.minRate),
                    targetRate: Number(cls.targetRate),
                    minStudents: cls.minStudents,
                    maxStudents: cls.maxStudents,
                    registrations: cls.registrations,
                    viewer,
                  })}
                  className="mt-1"
                />
                <Link
                  href={`/${cls.calendarEntry.teacher.pageSlug}/book/${cls.id}`}
                  className="type-label text-teal no-underline inline-block mt-1"
                >
                  View class &rarr;
                </Link>
```

`cls.minStudents`/`cls.maxStudents` — the waitlist query's `class` include
didn't previously select these as scalar fields explicitly, but a bare
`include: { class: { include: {...} } }` (no `select` on `class` itself)
already returns every scalar column on `Class`, `minStudents`/`maxStudents`
included — confirm this by checking the existing `cls.maxStudents` reference
already used at line 192 (`canClaim`), which proves it's already in scope.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the new integration test to verify it passes**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: PASS (both new tests, and the pre-existing payment-status-gate suite
in the same file unaffected).

- [ ] **Step 7: Run the full integration tier and the student-journey e2e spec (its Waitlist section now renders new markup)**

Run: `pnpm exec vitest run --project integration`
Expected: PASS.

Run: `pnpm exec playwright test tests/e2e/student-journey.spec.ts tests/e2e/a11y.spec.ts`
Expected: PASS — `a11y.spec.ts`'s "student bookings" test (signed-in) now
renders more markup on `/bookings`; it asserts no *serious* violations, not
exact content, but confirm it still passes rather than assuming.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
git commit -m "feat(bookings): fix active-count bug, add progress bar/price line/link to upcoming and waitlist (#433)"
```

---

## Self-Review Notes

- **Spec coverage**: Task 1 covers "Architecture" + the booking page's
  "regression-only" requirement. Task 2 covers the public schedule card row
  of the spec's table plus every e2e correction the spec's "Test impact"
  section named. Task 3 covers the bookings-overview row (upcoming + waitlist)
  and the count-bug fix. The spec's "Out of scope" section names nothing to
  build.
- **Type consistency**: `ResolvePriceLineInput`/`PriceLineResult` from Task 1
  are consumed with identical field names (`registrations`, `viewer`,
  `roomCost`/`minRate`/`targetRate`/`minStudents`/`maxStudents`) in Tasks 2
  and 3 — no renaming across tasks.
- **Task order**: strictly sequential — Task 2 and Task 3 both import Task
  1's `resolvePriceLine`/`ClassPriceLine`, so Task 1 must land first. Task 2
  and Task 3 touch disjoint files and could run in parallel once Task 1 is
  merged, but both modify e2e specs that visit overlapping fixtures
  (`student-journey.spec.ts`) only in Task 2 — Task 3 only touches
  `bookings-page.test.ts`, so there's no file collision between them either
  way.
